// The record of each subscription move an agent makes or attempts: which Codex home and seats moved,
// from which subscription to which, why, on which readings, and how each seat came out. The agent decides and moves
// (`rig auth switch`, then `rig seat restart --keep-conversation`, then a `--verify` check after a real turn); this
// only keeps what it reports, in the daemon's append-only event log, for the agent and the observatory to read. It
// holds labels and references, never credentials, and decides nothing. Its routes are off unless
// provider.subscription_moves is on.

import { randomBytes } from "node:crypto";
import type { EventBus } from "../event-bus.js";

export const SUBSCRIPTION_MOVE_EVENT = "subscription.move_recorded" as const;

// Move events carry no node, so `node_id IS NULL` lets both reads use idx_events_node_type_seq (node_id, type, seq)
// instead of scanning the whole event log, which on a long-lived daemon holds millions of rows.
export const SUBSCRIPTION_MOVE_LIST_SQL =
  "SELECT seq, payload, created_at FROM events WHERE node_id IS NULL AND type = ? ORDER BY seq DESC";
export const SUBSCRIPTION_MOVE_SHOW_SQL =
  "SELECT seq, payload, created_at FROM events WHERE node_id IS NULL AND type = ? AND json_extract(payload, '$.move.id') = ? ORDER BY seq DESC LIMIT 1";

/** How one seat came out of a move. `moved` needs the restart's uptake evidence (a real turn and the account in use). */
export type SeatMoveResult = "moved" | "unconfirmed" | "unknown";
const SEAT_RESULTS: ReadonlySet<string> = new Set(["moved", "unconfirmed", "unknown"]);

export interface SubscriptionMoveSeat {
  seat: string;
  result: SeatMoveResult;
  /** For `unconfirmed` or `unknown`: what is missing, e.g. "no completed tool turn". */
  missing?: string;
  /** What showed the result, e.g. the restart's verify outcome and Account line. */
  evidence?: string;
}

/** A reading the agent acted on, with when it was observed. */
export interface SubscriptionMoveReading {
  /** The allowance or subscription it describes. */
  subject: string;
  /** When the reading was observed (ISO 8601), not when the agent read it. */
  observedAt: string;
  /** What it said, e.g. "weekly 92% used, resets 2026-10-20T00:00Z". */
  summary: string;
}

/** What the agent reports. */
export interface SubscriptionMoveInput {
  /** The Codex home moved, as the agent names it (path or label). */
  home: string;
  /** The machine it is on. */
  host?: string;
  /** Subscription or account references, as labels: never credentials. */
  from: string;
  to: string;
  /** The agent's reason, in its own words. */
  reason: string;
  readings: SubscriptionMoveReading[];
  /** Seats restarted (or attempted), each with its result. */
  seats: SubscriptionMoveSeat[];
  /** Seats on the home that were not restarted ("not restarted; account unverified"), or skipped with a reason. */
  peers?: Array<{ seat: string; note: string }>;
  /** An earlier move id this record follows up, e.g. confirming an unconfirmed seat. */
  supersedes?: string;
}

/** What the event log holds for one move. */
export type SubscriptionMoveEventPayload = SubscriptionMoveInput & { id: string; recordedBy: string; recordedVia: string };

export interface SubscriptionMoveRecord extends SubscriptionMoveInput {
  id: string;
  /** Who recorded it: the caller's transport identity, or the operator it named when it had none. */
  recordedBy: string;
  /** How recordedBy is known: the transport identity, or `claimed:v1` for a named operator. */
  recordedVia: string;
  recordedAt: string;
  seq: number;
}

export class SubscriptionMoveInputError extends Error {}

const text = (value: unknown, field: string, optional = false): string | undefined => {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || value.trim() === "") throw new SubscriptionMoveInputError(`${field} must be a non-empty string`);
  return value;
};
const list = (value: unknown, field: string, optional = false): unknown[] => {
  if (value === undefined && optional) return [];
  if (!Array.isArray(value)) throw new SubscriptionMoveInputError(`${field} must be a list`);
  return value;
};
const object = (value: unknown, field: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new SubscriptionMoveInputError(`${field} must be an object`);
  return value as Record<string, unknown>;
};

/** An ISO 8601 date-time with an explicit timezone, on a real calendar date (no Feb 30): a reading's age depends on it. */
function isIsoTimestamp(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || Number.isNaN(Date.parse(value))) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const calendar = new Date(Date.UTC(year, month - 1, day));
  return calendar.getUTCFullYear() === year && calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day;
}

