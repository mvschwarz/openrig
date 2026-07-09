// OPR.0.4.6.WF5 FR-2 class (b): detection-time exception items for
// STUCK/OVERDUE instances.
//
// Class (b) has NO state-change transaction to ride — the item is created
// AT DETECTION TIME by the sweep/keepalive evaluation, and its never-lost
// guarantee is WF-1's crash-surviving sweep: re-detection re-creates a
// missed item on the next pass (P2 cleanup honored: no same-txn claim is
// made or implemented here).
//
// DEDUP (the occurrence contract): exactly ONE OPEN item per
// (instance, step, class, occurrence) — the occurrence key is the overdue
// packet id named by the WF-1 evaluator's evidence. Re-detections of the
// same unresolved episode find the open item by TAG QUERY (never summary
// parsing) and re-nudge it instead of minting a duplicate. A resolved/
// closed item with the episode still live is a MISSED item — the next
// detection re-creates it (the sweep guarantee), keeping exactly one
// OPEN item per occurrence at all times.
//
// The policy shape is untouched (X5 stands: PolicyEvaluation remains
// send|skip|terminal) — the keepalive calls this injected helper as a
// side effect of its EXISTING evaluation; the sweep likewise. Injection
// at startup per the validateRig precedent.

import type Database from "better-sqlite3";
import type { QueueRepository } from "./queue-repository.js";
import type { WorkflowDeadlineVerdict } from "./workflow-deadline.js";
import {
  classifyDeadlineVerdict,
  workflowExceptionTags,
  type WorkflowExceptionClass,
} from "./workflow-exception.js";
import type { ExceptionRoute } from "./workflow-exception-router.js";

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
   *  spec not cached; the never-lost fallback applies.
   *  OPR.0.4.6.FAC1 (arch Q3): boundRig = the stuck instance's bound
   *  rig (read from workflow_instances at detection time) so the
   *  orchestrator-role dial position resolves capability-aware. */
  resolveRoute: (
    workflowName: string,
    workflowVersion: string,
    exceptionClass: WorkflowExceptionClass,
    boundRig?: string | null,
  ) => ExceptionRoute | null;
  humanFallbackSeat?: string;
  log?: (line: string) => void;
}

export function makeEnsureStuckExceptionItem(deps: StuckExceptionDeps): EnsureStuckExceptionItem {
  const log = deps.log ?? (() => {});
  const fallbackSeat = deps.humanFallbackSeat ?? "human@host";
  return async (input: EnsureStuckExceptionInput): Promise<EnsureStuckExceptionResult> => {
    const exception = classifyDeadlineVerdict(input.workflowName, input.verdict);
    if (!exception) return { outcome: "skipped-healthy" };

    // Dedup by tag query against OPEN states only (pending | in-progress
    // | blocked): one open item per occurrence; a closed item with the
    // episode still live is missed and gets re-created.
    const open = deps.db
      .prepare(
        `SELECT qitem_id, destination_session FROM queue_items
         WHERE state IN ('pending','in-progress','blocked')
           AND tags LIKE ? AND tags LIKE ?`,
      )
      .get(
        `%"occurrence:${exception.identity.occurrenceKey}"%`,
        `%"exception:stuck_overdue"%`,
      ) as { qitem_id: string; destination_session: string } | undefined;
    if (open) {
      // Re-detection of the same unresolved episode: re-nudge the ONE
      // item (best-effort — the durable item is the guarantee).
      await deps.queueRepo.maybeNudge(open.qitem_id, open.destination_session, undefined);
      return { outcome: "deduped", qitemId: open.qitem_id };
    }

    // OPR.0.4.6.FAC1 (arch Q3): each exception item is a FRESH routing
    // decision at its own detection moment — read the stuck instance's
    // bound rig NOW (defensive to a pre-052 fixture db: absent column
    // reads as unbound, the shipped behavior).
    let detectionBoundRig: string | null = null;
    const stuckInstanceId = exception.deadlineEvidence?.instanceId;
    if (stuckInstanceId) {
      try {
        const row = deps.db
          .prepare(`SELECT bound_rig FROM workflow_instances WHERE instance_id = ?`)
          .get(stuckInstanceId) as { bound_rig: string | null } | undefined;
        detectionBoundRig = row?.bound_rig ?? null;
      } catch {
        detectionBoundRig = null;
      }
    }
    const route =
      deps.resolveRoute(input.workflowName, input.workflowVersion, "stuck_overdue", detectionBoundRig) ?? {
        position: "fallback" as const,
        destinationSession: fallbackSeat,
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
      `resolve: re-nudge/replace the owner per the WF-1 dead-seat mechanics (the step re-projects and the flow continues from this step); this item clears when the instance leaves the exception state.`;
    const createItem = (destination: string, tier: string) =>
      deps.queueRepo.create({
        sourceSession: input.createdBySession,
        destinationSession: destination,
        body,
        priority: "urgent",
        tier,
        tags: workflowExceptionTags(exception.identity),
        summary: exception.reason,
        evidenceRef,
      });
    let created;
    try {
      created = await createItem(route.destinationSession, route.tier);
    } catch {
      // THE NEVER-LOST WRITE-GATE FALLBACK (same contract as class (a)):
      // a gate-rejected routed destination re-routes human@host rather
      // than losing the exception. A failure of THIS create is a real
      // storage error and propagates to the caller's non-fatal handling.
      created = await createItem(fallbackSeat, "human-gate");
    }
    log(
      `workflow exception: stuck_overdue item ${created.qitemId} created for instance ${e.instanceId} (step ${e.stepId ?? "?"}, ${route.position})`,
    );
    return { outcome: "created", qitemId: created.qitemId };
  };
}
