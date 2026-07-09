// OPR.0.4.6.WF1 FR-2: the step-deadline evaluator (pure).
//
// Closes G1 — the 0.4.3 dead-seat class: before this slice a dead or
// compacted seat parked a workflow step forever because NO deadline
// existed anywhere in the workflow domain. This evaluator derives a
// stuck/overdue verdict for an instance from queue mechanics the
// system already records — it introduces NO new clock, NO new stored
// state, and NO queue-layer change.
//
// STUCK IS DERIVED STATE, NEVER STORED (ACK plan commit 2): every
// caller (keepalive policy, boot sweep, list/show/trace surfaces)
// recomputes the verdict from (instance, frontier packets, now); a
// normal re-projection therefore self-clears the stuck marker (the
// FR-2 AC) and nothing can go stale. BR-1 holds: this evaluator is
// consumed by observability + nudge paths ONLY — never by a routing
// decision.
//
// THE ANCHOR CLASSIFICATION (arch gate-leg ruling + third-state note,
// Rev-1; extended by the mode2-tier source discovery, flagged to arch
// 2026-07-06):
//
//   1. CLAIMED with a deadline — state=in-progress and
//      closure_required_at set (computed only at claim,
//      queue-repository.ts:858-870). Anchor = closure_required_at.
//      NOTE: workflow step packets ship with tier "mode2", which has
//      no TIER_SLA_SECONDS entry, so TODAY this sub-state is empty for
//      workflow packets — kept because it is the honest anchor the
//      moment tiers change, and the evaluator must never silently
//      ignore a real closure_required_at.
//   2. CLAIMED with NO deadline — state=in-progress,
//      closure_required_at NULL (the mode2 reality). Anchor =
//      claimed_at + WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS.
//   3. NEVER-CLAIMED — state=pending, never claimed (the
//      dead-seat-BEFORE-claim / lost-nudge case: the projector creates
//      the next packet PENDING in-txn and nudges only post-commit, so
//      a dead owner leaves it unclaimed forever). Anchor =
//      created_at + threshold.
//   4. UNCLAIMED-AFTER-CLAIM (the arch third state) — state=pending
//      after an unclaim, which NULLs claimed_at AND
//      closure_required_at (queue-repository.ts:908-917), making the
//      row indistinguishable from never-claimed. Anchor = created_at +
//      threshold — deliberately INCLUDING the elapsed claimed period,
//      so the packet may surface overdue immediately after unclaim.
//      That direction is safe (early nudge noise beats silent parking;
//      BR-4 — nothing blocks). Claim history remains recoverable via
//      queue_transitions; callers that render evidence may enrich from
//      there.
//
// A `blocked` frontier packet (a waiting park) is HEALTHY here: the
// park is an honest recorded state and waiting instances are already
// keepalive-eligible; park-duration policy is WF-5's lane.

// Structural views: the evaluator needs only these fields, so callers
// (projector-adjacent surfaces pass full WorkflowInstance/QueueItem;
// the keepalive policy passes its own minimal row mappings) satisfy
// them structurally without fake-casting full objects.
export interface DeadlineInstanceView {
  instanceId: string;
  status: string;
  currentFrontier: string[];
  currentStepId: string | null;
}

export interface DeadlinePacketView {
  qitemId: string;
  state: string;
  destinationSession: string;
  tsCreated: string;
  claimedAt: string | null;
  closureRequiredAt: string | null;
}

/**
 * THE single threshold home (arch gate-leg ruling: EXPORTED, documented
 * as the one place this number lives — WF-5's class-(b) stuck/overdue
 * thresholds bind to this constant by ruling; they never redefine it).
 *
 * Derivation: the shipped routine-tier SLA (TIER_SLA_SECONDS.routine =
 * 4h in hot-potato-enforcer.ts — module-private there, so the value is
 * restated rather than imported; the derivation is this sentence).
 * Workflow step packets carry tier "mode2" with no SLA entry, so this
 * constant is the effective deadline for both unclaimed anchors and
 * the claimed-null-deadline anchor.
 */
export const WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS = 4 * 60 * 60;

export type WorkflowStepDeadlineState =
  | "healthy"
  | "overdue-claimed"
  | "overdue-unclaimed";

export interface WorkflowStepDeadlineEvidence {
  instanceId: string;
  /** The instance's durable current step binding (may be null pre-R2). */
  stepId: string | null;
  packetId: string;
  ownerSession: string;
  packetState: string;
  /** Which anchor classified this packet (the JSDoc classification). */
  anchor: "closure_required_at" | "claimed_at" | "created_at";
  /** ISO timestamp the anchor points at (deadline or anchor start). */
  anchorAt: string;
  /** Seconds past the effective deadline (>= 0 when overdue). */
  overdueBySeconds: number;
  /** Age of the packet since creation, seconds. */
  ageSeconds: number;
  /** claimed_at when the row still carries it (sub-states 1/2). */
  claimedAt: string | null;
}

