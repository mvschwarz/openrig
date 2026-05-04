// Slice Story View v1 — workflow_spec → per-tab projection helpers.
//
// Pins the load-bearing behaviors of:
//   - projectSpecGraph: nodes from spec.steps; edges from each step's
//     next_hop.suggested_roles; isCurrent / isEntry / isTerminal flags;
//     loop-back detection by declared step order
//   - projectPhaseDefinitions: one entry per spec step, in declared
//     order, with role label
//   - projectCurrentStep: current_step_id resolves; allowed_exits +
//     next_hop suggested_roles → allowed_next_steps; null when
//     current_step_id is null or doesn't resolve

import { describe, it, expect } from "vitest";
import type { WorkflowSpec } from "../src/domain/workflow-types.js";
import {
  projectSpecGraph,
  projectPhaseDefinitions,
  projectCurrentStep,
} from "../src/domain/workflow/slice-workflow-projection.js";

const RSI_LIKE_SPEC: WorkflowSpec = {
  id: "test-loop",
  version: "1",
  objective: "test",
  entry: { role: "discovery-router" },
  invariants: { allowed_exits: ["handoff", "waiting", "done", "failed"] },
  roles: {
    "discovery-router": { preferred_targets: ["intake@r"] },
    "product-lab-planner": { preferred_targets: ["planner@r"] },
    "delivery-driver": { preferred_targets: ["driver@r"] },
    "qa-tester": { preferred_targets: ["qa@r"] },
  },
  steps: [
    {
      id: "discovery", actor_role: "discovery-router", objective: "scope candidates",
      allowed_exits: ["handoff", "waiting", "failed"],
      next_hop: { mode: "prefer", suggested_roles: ["product-lab-planner"] },
    },
    {
      id: "product-lab", actor_role: "product-lab-planner", objective: "shape slice",
      allowed_exits: ["handoff", "waiting", "failed"],
      next_hop: { mode: "prefer", suggested_roles: ["delivery-driver"] },
    },
    {
      id: "delivery", actor_role: "delivery-driver", objective: "implement",
      allowed_exits: ["handoff", "waiting", "failed"],
      next_hop: { mode: "prefer", suggested_roles: ["qa-tester"] },
    },
    {
      id: "qa", actor_role: "qa-tester", objective: "dogfood + fix-loop",
      allowed_exits: ["handoff", "done", "waiting", "failed"],
      // loop edge — qa can hand back to discovery for follow-up signal
      next_hop: { mode: "prefer", suggested_roles: ["discovery-router"] },
    },
  ],
};

describe("PL-slice-story-view-v1 projectSpecGraph", () => {
  it("emits one node per step in declared order", () => {
    const g = projectSpecGraph(RSI_LIKE_SPEC, null);
    expect(g.nodes.map((n) => n.stepId)).toEqual(["discovery", "product-lab", "delivery", "qa"]);
  });

  it("derives spec name + version on the payload", () => {
    const g = projectSpecGraph(RSI_LIKE_SPEC, null);
    expect(g.specName).toBe("test-loop");
    expect(g.specVersion).toBe("1");
  });

  it("emits one edge per (step, next_hop suggested role) pair, resolving roles back to step ids", () => {
    const g = projectSpecGraph(RSI_LIKE_SPEC, null);
    expect(g.edges).toEqual([
      { fromStepId: "discovery", toStepId: "product-lab", routingType: "direct", isLoopBack: false },
      { fromStepId: "product-lab", toStepId: "delivery", routingType: "direct", isLoopBack: false },
      { fromStepId: "delivery", toStepId: "qa", routingType: "direct", isLoopBack: false },
      { fromStepId: "qa", toStepId: "discovery", routingType: "direct", isLoopBack: true },
    ]);
  });

  it("flags isEntry on the spec.entry step (resolved by role)", () => {
    const g = projectSpecGraph(RSI_LIKE_SPEC, null);
    expect(g.nodes.find((n) => n.stepId === "discovery")?.isEntry).toBe(true);
    expect(g.nodes.find((n) => n.stepId === "delivery")?.isEntry).toBe(false);
  });

  it("flags isCurrent only for the named current_step_id", () => {
    const g = projectSpecGraph(RSI_LIKE_SPEC, "delivery");
    expect(g.nodes.find((n) => n.stepId === "delivery")?.isCurrent).toBe(true);
    expect(g.nodes.find((n) => n.stepId === "discovery")?.isCurrent).toBe(false);
    expect(g.nodes.filter((n) => n.isCurrent)).toHaveLength(1);
  });

  it("flags isTerminal=false for steps with next_hop suggestions; true for steps without", () => {
    const allHopSpec: WorkflowSpec = {
      ...RSI_LIKE_SPEC,
      steps: [
        { id: "step-a", actor_role: "discovery-router", allowed_exits: ["handoff"], next_hop: { suggested_roles: ["product-lab-planner"] } },
        { id: "step-b", actor_role: "product-lab-planner", allowed_exits: ["done"] },
      ],
    };
    const g = projectSpecGraph(allHopSpec, null);
    expect(g.nodes.find((n) => n.stepId === "step-a")?.isTerminal).toBe(false);
    expect(g.nodes.find((n) => n.stepId === "step-b")?.isTerminal).toBe(true);
  });

  it("populates preferredTarget from the role's first preferred_targets entry", () => {
    const g = projectSpecGraph(RSI_LIKE_SPEC, null);
    expect(g.nodes.find((n) => n.stepId === "discovery")?.preferredTarget).toBe("intake@r");
    expect(g.nodes.find((n) => n.stepId === "qa")?.preferredTarget).toBe("qa@r");
  });

  it("preferredTarget is null when role has no preferred_targets", () => {
    const noTargetSpec: WorkflowSpec = {
      ...RSI_LIKE_SPEC,
      roles: { "x": {} },
      steps: [{ id: "s1", actor_role: "x", allowed_exits: ["done"] }],
    };
    const g = projectSpecGraph(noTargetSpec, null);
    expect(g.nodes[0]!.preferredTarget).toBeNull();
  });

  it("v1 carve-out: every edge carries routingType=direct (Phase D has no routing_type field yet)", () => {
    const g = projectSpecGraph(RSI_LIKE_SPEC, null);
    for (const edge of g.edges) {
      expect(edge.routingType).toBe("direct");
    }
  });
});

