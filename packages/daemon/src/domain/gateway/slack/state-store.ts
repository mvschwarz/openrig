// Slice-11 slack-connector — durable, restart-surviving state.
//
// Three append-only JSONL stores, written to disk so they survive BOTH a
// connector restart AND a queue-daemon restart (locked item 2 + item 8):
//   - SeenStore     : delivery-dedup by id; a line is appended ONLY AFTER the
//                     side effect succeeds (outbound: after a 200 from Slack;
//                     inbound: after the durable qitem exists). At-least-once —
//                     a crash between success and append re-delivers a
//                     BYTE-IDENTICAL duplicate next run, never a drop.
//   - DeadLetterStore : the inbound never-drop net. An event that fails to land
//                     in the queue is appended (attempt-counted) BEFORE the
//                     failure path returns; drain() truncates and hands the
//                     lines back so the caller re-appends any that fail again
//                     ("zero-drop means zero, not zero-until-the-second-failure").
//   - InboundReceiptStore : credential-free ingress/lifecycle observations,
//                     with received recorded before filtering and a final disposition.
//
// FS + clock are injected so the whole thing is unit-testable with no real disk.
import fs from "node:fs";
import path from "node:path";

export interface StateFsOps {
  readFileSync(p: string): string; // throws (ENOENT) when absent — callers treat as empty
  appendFileSync(p: string, data: string): void;
  writeFileSync(p: string, data: string): void;
  rename(from: string, to: string): void; // atomic same-dir replace
  mkdirp(dir: string): void;
}

export const nodeStateFs: StateFsOps = {
  readFileSync: (p) => fs.readFileSync(p, "utf8"),
  // A crash can leave the previous append without its final newline. Separate
  // the next record unconditionally so it cannot become part of that torn JSON.
  // Blank lines are already ignored by parseLines; avoid rereading a growing log.
  appendFileSync: (p, d) => fs.appendFileSync(p, "\n" + d),
  writeFileSync: (p, d) => fs.writeFileSync(p, d),
  rename: (from, to) => fs.renameSync(from, to),
  mkdirp: (dir) => {
    fs.mkdirSync(dir, { recursive: true });
  },
};

function parseLines(raw: string): unknown[] {
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null; // tolerate a torn final line from a crash mid-append
      }
    })
    .filter((x): x is unknown => x !== null);
}

export interface SeenRecord {
  id: string;
  ts: string;
  status: string;
}

/**
 * Delivery-dedup log. `load()` reads the durable set from disk; `mark()` appends
 * AFTER the guarded side effect. Idempotent on id: a repeated id collapses in
 * `load()`'s Set, and callers gate the side effect on `!seen.has(id)` so a
 * duplicate is never re-delivered within a run.
 */
export class SeenStore {
  constructor(
    private readonly file: string,
    private readonly fsops: StateFsOps = nodeStateFs,
    private readonly now: () => Date = () => new Date(),
  ) {}

  load(): Set<string> {
    let raw: string;
    try {
      raw = this.fsops.readFileSync(this.file);
    } catch {
      return new Set();
    }
    return new Set(parseLines(raw).map((r) => (r as SeenRecord).id).filter((id) => typeof id === "string"));
  }

  /** Append a seen record. MUST be called only after the guarded side effect succeeds. */
  mark(id: string, status: string): void {
    this.fsops.mkdirp(path.dirname(this.file));
    this.fsops.appendFileSync(this.file, JSON.stringify({ id, ts: this.now().toISOString(), status }) + "\n");
  }

  /**
   * Seed existing ids as already-seen WITHOUT triggering the side effect
   * (locked item 9: enable-time backlog seeds as history, zero replay storm).
   */
  seed(ids: string[], status = "seeded"): number {
    if (ids.length === 0) return 0;
    this.fsops.mkdirp(path.dirname(this.file));
    const at = this.now().toISOString();
    const chunk = ids.map((id) => JSON.stringify({ id, ts: at, status })).join("\n") + "\n";
    this.fsops.appendFileSync(this.file, chunk);
    return ids.length;
  }
}

