// OPR.0.4.6.WF5 FR-1: the closed exception taxonomy.
//
// An EXCEPTION is one of exactly three classes, each a PURE PREDICATE over
// recorded state (BR-1: never ambient probing, never judgment in the engine —
// agent judgment lives in RESOLVING, not detecting). Extending this taxonomy
// is a convention change, not driver discretion.
//
//   (a) unmapped_failed — an instance entered status=failed. A MAPPED
//       `failed` exit routes to its WF-2 remediation branch inside the same
//       transaction (instance stays active) and is NOT an exception; only an
//       unrouted failed close — including the engine-authored max_hops
//       conversion — lands the instance in `failed`, so the recorded status
//       IS the predicate.
//   (b) stuck_overdue — a frontier packet past its deadline AS CLASSIFIED BY
//       WF-1 FR-2's evaluator (workflow-deadline.ts, the single threshold
//       home). This module consumes the verdict verbatim and never
//       recomputes an anchor or threshold.
//   (c) human_gate_trip — a WF-2 gate with a HUMAN target reached. The
//       WF-2-compiled park IS the attention item (FR-2 mints no second one);
//       this class exists so the item carries the exception identity.
//
// THE HANDLER-ROLE SPLIT (spec-guard blocker 2, ratified): a handler-role
// gate-trip is NOT an exception — it is a deterministic agent handoff by
// design. The escalation leg is the backstop BEHIND the handler: if the
// handler's own step fails or goes stuck, classes (a)/(b) fire on it.
//
// v1.3: CLASSIFICATION ≠ ROUTING. The maturity dial (workflow-exception-
// router.ts) maps class → target; nothing here knows about destinations.

import type { WorkflowDeadlineVerdict, WorkflowStepDeadlineEvidence } from "./workflow-deadline.js";
import type { WorkflowInstance } from "./workflow-types.js";

export const WORKFLOW_EXCEPTION_CLASSES = [
  "unmapped_failed",
  "stuck_overdue",
  "human_gate_trip",
] as const;
export type WorkflowExceptionClass = (typeof WORKFLOW_EXCEPTION_CLASSES)[number];

/**
 * THE OCCURRENCE DEFINITION (the single home — every dedup and
 * new-occurrence rule reads from this sentence): one occurrence is one
 * (instance, step, class) failure EPISODE, keyed by the recorded qitem id
 * of the packet that embodies the episode — re-detections of the same
 * unresolved episode share the key and dedupe into ONE item; resolve+resume
 * closes the occurrence, and any later episode of the same step carries a
 * NEW packet id and is therefore a NEW occurrence, never absorbed by the
 * resolved past.
 *
 * The key is a RECORDED FACT (arch cell-2 ruling: identity = structured
 * tags; a column stays delivery's option — not taken):
 *   (a) the frontier packet whose failed close felled the instance
 *   (b) the overdue packet named by the deadline evaluator's evidence
 *   (c) the compiled gate packet parked on the human
 */
export interface WorkflowExceptionIdentity {
  workflowName: string;
  instanceId: string;
  /** Nullable only for class (a) on a pre-R2 row with no trail context. */
  stepId: string | null;
  exceptionClass: WorkflowExceptionClass;
  /** The recorded packet id of this episode — see the occurrence JSDoc. */
  occurrenceKey: string;
}

export interface WorkflowException {
  identity: WorkflowExceptionIdentity;
  /** Plain-language, evidence-bearing reason (rides the item's summary). */
  reason: string;
  /** Class-(b) carries the evaluator's evidence verbatim; (a)/(c) null. */
  deadlineEvidence: WorkflowStepDeadlineEvidence | null;
}

/** The minimal recorded-state view class (a) classifies over. Callers pass
 *  the failed close's recorded facts (trail row / lastContinuationDecision);
 *  this module never queries. */
export interface FailedInstanceView {
  instance: Pick<
    WorkflowInstance,
    "instanceId" | "workflowName" | "status" | "currentStepId" | "lastContinuationDecision"
  >;
  /** The step that closed failed (trail.step_id of the failing close). */
  failedStepId: string | null;
  /** The packet whose failed close felled the instance (trail.prior_qitem_id). */
  failedPacketId: string;
  /** The recorded failure note if any (resultNote / event reason). */
  failureReason: string | null;
}

