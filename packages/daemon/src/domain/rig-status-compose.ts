// OPR.0.4.3.22 — rig-status compose (a pure FOLD of per-seat backend truths).
//
// This is the daemon side of the rig-status + launch-control UI. It is NOT a new
// restore pipeline and NOT slice-20's ledger. It folds four SHIPPED signals into
// a single `{ status, perSeat[], src[] }` object the UI renders:
//
//   1. ps-lifecycle       — per-node `lifecycleState` (running/detached/recoverable/attention).
//   2. restore-plan       — `buildRestorePlanPreview` per-seat forecast (tokenState + intendedAction).
//   3. restore-check      — `RecoveryPlan.status` readiness (blocked / actionable / unknown).
//   4. kernel-status      — `KernelState` (folded only for the kernel rig; NEVER daemon /healthz).
//
// THE LOCK (founder/PM): the aggregate is a pure FOLD of per-seat truths — a rig
// NEVER globally flips to `fresh`. "fresh" is only ever `freshLogicalIds` (a
// per-seat list threaded by the backend). This module derives an aggregate that
// READS `blocked`/`partial` BECAUSE individual seats are blocked; it never
// repaints the per-seat truths (a global-fresh flip would be the UI form of the
// silent-fresh-prime behavior FR-7 just removed). The compose function does NOT
// mutate its input plan — the seats that WOULD resume stay `resume-original`.
//
// `src[]` is the composed provenance (which signals folded, with their values) —
// the "composed, not inferred; source state visible in debug/test" contract. It
// is derived from real backend data, never from pane text.

import type { NodeLifecycleState } from "./types.js";
import type { RestorePlanPreview } from "./restore-plan-preview.js";
import type { ResumeTokenState } from "./restore-plan-preview.js";
import type { RecoveryPlan } from "./restore-check-service.js";
import type { KernelState } from "./kernel-boot-tracker.js";
import { deriveRigLifecycleState } from "./ps-projection.js";

/** The composed rig-level aggregate. A pure fold — never a verdict that
 *  overwrites per-seat truth. */
export type RigAggStatus = "up" | "partial" | "down" | "blocked" | "unknown";

export interface RigStatusSeat {
  logicalId: string;
  runtime: string | null;
  /** Live process lifecycle (ps-projection). */
  lifecycleState: NodeLifecycleState;
  /** Read-only restore-plan forecast (restore-plan-preview). */
  tokenState: ResumeTokenState;
  intendedAction: "resume-original" | "fresh-primed" | "awaiting-decision";
  freshRequired: boolean;
  /** True when THIS seat blocks a restore-original (awaiting-decision) — the
   *  per-seat blocker that folds up to the aggregate `blocked`. */
  blocked: boolean;
  provenance?: string | null;
  lastVerified?: string | null;
  reason?: string;
  runtimePrompt?: string;
}

export interface RigStatusObject {
  rigId: string;
  rigName: string;
  isKernel: boolean;
  status: RigAggStatus;
  seatsTotal: number;
  seatsRunning: number;
  /** true when the rig can be recovered without operator action (down/partial);
   *  false when blocked (needs a decision) or already up. */
  recoverable: boolean;
  perSeat: RigStatusSeat[];
  /** Composed provenance — the folded signals + their values. Visible in the UI
   *  `src:` line and in debug/test output (the non-inference contract). */
  src: string[];
}

export interface SeatLifecycleInput {
  logicalId: string;
  runtime: string | null;
  lifecycleState: NodeLifecycleState;
}

export interface ComposeRigStatusInput {
  rigId: string;
  rigName: string;
  isKernel?: boolean;
  /** Per-node ps-lifecycle truth (from node-inventory). */
  nodes: SeatLifecycleInput[];
  /** Read-only restore-plan forecast (buildRestorePlanPreview) — NOT mutated. */
  plan: RestorePlanPreview;
  /** restore-check recovery readiness for this rig (optional; folded when present). */
  recovery?: RecoveryPlan | null;
  /** kernel-status state — folded ONLY for the kernel rig (never /healthz). */
  kernelState?: KernelState | null;
}

/** Kernel states that require an explicit operator action (a real blocker). */
function kernelIsBlocked(state: KernelState): boolean {
  return state === "auth_blocked" || state === "spec_missing" || state === "bootstrap_failed";
}

/** Map a kernel state to an aggregate (used only for the kernel rig). Returns
 *  null for `skipped` — the caller then folds the lifecycle instead. */
function kernelAggregate(state: KernelState): RigAggStatus | null {
  switch (state) {
    case "ready":
      return "up";
    case "booting":
    case "partial_ready":
    case "degraded":
      return "partial";
    case "auth_blocked":
    case "spec_missing":
    case "bootstrap_failed":
      return "blocked";
    case "skipped":
      return null;
  }
}