export interface WorkflowDeadlineVerdict {
  state: WorkflowStepDeadlineState;
  /** Present iff state != healthy. */
  evidence: WorkflowStepDeadlineEvidence | null;
}

/**
 * Evaluate one instance's frontier against the deadline model. Pure:
 * (instance, packets, now) -> verdict. `packets` are the queue rows
 * for instance.currentFrontier (missing rows are ignored — a frontier
 * id that no longer resolves is a different corruption class, guarded
 * elsewhere).
 *
 * Only `active` and `waiting` instances can be overdue; terminal
 * instances are always healthy (nothing to nudge).
 */
export function evaluateStepDeadline(
  instance: DeadlineInstanceView,
  packets: Array<DeadlinePacketView | null | undefined>,
  now: Date,
): WorkflowDeadlineVerdict {
  if (instance.status !== "active" && instance.status !== "waiting") {
    return { state: "healthy", evidence: null };
  }
  const nowMs = now.getTime();
  const thresholdMs = WORKFLOW_STEP_STUCK_THRESHOLD_SECONDS * 1000;

  for (const packet of packets) {
    if (!packet) continue;
    if (!instance.currentFrontier.includes(packet.qitemId)) continue;

    if (packet.state === "in-progress") {
      // Sub-states 1 + 2: claimed.
      const deadlineMs = packet.closureRequiredAt
        ? new Date(packet.closureRequiredAt).getTime()
        : packet.claimedAt
          ? new Date(packet.claimedAt).getTime() + thresholdMs
          : new Date(packet.tsCreated).getTime() + thresholdMs;
      if (nowMs >= deadlineMs) {
        return {
          state: "overdue-claimed",
          evidence: buildEvidence(instance, packet, nowMs, {
            anchor: packet.closureRequiredAt
              ? "closure_required_at"
              : packet.claimedAt
                ? "claimed_at"
                : "created_at",
            anchorAt:
              packet.closureRequiredAt ??
              packet.claimedAt ??
              packet.tsCreated,
            deadlineMs,
          }),
        };
      }
    } else if (packet.state === "pending") {
      // Sub-states 3 + 4: never-claimed OR unclaimed-after-claim
      // (indistinguishable at the row after unclaim NULLs claimed_at;
      // both deliberately anchor on created_at).
      const deadlineMs = new Date(packet.tsCreated).getTime() + thresholdMs;
      if (nowMs >= deadlineMs) {
        return {
          state: "overdue-unclaimed",
          evidence: buildEvidence(instance, packet, nowMs, {
            anchor: "created_at",
            anchorAt: packet.tsCreated,
            deadlineMs,
          }),
        };
      }
    }
    // `blocked` (waiting park) and any closed state on the frontier:
    // healthy by classification.
  }
  return { state: "healthy", evidence: null };
}

function buildEvidence(
  instance: DeadlineInstanceView,
  packet: DeadlinePacketView,
  nowMs: number,
  input: {
    anchor: WorkflowStepDeadlineEvidence["anchor"];
    anchorAt: string;
    deadlineMs: number;
  },
): WorkflowStepDeadlineEvidence {
  return {
    instanceId: instance.instanceId,
    stepId: instance.currentStepId,
    packetId: packet.qitemId,
    ownerSession: packet.destinationSession,
    packetState: packet.state,
    anchor: input.anchor,
    anchorAt: input.anchorAt,
    overdueBySeconds: Math.max(0, Math.floor((nowMs - input.deadlineMs) / 1000)),
    ageSeconds: Math.max(
      0,
      Math.floor((nowMs - new Date(packet.tsCreated).getTime()) / 1000),
    ),
    claimedAt: packet.claimedAt,
  };
}

/**
 * FR-6 (G4) helper: the max_hops comparison, structured against an
 * EFFECTIVE BASELINE (arch N1 ruling). v1 pins baseline = 0
 * (MAX_HOPS_BASELINE_V1); WF-5 FR-4's resume later amends the baseline
 * so each redrive gets one bounded window — this helper is the seam,
 * never hard-welded to lifetime-total.
 *
 * Returns true when executing ONE MORE hop would exceed the guard.
 */
export const MAX_HOPS_BASELINE_V1 = 0;

export function exceedsMaxHops(
  hopCount: number,
  baseline: number,
  maxHops: number | undefined,
): boolean {
  // Guard blocker 2 hardening: only an ENFORCEABLE guard compares.
  // The parser rejects malformed values going forward; this check
  // protects against pre-fix cached spec_json blobs (a string would
  // silently never trip; a null would coerce to 0 and ALWAYS trip).
  if (typeof maxHops !== "number" || !Number.isInteger(maxHops) || maxHops < 1) {
    return false;
  }
  return hopCount + 1 - baseline > maxHops;
}