/** The shape check for a reported move. It refuses only malformed input; it never judges the move. */
export function parseSubscriptionMove(raw: unknown): SubscriptionMoveInput {
  const body = object(raw, "the move");
  const seats = list(body["seats"], "seats").map((entry, i) => {
    const seat = object(entry, `seats[${i}]`);
    const result = seat["result"];
    if (typeof result !== "string" || !SEAT_RESULTS.has(result)) {
      throw new SubscriptionMoveInputError(`seats[${i}].result must be moved, unconfirmed or unknown`);
    }
    // What the result rests on is part of the record: a move's evidence, or what a lesser result is missing.
    const evidence = text(seat["evidence"], `seats[${i}].evidence`, result !== "moved");
    const missing = text(seat["missing"], `seats[${i}].missing`, result === "moved");
    return {
      seat: text(seat["seat"], `seats[${i}].seat`)!,
      result: result as SeatMoveResult,
      ...(missing !== undefined ? { missing } : {}),
      ...(evidence !== undefined ? { evidence } : {}),
    };
  });
  const readingList = list(body["readings"], "readings");
  if (readingList.length === 0) throw new SubscriptionMoveInputError("readings must name what the move acted on");
  const readings = readingList.map((entry, i) => {
    const reading = object(entry, `readings[${i}]`);
    const observedAt = text(reading["observedAt"], `readings[${i}].observedAt`)!;
    if (!isIsoTimestamp(observedAt)) {
      throw new SubscriptionMoveInputError(`readings[${i}].observedAt must be an ISO 8601 time with a timezone, e.g. 2026-10-18T09:56:00Z`);
    }
    return { subject: text(reading["subject"], `readings[${i}].subject`)!, observedAt, summary: text(reading["summary"], `readings[${i}].summary`)! };
  });
  const peers = list(body["peers"], "peers", true).map((entry, i) => {
    const peer = object(entry, `peers[${i}]`);
    return { seat: text(peer["seat"], `peers[${i}].seat`)!, note: text(peer["note"], `peers[${i}].note`)! };
  });
  // A home switch can leave every seat as a peer (all mid-turn or running services): record that honestly.
  if (seats.length === 0 && peers.length === 0) throw new SubscriptionMoveInputError("seats or peers must name at least one seat");
  const host = text(body["host"], "host", true);
  const supersedes = text(body["supersedes"], "supersedes", true);
  return {
    home: text(body["home"], "home")!,
    ...(host ? { host } : {}),
    from: text(body["from"], "from")!,
    to: text(body["to"], "to")!,
    reason: text(body["reason"], "reason")!,
    readings,
    seats,
    ...(peers.length ? { peers } : {}),
    ...(supersedes ? { supersedes } : {}),
  };
}

export class SubscriptionMoves {
  constructor(private readonly eventBus: EventBus) {}

  record(input: SubscriptionMoveInput, recordedBy: string, recordedVia: string): SubscriptionMoveRecord {
    const id = `move-${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}-${randomBytes(4).toString("hex")}`;
    const persisted = this.eventBus.emit({ type: SUBSCRIPTION_MOVE_EVENT, move: { id, recordedBy, recordedVia, ...input } });
    return { id, recordedBy, recordedVia, ...input, recordedAt: persisted.createdAt, seq: persisted.seq };
  }

  /** Newest first. A seat filter matches a moved seat or a peer. */
  list(filter: { home?: string; seat?: string; limit?: number } = {}): SubscriptionMoveRecord[] {
    // Iterate, newest first, and stop as soon as the filtered limit is met: no reading the whole history for one row.
    const rows = this.eventBus.db.prepare(SUBSCRIPTION_MOVE_LIST_SQL)
      .iterate(SUBSCRIPTION_MOVE_EVENT) as Iterable<{ seq: number; payload: string; created_at: string }>;
    const records: SubscriptionMoveRecord[] = [];
    for (const row of rows) {
      const record = toRecord(row);
      if (!record) continue;
      if (filter.home && record.home !== filter.home) continue;
      if (filter.seat && !record.seats.some((s) => s.seat === filter.seat) && !(record.peers ?? []).some((p) => p.seat === filter.seat)) continue;
      records.push(record);
      if (records.length >= (filter.limit ?? 50)) break;
    }
    return records;
  }

  show(id: string): SubscriptionMoveRecord | null {
    const row = this.eventBus.db.prepare(SUBSCRIPTION_MOVE_SHOW_SQL)
      .get(SUBSCRIPTION_MOVE_EVENT, id) as { seq: number; payload: string; created_at: string } | undefined;
    return row ? toRecord(row) : null;
  }
}

function toRecord(row: { seq: number; payload: string; created_at: string }): SubscriptionMoveRecord | null {
  try {
    const move = (JSON.parse(row.payload) as { move?: SubscriptionMoveEventPayload }).move;
    return move ? { ...move, recordedAt: row.created_at, seq: row.seq } : null;
  } catch {
    return null;
  }
}
