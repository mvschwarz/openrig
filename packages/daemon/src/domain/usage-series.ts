// 51-08 A3 — the over-time query + top-N burn projection over usage_samples.
//
// ONE projection serves the HTTP route and the CLI (PM decisions 3+4): the rig
// serves FACTS — raw rows, token deltas, per-window velocities, sample spans —
// and the detector/edge owns thresholds and judgments (serve the fact, derive
// at the edge; no fifth copy of tier constants).
//
// HONESTY RAILS (contract item 5): a seat without enough in-window samples is
// an explicit `unknown` entry with its reason — never a fabricated zero row. A
// totals reset (session restart) never produces negative burn: consecutive
// POSITIVE deltas sum; resets are counted and reported as a fact.
//
// OPTION-A BAR: rows carry seat/node identity only; no account field exists in
// any served shape.
import type { Database } from "better-sqlite3";
import { hasClientCostColumns } from "./usage-samples-store.js";
import { hasPiUsageChargesTable, hasPiUsageEntriesTable } from "./pi-usage-entries-store.js";
import { openRouterChargeTarget } from "./openrouter-charge.js";
import { sameReset } from "./provider/usage-windows.js";

export interface UsageSeriesQuery {
  seatSession?: string;
  lane?: "context" | "provider_window";
  sinceIso?: string;
  untilIso?: string;
  limit?: number;
}

export interface UsageSeriesRow {
  id: number;
  lane: string;
  seatSession: string;
  nodeId: string | null;
  source: string | null;
  sampledAt: string | null;
  capturedAt: string;
  totalInputTokens: number | null;
  totalOutputTokens: number | null;
  usedPercentage: number | null;
  window: string | null;
  windowUsedPercent: number | null;
  resetsAt: string | null;
  /** Present once the cost columns exist: the sample's native session and Claude's cost estimate for it (history). */
  nativeSessionId?: string | null;
  clientCostEstimateUsd?: number | null;
}

/** Captures are stored at millisecond precision in UTC. Keep the indexed column
 * comparison, but compare an ISO cutoff's instant rather than its offset/spelling.
 * Both >= and < use the next stored instant for a sub-millisecond boundary. */
function capturedAtBound(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return value;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const local = new Date(0);
  local.setUTCFullYear(year!, month! - 1, day!);
  local.setUTCHours(hour!, minute!, second!, 0);
  if (local.getUTCFullYear() !== year || local.getUTCMonth() + 1 !== month ||
    local.getUTCDate() !== day || local.getUTCHours() !== hour ||
    local.getUTCMinutes() !== minute || local.getUTCSeconds() !== second) return value;
  const epoch = Date.parse(value);
  const betweenMilliseconds = /[1-9]/.test(match[7]?.slice(3) ?? "");
  const bound = epoch + (betweenMilliseconds ? 1 : 0);
  return Number.isFinite(bound) && Math.abs(bound) <= 8.64e15 ? new Date(bound).toISOString() : value;
}

/** Serve the RAW stored rows, oldest first. Bounds are absolute on captured_at
 *  (since inclusive-of-later, i.e. `>=`; until exclusive `<`). */
export function queryUsageSeries(db: Database, q: UsageSeriesQuery): UsageSeriesRow[] {
  return readUsageSeries(db, q, false);
}

