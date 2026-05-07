import { useMemo } from "react";
import dagre from "dagre";
import {
  Background,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { SpecGraphPayload, SpecGraphNode } from "../../../hooks/useSlices.js";
import { RegistrationMarks } from "../../ui/registration-marks.js";

const NODE_WIDTH = 200;
const NODE_HEIGHT = 112;

interface SliceWorkflowStepData extends Record<string, unknown> {
  step: SpecGraphNode;
}

type SliceWorkflowNode = Node<SliceWorkflowStepData, "sliceWorkflowStep">;

const nodeTypes: NodeTypes = {
  sliceWorkflowStep: SliceWorkflowStepNode,
};

export function SliceWorkflowGraph({ specGraph }: { specGraph: SpecGraphPayload }) {
  const { nodes, edges } = useMemo(() => buildSliceWorkflowGraph(specGraph), [specGraph]);

  return (
    <section
      data-testid="topology-spec-graph"
      data-spec-name={specGraph.specName}
      data-spec-version={specGraph.specVersion}
      data-layout="react-flow-dagre"
      className="border border-outline-variant bg-white/20"
    >
      <header className="flex items-center justify-between border-b border-outline-variant bg-white/20 px-3 py-2">
        <div className="font-mono text-[10px] uppercase tracking-[0.10em] text-stone-500">
          Workflow graph - {specGraph.specName} v{specGraph.specVersion}
        </div>
        <div className="font-mono text-[9px] uppercase tracking-[0.10em] text-stone-400">
          {specGraph.nodes.length} steps / {specGraph.edges.length} edges
        </div>
      </header>
      <div data-testid="slice-workflow-graph" className="h-[420px] bg-[radial-gradient(circle_at_1px_1px,rgba(87,83,78,0.22)_1px,transparent_0)] [background-size:18px_18px]">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          minZoom={0.2}
          maxZoom={1.5}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={18} size={0.5} color="#d6d3cd" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>
      <div className="sr-only" data-testid="slice-workflow-edge-metadata">
        {specGraph.edges.map((edge) => (
          <span
            key={`${edge.fromStepId}-${edge.toStepId}`}
            data-testid={`spec-edge-${edge.fromStepId}-${edge.toStepId}`}
            data-routing-type={edge.routingType}
            data-is-loop-back={edge.isLoopBack}
          >
            {edge.fromStepId} to {edge.toStepId}
          </span>
        ))}
      </div>
    </section>
  );
}

export function buildSliceWorkflowGraph(specGraph: SpecGraphPayload): { nodes: SliceWorkflowNode[]; edges: Edge[] } {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));
  dagreGraph.setGraph({
    rankdir: "LR",
    nodesep: 80,
    ranksep: 110,
    marginx: 24,
    marginy: 24,
  });

  specGraph.nodes.forEach((node) => {
    dagreGraph.setNode(node.stepId, { width: NODE_WIDTH, height: NODE_HEIGHT });
  });
  specGraph.edges.forEach((edge) => {
    dagreGraph.setEdge(edge.fromStepId, edge.toStepId);
  });
  dagre.layout(dagreGraph);

  const nodes: SliceWorkflowNode[] = specGraph.nodes.map((step) => {
    const pos = dagreGraph.node(step.stepId) as { x?: number; y?: number } | undefined;
    return {
      id: step.stepId,
      type: "sliceWorkflowStep",
      position: {
        x: (pos?.x ?? 0) - NODE_WIDTH / 2,
        y: (pos?.y ?? 0) - NODE_HEIGHT / 2,
      },
      data: { step },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    };
  });

  const edges: Edge[] = specGraph.edges.map((edge) => ({
    id: `spec-edge-${edge.fromStepId}-${edge.toStepId}`,
    source: edge.fromStepId,
    target: edge.toStepId,
    type: "smoothstep",
    markerEnd: { type: MarkerType.ArrowClosed, color: edge.isLoopBack ? "#b45309" : "#57534e" },
    style: {
      stroke: edge.isLoopBack ? "#b45309" : "#57534e",
      strokeWidth: edge.isLoopBack ? 1.5 : 1.25,
      strokeDasharray: edge.isLoopBack ? "6 5" : undefined,
    },
    label: edge.isLoopBack ? "loop" : edge.routingType,
    labelStyle: {
      fill: edge.isLoopBack ? "#b45309" : "#78716c",
      fontSize: 9,
      fontFamily: "monospace",
      textTransform: "uppercase",
    },
  }));

  return { nodes, edges };
}

function SliceWorkflowStepNode({ data }: NodeProps<SliceWorkflowNode>) {
  const step = data.step;
  return (
    <div
      data-testid={`spec-node-${step.stepId}`}
      data-is-current={step.isCurrent}
      data-is-entry={step.isEntry}
      data-is-terminal={step.isTerminal}
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
      className={`relative border border-outline-variant bg-white/30 p-3 font-mono hard-shadow ${
        step.isCurrent ? "ring-2 ring-emerald-500/50 bg-emerald-50/60" : ""
      }`}
    >
      <RegistrationMarks testIdPrefix={`slice-workflow-${step.stepId}`} />
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-outline-variant !bg-stone-500" />
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-outline-variant !bg-stone-500" />
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[11px] font-bold uppercase tracking-[0.04em] text-stone-950">{step.stepId}</div>
          <div className="mt-0.5 text-[9px] uppercase tracking-[0.10em] text-stone-500">{step.role}</div>
        </div>
        <div className="flex flex-col items-end gap-1">
          {step.isEntry && (
            <span
              data-testid={`spec-node-${step.stepId}-entry-badge`}
              className="border border-blue-300 bg-blue-50 px-1 text-[8px] uppercase tracking-[0.10em] text-blue-900"
            >
              entry
            </span>
          )}
          {step.isCurrent && (
            <span
              data-testid={`spec-node-${step.stepId}-current-badge`}
              className="border border-emerald-400 bg-emerald-100 px-1 text-[8px] uppercase tracking-[0.10em] text-emerald-900"
            >
              current
            </span>
          )}
          {step.isTerminal && (
            <span
              data-testid={`spec-node-${step.stepId}-terminal-badge`}
              className="border border-stone-300 bg-stone-100 px-1 text-[8px] uppercase tracking-[0.10em] text-stone-700"
            >
              terminal
            </span>
          )}
        </div>
      </div>
      <div className="mt-3 text-[10px] leading-4 text-stone-800">{step.label}</div>
      {step.preferredTarget && (
        <div className="mt-2 truncate text-[9px] text-stone-500">{step.preferredTarget}</div>
      )}
    </div>
  );
}
