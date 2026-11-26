// The live context health source (health-detectors.ts) reads every live seat's last 24 h of context samples on each
// GET /api/health, and an open TUI asks for that every 15 s. Reading the whole window each time is one table row per
// sample, synchronously on the daemon's loop: with a couple of hundred live seats, about 80k rows per call. This keeps
// each live seat's window between reads and asks the database only what changed: one index-only count and newest id
// over the window, then just the rows added since. Anything it can't account for takes the original read.
//
// It's exact because of how usage_samples is written (usage-samples-store.ts): rows are only appended, with AUTOINCREMENT
// committed ids that are never reused, or deleted by retention and erasure. A deleted row leaves the kept rows outnumbering the
// window's count, which forces the original read. A row rewritten in place would keep its id and the count, and this
// would keep serving its old values, so a writer that rewrites samples must change this reader too.
import type Database from "better-sqlite3";
import { queryUsageSeries, type UsageSeriesRow } from "./usage-series.js";

/** The page the live source asks queryUsageSeries for. A larger window takes the original read. */
export const CONTEXT_SAMPLE_LIMIT = 10_000;
/** A bound as toISOString writes it, the only kind the live source passes. usage-series.ts' capturedAtBound returns
 *  such a bound unchanged, so this memo's plain `captured_at >= ?` selects what the original read selects. */
const CANONICAL_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** Plain ASCII, where JavaScript's string order is SQLite's: only such captured_at values are kept. */
const PLAIN_TEXT = /^[\x20-\x7e]*$/;

/** The fields the live source reads from a sample, plus the two that order them. */
export type ContextSample = Pick<UsageSeriesRow, "id" | "nodeId" | "sampledAt" | "capturedAt" | "usedPercentage">;

interface SeatWindow { bound: string; rows: ContextSample[]; maxId: number | null }

export class ContextSampleMemo {
  private statements: { window: Database.Statement; added: Database.Statement } | null = null;
  private readonly windows = new Map<string, SeatWindow>();
  private seen = new Set<string>();

  constructor(private readonly db: Database.Database) {}

  /** Start a pass over the live seats: a seat this pass doesn't read is dropped at its end. */
  startPass(): void {
    this.seen = new Set();
  }

  /** End a pass: keep only the seats it read (the live ones). */
  endPass(): void {
    for (const seat of this.windows.keys()) if (!this.seen.has(seat)) this.windows.delete(seat);
  }

  /** The rows `queryUsageSeries(db, { seatSession, lane: "context", sinceIso: startedAt, limit: CONTEXT_SAMPLE_LIMIT })`
   *  returns, in its order (captured_at, then id), with the fields the live source reads. The array is new, but a
   *  memo hit returns the kept row objects themselves: don't mutate them, or later reads answer with the changed values. */
  read(seatSession: string, startedAt: string): ContextSample[] {
    this.seen.add(seatSession);
    const original = (): ContextSample[] =>
      queryUsageSeries(this.db, { seatSession, lane: "context", sinceIso: startedAt, limit: CONTEXT_SAMPLE_LIMIT });
    // An empty filter means all seats to queryUsageSeries, not one empty-named seat. Transactional reads can observe
    // rows whose ids are reused after rollback, so only committed, named-seat windows are kept between reads.
    if (!seatSession || !CANONICAL_INSTANT.test(startedAt) || this.db.inTransaction) return original();
    let counted: { n: number; maxId: number | null };
    try {
      const statements = this.prepared();
      counted = statements.window.get(seatSession, startedAt) as { n: number; maxId: number | null };
      const cached = this.windows.get(seatSession);
      // A window that moved back may hold rows this one never read: that takes the original read.
      if (cached && counted.n <= CONTEXT_SAMPLE_LIMIT && startedAt >= cached.bound) {
        let first = 0;
        while (first < cached.rows.length && cached.rows[first]!.capturedAt < startedAt) first += 1;
        const kept = cached.rows.slice(first);
        let rows: ContextSample[] | null = null;
        if (counted.maxId === cached.maxId) {
          rows = kept;
        } else if (counted.maxId !== null && (cached.maxId === null || counted.maxId > cached.maxId)) {
          const added = statements.added.all(seatSession, startedAt, cached.maxId ?? -1) as ContextSample[];
          if (memoable(added)) rows = merge(kept, added);
        }
        // Equal counts mean nothing kept was deleted: appends only ever add higher ids.
        if (rows && rows.length === counted.n) {
          this.windows.set(seatSession, { bound: startedAt, rows, maxId: counted.maxId });
          return rows.slice();
        }
      }
    } catch {
      this.windows.delete(seatSession);
      return original();
    }
    const full = original();
    try {
      const newest = full.reduce<number | null>((max, row) => (max === null || row.id > max ? row.id : max), null);
      if (counted.n <= CONTEXT_SAMPLE_LIMIT && full.length === counted.n && newest === counted.maxId && memoable(full)) {
        this.windows.set(seatSession, { bound: startedAt, maxId: counted.maxId, rows: full.map((row) =>
          ({ id: row.id, nodeId: row.nodeId, sampledAt: row.sampledAt, capturedAt: row.capturedAt, usedPercentage: row.usedPercentage })) });
      } else {
        this.windows.delete(seatSession);
      }
    } catch {
      this.windows.delete(seatSession);
    }
    return full;
  }

  private prepared(): { window: Database.Statement; added: Database.Statement } {
    this.statements ??= {
      // Both use idx_usage_samples_seat_time (seat_session, lane, captured_at); the count reads the index only.
      window: this.db.prepare(`SELECT COUNT(*) AS n, MAX(id) AS maxId FROM usage_samples
        WHERE seat_session = ? AND lane = 'context' AND captured_at >= ?`),
      added: this.db.prepare(`SELECT id, node_id AS nodeId, sampled_at AS sampledAt, captured_at AS capturedAt,
          used_percentage AS usedPercentage
        FROM usage_samples WHERE seat_session = ? AND lane = 'context' AND captured_at >= ? AND id > ?
        ORDER BY captured_at ASC, id ASC`),
    };
    return this.statements;
  }
}

function memoable(rows: readonly ContextSample[]): boolean {
  return rows.every((row) => typeof row.capturedAt === "string" && PLAIN_TEXT.test(row.capturedAt) && Number.isSafeInteger(row.id));
}

function before(a: ContextSample, b: ContextSample): boolean {
  return a.capturedAt < b.capturedAt || (a.capturedAt === b.capturedAt && a.id < b.id);
}

function merge(kept: readonly ContextSample[], added: readonly ContextSample[]): ContextSample[] {
  const merged: ContextSample[] = [];
  let i = 0, j = 0;
  while (i < kept.length && j < added.length) merged.push(before(added[j]!, kept[i]!) ? added[j++]! : kept[i++]!);
  while (i < kept.length) merged.push(kept[i++]!);
  while (j < added.length) merged.push(added[j++]!);
  return merged;
}
