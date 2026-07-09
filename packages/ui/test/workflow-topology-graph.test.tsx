// OPR.0.4.6.WF4 (C3b) — the shape renderer's binding pins:
//  - Q-B: handle assignment is a PURE FUNCTION of the edge record (via the
//    set-determined shortest-path depth) — permuting the edges array yields an
//    IDENTICAL assignment (the permutation-invariance "unit vector"), and a
//    reciprocal pair docks DISTINCT lanes so it never overlaps (WF4-F4).
//  - zero-instance: the extracted component renders (overlay props absent = the
//    base render; the additive overlay is the only instance-dependent surface).

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import {
  WorkflowTopologyGraph,
  computeStepDepths,
  assignEdgeHandles,
} from "../src/components/workflow/WorkflowTopologyGraph.js";
import type { LibraryWorkflowReview } from "../src/hooks/useSpecLibrary.js";

type Topology = LibraryWorkflowReview["topology"];

const node = (stepId: string, over: Partial<Topology["nodes"][number]> = {}): Topology["nodes"][number] => ({
  stepId,
  role: `${stepId}-role`,
  objective: null,
  preferredTarget: null,
  isEntry: false,
  isTerminal: false,
  ...over,
});

// A → B with a reciprocal branch B → A (the remediation-loop shape, WF4-F4),
// plus a forward B → C. B→A is the back-edge.
const RECIPROCAL: Topology = {
  nodes: [node("A", { isEntry: true }), node("B"), node("C", { isTerminal: true })],
  edges: [
    { fromStepId: "A", toStepId: "B", routingType: "direct" },
    { fromStepId: "B", toStepId: "A", routingType: "branch", branchOn: "failed" },
    { fromStepId: "B", toStepId: "C", routingType: "direct" },
  ],
};

function handleVector(topology: Topology): Record<string, string> {
  const depth = computeStepDepths(topology);
  const vec: Record<string, string> = {};
  for (const e of topology.edges) {
    const { sourceHandle, targetHandle } = assignEdgeHandles(e.fromStepId, e.toStepId, depth);
    vec[`${e.fromStepId}→${e.toStepId}`] = `${sourceHandle}|${targetHandle}`;
  }
  return vec;
}

afterEach(() => cleanup());

describe("WF-4 Q-B: pure handle assignment", () => {
  it("computeStepDepths is shortest-path from entry (A=0, B=1, C=2)", () => {
    const d = computeStepDepths(RECIPROCAL);
    expect(d.get("A")).toBe(0);
    expect(d.get("B")).toBe(1);
    expect(d.get("C")).toBe(2);
  });

  it("a forward edge docks the top/bottom lane; a back-edge docks the side lane", () => {
    const d = computeStepDepths(RECIPROCAL);
    expect(assignEdgeHandles("A", "B", d)).toEqual({ sourceHandle: "out-bottom", targetHandle: "in-top" });
    // B→A goes UP (depth A < depth B) → the side lane, NOT the forward lane.
    expect(assignEdgeHandles("B", "A", d)).toEqual({ sourceHandle: "out-side", targetHandle: "in-side" });
  });

  it("a reciprocal pair docks DISTINCT lanes (WF4-F4: no overlap into one line)", () => {
    const d = computeStepDepths(RECIPROCAL);
    const forward = assignEdgeHandles("A", "B", d);
    const back = assignEdgeHandles("B", "A", d);
    expect(forward).not.toEqual(back);
  });

  it("PERMUTATION-INVARIANT — the full handle vector is identical for any edge ORDER (same edge SET)", () => {
    const original = handleVector(RECIPROCAL);
    // Reverse the edges array — the SET is unchanged.
    const permuted: Topology = { nodes: RECIPROCAL.nodes, edges: [...RECIPROCAL.edges].reverse() };
    expect(handleVector(permuted)).toEqual(original);
    // And a rotation.
    const rotated: Topology = {
      nodes: RECIPROCAL.nodes,
      edges: [RECIPROCAL.edges[2]!, RECIPROCAL.edges[0]!, RECIPROCAL.edges[1]!],
    };
    expect(handleVector(rotated)).toEqual(original);
  });

  it("computeStepDepths itself is edge-order-independent", () => {
    const a = computeStepDepths(RECIPROCAL);
    const b = computeStepDepths({ nodes: RECIPROCAL.nodes, edges: [...RECIPROCAL.edges].reverse() });
    expect([...a.entries()].sort()).toEqual([...b.entries()].sort());
  });
});

describe("WF-4: the extracted renderer", () => {
  it("renders the shape canvas with ZERO instance-overlay props (the base/zero-instance render)", () => {
    const { getByTestId } = render(<WorkflowTopologyGraph topology={RECIPROCAL} />);
    expect(getByTestId("workflow-topology-graph")).toBeTruthy();
  });

  it("renders with instance-overlay props (current/visited/taken) without crashing", () => {
    const { getByTestId } = render(
      <WorkflowTopologyGraph
        topology={RECIPROCAL}
        currentStepId="B"
        visitedStepIds={["A"]}
        takenEdgeKeys={["A→B"]}
      />,
    );
    expect(getByTestId("workflow-topology-graph")).toBeTruthy();
  });
});