/** Complete internal projections must not inherit the public raw-row page cap. */
function readUsageSeries(db: Database, q: UsageSeriesQuery, complete: boolean): UsageSeriesRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.seatSession) { where.push("seat_session = ?"); params.push(q.seatSession); }
  if (q.lane) { where.push("lane = ?"); params.push(q.lane); }
  if (q.sinceIso) { where.push("captured_at >= ?"); params.push(capturedAtBound(q.sinceIso)); }
  if (q.untilIso) { where.push("captured_at < ?"); params.push(capturedAtBound(q.untilIso)); }
  const limit = q.limit && q.limit > 0 ? Math.floor(q.limit) : 10_000;
  const withCost = hasClientCostColumns(db);
  const rows = db
    .prepare(
      `SELECT id, lane, seat_session, node_id, source, sampled_at, captured_at,
              total_input_tokens, total_output_tokens, used_percentage,
              window, window_used_percent, resets_at${withCost ? ", native_session_id, client_cost_estimate_usd" : ""}
         FROM usage_samples
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY captured_at ASC, id ASC
        ${complete ? "" : "LIMIT ?"}`,
    )
    .all(...params, ...(complete ? [] : [limit])) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as number,
    lane: r.lane as string,
    seatSession: r.seat_session as string,
    nodeId: (r.node_id as string | null) ?? null,
    source: (r.source as string | null) ?? null,
    sampledAt: (r.sampled_at as string | null) ?? null,
    capturedAt: r.captured_at as string,
    totalInputTokens: (r.total_input_tokens as number | null) ?? null,
    totalOutputTokens: (r.total_output_tokens as number | null) ?? null,
    usedPercentage: (r.used_percentage as number | null) ?? null,
    window: (r.window as string | null) ?? null,
    windowUsedPercent: (r.window_used_percent as number | null) ?? null,
    resetsAt: (r.resets_at as string | null) ?? null,
    ...(withCost ? { nativeSessionId: (r.native_session_id as string | null) ?? null,
      clientCostEstimateUsd: (r.client_cost_estimate_usd as number | null) ?? null } : {}),
  }));
}

export interface TopBurnQuery {
  windowHours: number;
  nowIso: string;
  topN?: number;
}

export interface WindowVelocity {
  window: string;
  /** the burn span's first reading, which may belong to an earlier window than the rate */
  usedPercentFirst: number | null;
  usedPercentLast: number | null;
  /** percent-points per hour within the latest reading's window (readings sharing its resets_at);
   *  null when that window has fewer than two readings or is otherwise unmeasurable */
  percentPerHour: number | null;
  resetsAt: string | null;
}

export interface SeatBurn {
  seatSession: string;
  /** summed POSITIVE consecutive token deltas over the actual sample span, per hour */
  tokensPerHour: number;
  /** total positive token delta inside the window */
  tokensDelta: number;
  /** count of negative total-token transitions within a counter history inside the window */
  resets: number;
  /** actual span between first and last in-window context sample, hours */
  spanHours: number;
  samples: number;
  windows: WindowVelocity[];
}

export interface UnknownSeat {
  seatSession: string;
  reason: "no_fresh_samples" | "insufficient_samples";
}

export interface TopBurnResult {
  windowHours: number;
  sinceIso: string;
  ranked: SeatBurn[];
  unknown: UnknownSeat[];
  /** total seats that ranked BEFORE the topN cap — truncation is never silent */
  totalRankedSeats: number;
}

function hoursBetween(aIso: string, bIso: string): number {
  return (new Date(bIso).getTime() - new Date(aIso).getTime()) / 3_600_000;
}

