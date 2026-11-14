import type Database from "better-sqlite3";
import type { WatchdogJobsRepository } from "./watchdog-jobs-repository.js";
import { nextDueAt } from "./watchdog-due.js";
import { resolveSessionNodeId } from "./queue-owner.js";
import { sessionRigOf } from "./session-name.js";
import { WAKE_INTENT_PREFIX } from "./outbox-handler.js";

export interface RigDeliveryDrain {
  rigId: string;
  drainId: string;
  owner: string;
  startedAt: string;
  reviewAt: string;
  reviewJobId: string;
  endedAt: string | null;
}
const columns = `rig_id AS rigId, drain_id AS drainId, owner, started_at AS startedAt,
  review_at AS reviewAt, review_job_id AS reviewJobId, ended_at AS endedAt`;

/** Only the maintenance control is new state. Retained work stays in its existing stores. */
export class RigDeliveryDrainStore {
  private readonly available: boolean;
  constructor(readonly db: Database.Database, private readonly now: () => Date = () => new Date()) {
    // Old-schema readers have no opt-in drain; production applies the canonical migration list first.
    this.available = !!db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='rig_delivery_drains'").get();
  }
  get(rigId: string): RigDeliveryDrain | null {
    if (!this.available) return null;
    return (this.db.prepare(`SELECT ${columns} FROM rig_delivery_drains WHERE rig_id=?
      ORDER BY (ended_at IS NULL) DESC, id DESC LIMIT 1`).get(rigId) as RigDeliveryDrain | undefined) ?? null;
  }
  rigForSession(session: string): string | null {
    const nodeId = resolveSessionNodeId(this.db, session);
    if (nodeId) {
      const node = this.db.prepare("SELECT rig_id FROM nodes WHERE id=?").get(nodeId) as { rig_id: string } | undefined;
      if (node) return node.rig_id;
    }
    const name = sessionRigOf(session);
    if (!name) return null;
    const rows = this.db.prepare("SELECT id FROM rigs WHERE name=? AND archived_at IS NULL").all(name) as { id: string }[];
    return rows.length === 1 ? rows[0]!.id : null;
  }
  isReviewJob(jobId: string): boolean {
    return this.available && !!this.db.prepare("SELECT 1 FROM rig_delivery_drains WHERE review_job_id=? AND ended_at IS NULL").get(jobId);
  }
  /** A new maintenance check must never stop otherwise usable delivery on an unreadable control. */
  private admissionRead(read: () => boolean): boolean {
    try { return read(); } catch (error) {
      console.error("[delivery-drain] control read unavailable; allowing automatic delivery:", error);
      return false;
    }
  }
  hasActive(): boolean {
    return this.admissionRead(() => this.available && !!this.db.prepare("SELECT 1 FROM rig_delivery_drains WHERE ended_at IS NULL LIMIT 1").get());
  }
  holds(session: string, jobId?: string): boolean {
    return this.admissionRead(() => {
      if (!this.hasActive()) return false;
      // The owner's stored review job remains usable even when its seat belongs to another drained rig.
      if (jobId && this.isReviewJob(jobId)) return false;
      const rigId = this.rigForSession(session);
      return !!rigId && this.get(rigId)?.endedAt === null;
    });
  }
  begin(rigId: string, input: { drainId: string; owner: string; reviewAt: string }, jobs: WatchdogJobsRepository): RigDeliveryDrain {
    return this.db.transaction(() => {
      const known = this.db.prepare(`SELECT ${columns} FROM rig_delivery_drains WHERE rig_id=? AND drain_id=?`)
        .get(rigId, input.drainId) as RigDeliveryDrain | undefined;
      const current = this.get(rigId);
      // A delayed BEGIN for a completed window never reactivates it. An already-active window is returned as status.
      if (known?.endedAt || current?.endedAt === null && current.drainId !== input.drainId) return current!;
      const reviewAt = new Date(input.reviewAt).toISOString();
      if (known && known.owner === input.owner && known.reviewAt === reviewAt) return known;
      if (known) jobs.stop(known.reviewJobId, "delivery_drain_review_renewed");
      const startedAt = known?.startedAt ?? this.now().toISOString();
      const job = jobs.register({
        policy: "periodic-reminder", targetSession: input.owner, registeredBySession: input.owner,
        intervalSeconds: Math.max(300, Math.ceil((Date.parse(reviewAt) - this.now().getTime()) / 1000)),
        activeWakeIntervalSeconds: 300,
        specYaml: JSON.stringify({ target: { session: input.owner }, message:
          `Review delivery drain ${input.drainId} for rig ${rigId}. END it explicitly or renew its review deadline through /api/rigs/${rigId}/delivery-drain. A deadline never resumes delivery. Automatic native starts are NOT deferred.` }),
      });
      this.db.prepare(`INSERT INTO rig_delivery_drains (rig_id,drain_id,owner,started_at,review_at,review_job_id,ended_at)
        VALUES (?,?,?,?,?,?,NULL) ON CONFLICT(rig_id,drain_id) DO UPDATE SET owner=excluded.owner,
          review_at=excluded.review_at,review_job_id=excluded.review_job_id`)
        .run(rigId, input.drainId, input.owner, startedAt, reviewAt, job.jobId);
      return this.get(rigId)!;
    })();
  }
  end(rigId: string, drainId: string, jobs: WatchdogJobsRepository): { fresh: boolean; drain: RigDeliveryDrain | null } {
    return this.db.transaction(() => {
      const current = this.get(rigId);
      if (!current || current.drainId !== drainId || current.endedAt) return { fresh: false, drain: current };
      this.db.prepare("UPDATE rig_delivery_drains SET ended_at=? WHERE rig_id=? AND drain_id=? AND ended_at IS NULL")
        .run(this.now().toISOString(), rigId, drainId);
      jobs.stop(current.reviewJobId, "delivery_drain_ended");
      return { fresh: true, drain: this.get(rigId) };
    })();
  }
  status(rigId: string, jobs: WatchdogJobsRepository) {
    const drain = this.get(rigId);
    const active = drain?.endedAt === null;
    const rigCache = new Map<string, string | null>();
    const inRig = (session: string) => {
      if (!rigCache.has(session)) rigCache.set(session, this.rigForSession(session));
      return rigCache.get(session) === rigId;
    };
    const pending = active ? this.db.prepare(`SELECT destination_session AS session, count(*) AS n FROM outbox_entries
      WHERE delivery_state='pending' AND substr(outbox_id,1,?)=? GROUP BY destination_session`)
      .all(WAKE_INTENT_PREFIX.length, WAKE_INTENT_PREFIX) as { session: string; n: number }[] : [];
    const pendingWakeIntents = active ? pending.filter(x => inRig(x.session)).reduce((n, x) => n + x.n, 0) : 0;
    const dueJobs = active ? jobs.listActive().filter(job => !this.isReviewJob(job.jobId) && inRig(job.targetSession)
      && (nextDueAt(job) ?? 0) <= this.now().getTime()).length : 0;
    return { rigId, active, drain, retainedWorkCount: pendingWakeIntents + dueJobs,
      retained: { pendingWakeIntents, dueWatchdogJobs: dueJobs }, nativeStartsDeferred: false as const };
  }
}
