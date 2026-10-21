// OPR.0.7.0.2 (cost reporting, Pi atom): the store behind Pi's persisted-entry usage facts (migration 107).
// One row per (pi_session_id, entry_id): an entry Pi returns again (catch-up, the refresh after every turn, a
// runner restart, a replay) is never stored or counted twice. The only change ever made to a stored row is an
// "unknown" origin settling to own or inherited once the session header could be read.
import type { Database } from "better-sqlite3";
import type { PiUsageFact, PiUsageFactKind, PiUsageOrigin } from "./pi-usage-facts.js";
import { OPENROUTER_TEXT_LIMIT, type PiProviderCharge } from "./openrouter-charge.js";

const KINDS: ReadonlySet<PiUsageFactKind> = new Set(["assistant", "usage", "tool_result", "compaction", "branch_summary"]);
const ORIGINS: ReadonlySet<PiUsageOrigin> = new Set(["own", "inherited", "unknown"]);

export function hasPiUsageChargesTable(db: Database): boolean {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pi_usage_charges'").get();
  } catch {
    return false;
  }
}

export function hasPiUsageEntriesTable(db: Database): boolean {
  try {
    return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pi_usage_entries'").get();
  } catch {
    return false;
  }
}

/** A posted charge outcome, checked field by field; null when it doesn't have the shape the runner sends. */
export function validPiProviderCharge(raw: unknown): PiProviderCharge | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const f = raw as Record<string, unknown>;
  const s = (k: string) => (typeof f[k] === "string" && (f[k] as string).length > 0 ? f[k] as string : null);
  const n = (k: string) => (typeof f[k] === "number" && Number.isFinite(f[k]) ? f[k] as number : null);
  const ok = (k: string, test: (v: unknown) => boolean) => f[k] === null || f[k] === undefined || test(f[k]);
  const optional = ["upstreamInferenceCostUsd", "cacheDiscountUsd", "totalCostUsd"];
  const optionalText = ["providerName", "model", "apiType", "workspaceId", "generationCreatedAt", "reason"];
  const entryId = s("entryId"); const generationId = s("generationId"); const credentialSource = s("credentialSource");
  const status = f["status"];
  if (!entryId || !generationId || !credentialSource || (status !== "charged" && status !== "unavailable")) return null;
  if (!optional.every((k) => ok(k, (v) => typeof v === "number" && Number.isFinite(v)))) return null;
  // Bounded like the reply fields the runner keeps (OPENROUTER_TEXT_LIMIT); a reason is the runner's own text.
  if (!optionalText.every((k) => ok(k, (v) => typeof v === "string" && v.length <= (k === "reason" ? 512 : OPENROUTER_TEXT_LIMIT)))) return null;
  if ([entryId, generationId, credentialSource].some((v) => v.length > 256)) return null;
  if (!ok("isByok", (v) => typeof v === "boolean")) return null;
  const total = n("totalCostUsd");
  if (status === "charged" && (total === null || total < 0)) return null;
  if (status === "unavailable" && !s("reason")) return null;
  return {
    entryId, generationId, status, credentialSource,
    totalCostUsd: status === "charged" ? total : null,
    upstreamInferenceCostUsd: n("upstreamInferenceCostUsd"), cacheDiscountUsd: n("cacheDiscountUsd"),
    isByok: typeof f["isByok"] === "boolean" ? f["isByok"] as boolean : null,
    providerName: s("providerName"), model: s("model"), apiType: s("apiType"), workspaceId: s("workspaceId"),
    generationCreatedAt: s("generationCreatedAt"), reason: s("reason"),
  };
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
    api: nullable("api"), responseId: nullable("responseId"),
  };
}

export class PiUsageEntriesStore {
  private readonly chargeColumns: boolean;
  constructor(private readonly db: Database) {
    this.chargeColumns = hasPiUsageChargesTable(db);
  }

  /** Of these entries, the ones that already have a recorded OpenRouter charge (a restarted runner skips them). */
  chargedEntryIds(piSessionId: string, entryIds: string[]): string[] {
    if (!this.chargeColumns || entryIds.length === 0) return [];
    const charged = new Set((this.db.prepare(
      "SELECT entry_id FROM pi_usage_charges WHERE pi_session_id = ? AND status = 'charged'",
    ).all(piSessionId) as Array<{ entry_id: string }>).map((row) => row.entry_id));
    return entryIds.filter((id) => charged.has(id));
  }