/** The money question: top-N seats by token burn over the last H hours. */
export function computeTopBurn(db: Database, q: TopBurnQuery): TopBurnResult {
  const nowMs = new Date(q.nowIso).getTime();
  const sinceIso = new Date(nowMs - q.windowHours * 3_600_000).toISOString();
  // Stored captures use millisecond ISO timestamps; retain the exact endpoint.
  const untilIso = new Date(nowMs + 1).toISOString();

  const seats = (
    db.prepare(`SELECT DISTINCT seat_session AS s FROM usage_samples`).all() as Array<{ s: string }>
  ).map((r) => r.s);

  const ranked: SeatBurn[] = [];
  const unknown: UnknownSeat[] = [];

  for (const seat of seats) {
    const rawContext = readUsageSeries(db, { seatSession: seat, lane: "context", sinceIso, untilIso }, true);
    if (rawContext.length === 0) {
      // history exists (the seat appeared in the census) but nothing fresh
      unknown.push({ seatSession: seat, reason: "no_fresh_samples" });
      continue;
    }
    // Missing counters are unknown observations, not a restart to zero.
    const ctx = rawContext.filter((row): row is UsageSeriesRow & {
      totalInputTokens: number; totalOutputTokens: number;
    } => Number.isFinite(row.totalInputTokens) && Number.isFinite(row.totalOutputTokens));
    if (ctx.length < 2) {
      unknown.push({ seatSession: seat, reason: "insufficient_samples" });
      continue;
    }
    let tokensDelta = 0;
    let resets = 0;
    // A node can launch another native session or switch runtimes. Counters
    // only describe movement within that history; crossing baselines invents burn.
    const previousByHistory = new Map<string, number>();
    let pairs = 0;
    for (const row of ctx) {
      const cur = row.totalInputTokens + row.totalOutputTokens;
      const history = JSON.stringify([row.nodeId, row.source, row.nativeSessionId ?? null]);
      const prev = previousByHistory.get(history);
      if (prev !== undefined) {
        pairs += 1;
        const delta = cur - prev;
        if (delta >= 0) tokensDelta += delta;
        else resets += 1; // a restart dropped the totals — never negative burn
      }
      previousByHistory.set(history, cur);
    }
    if (pairs === 0) {
      unknown.push({ seatSession: seat, reason: "insufficient_samples" });
      continue;
    }
    const spanHours = hoursBetween(ctx[0]!.capturedAt, ctx[ctx.length - 1]!.capturedAt);
    const tokensPerHour = spanHours > 0 ? tokensDelta / spanHours : 0;

    const windows: WindowVelocity[] = [];
    const providerRows = readUsageSeries(db, { seatSession: seat, lane: "provider_window", sinceIso, untilIso }, true);
    for (const w of ["five_hour", "weekly"] as const) {
      const rows = providerRows.filter(
        (r) => r.window === w,
      );
      if (rows.length === 0) continue;
      const first = rows[0]!;
      const last = rows[rows.length - 1]!;
      // Rate only the window the latest reading belongs to: readings across a reset describe
      // different windows. Within it, a falling percentage still means an unseen reset (or
      // readings without resets_at), so like a token reset it yields no velocity, never a negative one.
      const current = rows.filter((r) => sameReset(r.resetsAt, last.resetsAt));
      const windowFirst = current[0]!;
      const wSpan = hoursBetween(windowFirst.capturedAt, last.capturedAt);
      const measurable =
        current.length >= 2 && wSpan > 0 && windowFirst.windowUsedPercent !== null && last.windowUsedPercent !== null
        && last.windowUsedPercent >= windowFirst.windowUsedPercent;
      windows.push({
        window: w,
        usedPercentFirst: first.windowUsedPercent,
        usedPercentLast: last.windowUsedPercent,
        percentPerHour: measurable ? (last.windowUsedPercent! - windowFirst.windowUsedPercent!) / wSpan : null,
        resetsAt: last.resetsAt,
      });
    }

    ranked.push({ seatSession: seat, tokensPerHour, tokensDelta, resets, spanHours, samples: ctx.length, windows });
  }

  ranked.sort((a, b) => b.tokensPerHour - a.tokensPerHour);
  const totalRankedSeats = ranked.length;
  const capped = q.topN && q.topN > 0 ? ranked.slice(0, q.topN) : ranked;
  return { windowHours: q.windowHours, sinceIso, ranked: capped, unknown, totalRankedSeats };
}

// ---------------------------------------------------------------------------
// OPR.0.7.0.2 (cost reporting, first atom): what each seat's harness reports about cost, beside its tokens.
// Read from the context lane only. Every figure names its kind, source, window and coverage; a missing figure
// is reported as missing and an old one as stale, never as zero. Nothing here is an invoice, and no
// subscription window is ever turned into dollars.

/** A Claude estimate older than this reads stale (it stays shown, as history). Matches context freshness. */
export const COST_STALE_AFTER_MS = 10 * 60_000;

export const CODEX_NO_COST_NOTE = "no cost reported by the inspected method (Codex token_count events carry tokens only)";

export type SeatCost =
  | {
      seatSession: string;
      runtime: "claude-code";
      status: "reported";
      kind: "client-side estimate";
      source: "Claude statusline cost.total_cost_usd";
      costUsd: number;
      /** The estimate is cumulative for one native Claude session, since its last reset. */
      window: { nativeSessionId: string; since: string; asOf: string };
      coverage: string;
      resets: number;
      stale: boolean;
      ageSeconds: number | null;
      tokens: { input: number | null; output: number | null };
    }
  | {
      seatSession: string;
      runtime: "claude-code";
      status: "absent";
      reason: string;
      window: { nativeSessionId: string | null; asOf: string | null };
      tokens: { input: number | null; output: number | null };
    }
  | {
      seatSession: string;
      runtime: "codex";
      status: "no-cost-method";
      note: string;
      window: { nativeSessionId: string | null; asOf: string | null };
      tokens: { input: number | null; output: number | null };
    }
  | PiSeatCost
  | { seatSession: string; runtime: null; status: "unknown"; reason: string };

