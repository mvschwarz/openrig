// OPR.0.3.4.9 — periodic snapshot scheduler (crash-insurance floor).
// Mirrors seat-activity-service timer pattern: idempotent start/stop,
// setInterval().unref(), per-rig error isolation.

import type Database from "better-sqlite3";
import type { SnapshotCapture } from "./snapshot-capture.js";
import type { SnapshotRepository } from "./snapshot-repository.js";

export interface PeriodicSnapshotSchedulerDeps {
  db: Database.Database;
  snapshotCapture: SnapshotCapture;
  snapshotRepo: SnapshotRepository;
}

export class PeriodicSnapshotScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private deps: PeriodicSnapshotSchedulerDeps;
  private retentionKeep: number = 10;
  private running = false;

  constructor(deps: PeriodicSnapshotSchedulerDeps) {
    this.deps = deps;
  }

  start(intervalMs: number, retentionKeep: number = 10): void {
    if (this.timer) return;
    this.retentionKeep = Math.max(1, retentionKeep);
    this.timer = setInterval(() => {
      if (this.running) return;
      void this.tick();
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get isActive(): boolean {
    return this.timer !== null;
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const runningRigs = this.getRunningNonArchivedRigs();
      for (const rigId of runningRigs) {
        try {
          this.deps.snapshotCapture.captureSnapshot(rigId, "auto-periodic");
          this.deps.snapshotRepo.pruneSnapshotsByKind(rigId, "auto-periodic", this.retentionKeep);
        } catch {
          // Per-rig error isolation: one rig's failure never aborts the tick.
        }
      }
    } finally {
      this.running = false;
    }
  }

  private getRunningNonArchivedRigs(): string[] {
    const rows = this.deps.db.prepare(
      `SELECT DISTINCT r.id FROM rigs r
       JOIN nodes n ON n.rig_id = r.id
       JOIN sessions s ON s.node_id = n.id
       WHERE s.status = 'running' AND r.archived_at IS NULL`
    ).all() as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }
}
