import { describe, expect, it } from "vitest";
import { applyTreeLayout } from "../src/lib/graph-layout.js";

type TestNode = Parameters<typeof applyTreeLayout>[0][number];
type TestEdge = Parameters<typeof applyTreeLayout>[1][number];

function getNode(nodes: TestNode[], id: string): TestNode {
  const node = nodes.find((candidate) => candidate.id === id);
  expect(node, `expected node ${id} to exist`).toBeDefined();
  return node!;
}

function makeGroup(id: string): TestNode {
  return {
    id,
    type: "group",
    position: { x: 0, y: 0 },
    data: { logicalId: id },
  };
}

function makeRigNode(id: string, parentId: string): TestNode {
  return {
    id,
    type: "rigNode",
    parentId,
    position: { x: 0, y: 0 },
    data: { logicalId: id },
  };
}

function makeDelegation(source: string, target: string): TestEdge {
  return {
    id: `${source}->${target}`,
    source,
    target,
    data: { kind: "delegates_to" },
  };
}

describe("applyTreeLayout", () => {
  it("lays out pods top-to-bottom from delegation structure", () => {
    const nodes: TestNode[] = [
      makeGroup("pod-orch"),
      makeGroup("pod-dev"),
      makeGroup("pod-qa"),
      makeRigNode("orch.lead", "pod-orch"),
      makeRigNode("dev.impl", "pod-dev"),
      makeRigNode("dev.design", "pod-dev"),
      makeRigNode("dev.qa", "pod-qa"),
    ];
    const edges: TestEdge[] = [
      makeDelegation("orch.lead", "dev.impl"),
      makeDelegation("orch.lead", "dev.design"),
      makeDelegation("orch.lead", "dev.qa"),
    ];

    const laidOut = applyTreeLayout(nodes, edges);
    const orchPod = getNode(laidOut, "pod-orch");
    const devPod = getNode(laidOut, "pod-dev");
    const qaPod = getNode(laidOut, "pod-qa");

    expect(orchPod.position.y).toBeLessThan(devPod.position.y);
    expect(orchPod.position.y).toBeLessThan(qaPod.position.y);
  });

  it("pushes disconnected pods below the connected root flow", () => {
    const nodes: TestNode[] = [
      makeGroup("pod-orch"),
      makeGroup("pod-dev"),
      makeGroup("pod-review"),
      makeRigNode("orch.lead", "pod-orch"),
      makeRigNode("dev.impl", "pod-dev"),
      makeRigNode("rev.r1", "pod-review"),
    ];
    const edges: TestEdge[] = [makeDelegation("orch.lead", "dev.impl")];

    const laidOut = applyTreeLayout(nodes, edges);
    const orchPod = getNode(laidOut, "pod-orch");
    const devPod = getNode(laidOut, "pod-dev");
    const reviewPod = getNode(laidOut, "pod-review");

    expect(orchPod.position.y).toBeLessThan(devPod.position.y);
    expect(reviewPod.position.y).toBeGreaterThanOrEqual(devPod.position.y);
  });

  it("wraps pod members after three columns", () => {
    const nodes: TestNode[] = [
      makeGroup("pod-dev"),
      makeRigNode("dev.1", "pod-dev"),
      makeRigNode("dev.2", "pod-dev"),
      makeRigNode("dev.3", "pod-dev"),
      makeRigNode("dev.4", "pod-dev"),
    ];
    const edges: TestEdge[] = [];

    const laidOut = applyTreeLayout(nodes, edges);
    const first = getNode(laidOut, "dev.1");
    const second = getNode(laidOut, "dev.2");
    const third = getNode(laidOut, "dev.3");
    const fourth = getNode(laidOut, "dev.4");

    expect(first.position.y).toBe(second.position.y);
    expect(second.position.y).toBe(third.position.y);
    expect(fourth.position.y).toBeGreaterThan(first.position.y);
    expect(fourth.position.x).toBe(first.position.x);
  });
});