/** OPR.0.7.0.2 (Pi atom): a Pi seat's model-priced estimate from its persisted entries. */
export type PiSeatCost = {
  seatSession: string;
  runtime: "pi";
  status: "reported" | "absent";
  kind: "model-priced estimate";
  source: "Pi persisted session entries (usage.cost.total)";
  /** The occupant's own entries in this Pi session that carried a cost, summed; absent when none did. */
  costUsd?: number;
  reason?: string;
  window: { piSessionId: string; since: string | null; asOf: string | null };
  coverage: string;
  /** Own entries by kind (all the usage-bearing kinds Pi records). */
  kinds: Record<"assistant" | "usage" | "tool_result" | "compaction" | "branch_summary", number>;
  entries: {
    own: number;
    /** Own entries Pi recorded without a cost: not counted as zero, and named. */
    ownWithoutCost: number;
    /** Own assistant entries that ended in an error or abort; their reported usage is included. */
    errorOrAborted: number;
    /** Entries a fork or branch copied in from the parent session: history, not this occupant's spend. */
    inherited: { count: number; costUsd: number | null };
    /** Entries whose origin couldn't be told (the session header wasn't readable): kept apart from the total. */
    unknownOrigin: { count: number; costUsd: number | null };
  };
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  /** OPR.0.7.0.2 K4: OpenRouter's actual charge for this session's own requests, BESIDE the estimate (never added
   *  to it). Present once the store can hold charges. */
  providerCharge?: PiProviderChargeView;
};

export type PiProviderChargeView = {
  kind: "provider charge";
  source: "OpenRouter GET /api/v1/generation (data.total_cost, USD)";
  /** What the lookup covers and the case it can't observe. */
  coverage: string;
  /** reported: every covered request charged; partial: some; pending: lookups not finished; unavailable: none
   *  could be charged; none: no lookups recorded; not-applicable: no OpenRouter requests in this session. */
  status: "reported" | "partial" | "pending" | "unavailable" | "none" | "not-applicable";
  /** The charged requests' total, in USD; absent when none is charged. */
  costUsd?: number;
  /** Pi's estimate for exactly the charged requests, to read beside costUsd. */
  estimateForChargedUsd?: number | null;
  requests: {
    openRouter: number;
    covered: number;
    charged: number;
    pending: number;
    unavailable: { count: number; reasons: Record<string, number> };
    notCovered: { count: number; reasons: Record<string, number> };
  };
  /** Who was charged, as far as the lookups establish it: the generating credential's name (never a value) and
   *  the workspace(s) OpenRouter attributed the generations to. */
  accountContext: { credentialSources: string[]; workspaceIds: string[]; byokRequests: number };
};

export const PI_COST_COVERAGE_WITH_CHARGE = "this Pi session's own persisted entries of every usage-bearing kind Pi records (assistant, usage, tool result, compaction, branch summary), each counted once; a model-priced estimate from catalog rates, not a provider charge (OpenRouter's actual charge, where established, is in providerCharge beside it, never added)";

export const PI_PROVIDER_CHARGE_COVERAGE = "OpenRouter requests Pi made through its openai-completions API with a recorded generation id, looked up with the key OpenRig forwarded only when the runner's observations before and after the request show that key as Pi's credential and no extension, credential-bearing models.json OpenRouter entry or unclassifiable credential source, and none has been seen, nor any reading failed, in the runner's life (models.json is read as Pi reads it, comments included). Conservatively excluded too: any settings.json package entry, and an explicit models.json apiKey even when it names OPENROUTER_API_KEY. Anthropic-messages requests, other credentials, inherited and unknown-origin entries are not looked up. Not observable: a credential Pi loads and drops between two of the runner's observations (an extension, a models.json entry, or a stored key added and removed within one gap), including runtime effects Pi keeps after it; Pi records no per-request credential";

