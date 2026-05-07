// V1 polish slice Phase 5.2 — multi-rig single-canvas /topology graph.
//
// Bundles 8 dispatch items in one canvas component:
//   P5.2-1 HostMultiRigGraph composition (this file)
//   P5.2-2 useQueries for N parallel rig graph fetches (lazy on expand)
//   P5.2-3 cross-rig node-ID prefixing via prefixRigData (multi-rig-layout.ts)
//   P5.2-4 rigGroup ReactFlow node type (RigGroupNode.tsx)
//   P5.2-5 default-collapsed rig groups + click-body-to-toggle affordance
//   P5.2-6 layout option (a) per-rig + outer offset (multi-rig-layout.ts)
//   P5.2-7 click handler reads rigId from node.data.rigId (NOT closure)
//   P5.2-8 per-rig features (cmux focus / agent click navigate / pod click
//          navigate) thread through node.data.rigId
//
// Default state: ALL rigs collapsed; rig cards on canvas with status pip
// + counts. Auto-expand rule (parity with Phase 5.1 TopologyTreeView):
// when route is /topology/rig/$rigId or /topology/seat/$rigId/* or
// /topology/pod/$rigId/*, the matching rig is auto-expanded on mount /
// route change. Click rig card body → toggle collapse. Click "→" Link
// on rig card name → navigate to /topology/rig/$rigId (drill-in).
//
// Performance: per-rig graph data is lazy-fetched (useQueries enabled
// only when rig is expanded). At default state with N rigs collapsed,
// only one /api/ps fetch happens (for the rig cards' counts). Scales
// to 100+ rigs per the for-you-feed.md L9 north-star without upfront
// fan-out.

import { useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  ReactFlow,
  Controls,
  type Node,
  type Edge,
  type NodeTypes,
  type NodeMouseHandler,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useQueries } from "@tanstack/react-query";
import { usePsEntries } from "../../hooks/usePsEntries.js";
import { applyTreeLayout } from "../../lib/graph-layout.js";
import { useShellViewport } from "../../hooks/useShellViewport.js";
import { RigNode } from "../RigNode.js";
import { RigGroupNode, type RigGroupNodeData } from "./RigGroupNode.js";
import { useTopologyOverlay } from "./topology-overlay-context.js";
import {
  prefixRigData,
  packRigGroups,
  computeBounds,
  COLLAPSED_RIG_WIDTH,
  COLLAPSED_RIG_HEIGHT,
  RIG_HEADER_HEIGHT,
  RIG_PADDING,
} from "../../lib/multi-rig-layout.js";

interface GraphData {
  nodes: unknown[];
  edges: unknown[];
}

