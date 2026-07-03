import { useMemo } from "react";
import dagre from "dagre";
import {
  Background,
  BackgroundVariant,
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
import { ToolMark } from "../../graphics/RuntimeMark.js";
import { RegistrationMarks } from "../../ui/registration-marks.js";

// OPR.0.4.1.20 — Workspace Workflow tab visualizer.
//
// Re-skins the slice's bound workflow-spec graph into the topology
// visual grammar (matches the approved creative-rig mockup
// digital-twin/opr-0.4.1.20/workflow-project-tab.intent): dotted-grid
// canvas, dark-header step cards (role header + state dot + step name +
// bound seat), curved topology-style edges, and the amber
// reject->rework back-edge for loop-back hops.
//
// Data honesty (founder north-star: represent-the-real-system / map != territory):
// this renders ONLY what the SpecGraphPayload carries — step identity,
// role, bound preferredTarget seat, and entry/current/terminal state.
// The mockup's live telemetry (ctx% / runtime / activity) is illustrative
// and comes from the SEPARATE node-inventory source (HybridAgentNode);
// joining it onto each step's bound seat is a tracked follow-up, NOT
// fabricated here.
//
// Layout stays dagre LR so the canvas scales to real multi-branch specs
// (fan-out, gate rings, loop-backs) rather than a fixed hand-placed graph.

const NODE_WIDTH = 200;
const NODE_HEIGHT = 112;

const FORWARD_STROKE = "#3a4048";
const LOOPBACK_STROKE = "#b9822f";

interface SliceWorkflowStepData extends Record<string, unknown> {
  step: SpecGraphNode;
}

type SliceWorkflowNode = Node<SliceWorkflowStepData, "sliceWorkflowStep">;

const nodeTypes: NodeTypes = {
  sliceWorkflowStep: SliceWorkflowStepNode,
};

export function SliceWorkflowGraph({ specGraph }: { specGraph: SpecGraphPayload }) {
  const { nodes, edges } = useMemo(() => buildSliceWorkflowGraph(specGraph), [specGraph]);
  const hasLoopBack = specGraph.edges.some((edge) => edge.isLoopBack);

  return (
    <section
      data-testid="topology-spec-graph"
      data-spec-name={specGraph.specName}
      data-spec-version={specGraph.specVersion}
      data-layout="react-flow-dagre"
      className="border border-outline-variant bg-surface-lowest/20"
    >
      <header className="flex items-center justify-between gap-3 border-b border-outline-variant bg-surface-lowest/30 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2 font-mono text-[10px] uppercase tracking-[0.10em] text-on-surface-variant">
          <span className="text-on-surface-variant">Workflow spec</span>
          <span className="text-on-surface-variant">·</span>
          <span className="truncate font-semibold text-on-surface">{specGraph.specName}</span>
          <span className="text-on-surface-variant">v{specGraph.specVersion}</span>
          {hasLoopBack && (
            <>
              <span className="text-on-surface-variant">·</span>
              <span className="inline-flex items-center gap-1 text-[var(--amber,#b9822f)]" style={{ color: LOOPBACK_STROKE }}>
                ↺ reject→rework loop
              </span>
            </>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="font-mono text-[9px] uppercase tracking-[0.10em] text-on-surface-variant">
            {specGraph.nodes.length} steps / {specGraph.edges.length} edges
          </span>
          <span className="border border-outline-variant px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-[0.14em] text-on-surface-variant">
            read-only
          </span>
        </div>
      </header>
      <div
        data-testid="slice-workflow-graph"
        className="h-[460px] bg-[radial-gradient(circle_at_1px_1px,rgba(120,116,104,0.30)_1.1px,transparent_0)] [background-size:21px_21px]"
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          fitViewOptions={{ padding: 0.18 }}
          minZoom={0.2}
          maxZoom={1.5}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          proOptions={{ hideAttribution: true }}
        >
          <Background variant={BackgroundVariant.Dots} gap={21} size={1.1} color="#b9b4a6" />
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
    nodesep: 70,
    ranksep: 120,
    marginx: 28,
    marginy: 28,
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
    // Curved topology-style edge; loop-backs ride the amber reject->rework path.
    type: edge.isLoopBack ? "default" : "smoothstep",
    markerEnd: { type: MarkerType.ArrowClosed, color: edge.isLoopBack ? LOOPBACK_STROKE : FORWARD_STROKE },
    style: {
      stroke: edge.isLoopBack ? LOOPBACK_STROKE : FORWARD_STROKE,
      strokeWidth: edge.isLoopBack ? 2.2 : 1.6,
      strokeDasharray: edge.isLoopBack ? "7 5" : undefined,
    },
    label: edge.isLoopBack ? "reject → rework" : undefined,
    labelStyle: {
      fill: LOOPBACK_STROKE,
      fontSize: 9,
      fontFamily: "monospace",
      letterSpacing: "0.08em",
      textTransform: "uppercase",
    },
    labelBgStyle: { fill: "hsl(var(--surface-container-lowest))", fillOpacity: 0.85 },
  }));

  return { nodes, edges };
}

function SliceWorkflowStepNode({ data }: NodeProps<SliceWorkflowNode>) {
  const step = data.step;
  const active = step.isCurrent;
  return (
    <div
      data-testid={`spec-node-${step.stepId}`}
      data-is-current={step.isCurrent}
      data-is-entry={step.isEntry}
      data-is-terminal={step.isTerminal}
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
      className={`relative border bg-surface-lowest font-mono hard-shadow ${
        active ? "border-emerald-500/70" : "border-outline/80"
      }`}
    >
      <RegistrationMarks testIdPrefix={`slice-workflow-${step.stepId}`} />
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-outline-variant !bg-outline" />
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-outline-variant !bg-outline" />
      {/* dark topology-style header: role + live-state affordance */}
      <div className="flex items-center justify-between bg-inverse-surface px-2 py-1 text-background">
        <span className="truncate text-[10px] tracking-[0.04em]">{step.role}</span>
        <span className="flex shrink-0 items-center gap-1.5">
          <span className="text-[7px] tracking-[0.14em] text-on-surface-variant">STATE</span>
          <span
            data-testid={`spec-node-${step.stepId}-state-dot`}
            data-active={active ? "true" : "false"}
            className={`inline-block h-2 w-2 rounded-full ${active ? "bg-emerald-400" : "bg-outline"}`}
          />
          <span className="inline-block h-2.5 w-2.5 rounded-full border-[1.4px] border-outline" />
        </span>
      </div>
      {/* body: step identity + bound seat + lifecycle markers */}
      <div className={`px-2 py-1.5 ${active ? "bg-emerald-50/70" : "bg-surface-lowest"}`}>
        <div className="flex items-start justify-between gap-2">
          <span className="truncate text-[11px] font-bold uppercase tracking-[0.04em] text-on-surface">
            {step.stepId}
          </span>
          <span className="flex shrink-0 flex-col items-end gap-0.5">
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
                className="inline-flex items-center gap-1 border border-outline-variant bg-surface-low px-1 text-[8px] uppercase tracking-[0.10em] text-on-surface"
              >
                <ToolMark tool="terminal" size="xs" />
                terminal
              </span>
            )}
          </span>
        </div>
        {step.preferredTarget && (
          <div className="mt-1 truncate text-[9px] text-on-surface-variant" title={step.preferredTarget}>
            {step.preferredTarget}
          </div>
        )}
        <div className="mt-0.5 line-clamp-2 text-[9px] leading-snug text-on-surface-variant">{step.label}</div>
      </div>
    </div>
  );
}
