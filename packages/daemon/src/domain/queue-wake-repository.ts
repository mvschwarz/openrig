import type Database from "better-sqlite3";

export type ParkWakeKind = "watchdog" | "timer" | "blocker";
export type ParkWakePhase = "armed" | "fired";

/** S16: identifies the one shared provider/account blocker whose own timer expiry
 *  is inherited by its dependent HELD rows. Ordinary blockers remain expiry-less. */
export const USAGE_LIMIT_BLOCKER_TAG = "usage-limit-blocker";
export const USAGE_LIMIT_POOL_TAG_PREFIX = "usage-limit-pool:";

/** One arithmetic for the S16 timer's projected due boundary. The scheduler
 *  enforces the same boundary after the attach leg seeds lastEvaluationAt to
 *  registeredAt. */
export function timerExpiresAt(registeredAt: string, intervalSeconds: number): string | undefined {
  const registeredAtMs = Date.parse(registeredAt);
  if (!Number.isFinite(registeredAtMs) || !Number.isFinite(intervalSeconds)) return undefined;
  return new Date(registeredAtMs + intervalSeconds * 1000).toISOString();
}

export interface QueueWakeRecord {
  transitionId: number;
  qitemId: string;
  phase: ParkWakePhase;
  kind: ParkWakeKind;
  ref: string;
  deliveryStatus: string | null;
  expiresAt?: string;
}

export interface ParkWakeStatus {
  kind: ParkWakeKind;
  ref: string;
  phase: ParkWakePhase;
  live: boolean;
  deliveryStatus: string | null;
  /** A wake fired, but the row is still HELD. The resume attempt is visible
   *  and cannot be mistaken for a healthy armed continuation. */
  unconsumed: boolean;
  /** Absolute due time derived from canonical watchdog metadata. Present only
   *  for a timer or a dependent of the sanctioned usage-limit timer blocker. */
  expiresAt?: string;
}

interface WakeRow {
  transition_id: number;
  qitem_id: string;
  phase: string;
  wake_kind: string;
  wake_ref: string;
  delivery_status: string | null;
}

/** Persistence + live-state projection for transition-bound park wakes. */
export class QueueWakeRepository {
  private readonly available: boolean;