async function fetchGraph(rigId: string): Promise<GraphData> {
  const res = await fetch(`/api/rigs/${encodeURIComponent(rigId)}/graph`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Pod-group inline renderer for the multi-rig canvas. Mirrors RigGraph's
// PodGroupNode shape (data.podDisplayName / podNamespace / etc.) but
// stays local so this canvas's nodeTypes registry is self-contained.
function MultiRigPodGroupNode({
  data,
}: {
  data: { podDisplayName?: string | null; podNamespace?: string | null; podId?: string | null };
}) {
  const label = data.podDisplayName ?? data.podNamespace ?? data.podId ?? "pod";
  return (
    <div
      data-testid="multi-rig-pod-group-node"
      className="w-full h-full relative pointer-events-auto"
    >
      <div className="absolute left-3 top-2 inline-flex items-center font-mono text-[11px] font-bold leading-none tracking-[0.08em] text-stone-700">
        {`${label} pod`}
      </div>
    </div>
  );
}

const nodeTypes: NodeTypes = {
  rigGroup: RigGroupNode as unknown as NodeTypes[string],
  podGroup: MultiRigPodGroupNode,
  rigNode: RigNode,
};

export function HostMultiRigGraph() {
  const navigate = useNavigate();
  const { data: psEntries } = usePsEntries();
  const { innerWidth } = useShellViewport();

  // V1 polish slice Phase 5.2 bounce-fix — rig-expanded state lifted to
  // TopologyOverlayProvider scope. Direct-URL entry to /topology/rig/$id
  // (which mounts RigScopePage, NOT HostMultiRigGraph because topology
  // routes are SIBLING) still updates the context's expandedRigs map
  // via the provider's auto-expand useEffect; when the operator returns
  // to /topology, this component reads the persisted state via
  // useTopologyOverlay() and renders the matching rig expanded.
  const { expandedRigs: expanded, toggleRig } = useTopologyOverlay();

  // P5.2-2 + P5.2-3: useQueries for per-rig graph data; enabled only
  // when the rig is expanded. Stable hook-call count (single useQueries
  // call) regardless of how psEntries grows from undefined → [N], so
  // no rules-of-hooks regression (P0-1 pattern preserved).
  const rigList = psEntries ?? [];
  const graphQueries = useQueries({
    queries: rigList.map((rig) => ({
      queryKey: ["rig", rig.rigId, "graph"] as const,
      queryFn: () => fetchGraph(rig.rigId),
      enabled: expanded.get(rig.rigId) ?? false,
      refetchInterval: 30_000,
    })),
  });

  // Build per-rig prefixed sub-graphs (only for expanded rigs); compute
  // each rig's bounding box; pack rig groups in a grid via packRigGroups.
  const { mergedNodes, mergedEdges } = useMemo(() => {
    type RawN = { id: string; type?: string; data?: Record<string, unknown>; position?: { x: number; y: number }; parentId?: string; initialWidth?: number; initialHeight?: number };
    type RawE = { id: string; source: string; target: string };

    // Step 1 — for each rig, compute its prefixed nodes/edges + bounds.
    const perRig: Array<{
      rigId: string;
      rigName: string;
      status: "running" | "partial" | "stopped";
      nodeCount: number;
      runningCount: number;
      podCount?: number;
      isExpanded: boolean;
      childNodes: Node[];
      childEdges: Edge[];
      width: number;
      height: number;
    }> = [];

    for (let i = 0; i < rigList.length; i++) {
      const rig = rigList[i]!;
      const isExpanded = expanded.get(rig.rigId) ?? false;
      const queryResult = graphQueries[i];

      let childNodes: Node[] = [];
      let childEdges: Edge[] = [];
      let width = COLLAPSED_RIG_WIDTH;
      let height = COLLAPSED_RIG_HEIGHT;
      let podCount: number | undefined;

      if (isExpanded && queryResult?.data) {
        // Apply per-rig layout (option (a) per Phase 5.2 ACK §2).
        const rawNodes = (queryResult.data.nodes ?? []) as RawN[];
        const rawEdges = (queryResult.data.edges ?? []) as RawE[];
        // Cast to LayoutNode shape for applyTreeLayout (it's permissive).
        const laidOut = applyTreeLayout(
          rawNodes as Parameters<typeof applyTreeLayout>[0],
          rawEdges as Parameters<typeof applyTreeLayout>[1],
        ) as RawN[];
        // Cross-rig prefix step.
        const prefixed = prefixRigData(rig.rigId, laidOut, rawEdges);
        // Bounds for the rig group container.
        const bounds = computeBounds(
          prefixed.nodes.map((n) => ({
            position: n.position ?? { x: 0, y: 0 },
            initialWidth: n.initialWidth,
            initialHeight: n.initialHeight,
          })),
        );
        width = bounds.width;
        height = bounds.height;
        // Re-position relative to rig-internal origin (top-left = padding,
        // header eaten by RIG_HEADER_HEIGHT).
        childNodes = prefixed.nodes.map((n) => ({
          ...(n as Node),
          position: {
            x: (n.position?.x ?? 0) - bounds.minX + RIG_PADDING,
            y: (n.position?.y ?? 0) - bounds.minY + RIG_HEADER_HEIGHT + RIG_PADDING,
          },
          parentId: `rig-${rig.rigId}`,
          extent: "parent" as const,
        }));
        childEdges = prefixed.edges as Edge[];
        podCount = prefixed.nodes.filter(
          (n) => n.type === "podGroup" || n.type === "group",
        ).length;
      }

      perRig.push({
        rigId: rig.rigId,
        rigName: rig.name,
        status: rig.status,
        nodeCount: rig.nodeCount,
        runningCount: rig.runningCount,
        podCount,
        isExpanded,
        childNodes,
        childEdges,
        width,
        height,
      });
    }

    // Step 2 — pack rig groups in the canvas grid.
    const packed = packRigGroups(
      perRig.map((p) => ({ rigId: p.rigId, width: p.width, height: p.height })),
      Math.max(innerWidth, 1024) - 64, // canvas padding
    );

    // Step 3 — emit rigGroup container nodes + child nodes (offset by
    // pack position, since children carry parentId so react-flow handles
    // the visual offset for us).
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    for (let i = 0; i < perRig.length; i++) {
      const p = perRig[i]!;
      const pack = packed[i]!;
      const data: RigGroupNodeData = {
        rigId: p.rigId,
        rigName: p.rigName,
        collapsed: !p.isExpanded,
        status: p.status,
        nodeCount: p.nodeCount,
        runningCount: p.runningCount,
        podCount: p.podCount,
        onToggle: toggleRig,
      };
      nodes.push({
        id: `rig-${p.rigId}`,
        type: "rigGroup",
        position: { x: pack.offsetX, y: pack.offsetY },
        data: data as unknown as Record<string, unknown>,
        style: { width: pack.width, height: pack.height },
        // Rig group must come BEFORE its children in the nodes array so
        // react-flow's parent/child positioning resolves correctly.
        // Children only included when expanded.
      });
      if (p.isExpanded) {
        nodes.push(...p.childNodes);
        edges.push(...p.childEdges);
      }
    }

    return { mergedNodes: nodes, mergedEdges: edges };
    // toggleRig is stable per-render but useMemo doesn't know; safe to
    // include rigList + expanded + graphQueries + innerWidth as deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rigList, expanded, graphQueries, innerWidth]);

  // P5.2-7 click handlers — agent → seat URL; pod group → pod URL;
  // rig group → toggle (handled inside RigGroupNode onClick; this
  // handler is a no-op for rigGroup type to avoid double-fire).
  const onNodeClick: NodeMouseHandler = (_evt, node) => {
    const data = node.data as { rigId?: string; logicalId?: string; podId?: string | null; podNamespace?: string | null } | undefined;
    const rigId = data?.rigId;
    if (!rigId) return;
    if (node.type === "rigGroup") return; // body click handled by RigGroupNode
    if (node.type === "podGroup" || node.type === "group") {
      const podName = data?.podNamespace ?? data?.podId;
      if (!podName) return;
      navigate({
        to: "/topology/pod/$rigId/$podName",
        params: { rigId, podName },
      });
      return;
    }
    if (data?.logicalId) {
      navigate({
        to: "/topology/seat/$rigId/$logicalId",
        params: { rigId, logicalId: encodeURIComponent(data.logicalId) },
      });
    }
  };

  if (rigList.length === 0) {
    return (
      <div
        data-testid="host-multi-rig-graph-empty"
        className="flex flex-col items-center justify-center h-full font-mono text-[10px] text-on-surface-variant"
      >
        No rigs registered. Run <code className="ml-1 text-stone-700">rig up</code> to start one.
      </div>
    );
  }

  return (
    <div
      data-testid="host-multi-rig-graph"
      className="w-full h-full relative"
    >
      <ReactFlow
        nodes={mergedNodes}
        edges={mergedEdges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        fitView
        fitViewOptions={{ padding: 0.15, includeHiddenNodes: false }}
        proOptions={{ hideAttribution: true }}
      >
        <Controls
          position="bottom-right"
          showInteractive={false}
          className="!bg-white/40 !border !border-outline-variant"
        />
      </ReactFlow>
    </div>
  );
}
