import { describe, expect, it } from "vitest";
import {
  HYBRID_COLLAPSED_RIG_HEIGHT,
  HYBRID_COLLAPSED_RIG_WIDTH,
  HYBRID_CROSS_RIG_STROKE_DASH,
  getHybridEdgeStyle,
  layoutHybridOuterRigs,
  layoutHybridRig,
  prefixedHybridNodeId,
  unprefixedHybridNodeId,
} from "../src/lib/hybrid-layout.js";

describe("P5.3 hybrid layout helpers", () => {
  it("prefixes node IDs with rigId and can parse them back", () => {
    const id = prefixedHybridNodeId("rig-1", "agent-a");
    expect(id).toBe("rig-1::agent-a");
    expect(unprefixedHybridNodeId(id)).toEqual({ rigId: "rig-1", localId: "agent-a" });
    expect(unprefixedHybridNodeId("agent-a")).toEqual({ rigId: null, localId: "agent-a" });
  });

  it("lays out expanded rig as nested rig -> pod -> agent nodes", () => {
    const layout = layoutHybridRig({
      rigId: "rig-1",
      collapsed: false,
      nodes: [
        { id: "pod-dev", type: "podGroup", position: { x: 0, y: 0 }, data: { podNamespace: "dev" } },
        { id: "dev.driver", type: "rigNode", parentId: "pod-dev", position: { x: 0, y: 0 }, data: { logicalId: "dev.driver" } },
        { id: "dev.guard", type: "rigNode", parentId: "pod-dev", position: { x: 0, y: 0 }, data: { logicalId: "dev.guard" } },
      ],
      edges: [
        { id: "e1", source: "dev.driver", target: "dev.guard" },
      ],
    });

    expect(layout.width).toBeGreaterThan(HYBRID_COLLAPSED_RIG_WIDTH);
    expect(layout.height).toBeGreaterThanOrEqual(HYBRID_COLLAPSED_RIG_HEIGHT);
    expect(layout.podCount).toBe(1);

    const pod = layout.nodes.find((node) => node.id === "rig-1::pod-dev");
    const agent = layout.nodes.find((node) => node.id === "rig-1::dev.driver");
    expect(pod?.parentId).toBe("rig-rig-1");
    expect(agent?.parentId).toBe("rig-1::pod-dev");
    expect(layout.edges[0]?.source).toBe("rig-1::dev.driver");
    expect(layout.edges[0]?.target).toBe("rig-1::dev.guard");
  });

  it("keeps collapsed rigs cheap: no child graph and fixed card dimensions", () => {
    const layout = layoutHybridRig({
      rigId: "rig-1",
      collapsed: true,
      nodes: [
        { id: "pod-dev", type: "podGroup", position: { x: 0, y: 0 }, data: { podNamespace: "dev" } },
      ],
      edges: [],
    });

    expect(layout.nodes).toHaveLength(0);
    expect(layout.edges).toHaveLength(0);
    expect(layout.width).toBe(HYBRID_COLLAPSED_RIG_WIDTH);
    expect(layout.height).toBe(HYBRID_COLLAPSED_RIG_HEIGHT);
  });

  it("outer dagre layout gives each rig frame a stable canvas position", () => {
    const positions = layoutHybridOuterRigs([
      { rigId: "rig-1", width: 300, height: 120 },
      { rigId: "rig-2", width: 320, height: 160 },
      { rigId: "rig-3", width: 280, height: 140 },
      { rigId: "rig-4", width: 360, height: 180 },
    ]);

    expect(positions).toHaveLength(4);
    expect(new Set(positions.map((rig) => `${rig.position.x}:${rig.position.y}`)).size).toBe(4);
  });

  it("shares the cross-rig dashed style constant", () => {
    const style = getHybridEdgeStyle("handoff", true);
    expect(style?.strokeDasharray).toBe(HYBRID_CROSS_RIG_STROKE_DASH);
  });
});