export const PI_COST_COVERAGE = "this Pi session's own persisted entries of every usage-bearing kind Pi records (assistant, usage, tool result, compaction, branch summary), each counted once; a model-priced estimate from catalog rates, not a provider charge (an OpenRouter actual charge isn't correlated here)";

export interface CostViewResult {
  seats: SeatCost[];
  note: string;
}

interface CostRow {
  id: number;
  seat_session: string;
  source: string | null;
  sampled_at: string | null;
  captured_at: string;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  native_session_id: string | null;
  client_cost_estimate_usd: number | null;
}

export function computeCostView(db: Database, q: { nowIso: string; seatSession?: string; staleAfterMs?: number }): CostViewResult {
  const note = "Costs are what each harness reports: a client-side estimate is not an invoice, and no subscription window is shown in dollars.";
  const withCost = hasClientCostColumns(db);
  const rows = db.prepare(
    `SELECT id, seat_session, source, sampled_at, captured_at, total_input_tokens, total_output_tokens,
            ${withCost ? "native_session_id, client_cost_estimate_usd" : "NULL AS native_session_id, NULL AS client_cost_estimate_usd"}
       FROM usage_samples
      WHERE lane = 'context'${q.seatSession ? " AND seat_session = ?" : ""}
      ORDER BY seat_session ASC, id ASC`,
  ).all(...(q.seatSession ? [q.seatSession] : [])) as CostRow[];
  const bySeat = new Map<string, CostRow[]>();
  for (const row of rows) bySeat.set(row.seat_session, [...(bySeat.get(row.seat_session) ?? []), row]);
  const now = Date.parse(q.nowIso);
  const staleAfter = q.staleAfterMs ?? COST_STALE_AFTER_MS;
  const seats: SeatCost[] = [];
  for (const [seatSession, seatRows] of bySeat) {
    const latest = seatRows[seatRows.length - 1]!;
    const tokens = { input: latest.total_input_tokens, output: latest.total_output_tokens };
    const asOf = latest.sampled_at ?? latest.captured_at;
    if (latest.source === "codex_token_count_jsonl") {
      seats.push({ seatSession, runtime: "codex", status: "no-cost-method", note: CODEX_NO_COST_NOTE,
        window: { nativeSessionId: latest.native_session_id, asOf }, tokens });
      continue;
    }
    if (latest.source !== "claude_statusline_json") {
      seats.push({ seatSession, runtime: null, status: "unknown", reason: `samples from source ${latest.source ?? "(none)"} carry no cost` });
      continue;
    }
    // The latest native session's estimates, in order. A drop within the session is a reset: the window restarts.
    const session = latest.native_session_id;
    const estimates = session ? seatRows.filter((r) => r.native_session_id === session && r.client_cost_estimate_usd !== null) : [];
    if (estimates.length === 0) {
      seats.push({ seatSession, runtime: "claude-code", status: "absent",
        reason: !withCost ? "this daemon's usage series has no cost columns yet"
          : !session ? "the latest sample names no native session"
          : "Claude's statusline has reported no cost for this session",
        window: { nativeSessionId: session, asOf }, tokens });
      continue;
    }
    let resets = 0;
    let since = estimates[0]!.sampled_at ?? estimates[0]!.captured_at;
    for (let i = 1; i < estimates.length; i += 1) {
      if (estimates[i]!.client_cost_estimate_usd! < estimates[i - 1]!.client_cost_estimate_usd!) {
        resets += 1;
        since = estimates[i]!.sampled_at ?? estimates[i]!.captured_at;
      }
    }
    const last = estimates[estimates.length - 1]!;
    const lastAt = last.sampled_at ?? last.captured_at;
    const age = Number.isNaN(now) || Number.isNaN(Date.parse(lastAt)) ? null : Math.max(0, Math.round((now - Date.parse(lastAt)) / 1000));
    seats.push({
      seatSession, runtime: "claude-code", status: "reported", kind: "client-side estimate", source: "Claude statusline cost.total_cost_usd",
      costUsd: last.client_cost_estimate_usd!,
      window: { nativeSessionId: session!, since, asOf: lastAt },
      coverage: "this native Claude session since its last reset, as Claude's client estimates it; not an invoice, and not the seat's other sessions",
      resets, stale: age === null ? true : age * 1000 > staleAfter, ageSeconds: age,
      tokens: { input: last.total_input_tokens, output: last.total_output_tokens },
    });
  }
  for (const pi of piSeatCosts(db, q.seatSession)) {
    const at = seats.findIndex((seat) => seat.seatSession === pi.seatSession);
    if (at >= 0) seats[at] = pi; else seats.push(pi);
  }
  return { seats, note };
}

