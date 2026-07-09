// OPR.0.4.6.WF1 FR-4 (G5): the startup resume sweep — the workflow
// twin of the existing rig/session boot reconcile.
//
// Before this slice NOTHING re-examined in-flight workflow instances
// at daemon boot: a nudge lost to the commit-then-crash window stayed
// lost, keepalives armed in a prior process (or never armed, pre-WF-1)
// stayed dead, and a stuck instance surfaced nowhere. The sweep closes
// all three on every boot:
//
//   1. RE-ARM — every active|waiting instance gets its per-instance
//      keepalive ensured (idempotent; heals pre-WF-1 instances that
//      never had one).
//   2. LOST-NUDGE RECOVERY — a PENDING frontier packet whose
//      last_nudge_attempt is NULL was routed but never nudged (the
//      daemon died between the scribe commit and the post-commit
//      nudge — the exact FR-3 window). It is re-nudged NOW, not after
//      a threshold: the potato is provably alive on restart.
//   3. DEADLINE EVALUATION — the FR-2 evaluator runs over each
//      instance's frontier; overdue instances are surfaced (log line +
//      re-nudge with the stuck steering) — never silently parked.
//
// The sweep is observable: ONE summary line naming counts. Zero
// in-flight instances → a no-op (no state side effects).
//
// BR-2 holds: the sweep arms, nudges, and logs — it never advances an
// instance (project() stays the sole advance write path).

import type { QueueRepository } from "./queue-repository.js";
import type { WatchdogJobsRepository } from "./watchdog-jobs-repository.js";
import type { WorkflowInstanceStore } from "./workflow-instance-store.js";
import { evaluateStepDeadline } from "./workflow-deadline.js";
import type { EnsureStuckExceptionItem } from "./workflow-exception-escalation.js";
import { ensureWorkflowKeepaliveArmed } from "./workflow-keepalive-arming.js";

export interface WorkflowBootSweepResult {
  instancesSwept: number;
  keepalivesArmed: number;
  lostNudgesReissued: number;
  stuckSurfaced: number;
  /** OPR.0.4.6.WF5 FR-2 class (b): stuck exception items created this
   *  sweep (deduped re-detections not counted). */
  exceptionItemsCreated: number;
}

export interface WorkflowBootSweepDeps {
  instanceStore: WorkflowInstanceStore;
  queueRepo: QueueRepository;
  watchdogJobsRepo: WatchdogJobsRepository;
  log?: (line: string) => void;
  now?: () => Date;
  /** OPR.0.4.6.WF5 FR-2 class (b): when supplied, a non-healthy deadline
   *  verdict ENSURES the durable exception item at detection time (the
   *  crash-surviving never-lost leg — re-detection re-creates a missed
   *  item). Optional so pre-WF-5 embedders keep working; startup wires
   *  the real closure. Failures are non-fatal to the sweep. */
  ensureStuckExceptionItem?: EnsureStuckExceptionItem;
}

export async function runWorkflowBootSweep(
  deps: WorkflowBootSweepDeps,
): Promise<WorkflowBootSweepResult> {
  const log = deps.log ?? (() => {});
  const now = (deps.now ?? (() => new Date()))();
  const instances = [
    ...deps.instanceStore.listByStatus("active"),
    ...deps.instanceStore.listByStatus("waiting"),
  ];
  const result: WorkflowBootSweepResult = {
    instancesSwept: instances.length,
    keepalivesArmed: 0,
    lostNudgesReissued: 0,
    stuckSurfaced: 0,
    exceptionItemsCreated: 0,
  };
  if (instances.length === 0) {
    log("workflow boot sweep: 0 in-flight instances (no-op)");
    return result;
  }

  for (const instance of instances) {
    const packets = instance.currentFrontier
      .map((id) => deps.queueRepo.getById(id))
      .filter((p): p is NonNullable<typeof p> => p != null);

    // 1. Re-arm the keepalive (idempotent; heals pre-WF-1 instances).
    const fallbackOwner =
      packets[0]?.destinationSession ?? instance.createdBySession;
    if (fallbackOwner && fallbackOwner.includes("@")) {
      const armed = ensureWorkflowKeepaliveArmed(deps.watchdogJobsRepo, {
        instanceId: instance.instanceId,
        targetSession: fallbackOwner,
        registeredBySession: instance.createdBySession,
      });
      if (armed.newlyArmed) result.keepalivesArmed += 1;
    }

    // 2. Lost-nudge recovery: routed-but-never-nudged pending packets.
    for (const packet of packets) {
      if (packet.state === "pending" && packet.lastNudgeAttempt === null) {
        result.lostNudgesReissued += 1;
        await deps.queueRepo.maybeNudge(
          packet.qitemId,
          packet.destinationSession,
          undefined,
          instance.createdBySession,
        );
      }
    }

    // 3. Deadline evaluation (derived; the unclaimed frontier is a
    // FIRST-CLASS case here — never invisible to an in-progress-only
    // scan like findOverdue).
    const verdict = evaluateStepDeadline(instance, packets, now);
    if (verdict.state !== "healthy" && verdict.evidence) {
      result.stuckSurfaced += 1;
      log(
        `workflow boot sweep: instance ${instance.instanceId} STUCK (${verdict.state}) — step ${verdict.evidence.stepId ?? "?"}, packet ${verdict.evidence.packetId}, owner ${verdict.evidence.ownerSession}, anchor ${verdict.evidence.anchor}@${verdict.evidence.anchorAt}, overdue ${verdict.evidence.overdueBySeconds}s`,
      );
      // Re-nudge the overdue owner (the keepalive will keep firing on
      // its own cadence; boot gives the immediate wake).
      await deps.queueRepo.maybeNudge(
        verdict.evidence.packetId,
        verdict.evidence.ownerSession,
        undefined,
        instance.createdBySession,
      );
      // OPR.0.4.6.WF5 FR-2 class (b): ensure the durable exception item
      // at detection. Non-fatal: an item failure must not break the
      // sweep's other legs (the next pass re-detects — the guarantee).
      if (deps.ensureStuckExceptionItem) {
        try {
          const ensured = await deps.ensureStuckExceptionItem({
            workflowName: instance.workflowName,
            workflowVersion: instance.workflowVersion,
            createdBySession: instance.createdBySession,
            verdict,
          });
          if (ensured.outcome === "created") result.exceptionItemsCreated += 1;
        } catch (err) {
          log(
            `workflow boot sweep: exception-item ensure failed (non-fatal) for ${instance.instanceId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
  }

  log(
    `workflow boot sweep: ${result.instancesSwept} in-flight instance(s) — ${result.keepalivesArmed} keepalive(s) armed, ${result.lostNudgesReissued} lost nudge(s) reissued, ${result.stuckSurfaced} stuck surfaced, ${result.exceptionItemsCreated} exception item(s) created`,
  );
  return result;
}
