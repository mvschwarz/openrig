import type { SpecGraphData } from "../types.js";
import type { RigGraph, GraphNodeData } from "../topology/graph-types.js";

/** Adapt the existing spec review projection to the live graph renderer. No live status is implied. */
export function specGraph(graph: SpecGraphData): RigGraph {
  const empty: GraphNodeData = { logicalId: "", runtime: null, model: null, status: null,
    nodeKind: "agent", startupStatus: null, contextUsedPercentage: null };
  const pods = [...new Set(graph.nodes.flatMap(n => n.pod ? [n.pod] : []))];
  const podId = (pod: string) => `spec-pod:${pod}`;
  return {
    nodes: [
      ...pods.map(pod => ({ id: podId(pod), type: "podGroup", data: { ...empty, logicalId: pod, podNamespace: pod } })),
      ...graph.nodes.map(n => ({ id: n.id, type: "rigNode", ...(n.pod ? { parentId: podId(n.pod) } : {}),
        data: { ...empty, logicalId: n.id, podNamespace: n.pod, runtime: n.runtime, nodeKind: n.kind } })),
    ],
    edges: graph.edges.map((e, i) => ({ id: `spec-edge:${i}`, source: e.source, target: e.target, label: e.kind })),
  };
}
