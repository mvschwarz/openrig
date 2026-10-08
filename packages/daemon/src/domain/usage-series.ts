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
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.seatSession) { where.push("seat_session = ?"); params.push(q.seatSession); }
  if (q.lane) { where.push("lane = ?"); params.push(q.lane); }
  if (q.sinceIso) { where.push("captured_at >= ?"); params.push(capturedAtBound(q.sinceIso)); }
  if (q.untilIso) { where.push("captured_at < ?"); params.push(capturedAtBound(q.untilIso)); }
  const limit = q.limit && q.limit > 0 ? Math.floor(q.limit) : 10_000;
  const rows = db
    .prepare(
      `SELECT id, lane, seat_session, node_id, source, sampled_at, captured_at,
              total_input_tokens, total_output_tokens, used_percentage,
              window, window_used_percent, resets_at
         FROM usage_samples
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY captured_at ASC, id ASC
        LIMIT ?`,
    )
    .all(...params, limit) as Array<Record<string, unknown>>;
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
  }));
}

export interface TopBurnQuery {
  windowHours: number;
  nowIso: string;
  topN?: number;
}

export interface WindowVelocity {
  window: string;
  usedPercentFirst: number | null;
  usedPercentLast: number | null;
  /** percent-points per hour over the actual sample span; null when unmeasurable */
  percentPerHour: number | null;
  resetsAt: string | null;
}

export interface SeatBurn {
  seatSession: string;
  /** summed POSITIVE consecutive token deltas over the actual sample span, per hour */
  tokensPerHour: number;
  /** total positive token delta inside the window */
  tokensDelta: number;
  /** count of negative total-token transitions (session restarts) inside the window */
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
    const rawContext = queryUsageSeries(db, { seatSession: seat, lane: "context", sinceIso, untilIso });
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
    // A seat name can be reused by a later rig. Cumulative counters only
    // describe movement within one node; crossing node baselines invents burn.
    const previousByNode = new Map<string | null, number>();
    let pairs = 0;
    for (const row of ctx) {
      const cur = row.totalInputTokens + row.totalOutputTokens;
      const prev = previousByNode.get(row.nodeId);
      if (prev !== undefined) {
        pairs += 1;
        const delta = cur - prev;
        if (delta >= 0) tokensDelta += delta;
        else resets += 1; // a restart dropped the totals — never negative burn
      }
      previousByNode.set(row.nodeId, cur);
    }
    if (pairs === 0) {
      unknown.push({ seatSession: seat, reason: "insufficient_samples" });
      continue;
    }
    const spanHours = hoursBetween(ctx[0]!.capturedAt, ctx[ctx.length - 1]!.capturedAt);
    const tokensPerHour = spanHours > 0 ? tokensDelta / spanHours : 0;

    const windows: WindowVelocity[] = [];
    for (const w of ["five_hour", "weekly"] as const) {
      const rows = queryUsageSeries(db, { seatSession: seat, lane: "provider_window", sinceIso, untilIso }).filter(
        (r) => r.window === w,
      );
      if (rows.length === 0) continue;
      const first = rows[0]!;
      const last = rows[rows.length - 1]!;
      const wSpan = hoursBetween(first.capturedAt, last.capturedAt);
      const measurable =
        rows.length >= 2 && wSpan > 0 && first.windowUsedPercent !== null && last.windowUsedPercent !== null;
      windows.push({
        window: w,
        usedPercentFirst: first.windowUsedPercent,
        usedPercentLast: last.windowUsedPercent,
        percentPerHour: measurable ? (last.windowUsedPercent! - first.windowUsedPercent!) / wSpan : null,
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