  constructor(private readonly db: Database.Database) {
    this.available = this.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'queue_transition_wakes'",
    ).get() !== undefined;
  }

  record(input: QueueWakeRecord): void {
    if (!this.available) return;
    this.db.prepare(
      `INSERT INTO queue_transition_wakes
        (transition_id, qitem_id, phase, wake_kind, wake_ref, delivery_status)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      input.transitionId,
      input.qitemId,
      input.phase,
      input.kind,
      input.ref,
      input.deliveryStatus,
    );
  }

  getForTransition(transitionId: number): QueueWakeRecord | null {
    if (!this.available) return null;
    const row = this.db.prepare(
      "SELECT * FROM queue_transition_wakes WHERE transition_id = ?",
    ).get(transitionId) as WakeRow | undefined;
    return row ? this.row(row) : null;
  }

  getStatus(qitemId: string): ParkWakeStatus | null {
    if (!this.available) return null;
    const armed = this.db.prepare(
      `SELECT * FROM queue_transition_wakes
        WHERE qitem_id = ? AND phase = 'armed'
        ORDER BY transition_id DESC LIMIT 1`,
    ).get(qitemId) as WakeRow | undefined;
    if (!armed) return null;
    const fired = this.db.prepare(
      `SELECT * FROM queue_transition_wakes
        WHERE qitem_id = ? AND phase = 'fired' AND wake_ref = ?
          AND transition_id > ?
        ORDER BY transition_id DESC LIMIT 1`,
    ).get(qitemId, armed.wake_ref, armed.transition_id) as WakeRow | undefined;
    const state = (this.db.prepare(
      "SELECT state FROM queue_items WHERE qitem_id = ?",
    ).get(qitemId) as { state: string } | undefined)?.state;
    const kind = armed.wake_kind as ParkWakeKind;
    const expiresAt = this.wakeExpiry(qitemId, kind, armed.wake_ref);
    return {
      kind,
      ref: armed.wake_ref,
      phase: fired ? "fired" : "armed",
      live: fired ? false : this.isLive(kind, armed.wake_ref),
      deliveryStatus: fired?.delivery_status ?? null,
      unconsumed: fired !== undefined && state === "blocked",
      ...(expiresAt ? { expiresAt } : {}),
    };
  }

  findBlockedQitemsByWatchdog(jobId: string): Array<{ qitemId: string; kind: "watchdog" | "timer" }> {
    if (!this.available) return [];
    return this.db.prepare(
      `SELECT DISTINCT w.qitem_id, w.wake_kind
         FROM queue_transition_wakes w
         JOIN queue_items q ON q.qitem_id = w.qitem_id
        WHERE w.phase = 'armed' AND w.wake_ref = ?
          AND w.wake_kind IN ('watchdog', 'timer') AND q.state = 'blocked'
          AND NOT EXISTS (
            SELECT 1 FROM queue_transition_wakes f
             WHERE f.qitem_id = w.qitem_id AND f.phase = 'fired'
               AND f.wake_ref = w.wake_ref AND f.transition_id > w.transition_id
          )`,
    ).all(jobId).map((row) => {
      const r = row as { qitem_id: string; wake_kind: "watchdog" | "timer" };
      return { qitemId: r.qitem_id, kind: r.wake_kind };
    });
  }

  /** Queue rows bound to a park-generated timer, regardless of whether that
   *  timer has fired before. Legacy daemons could leave a repeating timer live
   *  after its row closed, so delivery-time defense must consult the original
   *  armed binding rather than only the current blocked/fired projection. */
  findQitemsByGeneratedTimer(jobId: string): Array<{ qitemId: string; state: string }> {
    if (!this.available) return [];
    return this.db.prepare(
      `SELECT DISTINCT w.qitem_id, q.state
         FROM queue_transition_wakes w
         JOIN queue_items q ON q.qitem_id = w.qitem_id
        WHERE w.phase = 'armed' AND w.wake_ref = ? AND w.wake_kind = 'timer'`,
    ).all(jobId).map((row) => {
      const r = row as { qitem_id: string; state: string };
      return { qitemId: r.qitem_id, state: r.state };
    });
  }

  /** Rows that attached an OPERATOR watchdog to this job, whatever their state.
   *  A park-generated timer and an operator attachment can share one job id:
   *  `--wake-watchdog` accepts any active job whose target matches the parked
   *  owner, including the job another row's `--wake-after` produced, and that
   *  second binding persists as wake_kind = 'watchdog' against the same
   *  wake_ref. This lookup is how the timer backstop learns the job is not
   *  solely its own to retire. */
  findQitemsByAttachedWatchdog(jobId: string): Array<{ qitemId: string; state: string }> {
    if (!this.available) return [];
    return this.db.prepare(
      `SELECT DISTINCT w.qitem_id, q.state
         FROM queue_transition_wakes w
         JOIN queue_items q ON q.qitem_id = w.qitem_id
        WHERE w.phase = 'armed' AND w.wake_ref = ? AND w.wake_kind = 'watchdog'`,
    ).all(jobId).map((row) => {
      const r = row as { qitem_id: string; state: string };
      return { qitemId: r.qitem_id, state: r.state };
    });
  }

  private isLive(kind: ParkWakeKind, ref: string): boolean {
    if (kind === "blocker") {
      const row = this.db.prepare("SELECT state FROM queue_items WHERE qitem_id = ?").get(ref) as
        | { state: string }
        | undefined;
      return row !== undefined && ["pending", "in-progress", "blocked"].includes(row.state);
    }
    const row = this.db.prepare("SELECT state FROM watchdog_jobs WHERE job_id = ?").get(ref) as
      | { state: string }
      | undefined;
    return row?.state === "active";
  }

  private isUsageLimitBlocker(qitemId: string): boolean {
    const row = this.db.prepare("SELECT tags FROM queue_items WHERE qitem_id = ?").get(qitemId) as
      | { tags: string | null }
      | undefined;
    if (!row?.tags) return false;
    try {
      return (JSON.parse(row.tags) as unknown[]).includes(USAGE_LIMIT_BLOCKER_TAG);
    } catch {
      return false;
    }
  }

  private wakeExpiry(qitemId: string, kind: ParkWakeKind, ref: string): string | undefined {
    if (kind === "timer" && this.isUsageLimitBlocker(qitemId)) return this.timerExpiry(ref);
    if (kind === "blocker" && this.isUsageLimitBlocker(ref)) return this.usageLimitBlockerExpiry(ref);
    return undefined;
  }

  private usageLimitBlockerExpiry(qitemId: string): string | undefined {
    const row = this.db.prepare(
      `SELECT wake_ref FROM queue_transition_wakes
        WHERE qitem_id = ? AND phase = 'armed' AND wake_kind = 'timer'
        ORDER BY transition_id DESC LIMIT 1`,
    ).get(qitemId) as { wake_ref: string } | undefined;
    return row ? this.timerExpiry(row.wake_ref) : undefined;
  }

  private timerExpiry(jobId: string): string | undefined {
    const row = this.db.prepare(
      "SELECT registered_at, interval_seconds FROM watchdog_jobs WHERE job_id = ?",
    ).get(jobId) as { registered_at: string; interval_seconds: number } | undefined;
    if (!row) return undefined;
    return timerExpiresAt(row.registered_at, row.interval_seconds);
  }

  private row(row: WakeRow): QueueWakeRecord {
    const kind = row.wake_kind as ParkWakeKind;
    const expiresAt = this.wakeExpiry(row.qitem_id, kind, row.wake_ref);
    return {
      transitionId: row.transition_id,
      qitemId: row.qitem_id,
      phase: row.phase as ParkWakePhase,
      kind,
      ref: row.wake_ref,
      deliveryStatus: row.delivery_status,
      ...(expiresAt ? { expiresAt } : {}),
    };
  }
}
