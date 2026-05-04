// PL-019 items 4 + 5: graph projection carries agentActivity + currentQitems
// through InventoryOverlay so UI consumers (RigGraph, Explorer) see activity
// state and in-progress qitem ownership in a single payload.

import { describe, it, expect } from "vitest";
import { projectRigToGraph } from "../src/domain/graph-projection.js";
import type { InventoryOverlay, RigGraphInput } from "../src/domain/graph-projection.js";
import type { Pod, RigWithRelations, Session, AgentActivity } from "../src/domain/types.js";

function makeRig(
  nodes: { id: string; logicalId: string; role?: string; runtime?: string }[],
  edges: { id: string; sourceId: string; targetId: string; kind: string }[] = [],
  sessions: Session[] = [],
  pods: Pod[] = []
): RigGraphInput {
  const rig: RigWithRelations = {
    rig: { id: "rig-1", name: "r01", createdAt: "2026-05-04", updatedAt: "2026-05-04" },
    nodes: nodes.map((n) => ({
      id: n.id,
      rigId: "rig-1",
      logicalId: n.logicalId,
      role: n.role ?? null,
      runtime: n.runtime ?? null,
      model: null,
      cwd: null,
      createdAt: "2026-05-04",
      binding: null,
    })),
    edges: edges.map((e) => ({
      id: e.id,
      rigId: "rig-1",
      sourceId: e.sourceId,
      targetId: e.targetId,
      kind: e.kind,
      createdAt: "2026-05-04",
    })),
  };
  return { ...rig, sessions, pods };
}

function makeRunningSession(nodeId: string): Session {
  return {
    id: `sess-${nodeId}-2026-05-04`,
    nodeId,
    sessionName: `r01-${nodeId}`,
    status: "running",
    lastSeenAt: null,
    createdAt: "2026-05-04",
  };
}

const RUNNING_ACTIVITY: AgentActivity = {
  state: "running",
  reason: "mid_work_pattern",
  evidenceSource: "pane_heuristic",
  sampledAt: "2026-05-04T12:00:00.000Z",
  evidence: "implementing PL-019",
};

describe("PL-019 projectRigToGraph: agentActivity + currentQitems", () => {
  it("projects agentActivity onto the RFNodeData when overlay carries it", () => {
    const input = makeRig(
      [{ id: "n1", logicalId: "alpha", role: "worker" }],
      [],
      [makeRunningSession("n1")]
    );
    const overlay: InventoryOverlay[] = [
      {
        logicalId: "alpha",
        startupStatus: "ready",
        canonicalSessionName: "r01-alpha",
        restoreOutcome: "n-a",
        agentActivity: RUNNING_ACTIVITY,
      },
    ];
    const result = projectRigToGraph(input, overlay);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].data.agentActivity).toEqual(RUNNING_ACTIVITY);
  });

  it("defaults agentActivity to null when overlay omits it", () => {
    const input = makeRig(
      [{ id: "n1", logicalId: "alpha", role: "worker" }],
      [],
      [makeRunningSession("n1")]
    );
    const overlay: InventoryOverlay[] = [
      { logicalId: "alpha", startupStatus: "ready", canonicalSessionName: "r01-alpha", restoreOutcome: "n-a" },
    ];
    const result = projectRigToGraph(input, overlay);
    expect(result.nodes[0].data.agentActivity).toBeNull();
  });

  it("projects currentQitems onto running nodes when overlay carries them", () => {
    const input = makeRig(
      [{ id: "n1", logicalId: "alpha", role: "worker" }],
      [],
      [makeRunningSession("n1")]
    );
    const overlay: InventoryOverlay[] = [
      {
        logicalId: "alpha",
        startupStatus: "ready",
        canonicalSessionName: "r01-alpha",
        restoreOutcome: "n-a",
        agentActivity: RUNNING_ACTIVITY,
        currentQitems: [
          { qitemId: "qitem-20260504001234-aaaa1111", bodyExcerpt: "Audit row 1", tier: "mode2" },
          { qitemId: "qitem-20260504001235-bbbb2222", bodyExcerpt: "Phase A R1", tier: null },
        ],
      },
    ];
    const result = projectRigToGraph(input, overlay);
    const data = result.nodes[0].data;
    expect(data.currentQitems).toHaveLength(2);
    expect(data.currentQitems?.[0].qitemId).toBe("qitem-20260504001234-aaaa1111");
    expect(data.currentQitems?.[0].tier).toBe("mode2");
  });

  it("defaults currentQitems to [] when overlay omits them", () => {
    const input = makeRig(
      [{ id: "n1", logicalId: "alpha", role: "worker" }],
      [],
      [makeRunningSession("n1")]
    );
    const overlay: InventoryOverlay[] = [
      { logicalId: "alpha", startupStatus: "ready", canonicalSessionName: "r01-alpha", restoreOutcome: "n-a" },
    ];
    const result = projectRigToGraph(input, overlay);
    expect(result.nodes[0].data.currentQitems).toEqual([]);
  });

  it("pod group nodes carry null/empty defaults (no inventory mapping)", () => {
    const pod: Pod = {
      id: "pod-1",
      rigId: "rig-1",
      namespace: "demo-ns",
      label: "demo",
      summary: null,
      continuityPolicyJson: null,
      createdAt: "2026-05-04",
    };
    const input = {
      ...makeRig(
        [{ id: "n1", logicalId: "alpha", role: "worker" }],
        [],
        [makeRunningSession("n1")]
      ),
      // Attach pod by mutating the synthesized node:
    };
    input.nodes[0].podId = pod.id;
    input.pods = [pod];
    const result = projectRigToGraph(input);
    const podNode = result.nodes.find((n) => n.id.startsWith("pod-"));
    expect(podNode).toBeDefined();
    expect(podNode!.data.agentActivity).toBeNull();
    expect(podNode!.data.currentQitems).toEqual([]);
  });

  it("multiple nodes with mixed activity states project independently", () => {
    const input = makeRig(
      [
        { id: "n1", logicalId: "alpha" },
        { id: "n2", logicalId: "beta" },
        { id: "n3", logicalId: "gamma" },
      ],
      [],
      [makeRunningSession("n1"), makeRunningSession("n2"), makeRunningSession("n3")]
    );
    const overlay: InventoryOverlay[] = [
      { logicalId: "alpha", startupStatus: "ready", canonicalSessionName: "r01-alpha", restoreOutcome: "n-a", agentActivity: RUNNING_ACTIVITY },
      { logicalId: "beta", startupStatus: "ready", canonicalSessionName: "r01-beta", restoreOutcome: "n-a", agentActivity: { ...RUNNING_ACTIVITY, state: "needs_input", reason: "approval_pending" } },
      { logicalId: "gamma", startupStatus: "ready", canonicalSessionName: "r01-gamma", restoreOutcome: "n-a", agentActivity: { ...RUNNING_ACTIVITY, state: "idle", reason: "idle_prompt" } },
    ];
    const result = projectRigToGraph(input, overlay);
    const states = result.nodes
      .filter((n) => n.type === "rigNode")
      .map((n) => n.data.agentActivity?.state);
    expect(states).toEqual(["running", "needs_input", "idle"]);
  });
});