function hasChargeOutcome(db: Database, piSession: string): boolean {
  return !!db.prepare("SELECT 1 FROM pi_usage_charges WHERE pi_session_id = ? LIMIT 1").get(piSession);
}

/** OpenRouter's charge for one seat's Pi session: own assistant requests only, charged ones summed apart from
 *  the estimate, every other request counted with its reason. */
function providerChargeView(db: Database, seat: string, piSession: string): PiProviderChargeView {
  const rows = db.prepare(
    `SELECT e.kind, e.provider, e.api, e.response_id, e.cost_total, c.status, c.total_cost_usd, c.reason,
            c.credential_source, c.workspace_id, c.is_byok, c.generation_id
       FROM pi_usage_entries e
       LEFT JOIN pi_usage_charges c ON c.pi_session_id = e.pi_session_id AND c.entry_id = e.entry_id
      WHERE e.seat_session = ? AND e.pi_session_id = ? AND e.origin = 'own' AND e.kind = 'assistant' AND e.provider = 'openrouter'`,
  ).all(seat, piSession) as Array<{ kind: string; provider: string | null; api: string | null; response_id: string | null;
    cost_total: number | null; status: "charged" | "unavailable" | null; total_cost_usd: number | null; reason: string | null;
    credential_source: string | null; workspace_id: string | null; is_byok: number | null; generation_id: string | null }>;
  const tally = (into: Record<string, number>, key: string) => { into[key] = (into[key] ?? 0) + 1; };
  const notCovered: Record<string, number> = {};
  const unavailable: Record<string, number> = {};
  const covered = rows.filter((row) => {
    const target = openRouterChargeTarget({ kind: row.kind, provider: row.provider, api: row.api, responseId: row.response_id });
    if ("notCovered" in target) tally(notCovered, target.notCovered);
    return "generationId" in target;
  });
  const charged = covered.filter((row) => row.status === "charged" && row.generation_id === row.response_id);
  for (const row of covered) if (row.status === "unavailable") tally(unavailable, row.reason ?? "unavailable");
  const unavailableCount = covered.filter((row) => row.status === "unavailable").length;
  const pending = covered.length - charged.length - unavailableCount;
  const looked = covered.some((row) => row.status !== null);
  const status: PiProviderChargeView["status"] = rows.length === 0 ? "not-applicable"
    : charged.length > 0 && charged.length === covered.length ? "reported"
    : charged.length > 0 ? "partial"
    : !looked ? "none"
    : pending > 0 ? "pending" : "unavailable";
  const priced = charged.filter((row) => row.cost_total !== null);
  const distinct = (values: Array<string | null>) => [...new Set(values.filter((v): v is string => !!v))].sort();
  return {
    kind: "provider charge",
    source: "OpenRouter GET /api/v1/generation (data.total_cost, USD)",
    coverage: PI_PROVIDER_CHARGE_COVERAGE,
    status,
    ...(charged.length > 0 ? {
      costUsd: charged.reduce((t, row) => t + row.total_cost_usd!, 0),
      estimateForChargedUsd: priced.length === charged.length ? priced.reduce((t, row) => t + row.cost_total!, 0) : null,
    } : {}),
    requests: {
      openRouter: rows.length, covered: covered.length, charged: charged.length, pending,
      unavailable: { count: unavailableCount, reasons: unavailable },
      notCovered: { count: rows.length - covered.length, reasons: notCovered },
    },
    accountContext: {
      credentialSources: distinct(covered.map((row) => row.credential_source)),
      workspaceIds: distinct(charged.map((row) => row.workspace_id)),
      byokRequests: charged.filter((row) => row.is_byok === 1).length,
    },
  };
}

