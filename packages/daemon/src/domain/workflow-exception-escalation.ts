import { packetScopeTags, readInstanceScope } from "./workflow-scope.js";
import { findQueueRecovery, recoveryId, recoveryTag } from "./queue-recovery.js";
// OPR.0.4.6.WF5 FR-2 class (b): detection-time exception items for
// STUCK/OVERDUE instances.
//
// Class (b) has NO state-change transaction to ride — the item is created
// AT DETECTION TIME by the sweep/keepalive evaluation, and its never-lost
// guarantee is WF-1's crash-surviving sweep: re-detection re-creates a
// missed item on the next pass (P2 cleanup honored: no same-txn claim is
// made or implemented here).
//
// The existing diagnostic row carries the underlying obligation tag. Timer,
// ladder and sweep converge on that same recovery. Unchanged redetection neither
// sends nor appends a transition; a closed disposition stands until a new
// meaningful source transition or actual failed delivery creates a new episode.
// Legacy occurrence tags remain readable without rewriting historical rows.
//
// The policy shape is untouched (X5 stands: PolicyEvaluation remains
// send|skip|terminal) — the keepalive calls this injected helper as a
// side effect of its EXISTING evaluation; the sweep likewise. Injection
// at startup per the validateRig precedent.

import type Database from "better-sqlite3";
import { QueueRepositoryError, type QueueRepository } from "./queue-repository.js";
import type { WorkflowDeadlineVerdict } from "./workflow-deadline.js";
import {
  classifyDeadlineVerdict,
  workflowExceptionTags,
  type WorkflowExceptionClass,
} from "./workflow-exception.js";
import type { ExceptionRoute } from "./workflow-exception-router.js";
import { workflowHumanDestination, type WorkflowHumanDestination } from "./workflow-human-destination.js";

export interface EnsureStuckExceptionInput {
  workflowName: string;
  workflowVersion: string;
  /** The session recorded as the item's source (the instance creator —
   *  a real, validated session; the detector is machinery, not a seat). */
  createdBySession: string;
  verdict: WorkflowDeadlineVerdict;
}

export interface EnsureStuckExceptionResult {
  outcome: "skipped-healthy" | "deduped" | "created";
  qitemId?: string;
}

export type EnsureStuckExceptionItem = (
  input: EnsureStuckExceptionInput,
) => Promise<EnsureStuckExceptionResult>;

export interface StuckExceptionDeps {
  db: Database.Database;
  queueRepo: QueueRepository;
  /** The maturity-dial resolution for a cached spec (runtime-owned —
   *  spec lookup + the shipped role resolution live there). null =
   *  spec not cached; registered-human selection applies.
   *  OPR.0.4.6.FAC1 (arch Q3): boundRig = the stuck instance's bound
   *  rig (read from workflow_instances at detection time) so the
   *  orchestrator-role dial position resolves capability-aware. */
  resolveRoute: (
    workflowName: string,
    workflowVersion: string,
    exceptionClass: WorkflowExceptionClass,
    boundRig?: string | null,
  ) => ExceptionRoute | null;
  humanFallbackSeat?: WorkflowHumanDestination;
  log?: (line: string) => void;
}

