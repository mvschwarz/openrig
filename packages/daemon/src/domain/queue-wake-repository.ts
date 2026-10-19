import type Database from "better-sqlite3";
import { isQueueWait } from "./queue-wait-backoff.js";

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
  /** Repeating wait notices have a separate bounded recovery owner. */
  recoveryOwner?: "queue-stuck-sweep";
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
    const repeating = this.isRepeatingTimer(armed.wake_ref);
    // A retained attempt (held back by the typing guard) was not delivered, so it doesn't consume a one-shot wake:
    // the backstop is still live and nothing awaits the owner. The attempt stays in the history.
    const heldBack = fired?.delivery_status === "retained" && !repeating;
    return {
      kind,
      ref: armed.wake_ref,
      phase: fired ? "fired" : "armed",
      live: fired && !repeating && !heldBack ? false : this.isLive(kind, armed.wake_ref),
      deliveryStatus: fired?.delivery_status ?? null,
      unconsumed: fired !== undefined && !heldBack && state === "blocked",
      ...(repeating ? { recoveryOwner: "queue-stuck-sweep" as const } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    };
  }

  /** A blocked row whose current wake is an attached, active `periodic-reminder` aimed at the row's own owner, which
   *  has fired since this park and whose latest delivery reached that owner. Its owner is being woken by that reminder
   *  on its cadence, so parked diagnosis needn't count the row as stranded. Read only from existing records; anything
   *  it can't establish (no fire yet, a failed or retained attempt, a refused or skipped latest evaluation, a stopped
   *  job, another target, a one-shot park timer, a blocker, missing history) answers false, leaving today's result. */
  servedByOwnRepeatingReminder(qitemId: string): boolean {
    if (!this.available) return false;
    const armed = this.db.prepare(
      `SELECT * FROM queue_transition_wakes
        WHERE qitem_id = ? AND phase = 'armed'
        ORDER BY transition_id DESC LIMIT 1`,
    ).get(qitemId) as WakeRow | undefined;
    if (!armed || armed.wake_kind !== "watchdog") return false;
    // That arm must belong to the current park: a row that has left `blocked` since then and was blocked again with no
    // wake of its own (a gate or a person) wrote no arm, so the earlier park's reminder isn't serving this one.
    // Note-only transitions stay `blocked`.
    const leftSince = this.db.prepare(
      `SELECT 1 FROM queue_transitions WHERE qitem_id = ? AND transition_id > ? AND state <> 'blocked' LIMIT 1`,
    ).get(qitemId, armed.transition_id);
    if (leftSince) return false;
    const job = this.db.prepare(
      `SELECT j.policy, j.spec_yaml, j.state, j.target_session, q.destination_session, q.state AS row_state
         FROM watchdog_jobs j JOIN queue_items q ON q.qitem_id = ?
        WHERE j.job_id = ?`,
    ).get(qitemId, armed.wake_ref) as
      | { policy: string; spec_yaml: string; state: string; target_session: string; destination_session: string; row_state: string }
      | undefined;
    if (!job || job.row_state !== "blocked" || job.policy !== "periodic-reminder" || job.state !== "active"
      || job.target_session !== job.destination_session || isQueueWait(job.spec_yaml)) return false;
    const fired = this.db.prepare(
      `SELECT delivery_status FROM queue_transition_wakes
        WHERE qitem_id = ? AND phase = 'fired' AND wake_ref = ? AND transition_id > ?
        ORDER BY transition_id DESC LIMIT 1`,
    ).get(qitemId, armed.wake_ref, armed.transition_id) as { delivery_status: string | null } | undefined;
    if (fired?.delivery_status !== "ok") return false;
    // A refusal never reaches the row's own records (it isn't a delivery attempt), so the job's latest evaluation
    // must itself be a delivered send. Latest = the history log's own order: evaluated_at, then history_id (a ULID).
    const hasHistory = this.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'watchdog_history'",
    ).get() !== undefined;
    if (!hasHistory) return false;
    // It must have reached this owner: the session the delivery went to, not only the one the job was registered for
    // (a job's spec can name another target). An unknown delivery target keeps today's result.
    const latest = this.db.prepare(
      `SELECT outcome, delivery_status, delivery_target_session FROM watchdog_history
        WHERE job_id = ? ORDER BY evaluated_at DESC, history_id DESC LIMIT 1`,
    ).get(armed.wake_ref) as { outcome: string; delivery_status: string | null; delivery_target_session: string | null } | undefined;
    return latest?.outcome === "sent" && latest.delivery_status === "ok"
      && latest.delivery_target_session === job.destination_session;
  }

  findBlockedQitemsByWatchdog(jobId: string, latestArmedOnly = false): Array<{ qitemId: string; kind: "watchdog" | "timer" }> {
    if (!this.available) return [];
    return this.db.prepare(
      `SELECT DISTINCT w.qitem_id, w.wake_kind
         FROM queue_transition_wakes w
         JOIN queue_items q ON q.qitem_id = w.qitem_id
        WHERE w.phase = 'armed' AND w.wake_ref = ?
          AND w.wake_kind IN ('watchdog', 'timer') AND q.state = 'blocked'
          -- An operator-owned job can outlive the park that attached it.
          -- Only the latest armed continuation owns this row's wake receipt.
          AND (? = 0 OR w.transition_id = (
            SELECT MAX(a.transition_id) FROM queue_transition_wakes a
             WHERE a.qitem_id = w.qitem_id AND a.phase = 'armed'
          ))
          AND (? OR NOT EXISTS (
            SELECT 1 FROM queue_transition_wakes f
             WHERE f.qitem_id = w.qitem_id AND f.phase = 'fired'
               AND f.wake_ref = w.wake_ref AND f.transition_id > w.transition_id
               -- A retained attempt was not delivered: the one-shot binding still owns the next attempt.
               AND (f.delivery_status IS NULL OR f.delivery_status != 'retained')
          ))`,
    ).all(jobId, latestArmedOnly ? 1 : 0, this.isRepeatingTimer(jobId) ? 1 : 0).map((row) => {
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

  /** A current attachment keeps a shared generated job alive until consumed.
   *  A retained attempt never consumes it; a failed one does, except on a repeating timer, which retries. */
  findLiveQitemsByAttachedWatchdog(jobId: string): Array<{ qitemId: string; state: string }> {
    if (!this.available) return [];
    return this.db.prepare(
      `SELECT DISTINCT w.qitem_id, q.state
         FROM queue_transition_wakes w
         JOIN queue_items q ON q.qitem_id = w.qitem_id
        WHERE w.phase = 'armed' AND w.wake_ref = ? AND w.wake_kind = 'watchdog'
          AND q.state = 'blocked'
          AND w.transition_id = (
            SELECT MAX(a.transition_id) FROM queue_transition_wakes a
             WHERE a.qitem_id = w.qitem_id AND a.phase = 'armed'
          )
          AND NOT EXISTS (
            SELECT 1 FROM queue_transition_wakes f
             WHERE f.qitem_id = w.qitem_id AND f.phase = 'fired'
               AND f.wake_ref = w.wake_ref AND f.transition_id > w.transition_id
               -- A retained attempt never consumes an attachment; a failed one consumes it only on a one-shot timer.
               AND (f.delivery_status IS NULL OR f.delivery_status != 'retained')
               AND (? = 0 OR f.delivery_status IS NULL OR (
                 f.delivery_status != 'failed' AND f.delivery_status NOT LIKE 'failed:%'
               ))
          )`,
    ).all(jobId, this.isRepeatingTimer(jobId) ? 1 : 0).map((row) => {
      const r = row as { qitem_id: string; state: string };
      return { qitemId: r.qitem_id, state: r.state };
    });
  }

  /** The generating row retains timer lifecycle only while its current park
   *  uses this job, including an explicit reattachment to the same job. */
  findCurrentQitemsByGeneratedTimer(jobId: string): Array<{ qitemId: string; state: string }> {
    return this.findQitemsByGeneratedTimer(jobId).filter(row =>
      row.state === "blocked" && this.getStatus(row.qitemId)?.ref === jobId);
  }

  /** Active park-generated timers that are still their blocked row's current wake and still target the
   *  row's owner. These wake the seat that owns the row, not a particular occupant, so a seat swap keeps
   *  them; any other job the retiring occupant registered still stops. */
  currentParkTimerIds(): string[] {
    if (!this.available) return [];
    return this.db.prepare(
      `SELECT w.wake_ref
         FROM queue_transition_wakes w
         JOIN queue_items q ON q.qitem_id = w.qitem_id
         JOIN watchdog_jobs j ON j.job_id = w.wake_ref
        WHERE w.phase = 'armed' AND w.wake_kind = 'timer'
          AND q.state = 'blocked' AND j.state = 'active' AND j.target_session = q.destination_session
          AND w.transition_id = (
            SELECT MAX(a.transition_id) FROM queue_transition_wakes a
             WHERE a.qitem_id = w.qitem_id AND a.phase = 'armed'
          )`,
    ).all().map((row) => (row as { wake_ref: string }).wake_ref);
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

  private isRepeatingTimer(ref: string): boolean {
    const row = this.db.prepare("SELECT spec_yaml FROM watchdog_jobs WHERE job_id = ? AND state = 'active'").get(ref) as { spec_yaml: string } | undefined;
    return row ? isQueueWait(row.spec_yaml) : false;
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
