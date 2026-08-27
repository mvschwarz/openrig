import type Database from "better-sqlite3";

export type ParkWakeKind = "watchdog" | "timer" | "blocker";
export type ParkWakePhase = "armed" | "fired";

export interface QueueWakeRecord {
  transitionId: number;
  qitemId: string;
  phase: ParkWakePhase;
  kind: ParkWakeKind;
  ref: string;
  deliveryStatus: string | null;
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
    return {
      kind: armed.wake_kind as ParkWakeKind,
      ref: armed.wake_ref,
      phase: fired ? "fired" : "armed",
      live: fired ? false : this.isLive(armed.wake_kind as ParkWakeKind, armed.wake_ref),
      deliveryStatus: fired?.delivery_status ?? null,
      unconsumed: fired !== undefined && state === "blocked",
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

  private row(row: WakeRow): QueueWakeRecord {
    return {
      transitionId: row.transition_id,
      qitemId: row.qitem_id,
      phase: row.phase as ParkWakePhase,
      kind: row.wake_kind as ParkWakeKind,
      ref: row.wake_ref,
      deliveryStatus: row.delivery_status,
    };
  }
}
