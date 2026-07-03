// OPR.0.3.4.9 — periodic snapshot scheduler (crash-insurance floor).
// Mirrors seat-activity-service timer pattern: idempotent start/stop,
// setInterval().unref(), per-rig error isolation.

import type Database from "better-sqlite3";
import type { SnapshotCapture } from "./snapshot-capture.js";
import type { SnapshotRepository } from "./snapshot-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { ResumeMetadataRefresher } from "./resume-metadata-refresher.js";

export interface PeriodicSnapshotSchedulerDeps {
  db: Database.Database;
  snapshotCapture: SnapshotCapture;
  snapshotRepo: SnapshotRepository;
  // OPR.0.4.3.20 FR-4 — refresh the live per-seat resume ledger before each
  // periodic snapshot serializes it (optional: absent → no refresh, as before).
  sessionRegistry?: SessionRegistry;
  resumeMetadataRefresher?: ResumeMetadataRefresher;
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
          // OPR.0.4.3.20 FR-4 — refresh live tokens before serialize, in its OWN
          // try/catch so a refresh throw NEVER skips the snapshot (guard caveat:
          // do not wrap refresh + capture in a single try/catch).
          if (this.deps.resumeMetadataRefresher && this.deps.sessionRegistry) {
            try {
              // fillNullOnly: a routine snapshot refresh fills null tokens but NEVER
              // clears a present one (rev1-r2 fix — keep stale-present for FR-6).
              await this.deps.resumeMetadataRefresher.refresh(
                this.deps.sessionRegistry.getLatestLiveSessions(rigId),
                { fillNullOnly: true },
              );
            } catch { /* best-effort — the snapshot still writes below */ }
          }
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
    // Latest-session-per-node semantics: a node is running only when its
    // NEWEST session (by created_at DESC, id DESC) has status='running'.
    // Mirrors ps-projection.ts:116-118. An older running + newer exited
    // session means the node is NOT running.
    const rows = this.deps.db.prepare(
      `SELECT DISTINCT r.id FROM rigs r
       JOIN nodes n ON n.rig_id = r.id
       WHERE r.archived_at IS NULL
         AND (SELECT s.status FROM sessions s WHERE s.node_id = n.id
              ORDER BY s.created_at DESC, s.id DESC LIMIT 1) = 'running'`
    ).all() as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }
}