export interface DeadLetterEntry<T = unknown> {
  ev: T;
  at: string;
  attempts: number;
}

/**
 * Inbound never-drop net. Every event that fails to land is appended
 * (attempt-counted) BEFORE the error path returns.
 *
 * INTERRUPTION-SAFE retry (the B2 fix): retry does NOT truncate first. The
 * caller `readAll()`s (non-destructive), attempts each, then `replaceAll()`s the
 * file with ONLY the still-failing entries via an atomic temp-write + rename. So
 * the durable file always reflects the unrecovered set: a crash at ANY point
 * before the rename leaves the ORIGINAL file fully intact (at-least-once — a
 * since-landed event is skipped on re-read via the seen-set, so not even a dup).
 * There is no truncate-before-success window.
 */
export class DeadLetterStore<T = unknown> {
  constructor(
    private readonly file: string,
    private readonly fsops: StateFsOps = nodeStateFs,
    private readonly now: () => Date = () => new Date(),
  ) {}

  append(ev: T, attempts: number): void {
    this.fsops.mkdirp(path.dirname(this.file));
    this.fsops.appendFileSync(
      this.file,
      JSON.stringify({ ev, at: this.now().toISOString(), attempts } satisfies DeadLetterEntry<T>) + "\n",
    );
  }

  /** Non-destructive read of all durable entries. */
  readAll(): DeadLetterEntry<T>[] {
    let raw: string;
    try {
      raw = this.fsops.readFileSync(this.file);
    } catch {
      return [];
    }
    return parseLines(raw) as DeadLetterEntry<T>[];
  }

  /** Atomically replace the durable set (temp-write + rename). Used after a retry pass. */
  replaceAll(entries: DeadLetterEntry<T>[]): void {
    this.fsops.mkdirp(path.dirname(this.file));
    const body = entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : "");
    const tmp = `${this.file}.tmp`;
    this.fsops.writeFileSync(tmp, body);
    this.fsops.rename(tmp, this.file); // atomic: original intact until this instant
  }

  /** Finish a retry snapshot without removing entries appended while it awaited I/O.
   * Match occurrences, not just event ids: a later identical append is still owed. */
  replaceBatch(processed: DeadLetterEntry<T>[], remaining: DeadLetterEntry<T>[]): void {
    const counts = new Map<string, number>();
    for (const entry of processed) {
      const key = JSON.stringify(entry);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const appended = this.readAll().filter((entry) => {
      const key = JSON.stringify(entry);
      const count = counts.get(key) ?? 0;
      if (count === 0) return true;
      counts.set(key, count - 1);
      return false;
    });
    this.replaceAll([...remaining, ...appended]);
  }
}

export type InboundReceiptStatus =
  | "connect-attempt"
  | "connected"
  | "disconnected"
  | "connect-failed"
  | "received"
  | "accepted"
  | "ignored"
  | "refused"
  | "dead-lettered"
  | "handler-failed";

export interface InboundReceipt {
  at: string;
  generation: number;
  status: InboundReceiptStatus;
  envelopeId?: string;
  eventTs?: string;
  channel?: string;
  reason?: string;
}

/** Credential-free ingress/lifecycle ledger. A received receipt is appended before
 * handler filtering, then a final typed disposition follows. It deliberately has no
 * message body, sender, token, or secret fields. */
export class InboundReceiptStore {
  constructor(
    private readonly file: string,
    private readonly fsops: StateFsOps = nodeStateFs,
    private readonly now: () => Date = () => new Date(),
  ) {}

  append(receipt: Omit<InboundReceipt, "at">): void {
    this.fsops.mkdirp(path.dirname(this.file));
    this.fsops.appendFileSync(this.file, JSON.stringify({ at: this.now().toISOString(), ...receipt } satisfies InboundReceipt) + "\n");
  }

  readAll(): InboundReceipt[] {
    try {
      return parseLines(this.fsops.readFileSync(this.file)) as InboundReceipt[];
    } catch {
      return [];
    }
  }
}

