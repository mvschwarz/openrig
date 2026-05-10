// Slice Story View v1 — workflow_spec → per-tab payload projection.
//
// Given a SliceWorkflowBinding (the resolved instance) and the bound
// WorkflowSpec (read through Phase D's WorkflowSpecCache), project the
// four v1-floor dimensions:
//
//   1. specGraph — nodes (one per step) + edges (from each step's
//      next_hop.suggested_roles → next-step ids). All edges carry
//      routingType: "direct" because Phase D's spec format does NOT
//      yet have a routing_type field (per audit row 6 carve-out:
//      dimension #4 ships as default-styled solid edges only;
//      routing-type metadata is v2+).
//   2. phaseDefinitions — step.id → { label, role } so the Story tab
//      can group events by spec-declared phase tags. Replaces v0's
//      hardcoded legacy phase taxonomy with spec-driven mapping.
//   3. currentStep — bound instance's current_step_id resolved against
//      the spec, returning step.objective + allowed_exits + the
//      enumerated next-step destinations from next_hop.
//   4. eventPhaseFor(stepId) — convenience used by SliceDetailProjector
//      to tag each StoryEvent with the spec's phase id when the event
//      can be mapped to a step (via workflow_step_trails join). When
//      there is no mapping, the event stays untagged (UI renders it in
//      the "Other" or "Untagged" group).

import type { WorkflowSpec, WorkflowStepSpec } from "../workflow-types.js";

export interface SpecGraphNode {
  /** step.id (e.g., "discovery"). */
  stepId: string;
  /** Display label = step.role title with id fallback. */
  label: string;
  /** step.actor_role (e.g., "discovery-router"). */
  role: string;
  /** First preferred_target seat for this role, when declared. UI uses
   *  this to compose PL-019 activity indicators on the spec node. */
  preferredTarget: string | null;
  /** True for the spec's entry step (the one workflow_instance starts on). */
  isEntry: boolean;
  /** True when this is the active step on the bound instance. */
  isCurrent: boolean;
  /** True when this step has no next_hop pointing forward (possible terminal). */
  isTerminal: boolean;
}

export interface SpecGraphEdge {
  fromStepId: string;
  toStepId: string;
  /** "direct" only at v1 — Phase D's spec format does not carry
   *  routing_type yet (audit row 6 carve-out). */
  routingType: "direct";
  /** True when this edge is the loop-back edge (target step earlier in
   *  declared order than source). UI uses this to optionally curve the
   *  edge differently from forward edges. */
  isLoopBack: boolean;
}

export interface SpecGraphPayload {
  specName: string;
  specVersion: string;
  nodes: SpecGraphNode[];
  edges: SpecGraphEdge[];
}

export interface PhaseDefinition {
  /** step.id (the canonical phase tag). */
  id: string;
  /** Human label = role title fallback to step.id. */
  label: string;
  role: string;
}

export interface CurrentStepPayload {
  stepId: string;
  role: string;
  objective: string | null;
  /** Phase D's WorkflowStepSpec.allowed_exits enum subset. */
  allowedExits: string[];
  /** Resolved next-step destinations from next_hop.suggested_roles
   *  mapped back to step ids. Empty array when no next_hop or no roles. */
  allowedNextSteps: Array<{ stepId: string; role: string; reason: "next_hop" }>;
  hopCount: number;
  instanceStatus: string;
}

/**
 * Projects the spec graph for the Topology tab. Nodes are ordered by
 * the spec's declared step order; edges are derived from each step's
 * next_hop.suggested_roles list resolved back to step ids.
 */
export function projectSpecGraph(
  spec: WorkflowSpec,
  currentStepId: string | null,
): SpecGraphPayload {
  const declaredOrder = spec.steps.map((s) => s.id);
  const stepByRole = new Map<string, WorkflowStepSpec>();
  for (const step of spec.steps) {
    if (!stepByRole.has(step.actor_role)) stepByRole.set(step.actor_role, step);
  }

  const entryRole = spec.entry?.role ?? spec.steps[0]?.actor_role;
  const entryStepId = entryRole ? stepByRole.get(entryRole)?.id : undefined;

  const nodes: SpecGraphNode[] = spec.steps.map((step) => {
    const roleSpec = (spec.roles as Record<string, { preferred_targets?: string[] }>)[step.actor_role] ?? {};
    const firstTarget = roleSpec.preferred_targets?.[0] ?? null;
    return {
      stepId: step.id,
      label: step.actor_role,
      role: step.actor_role,
      preferredTarget: firstTarget,
      isEntry: step.id === entryStepId,
      isCurrent: step.id === currentStepId,
      isTerminal: !hasNextHop(step),
    };
  });

  const edges: SpecGraphEdge[] = [];
  for (const step of spec.steps) {
    const suggestedRoles = step.next_hop?.suggested_roles ?? [];
    for (const role of suggestedRoles) {
      const target = stepByRole.get(role);
      if (!target) continue;
      const fromIdx = declaredOrder.indexOf(step.id);
      const toIdx = declaredOrder.indexOf(target.id);
      edges.push({
        fromStepId: step.id,
        toStepId: target.id,
        routingType: "direct",
        isLoopBack: toIdx >= 0 && fromIdx >= 0 && toIdx <= fromIdx,
      });
    }
  }

  return {
    specName: spec.id,
    specVersion: spec.version,
    nodes,
    edges,
  };
}

/**
 * Projects the spec's phase definitions. Each step contributes one phase
 * (canonical tag = step.id; label = step.actor_role). The Story tab
 * groups events by phase id when a step trail exists for the event's
 * qitem; events without a trail mapping render in an "untagged" group
 * (the UI decides the literal label).
 */
export function projectPhaseDefinitions(spec: WorkflowSpec): PhaseDefinition[] {
  return spec.steps.map((step) => ({
    id: step.id,
    label: step.actor_role,
    role: step.actor_role,
  }));
}

/**
 * Projects the Current Step payload from the spec + the bound instance's
 * current_step_id. Returns null when current_step_id is null (terminal
 * instance) or doesn't resolve against the spec (instance instantiated
 * against a different spec version that has since changed shape — UI
 * surfaces this as "current step unknown").
 */
export function projectCurrentStep(
  spec: WorkflowSpec,
  currentStepId: string | null,
  hopCount: number,
  instanceStatus: string,
): CurrentStepPayload | null {
  if (!currentStepId) return null;
  const step = spec.steps.find((s) => s.id === currentStepId);
  if (!step) return null;
  const stepByRole = new Map<string, WorkflowStepSpec>();
  for (const s of spec.steps) {
    if (!stepByRole.has(s.actor_role)) stepByRole.set(s.actor_role, s);
  }
  const allowedNextSteps: CurrentStepPayload["allowedNextSteps"] = [];
  for (const role of step.next_hop?.suggested_roles ?? []) {
    const target = stepByRole.get(role);
    if (!target) continue;
    allowedNextSteps.push({ stepId: target.id, role, reason: "next_hop" });
  }
  return {
    stepId: step.id,
    role: step.actor_role,
    objective: step.objective ?? null,
    allowedExits: [...(step.allowed_exits ?? [])],
    allowedNextSteps,
    hopCount,
    instanceStatus,
  };
}

function hasNextHop(step: WorkflowStepSpec): boolean {
  return (step.next_hop?.suggested_roles ?? []).length > 0;
}