interface PiRow {
  id: number; seat_session: string; pi_session_id: string; entry_timestamp: string; kind: PiSeatCost["kinds"] extends Record<infer K, number> ? K : never;
  input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; cost_total: number | null;
  stop_reason: string | null; origin: "own" | "inherited" | "unknown";
}

/** Each Pi seat's latest Pi session: the one whose facts first arrived most recently (a late entry for an older
 *  session doesn't make it current again). Earlier sessions stay stored as history. */
function piSeatCosts(db: Database, seatSession?: string): PiSeatCost[] {
  if (!hasPiUsageEntriesTable(db)) return [];
  const latest = db.prepare(
    `WITH s AS (SELECT seat_session, pi_session_id, MIN(id) AS first_id FROM pi_usage_entries
                ${seatSession ? "WHERE seat_session = ? " : ""}GROUP BY seat_session, pi_session_id)
     SELECT seat_session, pi_session_id FROM s
      WHERE first_id = (SELECT MAX(first_id) FROM s s2 WHERE s2.seat_session = s.seat_session)
      ORDER BY seat_session ASC`,
  ).all(...(seatSession ? [seatSession] : [])) as Array<{ seat_session: string; pi_session_id: string }>;
  const sum = (rows: PiRow[]): number | null => {
    const priced = rows.filter((r) => r.cost_total !== null);
    return priced.length ? priced.reduce((total, r) => total + r.cost_total!, 0) : null;
  };
  return latest.map(({ seat_session: seat, pi_session_id: piSession }) => {
    const rows = db.prepare(
      `SELECT id, seat_session, pi_session_id, entry_timestamp, kind, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
              cost_total, stop_reason, origin
         FROM pi_usage_entries WHERE seat_session = ? AND pi_session_id = ? ORDER BY entry_timestamp ASC, id ASC`,
    ).all(seat, piSession) as PiRow[];
    const own = rows.filter((r) => r.origin === "own");
    const charged = hasPiUsageChargesTable(db) && hasChargeOutcome(db, piSession);
    const inherited = rows.filter((r) => r.origin === "inherited");
    const unknown = rows.filter((r) => r.origin === "unknown");
    const kinds = { assistant: 0, usage: 0, tool_result: 0, compaction: 0, branch_summary: 0 };
    for (const r of own) kinds[r.kind] += 1;
    const ownCost = sum(own);
    return {
      seatSession: seat, runtime: "pi" as const,
      status: ownCost === null ? "absent" as const : "reported" as const,
      kind: "model-priced estimate" as const, source: "Pi persisted session entries (usage.cost.total)" as const,
      ...(ownCost === null
        ? { reason: own.length === 0 ? "no own entries with usage are stored for this Pi session yet" : "Pi recorded no cost on this session's own entries" }
        : { costUsd: ownCost }),
      window: { piSessionId: piSession, since: own[0]?.entry_timestamp ?? null, asOf: own.at(-1)?.entry_timestamp ?? null },
      coverage: charged ? PI_COST_COVERAGE_WITH_CHARGE : PI_COST_COVERAGE,
      kinds,
      entries: {
        own: own.length,
        ownWithoutCost: own.filter((r) => r.cost_total === null).length,
        errorOrAborted: own.filter((r) => r.kind === "assistant" && (r.stop_reason === "error" || r.stop_reason === "aborted")).length,
        inherited: { count: inherited.length, costUsd: sum(inherited) },
        unknownOrigin: { count: unknown.length, costUsd: sum(unknown) },
      },
      tokens: {
        input: own.reduce((t, r) => t + r.input_tokens, 0), output: own.reduce((t, r) => t + r.output_tokens, 0),
        cacheRead: own.reduce((t, r) => t + r.cache_read_tokens, 0), cacheWrite: own.reduce((t, r) => t + r.cache_write_tokens, 0),
      },
      // Only once this session has a charge outcome, so with the charge lookup off the view is unchanged.
      ...(charged ? { providerCharge: providerChargeView(db, seat, piSession) } : {}),
    };
  });
}
