// OPR.0.7.0.2 (cost reporting, Pi atom): the store behind Pi's persisted-entry usage facts (migration 107).
// One row per (pi_session_id, entry_id): an entry Pi returns again (catch-up, the refresh after every turn, a
// runner restart, a replay) is never stored or counted twice. The only change ever made to a stored row is an
// "unknown" origin settling to own or inherited once the session header could be read.
import type { Database } from "better-sqlite3";
import type { PiUsageFact, PiUsageFactKind, PiUsageOrigin } from "./pi-usage-facts.js";

const KINDS: ReadonlySet<PiUsageFactKind> = new Set(["assistant", "usage", "tool_result", "compaction", "branch_summary"]);
const ORIGINS: ReadonlySet<PiUsageOrigin> = new Set(["own", "inherited", "unknown"]);

export function hasPiUsageEntriesTable(db: Database): boolean {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pi_usage_entries'").get();
  } catch {
    return false;
  }
}

/** A posted fact, checked field by field; null when it doesn't have the shape the runner sends. */
export function validPiUsageFact(raw: unknown): PiUsageFact | null {
  if (raw === null || typeof raw !== "object") return null;
  const f = raw as Record<string, unknown>;
  const s = (k: string) => (typeof f[k] === "string" && (f[k] as string).length > 0 ? f[k] as string : null);
  const n = (k: string) => (typeof f[k] === "number" && Number.isFinite(f[k]) ? f[k] as number : null);
  const nullable = (k: string) => (f[k] === null || f[k] === undefined ? null : s(k));
  const entryId = s("entryId");
  const entryTimestamp = s("entryTimestamp");
  const kind = s("kind") as PiUsageFactKind | null;
  const origin = s("origin") as PiUsageOrigin | null;
  const input = n("input");
  const output = n("output");
  if (!entryId || !entryTimestamp || !kind || !KINDS.has(kind) || !origin || !ORIGINS.has(origin) || input === null || output === null) return null;
  const cost = f["costTotal"] === null || f["costTotal"] === undefined ? null : n("costTotal");
  if (f["costTotal"] !== null && f["costTotal"] !== undefined && cost === null) return null;
  return {
    entryId, entryTimestamp, kind, origin, input, output,
    parentEntryId: nullable("parentEntryId"), usageCategory: nullable("usageCategory"),
    provider: nullable("provider"), model: nullable("model"),
    cacheRead: n("cacheRead") ?? 0, cacheWrite: n("cacheWrite") ?? 0,
    costTotal: cost, stopReason: nullable("stopReason"),
  };
}

export class PiUsageEntriesStore {
  constructor(private readonly db: Database) {}

  /** Store each fact once. Returns how many were new (or had an unknown origin settled) and how many were already stored. */
  record(input: { seatSession: string; nodeId: string | null; generation: string | null; piSessionId: string; facts: PiUsageFact[] }, recordedAt: string):
    { stored: number; duplicates: number } {
    const insert = this.db.prepare(
      `INSERT INTO pi_usage_entries
         (pi_session_id, entry_id, parent_entry_id, entry_timestamp, kind, usage_category, provider, model,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_total, stop_reason, origin,
          seat_session, node_id, occupant_generation, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(pi_session_id, entry_id) DO UPDATE SET origin = excluded.origin
         WHERE pi_usage_entries.origin = 'unknown' AND excluded.origin <> 'unknown'`,
    );
    let stored = 0;
    this.db.transaction(() => {
      for (const fact of input.facts) {
        stored += insert.run(input.piSessionId, fact.entryId, fact.parentEntryId, fact.entryTimestamp, fact.kind, fact.usageCategory,
          fact.provider, fact.model, fact.input, fact.output, fact.cacheRead, fact.cacheWrite, fact.costTotal, fact.stopReason,
          fact.origin, input.seatSession, input.nodeId, input.generation, recordedAt).changes;
      }
    })();
    return { stored, duplicates: input.facts.length - stored };
  }
}
