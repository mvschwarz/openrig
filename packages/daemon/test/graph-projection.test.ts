import { describe, it, expect } from "vitest";
import { projectRigToGraph } from "../src/domain/graph-projection.js";
import type { RigGraphInput } from "../src/domain/graph-projection.js";
import type { Pod, RigWithRelations, Session } from "../src/domain/types.js";

function makeRig(
  nodes: { id: string; logicalId: string; role?: string; runtime?: string; bindingTmux?: string; cmuxSurface?: string }[],
  edges: { id: string; sourceId: string; targetId: string; kind: string }[] = [],
  sessions: Session[] = [],
  pods: Pod[] = []
): RigGraphInput {
  const rig: RigWithRelations = {
    rig: { id: "rig-1", name: "r01", createdAt: "2026-03-23", updatedAt: "2026-03-23" },
    nodes: nodes.map((n) => ({
      id: n.id,
      rigId: "rig-1",
      logicalId: n.logicalId,
      role: n.role ?? null,
      runtime: n.runtime ?? null,
      model: null,
      cwd: null,
      createdAt: "2026-03-23",
      binding: n.bindingTmux
        ? {
            id: `bind-${n.id}`,
            nodeId: n.id,
            tmuxSession: n.bindingTmux,
            tmuxWindow: null,
            tmuxPane: null,
            cmuxWorkspace: null,
            cmuxSurface: n.cmuxSurface ?? null,
            updatedAt: "2026-03-23",
          }
        : null,
    })),
    edges: edges.map((e) => ({
      id: e.id,
      rigId: "rig-1",
      sourceId: e.sourceId,
      targetId: e.targetId,
      kind: e.kind,
      createdAt: "2026-03-23",
    })),
  };
  return { ...rig, sessions, pods };
}

function makeSession(nodeId: string, status: string, createdAt: string): Session {
  return {
    id: `sess-${nodeId}-${createdAt}`,
    nodeId,
    sessionName: `r01-${nodeId}`,
    status,
    lastSeenAt: null,
    createdAt,
  };
}