/** Fold the four backend signals into a single rig-status object. Pure — does
 *  NOT mutate the input plan (the resumable seats stay resume-original). */
export function composeRigStatus(input: ComposeRigStatusInput): RigStatusObject {
  const { rigId, rigName, nodes, plan, recovery, kernelState } = input;
  const isKernel = input.isKernel ?? false;

  // Join ps-lifecycle nodes with the restore-plan forecast (per logicalId).
  const planByLogicalId = new Map(plan.nodes.map((n) => [n.logicalId, n]));
  const perSeat: RigStatusSeat[] = nodes.map((node) => {
    const p = planByLogicalId.get(node.logicalId);
    const intendedAction = p?.intendedAction ?? "awaiting-decision";
    const tokenState: ResumeTokenState = p?.tokenState ?? "unverified";
    const blocked = intendedAction === "awaiting-decision";
    return {
      logicalId: node.logicalId,
      runtime: node.runtime,
      lifecycleState: node.lifecycleState,
      tokenState,
      intendedAction,
      freshRequired: p?.freshRequired ?? false,
      blocked,
      provenance: p?.provenance ?? null,
      lastVerified: p?.lastVerified ?? null,
      ...(p?.reason ? { reason: p.reason } : {}),
      ...(p?.runtimePrompt ? { runtimePrompt: p.runtimePrompt } : {}),
    };
  });

  const seatsTotal = nodes.length;
  const seatsRunning = nodes.filter((n) => n.lifecycleState === "running").length;
  const lifecycle = deriveRigLifecycleState(nodes.map((n) => n.lifecycleState));

  // --- Aggregate fold (precedence: blocked > unknown > lifecycle/kernel) ------
  // ANY blocked seat (awaiting-decision / restore-check blocker / kernel auth/spec/
  // bootstrap failure) → aggregate `blocked`. This is the LOCK's money case: a
  // rig with resumable AND blocked seats reads `blocked` BECAUSE seats are
  // blocked — the resumable seats remain resume-original in perSeat.
  const anySeatBlocked = perSeat.some((s) => s.blocked);
  const recoveryBlocked = recovery?.status === "blocked";
  const kernelBlocked = isKernel && kernelState != null && kernelIsBlocked(kernelState);

  let status: RigAggStatus;
  if (anySeatBlocked || recoveryBlocked || kernelBlocked) {
    status = "blocked";
  } else if (recovery?.status === "unknown") {
    status = "unknown";
  } else {
    // Kernel rig: kernel-status drives the non-blocked aggregate (never lifecycle
    // alone, never /healthz). Falls back to the lifecycle fold when skipped.
    const kernelAgg = isKernel && kernelState != null ? kernelAggregate(kernelState) : null;
    if (kernelAgg) {
      status = kernelAgg;
    } else {
      status = lifecycleToAggregate(lifecycle);
    }
  }

  const recoverable = status === "down" || status === "partial";

  // --- src[] provenance (composed, not inferred) -----------------------------
  const actionCounts = countActions(perSeat);
  const src: string[] = [
    `ps: ${seatsRunning}/${seatsTotal} running · lifecycle=${lifecycle}`,
    `restore-plan: ${actionCounts}`,
  ];
  if (recovery) src.push(`restore-check: ${recovery.status}`);
  if (isKernel && kernelState != null) src.push(`kernel-status.kernel_state=${kernelState}`);

  return {
    rigId,
    rigName,
    isKernel,
    status,
    seatsTotal,
    seatsRunning,
    recoverable,
    perSeat,
    src,
  };
}

function lifecycleToAggregate(lifecycle: ReturnType<typeof deriveRigLifecycleState>): RigAggStatus {
  switch (lifecycle) {
    case "running":
      return "up";
    case "degraded":
    case "attention_required":
      return "partial";
    case "recoverable":
    case "stopped":
      return "down";
  }
}

function countActions(perSeat: RigStatusSeat[]): string {
  const counts = { "resume-original": 0, "fresh-primed": 0, "awaiting-decision": 0 };
  for (const s of perSeat) counts[s.intendedAction] += 1;
  const parts: string[] = [];
  if (counts["resume-original"]) parts.push(`${counts["resume-original"]} resume-original`);
  if (counts["fresh-primed"]) parts.push(`${counts["fresh-primed"]} fresh-primed`);
  if (counts["awaiting-decision"]) parts.push(`${counts["awaiting-decision"]} awaiting-decision`);
  return parts.length > 0 ? parts.join(", ") : "no seats";
}
