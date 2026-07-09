// OPR.0.4.6.WF5 FR-2: the maturity dial — exception ROUTING (v1.3 founder
// inversion). CLASSIFICATION ≠ ROUTING: workflow-exception.ts detects;
// this module maps class → target, deterministically.
//
// THE DIAL CHAIN (arch-ruled, in order):
//   1. the spec's declared per-CLASS position   (exception_routing.classes)
//   2. the spec's declared per-WORKFLOW default (exception_routing.default)
//   3. the host-level dial default              (settings key
//      `workflow.exception_routing` — the MH-1 dynamic-key pattern;
//      READ BY THE CALLER and passed in: this module stays pure)
//   4. absent everywhere → ORCHESTRATOR-FIRST (the v1.3 engine default)
//
// Position → target:
//   orchestrator → the spec-declared orchestrator role, resolved through
//     the SAME shipped role→preferred_targets mechanism step owners use
//     (caller passes the resolver — no new resolution machinery, no
//     binding-layer dependency). Unresolvable → THE NEVER-LOST FALLBACK:
//     the human seat (an exception NEVER fails to route).
//   human_only → the human seat FIRST, and it GATES there (the
//     orchestrator never auto-acts). Class (c) is intrinsically
//     human-only — its WF-2-compiled park IS the item; FR-2 mints no
//     second one, so class (c) never reaches item creation here.
//
// THE TIER SPLIT (arch re-rule sharpening; guard's fence): the shipped
// attention union matches ON TIER regardless of destination, so
// `tier='human-gate'` rides ONLY human-routed positions (human_only ·
// the fallback · class-c); an orchestrator-routed item carries the
// ordinary workflow tier. The shape splits HERE, in this module — the
// shipped attention predicate is never edited by this slice.
//
// Dial semantics: same recorded state + same config = same target, every
// time. A dial change applies to FUTURE items only — resolution runs
// exactly once, at item creation; nothing re-routes live items.

import type { WorkflowExceptionClass } from "./workflow-exception.js";
import type { WorkflowExceptionDialPosition, WorkflowSpec } from "./workflow-types.js";

/** The ordinary workflow-packet tier (the shipped default the attention
 *  union deliberately does NOT match on). */
export const WORKFLOW_EXCEPTION_ORCHESTRATOR_TIER = "mode2";
/** The human-routed tier — the attention union's first leg. */
export const WORKFLOW_EXCEPTION_HUMAN_TIER = "human-gate";

export interface ExceptionRouteInput {
  exceptionClass: WorkflowExceptionClass;
  spec: Pick<WorkflowSpec, "exception_routing" | "roles">;
  /** The host-level dial default (settings `workflow.exception_routing`),
   *  read by the caller; null = key unset. */
  hostDialDefault: WorkflowExceptionDialPosition | null;
  /** The shipped role→preferred_targets resolution, wrapped by the caller
   *  (workflow-runtime owns runtime matching). null = unresolvable. */
  resolveRoleTarget: (roleName: string) => string | null;
  /** The honest never-lost fallback seat (human@<host> form). */
  humanFallbackSeat: string;
}

export interface ExceptionRoute {
  /** Where the chain landed. `fallback` = orchestrator position whose
   *  role target did not resolve (still never lost). */
  position: "orchestrator" | "human_only" | "fallback";
  destinationSession: string;
  /** THE TIER SPLIT — human-gate iff humanRouted. */
  tier: string;
  humanRouted: boolean;
  /** Which chain link decided the position (recorded in item evidence —
   *  the dial walks assert it). */
  resolvedVia: "class-intrinsic" | "class-declared" | "workflow-declared" | "host-default" | "engine-default";
}

export function resolveExceptionRoute(input: ExceptionRouteInput): ExceptionRoute {
  // Class (c) is intrinsically human-only by its nature (a human decision
  // IS the exception); the dial cannot re-point it.
  let position: WorkflowExceptionDialPosition;
  let resolvedVia: ExceptionRoute["resolvedVia"];
  const routing = input.spec.exception_routing;
  if (input.exceptionClass === "human_gate_trip") {
    position = "human_only";
    resolvedVia = "class-intrinsic";
  } else if (routing?.classes?.[input.exceptionClass]) {
    position = routing.classes[input.exceptionClass]!;
    resolvedVia = "class-declared";
  } else if (routing?.default) {
    position = routing.default;
    resolvedVia = "workflow-declared";
  } else if (input.hostDialDefault) {
    position = input.hostDialDefault;
    resolvedVia = "host-default";
  } else {
    position = "orchestrator";
    resolvedVia = "engine-default";
  }

  if (position === "human_only") {
    return {
      position: "human_only",
      destinationSession: input.humanFallbackSeat,
      tier: WORKFLOW_EXCEPTION_HUMAN_TIER,
      humanRouted: true,
      resolvedVia,
    };
  }

  // orchestrator position: resolve the declared orchestrator role via the
  // shipped mechanism; unresolvable (no role declared, role unknown, or
  // no target) = the never-lost human fallback.
  const roleName = routing?.orchestrator_role;
  const target = roleName ? input.resolveRoleTarget(roleName) : null;
  if (!target) {
    return {
      position: "fallback",
      destinationSession: input.humanFallbackSeat,
      tier: WORKFLOW_EXCEPTION_HUMAN_TIER,
      humanRouted: true,
      resolvedVia,
    };
  }
  return {
    position: "orchestrator",
    destinationSession: target,
    tier: WORKFLOW_EXCEPTION_ORCHESTRATOR_TIER,
    humanRouted: false,
    resolvedVia,
  };
}