describe("PL-slice-story-view-v1 projectPhaseDefinitions", () => {
  it("emits one phase per step in declared order", () => {
    const phases = projectPhaseDefinitions(RSI_LIKE_SPEC);
    expect(phases.map((p) => p.id)).toEqual(["discovery", "product-lab", "delivery", "qa"]);
  });

  it("phase label = step.actor_role", () => {
    const phases = projectPhaseDefinitions(RSI_LIKE_SPEC);
    expect(phases.find((p) => p.id === "discovery")?.label).toBe("discovery-router");
    expect(phases.find((p) => p.id === "qa")?.label).toBe("qa-tester");
  });
});

describe("PL-slice-story-view-v1 projectCurrentStep", () => {
  it("returns null when current_step_id is null (terminal instance)", () => {
    expect(projectCurrentStep(RSI_LIKE_SPEC, null, 5, "completed")).toBeNull();
  });

  it("returns null when current_step_id doesn't resolve against the spec", () => {
    expect(projectCurrentStep(RSI_LIKE_SPEC, "step-from-different-spec", 1, "active")).toBeNull();
  });

  it("returns step metadata + allowed_next_steps for an in-spec current step", () => {
    const cs = projectCurrentStep(RSI_LIKE_SPEC, "delivery", 3, "active");
    expect(cs).not.toBeNull();
    expect(cs!.stepId).toBe("delivery");
    expect(cs!.role).toBe("delivery-driver");
    expect(cs!.objective).toBe("implement");
    expect(cs!.allowedExits).toEqual(["handoff", "waiting", "failed"]);
    expect(cs!.allowedNextSteps).toEqual([
      { stepId: "qa", role: "qa-tester", reason: "next_hop" },
    ]);
    expect(cs!.hopCount).toBe(3);
    expect(cs!.instanceStatus).toBe("active");
  });

  it("allowedNextSteps empty when step has no next_hop (terminal)", () => {
    const terminalSpec: WorkflowSpec = {
      ...RSI_LIKE_SPEC,
      steps: [
        { id: "only", actor_role: "discovery-router", allowed_exits: ["done"] },
      ],
    };
    const cs = projectCurrentStep(terminalSpec, "only", 0, "active");
    expect(cs!.allowedNextSteps).toEqual([]);
  });

  it("allowedNextSteps for qa step includes the loop-back to discovery", () => {
    const cs = projectCurrentStep(RSI_LIKE_SPEC, "qa", 4, "active");
    expect(cs!.allowedNextSteps).toEqual([
      { stepId: "discovery", role: "discovery-router", reason: "next_hop" },
    ]);
  });
});
