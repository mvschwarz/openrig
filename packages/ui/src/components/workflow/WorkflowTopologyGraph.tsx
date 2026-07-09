// OPR.0.4.6.WF4 (C3b) — the ONE workflow shape renderer, EXTRACTED from
// LibraryReview.tsx (where it shipped as a local component; extend-not-fork,
// arch Q2). SliceWorkflowGraph stays untouched (convergence = named follow-up).
//
// Shipped behavior preserved EXACTLY: BFS depth layout from entry nodes
// (visit-once = shortest-path depth, cycle-safe), the entry/terminal accent
// palette, the role + preferredTarget node anatomy, the static non-interactive
// canvas. Node POSITIONS are byte-identical to the shipped render for any given
// topology (the layout math is unchanged).
//
// WF-4 additive layers — each renders NOTHING when its prop/field is absent, so
// the Library spec page WITHOUT instances stays visually the shipped render:
//   - branch edges (C1 routingType:"branch") render DASHED + labeled `on <exit>`
//     (WF4-F1: the shipped scanner dropped these; C1's projection carries them)
//   - harness / host / gate chips per node (WF-2 language, C1 seam)
//   - LIVE POSITION: currentStepId → "you are here" (heavy ring + ● marker),
//     visited steps tint, taken trail edges draw solid-dark
//
// WF4-F4 (arch Q-B, RULED): a forward+back edge PAIR between the same two
// stacked nodes must NOT overlap into one ambiguous line. Mechanism = DISTINCT
// HANDLE-PAIRS PER DIRECTION on a custom node (a forward top/bottom lane + a
// side lane for back/lateral edges). BINDING PIN: handle assignment is a PURE
// FUNCTION of the edge record (via the set-determined shortest-path depth) —
// NEVER render order; permuting the edges array yields identical handles
// (assertion in the WorkflowTopologyGraph test). This diverges from the twin's
// `type:"smoothstep"` placeholder, which the twin flagged as not-over-engineered.