/** Slack timestamps are decimal seconds with up to six fractional digits, not floats. */
export function slackMicros(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^\d{1,12}\.\d{1,6}$/.test(value)) return null;
  const [seconds, fraction] = value.split(".");
  return BigInt(seconds!) * 1_000_000n + BigInt(fraction!.padEnd(6, "0"));
}
export function slackTimestamp(micros: bigint): string {
  return `${micros / 1_000_000n}.${String(micros % 1_000_000n).padStart(6, "0")}`;
}

export interface ChannelCoverage {
  coverageStart: string;
  coveredThrough: string;
  seedBasis: "newest-durable-landing" | "feature-adoption";
  pending?: { upper: string; nextLatest: string };
  nextRetryAt?: number;
  /** Available history was scanned, but Slack reported older history beyond its plan limit. */
  historyLimited?: boolean;
}

function readOptional(file: string, fsops: StateFsOps): string | undefined {
  try { return fsops.readFileSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error; // Never replace unreadable existing coverage with a new floor.
  }
}

/** A scan boundary, not an event receipt. Status uses an in-memory snapshot, never this file. */
export class ChannelCoverageStore {
  constructor(private readonly file: string, private readonly fsops: StateFsOps = nodeStateFs) {}

  private read(): Record<string, ChannelCoverage> {
    const raw = readOptional(this.file, this.fsops);
    if (raw === undefined) return {};
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid coverage store");
    for (const c of Object.values(data) as ChannelCoverage[]) {
      const start = slackMicros(c?.coverageStart), through = slackMicros(c?.coveredThrough);
      if (start === null || through === null || start > through ||
        !["newest-durable-landing", "feature-adoption"].includes(c.seedBasis) ||
        (c.historyLimited !== undefined && typeof c.historyLimited !== "boolean") ||
        (c.nextRetryAt !== undefined && (!Number.isFinite(c.nextRetryAt) || c.nextRetryAt < 0))) throw new Error("invalid coverage checkpoint");
      if (c.pending) {
        const upper = slackMicros(c.pending.upper), next = slackMicros(c.pending.nextLatest);
        if (upper === null || next === null || next <= through || next > upper) throw new Error("invalid pending interval");
      }
    }
    return data;
  }

  save(channel: string, coverage: ChannelCoverage): void {
    const data = this.read();
    Object.defineProperty(data, channel, { value: coverage, enumerable: true, configurable: true });
    this.fsops.mkdirp(path.dirname(this.file));
    this.fsops.writeFileSync(`${this.file}.tmp`, JSON.stringify(data) + "\n");
    this.fsops.rename(`${this.file}.tmp`, this.file);
  }

  initialize(channel: string, at: string, seenFile: string, receiptsFile: string): ChannelCoverage {
    const data = this.read();
    if (Object.hasOwn(data, channel)) return data[channel]!;
    // Only once per channel. A live event can seed an upgrade, never advance later coverage.
    const candidates: string[] = [];
    for (const r of parseLines(readOptional(seenFile, this.fsops) ?? "") as SeenRecord[]) {
      if (typeof r.id === "string" && r.id.startsWith(`${channel}:`)) candidates.push(r.id.slice(channel.length + 1));
    }
    for (const r of parseLines(readOptional(receiptsFile, this.fsops) ?? "") as InboundReceipt[]) {
      if (r.status === "accepted" && r.channel === channel && r.eventTs) candidates.push(r.eventTs);
    }
    const valid = candidates.filter(ts => slackMicros(ts) !== null);
    valid.sort((a, b) => slackMicros(a)! < slackMicros(b)! ? 1 : -1);
    const floor = valid[0] ?? at;
    const coverage: ChannelCoverage = { coverageStart: floor, coveredThrough: floor,
      seedBasis: valid.length ? "newest-durable-landing" : "feature-adoption" };
    this.save(channel, coverage);
    return coverage;
  }
}