export function makeEnsureStuckExceptionItem(deps: StuckExceptionDeps): EnsureStuckExceptionItem {
  const log = deps.log ?? (() => {});
  return async (input: EnsureStuckExceptionInput): Promise<EnsureStuckExceptionResult> => {
    const exception = classifyDeadlineVerdict(input.workflowName, input.verdict);
    if (!exception) return { outcome: "skipped-healthy" };

    // A delivery failure notice at the sender does not own the workflow exception route.
    const previous = findQueueRecovery(deps.db, exception.deadlineEvidence!.packetId, "slack-undeliverable");
    if (previous) return { outcome: "deduped", qitemId: previous.qitemId };

    // Honor historical occurrence rows, including their closed disposition.
    // Modern rows were already resolved through the current source episode above.
    const open = deps.db
      .prepare(
        `SELECT qitem_id, destination_session FROM queue_items
         WHERE json_valid(tags)
           AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)
           AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)
           AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)
           AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = 'workflow-exception')
           AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = 'exception:stuck_overdue')
           AND NOT EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)` ,
      )
      .get(
        `occurrence:${exception.identity.occurrenceKey}`,
        `instance:${exception.identity.instanceId}`,
        `workflow:${exception.identity.workflowName}`,
        recoveryTag(exception.deadlineEvidence!.packetId),
      ) as { qitem_id: string; destination_session: string } | undefined;
    if (open) {
      // Re-detection of the same unresolved episode: re-nudge the ONE
      // item (best-effort — the durable item is the guarantee).
      return { outcome: "deduped", qitemId: open.qitem_id };
    }

    // OPR.0.4.6.FAC1 (arch Q3): each exception item is a FRESH routing
    // decision at its own detection moment — read the stuck instance's
    // bound rig NOW. A failed read cannot establish an unbound instance:
    // propagate it before any routing or queue write.
    let detectionBoundRig: string | null = null;
    const stuckInstanceId = exception.deadlineEvidence?.instanceId;
    if (stuckInstanceId) {
      const row = deps.db
        .prepare(`SELECT bound_rig FROM workflow_instances WHERE instance_id = ?`)
        .get(stuckInstanceId) as { bound_rig: string | null } | undefined;
      detectionBoundRig = row?.bound_rig ?? null;
    }
    const route =
      deps.resolveRoute(input.workflowName, input.workflowVersion, "stuck_overdue", detectionBoundRig) ?? {
        position: "fallback" as const,
        destinationSession: workflowHumanDestination(deps.humanFallbackSeat),
        tier: "human-gate",
        humanRouted: true,
        resolvedVia: "engine-default" as const,
      };
    const e = exception.deadlineEvidence!;
    const evidenceRef = `rig workflow trace ${e.instanceId}`;
    const body =
      `WORKFLOW EXCEPTION (stuck_overdue)\n` +
      `workflow: ${input.workflowName} v${input.workflowVersion}\n` +
      `instance: ${e.instanceId}\n` +
      `step: ${e.stepId ?? "(unbound)"} — packet ${e.packetId} held by ${e.ownerSession} (${e.packetState})\n` +
      `deadline: ${e.overdueBySeconds}s past the ${e.anchor} anchor (${e.anchorAt}); packet age ${e.ageSeconds}s\n` +
      `reason: ${exception.reason}\n` +
      `evidence: ${evidenceRef}\n` +
      `resolve: inspect the current owner and deadline; packet age alone does not establish idle. This item clears when the instance leaves the exception state.`;
    const scopeTags = packetScopeTags(readInstanceScope(deps.db, e.instanceId), e.stepId);
    // Routed to the person, a stuck workflow is an approval whose wait costs now: alert them.
    const createItem = (destination: string, tier: string, toPerson: boolean) =>
      deps.queueRepo.create({
        qitemId: recoveryId(deps.db, e.packetId),
        sourceSession: input.createdBySession,
        destinationSession: destination,
        body,
        priority: "urgent",
        // OpenRig's own escalation: it wakes as OpenRig's, marked urgent by OpenRig.
        wakeTrigger: "openrig",
        tier,
        tags: [...workflowExceptionTags(exception.identity), recoveryTag(e.packetId), ...scopeTags],
        summary: exception.reason,
        evidenceRef,
        ...(toPerson ? { humanAlert: true } : {}),
      });
    let created;
    try {
      created = await createItem(route.destinationSession, route.tier, route.humanRouted === true);
    } catch (error) {
      if (!(error instanceof QueueRepositoryError) || error.code !== "unknown_destination_rig" || route.humanRouted) throw error;
      // An unavailable agent rig may use the registered human fallback.
      // Other admission/storage failures retain their original diagnosis.
      created = await createItem(workflowHumanDestination(deps.humanFallbackSeat), "human-gate", true);
    }
    log(
      `workflow exception: stuck_overdue item ${created.qitemId} created for instance ${e.instanceId} (step ${e.stepId ?? "?"}, ${route.position})`,
    );
    return { outcome: "created", qitemId: created.qitemId };
  };
}
