// 51-08 A1 — writer for the append-only per-seat usage series (migration 062).
//
// ADVANCE-ONLY is the load-bearing property: a sample byte-identical to the
// seat's latest row in the same lane (and window, for the provider lane) is
// refused, so an idle seat adds zero rows and the series length measures actual
// movement. History is never mutated — unlike context_usage (018), whose
// destructive upsert stays the point-in-time lane; this store is its
// over-time twin.
//
// OPTION-A BAR: inputs carry seat/node identity only. No account identity
// exists in the schema and none is accepted here.
import type { Database } from "better-sqlite3";
import type { ProviderSignal } from "./provider/provider-types.js";

export interface ContextSampleInput {
  nodeId: string;
  seatSession: string;
  source: string | null;
  sampledAt: string | null;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  usedPercentage: number | null;
  /** The native session the sample belongs to (Claude session id, Codex thread id). */
  nativeSessionId?: string | null;
  /** Claude's cumulative client-side cost estimate for that session; null when none is reported. */
  clientCostEstimateUsd?: number | null;
}

export interface ProviderWindowSampleInput {
  seatSession: string;
  window: "five_hour" | "weekly";
  usedPercent: number | null;
  resetsAt: string | null;
  asOf: string;
}

interface LastContextRow {
  sampled_at: string | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  used_percentage: number | null;
  native_session_id?: string | null;
  client_cost_estimate_usd?: number | null;
}

/** Whether migration 105's cost columns exist (a database built from 062 alone has none). */
export function hasClientCostColumns(db: Database): boolean {
  try {
    const cols = db.prepare("PRAGMA table_info(usage_samples)").all() as Array<{ name: string }>;
    return cols.some((c) => c.name === "client_cost_estimate_usd") && cols.some((c) => c.name === "native_session_id");
  } catch {
    return false;
  }
}

interface LastWindowRow {
  sampled_at: string | null;
  window_used_percent: number | null;
  resets_at: string | null;
}

export class UsageSamplesStore {
  private readonly db: Database;
  private costColumns: boolean | null = null;

  constructor(db: Database) {
    this.db = db;
  }

  private withCost(): boolean {
    this.costColumns ??= hasClientCostColumns(this.db);
    return this.costColumns;
  }

  /** Append the context-lane sample IFF it advanced past the seat's latest row. */
  appendContextSample(s: ContextSampleInput, capturedAt: string): boolean {
    const cost = this.withCost();
    const nativeSessionId = s.nativeSessionId ?? null;
    const estimate = s.clientCostEstimateUsd ?? null;
    const last = this.db
      .prepare(
        `SELECT sampled_at, total_input_tokens, total_output_tokens, used_percentage${cost ? ", native_session_id, client_cost_estimate_usd" : ""}
         FROM usage_samples
         WHERE lane = 'context' AND seat_session = ? AND node_id = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(s.seatSession, s.nodeId) as LastContextRow | undefined;
    if (
      last &&
      last.sampled_at === s.sampledAt &&
      last.total_input_tokens === s.totalInputTokens &&
      last.total_output_tokens === s.totalOutputTokens &&
      last.used_percentage === s.usedPercentage &&
      (!cost || ((last.native_session_id ?? null) === nativeSessionId && (last.client_cost_estimate_usd ?? null) === estimate))
    ) {
      return false;
    }
    this.db
      .prepare(
        `INSERT INTO usage_samples
           (lane, seat_session, node_id, source, sampled_at, captured_at,
            total_input_tokens, total_output_tokens, used_percentage${cost ? ", native_session_id, client_cost_estimate_usd" : ""})
         VALUES ('context', ?, ?, ?, ?, ?, ?, ?, ?${cost ? ", ?, ?" : ""})`,
      )
      .run(
        s.seatSession,
        s.nodeId,
        s.source,
        s.sampledAt,
        capturedAt,
        s.totalInputTokens,
        s.totalOutputTokens,
        s.usedPercentage,
        ...(cost ? [nativeSessionId, estimate] : []),
      );
    return true;
  }

  /** Append the provider-window sample IFF it advanced past the seat's latest row for that window. */
  appendProviderWindowSample(s: ProviderWindowSampleInput, capturedAt: string): boolean {
    const last = this.db
      .prepare(
        `SELECT sampled_at, window_used_percent, resets_at
         FROM usage_samples
         WHERE lane = 'provider_window' AND seat_session = ? AND window = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(s.seatSession, s.window) as LastWindowRow | undefined;
    if (
      last &&
      last.sampled_at === s.asOf &&
      last.window_used_percent === s.usedPercent &&
      last.resets_at === s.resetsAt
    ) {
      return false;
    }
    this.db
      .prepare(
        `INSERT INTO usage_samples
           (lane, seat_session, source, sampled_at, captured_at,
            window, window_used_percent, resets_at)
         VALUES ('provider_window', ?, 'claude_statusline_json', ?, ?, ?, ?, ?)`,
      )
      .run(s.seatSession, s.asOf, capturedAt, s.window, s.usedPercent, s.resetsAt);
    return true;
  }
}

/** Map the read model's statusline signals to window-sample inputs. Only the two
 *  normalized subscription windows ride the series; rows without a seat identity
 *  or an asOf stamp are skipped (nothing is fabricated — the Option-A bar). */
export function providerWindowSamplesFromSignals(signals: ProviderSignal[]): ProviderWindowSampleInput[] {
  const out: ProviderWindowSampleInput[] = [];
  for (const sig of signals) {
    if (!sig.seatSession || !sig.asOf) continue;
    // SignalWindow admits provider-native strings; only the two normalized
    // windows ride the series (an explicit re-literal narrows the open union).
    const window = sig.window === "five_hour" ? "five_hour" : sig.window === "weekly" ? "weekly" : null;
    if (!window) continue;
    out.push({
      seatSession: sig.seatSession,
      window,
      usedPercent: typeof sig.usedPercent === "number" ? sig.usedPercent : null,
      resetsAt: sig.resetsAt ?? null,
      asOf: sig.asOf,
    });
  }
  return out;
}