/**
 * Class (a): unmapped_failed. Pure: same view → same classification,
 * replayed N times. A non-failed instance NEVER classifies (the mapped-
 * failed negative: branch-routed failures keep status=active and are
 * deterministic remediation, not exceptions).
 */
export function classifyFailedInstance(view: FailedInstanceView): WorkflowException | null {
  if (view.instance.status !== "failed") return null;
  return {
    identity: {
      workflowName: view.instance.workflowName,
      instanceId: view.instance.instanceId,
      stepId: view.failedStepId,
      exceptionClass: "unmapped_failed",
      occurrenceKey: view.failedPacketId,
    },
    reason: view.failureReason
      ? `workflow step failed with no remediation branch: ${view.failureReason}`
      : "workflow step failed with no remediation branch",
    deadlineEvidence: null,
  };
}

/**
 * Class (b): stuck_overdue. CONSUMES the WF-1 evaluator's verdict verbatim
 * (rail: the single threshold home classifies; this function only lifts a
 * non-healthy verdict into the exception shape). Healthy → null.
 */
export function classifyDeadlineVerdict(
  workflowName: string,
  verdict: WorkflowDeadlineVerdict,
): WorkflowException | null {
  if (verdict.state === "healthy" || !verdict.evidence) return null;
  const e = verdict.evidence;
  return {
    identity: {
      workflowName,
      instanceId: e.instanceId,
      stepId: e.stepId,
      exceptionClass: "stuck_overdue",
      occurrenceKey: e.packetId,
    },
    reason:
      `workflow step ${e.stepId ?? "(unbound)"} is ${verdict.state} — packet ${e.packetId} ` +
      `held by ${e.ownerSession}, ${e.overdueBySeconds}s past its ${e.anchor} anchor`,
    deadlineEvidence: e,
  };
}

/** The recorded facts of a gate reach — the compiled kind is WF-2's
 *  recorded output, not a re-derivation. */
export interface GateTripView {
  workflowName: string;
  instanceId: string;
  gatedStepId: string;
  /** GateCompileResult.kind — "human" | "handler-role". */
  gateKind: "human" | "handler-role";
  /** The compiled gate packet's qitem id. */
  gatePacketId: string;
  /** The human seat the packet parks on (null for handler-role). */
  parkOn: string | null;
}

/**
 * Class (c): human_gate_trip — HUMAN-target gates only. THE HANDLER-ROLE
 * NEGATIVE lives here: a handler-role gate returns null (a deterministic
 * handoff, not an exception; the (a)/(b) backstop covers the handler's own
 * step). Class (c) is intrinsically human-only at the dial.
 */
export function classifyGateTrip(view: GateTripView): WorkflowException | null {
  if (view.gateKind !== "human") return null;
  return {
    identity: {
      workflowName: view.workflowName,
      instanceId: view.instanceId,
      stepId: view.gatedStepId,
      exceptionClass: "human_gate_trip",
      occurrenceKey: view.gatePacketId,
    },
    reason: `human decision required at gated step ${view.gatedStepId}` +
      (view.parkOn ? ` (parked on ${view.parkOn})` : ""),
    deadlineEvidence: null,
  };
}

/** Tag prefixes: `workflow:`/`instance:` extend the SHIPPED stamp
 *  (workflow-runtime.ts / workflow-projector.ts already emit them);
 *  `step:`/`exception:`/`occurrence:` are WF-5's additions (arch cell 2).
 *  FR-2 dedup and FR-3 cross-channel one-count JOIN on these BY QUERY —
 *  never by summary parsing. */
export function workflowExceptionTags(identity: WorkflowExceptionIdentity): string[] {
  const tags = [
    "workflow-exception",
    `workflow:${identity.workflowName}`,
    `instance:${identity.instanceId}`,
    `exception:${identity.exceptionClass}`,
    `occurrence:${identity.occurrenceKey}`,
  ];
  if (identity.stepId) tags.splice(3, 0, `step:${identity.stepId}`);
  return tags;
}

/** The query key for within-occurrence dedup: one item per this tuple. */
export function occurrenceDedupKey(identity: WorkflowExceptionIdentity): string {
  return `${identity.instanceId}|${identity.stepId ?? ""}|${identity.exceptionClass}|${identity.occurrenceKey}`;
}