describe("projectRigToGraph", () => {
  it("3 nodes + 2 edges -> correct React Flow shape", () => {
    const input = makeRig(
      [
        { id: "n1", logicalId: "orchestrator", role: "orchestrator" },
        { id: "n2", logicalId: "worker-a", role: "worker" },
        { id: "n3", logicalId: "worker-b", role: "worker" },
      ],
      [
        { id: "e1", sourceId: "n1", targetId: "n2", kind: "delegates_to" },
        { id: "e2", sourceId: "n1", targetId: "n3", kind: "delegates_to" },
      ]
    );

    const result = projectRigToGraph(input);
    expect(result.nodes).toHaveLength(3);
    expect(result.edges).toHaveLength(2);
  });

  it("empty rig -> { nodes: [], edges: [] }", () => {
    const input = makeRig([], []);
    const result = projectRigToGraph(input);
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });

  it("all nodes have type: 'rigNode'", () => {
    const input = makeRig([
      { id: "n1", logicalId: "a" },
      { id: "n2", logicalId: "b" },
    ]);
    const result = projectRigToGraph(input);
    for (const node of result.nodes) {
      expect(node.type).toBe("rigNode");
    }
  });

  it("deterministic layout: 3-node rig has exact positions", () => {
    const input = makeRig([
      { id: "n1", logicalId: "a" },
      { id: "n2", logicalId: "b" },
      { id: "n3", logicalId: "c" },
    ]);

    const result = projectRigToGraph(input);
    expect(result.nodes[0]!.position).toEqual({ x: 0, y: 0 });
    expect(result.nodes[1]!.position).toEqual({ x: 0, y: 200 });
    expect(result.nodes[2]!.position).toEqual({ x: 0, y: 400 });
  });

  it("node with binding -> binding data in node.data", () => {
    const input = makeRig([
      { id: "n1", logicalId: "worker", bindingTmux: "r01-worker", cmuxSurface: "s-1" },
    ]);

    const result = projectRigToGraph(input);
    const data = result.nodes[0]!.data;
    expect(data.binding).not.toBeNull();
    expect(data.binding.tmuxSession).toBe("r01-worker");
    expect(data.binding.cmuxSurface).toBe("s-1");
  });

  it("node without binding -> binding: null in node.data", () => {
    const input = makeRig([{ id: "n1", logicalId: "worker" }]);

    const result = projectRigToGraph(input);
    const data = result.nodes[0]!.data;
    expect(data).toHaveProperty("binding");
    expect(data.binding).toBeNull();
  });

  it("RF node.id === nodes.id, edge.source === sourceId, edge.target === targetId", () => {
    const input = makeRig(
      [
        { id: "node-abc", logicalId: "a" },
        { id: "node-xyz", logicalId: "b" },
      ],
      [{ id: "edge-1", sourceId: "node-abc", targetId: "node-xyz", kind: "delegates_to" }]
    );

    const result = projectRigToGraph(input);
    expect(result.nodes[0]!.id).toBe("node-abc");
    expect(result.nodes[1]!.id).toBe("node-xyz");
    expect(result.edges[0]!.source).toBe("node-abc");
    expect(result.edges[0]!.target).toBe("node-xyz");
  });

  it("edge label matches edge kind", () => {
    const input = makeRig(
      [
        { id: "n1", logicalId: "a" },
        { id: "n2", logicalId: "b" },
      ],
      [{ id: "e1", sourceId: "n1", targetId: "n2", kind: "can_observe" }]
    );

    const result = projectRigToGraph(input);
    expect(result.edges[0]!.label).toBe("can_observe");
  });

  it("session status included in node.data (latest by createdAt)", () => {
    const input = makeRig(
      [{ id: "n1", logicalId: "worker" }],
      [],
      [makeSession("n1", "running", "2026-03-23T01:00:00")]
    );

    const result = projectRigToGraph(input);
    expect(result.nodes[0]!.data.status).toBe("running");
  });

  it("node with multiple sessions -> latest by createdAt wins", () => {
    const input = makeRig(
      [{ id: "n1", logicalId: "worker" }],
      [],
      [
        makeSession("n1", "exited", "2026-03-23T01:00:00"),
        makeSession("n1", "running", "2026-03-23T02:00:00"),
      ]
    );

    const result = projectRigToGraph(input);
    expect(result.nodes[0]!.data.status).toBe("running");
  });

  it("node with no session -> node.data.status = null", () => {
    const input = makeRig([{ id: "n1", logicalId: "worker" }]);

    const result = projectRigToGraph(input);
    expect(result.nodes[0]!.data).toHaveProperty("status");
    expect(result.nodes[0]!.data.status).toBeNull();
  });

  it("non-running latest session clears startupStatus so graph does not show stale READY", () => {
    const input = makeRig(
      [{ id: "n1", logicalId: "worker", runtime: "claude-code" }],
      [],
      [makeSession("n1", "exited", "2026-03-23T02:00:00")]
    );

    const overlay = [
      { logicalId: "worker", startupStatus: "ready" as const, canonicalSessionName: "worker@test-rig", restoreOutcome: "n-a" },
    ];

    const result = projectRigToGraph(input, overlay);
    expect(result.nodes[0]!.data.status).toBe("exited");
    expect(result.nodes[0]!.data.startupStatus).toBeNull();
  });

  // NS-T12: enriched fields
  it("enriched fields include startupStatus, canonicalSessionName, podId, restoreOutcome from overlay", () => {
    const input = makeRig(
      [{ id: "n1", logicalId: "dev.impl", runtime: "claude-code" }],
      [],
      [makeSession("n1", "running", "2026-03-23T03:00:00")]
    );

    const overlay = [
      { logicalId: "dev.impl", startupStatus: "ready" as const, canonicalSessionName: "dev-impl@test-rig", restoreOutcome: "resumed" },
    ];

    const result = projectRigToGraph(input, overlay);
    const node = result.nodes.find((n) => n.data.logicalId === "dev.impl");
    expect(node).toBeDefined();
    expect(node!.data.startupStatus).toBe("ready");
    expect(node!.data.canonicalSessionName).toBe("dev-impl@test-rig");
    expect(node!.data.restoreOutcome).toBe("resumed");
  });

  // NS-T12: pod group nodes
  it("creates React Flow group nodes for pods", () => {
    const input = makeRig([
      { id: "n1", logicalId: "dev.impl", runtime: "claude-code" },
      { id: "n2", logicalId: "dev.qa", runtime: "codex" },
    ], [], [], [
      {
        id: "dev",
        namespace: "dev",
        rigId: "rig-1",
        label: "Implementation",
        summary: null,
        continuityPolicyJson: null,
        createdAt: "2026-03-23",
      },
    ]);
    // Add podId to nodes
    input.nodes[0]!.podId = "dev";
    input.nodes[1]!.podId = "dev";

    const result = projectRigToGraph(input);
    const groupNode = result.nodes.find((n) => n.id === "pod-dev");
    expect(groupNode).toBeDefined();
    expect(groupNode!.type).toBe("podGroup");
    expect(groupNode!.data.podLabel).toBe("Implementation");
    expect(groupNode!.data.podNamespace).toBe("dev");
    expect(groupNode!.data.logicalId).toBe("dev");

    // Child nodes should have parentId and podId in data
    const childNodes = result.nodes.filter((n) => n.parentId === "pod-dev");
    expect(childNodes).toHaveLength(2);
    expect(childNodes[0]!.data.podId).toBe("dev");
    expect(childNodes[0]!.data.podNamespace).toBe("dev");
  });

  // NS-T03: nodeKind derived from runtime
  it("nodeKind is 'infrastructure' for terminal runtime, 'agent' otherwise", () => {
    const input = makeRig([
      { id: "n1", logicalId: "impl", runtime: "claude-code" },
      { id: "n2", logicalId: "server", runtime: "terminal" },
      { id: "n3", logicalId: "qa", runtime: "codex" },
    ]);

    const result = projectRigToGraph(input);
    expect(result.nodes[0]!.data.nodeKind).toBe("agent");
    expect(result.nodes[1]!.data.nodeKind).toBe("infrastructure");
    expect(result.nodes[2]!.data.nodeKind).toBe("agent");
  });
});