import { useMemo } from "react";
import {
  ReactFlow,
  Handle,
  Position,
  Background,
  Controls,
  type Node,
  type Edge,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { LibraryWorkflowReview } from "../../hooks/useSpecLibrary.js";
import { ToolMark } from "../graphics/RuntimeMark.js";

export const WF_NODE_WIDTH = 180;
export const WF_NODE_HEIGHT = 56;
export const WF_H_SPACING = 220;
export const WF_V_SPACING = 110;

type Topology = LibraryWorkflowReview["topology"];

// Handle ids — every node carries all four so any edge can dock either lane.
const H_IN_TOP = "in-top";
const H_OUT_BOTTOM = "out-bottom";
const H_IN_SIDE = "in-side";
const H_OUT_SIDE = "out-side";

/** The shipped BFS depth assignment (visit-once from entry nodes). This is the
 *  SHORTEST-PATH distance from the entry set, which is a pure function of the
 *  edge SET — a node's first-visit BFS level is invariant to sibling/edge-array
 *  ORDER. So the same map drives both node positions (byte-identity) AND the
 *  Q-B handle classification (permutation-invariance) with no conflict. */
export function computeStepDepths(topology: Topology): Map<string, number> {
  const adj = new Map<string, string[]>();
  for (const e of topology.edges) {
    if (!adj.has(e.fromStepId)) adj.set(e.fromStepId, []);
    adj.get(e.fromStepId)!.push(e.toStepId);
  }
  const depth = new Map<string, number>();
  const queue: Array<{ id: string; d: number }> = [];
  for (const n of topology.nodes) {
    if (n.isEntry) {
      depth.set(n.stepId, 0);
      queue.push({ id: n.stepId, d: 0 });
    }
  }
  while (queue.length > 0) {
    const { id, d } = queue.shift()!;
    for (const child of adj.get(id) ?? []) {
      if (!depth.has(child)) {
        depth.set(child, d + 1);
        queue.push({ id: child, d: d + 1 });
      }
    }
  }
  // Fallback for orphan nodes (unchanged from shipped).
  let fallbackDepth = 0;
  for (const n of topology.nodes) {
    if (!depth.has(n.stepId)) depth.set(n.stepId, fallbackDepth++);
  }
  return depth;
}

/** Q-B (arch-RULED, binding): assign an edge's handle pair as a PURE FUNCTION of
 *  the edge record — a forward/downhill edge (depth[to] > depth[from]) docks the
 *  top→bottom lane; a back-edge or same-level edge docks the SIDE lane, so a
 *  reciprocal pair renders as two separate curves. `depth` is set-determined
 *  (see computeStepDepths), so this is permutation-invariant by construction. */
export function assignEdgeHandles(
  fromStepId: string,
  toStepId: string,
  depth: Map<string, number>,
): { sourceHandle: string; targetHandle: string } {
  const dFrom = depth.get(fromStepId) ?? 0;
  const dTo = depth.get(toStepId) ?? 0;
  return dTo > dFrom
    ? { sourceHandle: H_OUT_BOTTOM, targetHandle: H_IN_TOP }
    : { sourceHandle: H_OUT_SIDE, targetHandle: H_IN_SIDE };
}

interface WorkflowStepData {
  stepId: string;
  role: string;
  preferredTarget: string | null;
  isEntry: boolean;
  isTerminal: boolean;
  harness?: "claude-code" | "codex";
  host?: string;
  gate?: { target: string; summary?: string; evidence_ref?: string };
  isCurrent: boolean;
  wasVisited: boolean;
}

/** The custom step node — content identical to the shipped default-node label
 *  plus the WF-4 chips/live-position, with the Q-B four-handle dock set. */
function WorkflowStepNode({ data }: { data: WorkflowStepData }) {
  const accent = data.isEntry ? "#a8c8d4" : data.isTerminal ? "#d4b8a8" : "#d4c4a8";
  const hasPins = Boolean(data.harness || data.host || data.gate);
  return (
    <div
      style={{
        backgroundColor: data.isCurrent ? "#e8dcb8" : data.wasVisited ? "#cfc3a4" : accent,
        border: data.isCurrent ? "3px solid #7a5c10" : "1px solid #8a8577",
        boxShadow: data.isCurrent ? "0 0 0 3px rgba(122, 92, 16, 0.25)" : undefined,
        // Sharp corners: the design system zeroes all border radius
        // (tailwind-foundation + design-compliance enforce borderRadius 0), and
        // the app's default nodes render 0-radius — so the only build-vs-twin
        // divergence stays the Q-B edge handle-pairs (the ruled fix), not the
        // node box itself.
        borderRadius: 0,
        width: WF_NODE_WIDTH,
        height: hasPins ? WF_NODE_HEIGHT + 12 : WF_NODE_HEIGHT,
        padding: 6,
        fontFamily: "monospace",
        fontSize: 11,
      }}
    >
      {/* Q-B docks: a forward top/bottom lane + a side lane for back-edges. */}
      <Handle type="target" position={Position.Top} id={H_IN_TOP} className="opacity-0" />
      <Handle type="source" position={Position.Bottom} id={H_OUT_BOTTOM} className="opacity-0" />
      <Handle type="target" position={Position.Right} id={H_IN_SIDE} className="opacity-0" />
      <Handle type="source" position={Position.Right} id={H_OUT_SIDE} className="opacity-0" />
      <div className="font-mono text-[10px] leading-tight">
        <div className="flex items-center justify-between gap-2 font-bold">
          <span>
            {data.isCurrent ? <span aria-hidden>● </span> : null}
            {data.stepId}
          </span>
          {data.isTerminal ? <ToolMark tool="terminal" size="xs" title="Terminal step" decorative /> : null}
        </div>
        <div className="text-on-surface-variant">{data.role}</div>
        {data.preferredTarget && <div className="text-[8px] text-on-surface-variant">→ {data.preferredTarget}</div>}
        {hasPins && (
          <div className="text-[8px] text-on-surface-variant">
            {data.harness ? <span data-testid={`wf-node-harness-${data.stepId}`}>⌁ {data.harness}</span> : null}
            {data.host ? <span data-testid={`wf-node-host-${data.stepId}`}>{data.harness ? " · " : ""}host: {data.host}</span> : null}
            {data.gate ? (
              <span data-testid={`wf-node-gate-${data.stepId}`}>
                {data.harness || data.host ? " · " : ""}⛨ gate: {data.gate.target}
              </span>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

const nodeTypes: NodeTypes = { workflowStep: WorkflowStepNode };

export interface WorkflowTopologyGraphProps {
  topology: Topology;
  testId?: string;
  /** Live position: the instance's durable current-step binding. */
  currentStepId?: string | null;
  /** Steps with at least one closed trail row (position-history tint). */
  visitedStepIds?: string[];
  /** Taken routing edges as "from→to" keys derived from the trail. */
  takenEdgeKeys?: string[];
  /** Canvas height (Tailwind class); the shipped default is h-[400px]. */
  heightClass?: string;
}

export function WorkflowTopologyGraph({
  topology,
  testId,
  currentStepId,
  visitedStepIds,
  takenEdgeKeys,
  heightClass,
}: WorkflowTopologyGraphProps) {
  const { nodes, edges } = useMemo(() => {
    const depth = computeStepDepths(topology);

    // Group by depth → x by index within depth (unchanged from shipped).
    const byDepth = new Map<number, string[]>();
    for (const n of topology.nodes) {
      const d = depth.get(n.stepId) ?? 0;
      if (!byDepth.has(d)) byDepth.set(d, []);
      byDepth.get(d)!.push(n.stepId);
    }
    const positions = new Map<string, { x: number; y: number }>();
    for (const [d, ids] of byDepth) {
      ids.forEach((id, idx) => positions.set(id, { x: idx * WF_H_SPACING, y: d * WF_V_SPACING }));
    }

    const visited = new Set(visitedStepIds ?? []);
    const taken = new Set(takenEdgeKeys ?? []);

    const rfNodes: Node[] = topology.nodes.map((n) => ({
      id: n.stepId,
      type: "workflowStep",
      position: positions.get(n.stepId) ?? { x: 0, y: 0 },
      data: {
        stepId: n.stepId,
        role: n.role,
        preferredTarget: n.preferredTarget,
        isEntry: n.isEntry,
        isTerminal: n.isTerminal,
        harness: n.harness,
        host: n.host,
        gate: n.gate,
        isCurrent: currentStepId != null && n.stepId === currentStepId,
        wasVisited: visited.has(n.stepId),
      } as unknown as Record<string, unknown>,
    }));

    const rfEdges: Edge[] = topology.edges.map((e, i) => {
      const isBranch = e.routingType === "branch";
      const wasTaken = taken.has(`${e.fromStepId}→${e.toStepId}`);
      const { sourceHandle, targetHandle } = assignEdgeHandles(e.fromStepId, e.toStepId, depth);
      return {
        id: `e-${i}`,
        source: e.fromStepId,
        target: e.toStepId,
        sourceHandle,
        targetHandle,
        label: isBranch && e.branchOn ? `on ${e.branchOn}` : undefined,
        labelStyle: { fontFamily: "monospace", fontSize: 9, fill: "#7a5c10" },
        labelBgStyle: { fill: "#f2ead6" },
        animated: wasTaken && currentStepId != null,
        style: {
          stroke: wasTaken ? "#5c4a10" : isBranch ? "#a8842c" : "#8a8577",
          strokeWidth: wasTaken ? 2.5 : 1,
          strokeDasharray: isBranch ? "6 4" : undefined,
        },
      };
    });

    return { nodes: rfNodes, edges: rfEdges };
  }, [topology, currentStepId, visitedStepIds, takenEdgeKeys]);

  return (
    <div
      data-testid={testId ?? "workflow-topology-graph"}
      className={`w-full ${heightClass ?? "h-[400px]"} bg-background border border-outline-variant`}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
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
