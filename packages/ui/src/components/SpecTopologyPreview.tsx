import { useMemo } from "react";
import {
  ReactFlow,
  type Node,
  type Edge,
  Background,
  Controls,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { SpecGraphData } from "../hooks/useSpecReview.js";

interface SpecTopologyPreviewProps {
  graph?: SpecGraphData | null;
  testId?: string;
}

const NODE_WIDTH = 160;
const NODE_HEIGHT = 48;
const H_SPACING = 200;
const V_SPACING = 100;

function runtimeColor(runtime: string): string {
  switch (runtime) {
    case "claude-code": return "#d4c4a8";
    case "codex": return "#b8c9d4";
    case "terminal": return "#c4c4c4";
    default: return "#e0ddd4";
  }
}

/**
 * Simple grid layout for spec preview.
 * Groups by pod, lays pods out vertically, members horizontally within each pod.
 */
function layoutNodes(graphNodes: SpecGraphData["nodes"]): Array<{ id: string; x: number; y: number }> {
  const pods = new Map<string, typeof graphNodes>();
  const ungrouped: typeof graphNodes = [];
  for (const n of graphNodes) {
    if (n.pod) {
      if (!pods.has(n.pod)) pods.set(n.pod, []);
      pods.get(n.pod)!.push(n);
    } else {
      ungrouped.push(n);
    }
  }

  const positions: Array<{ id: string; x: number; y: number }> = [];
  let y = 0;

  for (const [, members] of pods) {
    members.forEach((n, i) => {
      positions.push({ id: n.id, x: i * H_SPACING, y });
    });
    y += V_SPACING;
  }

  ungrouped.forEach((n, i) => {
    positions.push({ id: n.id, x: i * H_SPACING, y });
  });

  return positions;
}

export function SpecTopologyPreview({ graph, testId }: SpecTopologyPreviewProps) {
  const safeGraph = graph ?? { nodes: [], edges: [] };
  const { nodes, edges } = useMemo(() => {
    const positions = layoutNodes(safeGraph.nodes);
    const posMap = new Map(positions.map((p) => [p.id, p]));

    const rfNodes: Node[] = safeGraph.nodes.map((n) => {
      const pos = posMap.get(n.id) ?? { x: 0, y: 0 };
      return {
        id: n.id,
        type: "default",
        position: { x: pos.x, y: pos.y },
        data: { label: `${n.pod ? `${n.pod} / ` : ""}${n.label}` },
        style: {
          backgroundColor: runtimeColor(n.runtime),
          border: "1px solid #8a8577",
            fontSize: 11,
          fontFamily: "monospace",
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
        },
      };
    });

    const rfEdges: Edge[] = safeGraph.edges.map((e, i) => ({
      id: `e-${i}`,
      source: e.source,
      target: e.target,
      label: e.kind,
      labelStyle: { fontSize: 9, fontFamily: "monospace" },
      style: { strokeDasharray: "4 4", stroke: "#8a8577" },
    }));

    return { nodes: rfNodes, edges: rfEdges };
  }, [safeGraph]);

  return (
    <div data-testid={testId ?? "spec-topology-preview"} className="w-full h-[400px] bg-stone-50 border border-stone-200">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} size={0.5} color="#d4d0c8" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