  /** Record charge outcomes for entries already stored for this seat and session. A charged row is final; an
   *  unavailable one can become charged; anything else is a replay and changes nothing. Facts never stored, or
   *  stored for another seat, are refused. */
  recordCharges(input: { seatSession: string; piSessionId: string; charges: PiProviderCharge[] }, recordedAt: string):
    { stored: number; unchanged: number; refused: number; acknowledged: string[] } {
    const known = this.db.prepare(
      "SELECT response_id FROM pi_usage_entries WHERE pi_session_id = ? AND entry_id = ? AND seat_session = ?",
    );
    const upsert = this.db.prepare(
      `INSERT INTO pi_usage_charges
         (pi_session_id, entry_id, generation_id, status, total_cost_usd, upstream_inference_cost_usd, cache_discount_usd,
          is_byok, provider_name, model, api_type, workspace_id, generation_created_at, credential_source, reason,
          seat_session, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(pi_session_id, entry_id) DO UPDATE SET
         generation_id = excluded.generation_id, status = excluded.status, total_cost_usd = excluded.total_cost_usd,
         upstream_inference_cost_usd = excluded.upstream_inference_cost_usd, cache_discount_usd = excluded.cache_discount_usd,
         is_byok = excluded.is_byok, provider_name = excluded.provider_name, model = excluded.model,
         api_type = excluded.api_type, workspace_id = excluded.workspace_id,
         generation_created_at = excluded.generation_created_at, credential_source = excluded.credential_source,
         reason = excluded.reason, recorded_at = excluded.recorded_at
       WHERE pi_usage_charges.status = 'unavailable'
         AND (excluded.status = 'charged' OR excluded.reason IS NOT pi_usage_charges.reason)`,
    );
    let stored = 0;
    let refused = 0;
    const acknowledged: string[] = [];
    this.db.transaction(() => {
      for (const c of input.charges) {
        const entry = known.get(input.piSessionId, c.entryId, input.seatSession) as { response_id: string | null } | undefined;
        if (!entry || entry.response_id !== c.generationId) { refused += 1; continue; }
        acknowledged.push(c.entryId); // stored now, or the store already holds this entry's outcome
        stored += upsert.run(input.piSessionId, c.entryId, c.generationId, c.status, c.totalCostUsd, c.upstreamInferenceCostUsd,
          c.cacheDiscountUsd, c.isByok === null ? null : c.isByok ? 1 : 0, c.providerName, c.model, c.apiType, c.workspaceId,
          c.generationCreatedAt, c.credentialSource, c.reason, input.seatSession, recordedAt).changes;
      }
    })();
    return { stored, unchanged: input.charges.length - stored - refused, refused, acknowledged };
  }

  /** Store each fact once. Returns how many were new (or had an unknown origin settled) and how many were already stored. */
  record(input: { seatSession: string; nodeId: string | null; generation: string | null; piSessionId: string; facts: PiUsageFact[] }, recordedAt: string):
    { stored: number; duplicates: number } {
    const insert = this.db.prepare(
      `INSERT INTO pi_usage_entries
         (pi_session_id, entry_id, parent_entry_id, entry_timestamp, kind, usage_category, provider, model,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_total, stop_reason, origin,
          seat_session, node_id, occupant_generation, recorded_at${this.chargeColumns ? ", api, response_id" : ""})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?${this.chargeColumns ? ", ?, ?" : ""})
       ON CONFLICT(pi_session_id, entry_id) DO UPDATE SET origin = excluded.origin
         WHERE pi_usage_entries.origin = 'unknown' AND excluded.origin <> 'unknown'`,
    );
    // K4 (rows stored before migration 108): a replay of the same entry fills the request correlation it didn't
    // have. Same means it agrees with every fact field stored for the entry: seat, parent entry, time, kind,
    // usage category, provider, model, all four token counts, estimate and stop reason (origin settles on its
    // own), and with any correlation value already stored. A value already there is never overwritten; cost and
    // origin are never changed here.
    const backfill = this.chargeColumns ? this.db.prepare(
      `UPDATE pi_usage_entries SET api = COALESCE(api, ?), response_id = COALESCE(response_id, ?)
        WHERE pi_session_id = ? AND entry_id = ? AND seat_session = ? AND parent_entry_id IS ? AND entry_timestamp = ?
          AND kind = ? AND usage_category IS ? AND provider IS ? AND model IS ?
          AND input_tokens = ? AND output_tokens = ? AND cache_read_tokens = ? AND cache_write_tokens = ?
          AND cost_total IS ? AND stop_reason IS ?
          AND (api IS NULL OR api IS ?) AND (response_id IS NULL OR response_id IS ?)
          AND ((api IS NULL AND ? IS NOT NULL) OR (response_id IS NULL AND ? IS NOT NULL))`,
    ) : null;
    let stored = 0;
    this.db.transaction(() => {
      for (const fact of input.facts) {
        const changes = insert.run(input.piSessionId, fact.entryId, fact.parentEntryId, fact.entryTimestamp, fact.kind, fact.usageCategory,
          fact.provider, fact.model, fact.input, fact.output, fact.cacheRead, fact.cacheWrite, fact.costTotal, fact.stopReason,
          fact.origin, input.seatSession, input.nodeId, input.generation, recordedAt,
          ...(this.chargeColumns ? [fact.api ?? null, fact.responseId ?? null] : [])).changes;
        stored += changes;
        // Also when this replay just settled the row's origin (a change of its own): correlation is separate.
        if (backfill) {
          const api = fact.api ?? null;
          const responseId = fact.responseId ?? null;
          backfill.run(api, responseId, input.piSessionId, fact.entryId, input.seatSession, fact.parentEntryId, fact.entryTimestamp,
            fact.kind, fact.usageCategory, fact.provider, fact.model, fact.input, fact.output, fact.cacheRead, fact.cacheWrite,
            fact.costTotal, fact.stopReason, api, responseId, api, responseId);
        }
      }
    })();
    return { stored, duplicates: input.facts.length - stored };
  }
}
