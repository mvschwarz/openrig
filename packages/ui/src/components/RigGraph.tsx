import { useMemo, useCallback, useState, useRef, useEffect } from "react";
import { ReactFlow, Controls, Handle, Position, type NodeTypes, type Node, type Edge, type NodeMouseHandler } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useRigGraph } from "../hooks/useRigGraph.js";
import { useRigEvents } from "../hooks/useRigEvents.js";
import { useDiscoveredSessionsConditional, type DiscoveredSession } from "../hooks/useDiscovery.js";
import { useDrawerSelection, useNodeSelection } from "./AppShell.js";
import { getEdgeStyle } from "@/lib/edge-styles";
import { applyTreeLayout } from "@/lib/graph-layout";
import { RigNode } from "./RigNode.js";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { displayPodName, inferPodName } from "../lib/display-name.js";
import { shortId } from "../lib/display-id.js";

function PodGroupNode({ data }: { data: { podLabel?: string | null; logicalId?: string | null; podId?: string | null; podDisplayName?: string | null } }) {
  const label = data.podDisplayName ?? inferPodName(data.logicalId) ?? displayPodName(data.podId ?? data.logicalId);

  return (
    <div
      data-testid="pod-group-node"
      className="w-full h-full relative pointer-events-auto"
    >
      <div className="absolute left-4 top-3 inline-flex items-center font-mono text-[12px] font-bold leading-none tracking-[0.08em] text-stone-800">
        {`${label} pod`}
      </div>
    </div>
  );
}

/** Discovered (unmanaged) node rendered with dashed border */
function DiscoveredNode({ data }: { data: { session: DiscoveredSession } }) {
  const s = data.session;
  return (
    <div data-testid="discovered-graph-node" className="border-dashed border-2 border-foreground/30 bg-surface-low/50 p-spacing-3 min-w-[180px]">
      <Handle type="target" position={Position.Top} className="opacity-0" />
      <div className="text-label-sm font-mono uppercase mb-spacing-1">{s.tmuxSession}:{s.tmuxPane}</div>
      <div className="flex gap-spacing-2 items-center mb-spacing-1">
        <span className="text-label-sm uppercase text-foreground-muted">{s.runtimeHint}</span>
        <span className="text-label-sm text-foreground-muted">{s.confidence}</span>
      </div>
      {s.cwd && <div className="text-label-sm font-mono text-foreground-muted truncate">{s.cwd}</div>}
      <Handle type="source" position={Position.Bottom} className="opacity-0" />
    </div>
  );
}

const nodeTypes: NodeTypes = {
  rigNode: RigNode,
  discoveredNode: DiscoveredNode,
  podGroup: PodGroupNode,
};

/** Wireframe ghost for empty topology */
function EmptyTopologyGhost() {
  return (
    <div className="flex flex-col items-center justify-center h-full relative text-foreground-muted" data-testid="empty-topology">
      <svg className="absolute inset-0 w-full h-full" viewBox="0 0 400 300" fill="none" style={{ opacity: 0.08 }}>
        <rect x="160" y="60" width="80" height="40" stroke="currentColor" strokeWidth="1" />
        <rect x="60" y="180" width="80" height="40" stroke="currentColor" strokeWidth="1" />
        <rect x="260" y="180" width="80" height="40" stroke="currentColor" strokeWidth="1" />
        <line x1="200" y1="100" x2="100" y2="180" stroke="currentColor" strokeWidth="1" strokeDasharray="4 4" />
        <line x1="200" y1="100" x2="300" y2="180" stroke="currentColor" strokeWidth="1" strokeDasharray="4 4" />
      </svg>
      <div className="relative z-10 text-center">
        <h2 className="text-headline-md uppercase">EMPTY TOPOLOGY</h2>
      </div>
    </div>
  );
}

interface FocusMessage {
  text: string;
  type: "success" | "error" | "info";
}

export function RigGraph({
  rigId,
  rigName = null,
  showDiscovered = true,
}: {
  rigId: string | null;
  rigName?: string | null;
  showDiscovered?: boolean;
}) {
  const { data, isPending: loading, error: queryError } = useRigGraph(rigId ?? "");
  const discoveredSessions = useDiscoveredSessionsConditional(showDiscovered);
  const rawNodes = data?.nodes ?? [];
  const rawEdges = data?.edges ?? [];
  const error = queryError?.message ?? null;
  const { reconnecting } = useRigEvents(rigId);
  const [focusMessage, setFocusMessage] = useState<FocusMessage | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Entrance animation tracking — keyed by rigId, fires once per navigation
  const animatedRigRef = useRef<string | null>(null);
  const shouldAnimate = rigId !== null && animatedRigRef.current !== rigId;

  // Mark animation as done after first render
  useEffect(() => {
    if (rigId && rawNodes.length > 0 && animatedRigRef.current !== rigId) {
      animatedRigRef.current = rigId;
    }
  }, [rigId, rawNodes.length]);

  const showFocusMessage = useCallback((msg: FocusMessage) => {
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    setFocusMessage(msg);
    dismissTimerRef.current = setTimeout(() => {
      setFocusMessage(null);
      dismissTimerRef.current = null;
    }, 3000);
  }, []);

  useEffect(() => {
    return () => {
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    };
  }, []);

  // Apply edge styles from design system + entrance animation
  const rfEdges = useMemo(() => {
    return (rawEdges as (Edge & { data?: { kind?: string } })[]).map((edge) => {
      const kind = (edge as { data?: { kind?: string } }).data?.kind ??
        (edge as { label?: string }).label ?? "delegates_to";
      const styleResult = getEdgeStyle(kind);
      return {
        ...edge,
        ...styleResult,
        className: shouldAnimate ? "edge-draw-in" : undefined,
        style: {
          ...styleResult.style,
          animationDelay: shouldAnimate ? `${Math.min(rawNodes.length * 50 + 100, 2000)}ms` : undefined,
        },
      };
    });
  }, [rawEdges, shouldAnimate, rawNodes.length]);

  // Apply tree layout + entrance animation to nodes
  const rfNodes = useMemo(() => {
    const podDisplayNames = new Map<string, string>();
    for (const node of rawNodes as Node[]) {
      if (!node.parentId) {
        continue;
      }

      const logicalId = typeof node.data === "object" && node.data !== null && "logicalId" in node.data
        ? (node.data as { logicalId?: string | null }).logicalId
        : null;
      const podId = typeof node.data === "object" && node.data !== null && "podId" in node.data
        ? (node.data as { podId?: string | null }).podId
        : null;
      const podDisplayName = inferPodName(logicalId) ?? displayPodName(podId);

      if (podDisplayName && !podDisplayNames.has(node.parentId)) {
        podDisplayNames.set(node.parentId, podDisplayName);
      }
    }

    const layoutNodes = applyTreeLayout(rawNodes as Node[], rawEdges as unknown as Parameters<typeof applyTreeLayout>[1]);
    const managed = layoutNodes.map((node, index) => ({
      ...node,
      data: node.type === "podGroup" || node.type === "group"
        ? {
            ...(node.data ?? {}),
            podDisplayName: podDisplayNames.get(node.id) ?? null,
          }
        : node.data,
      className: shouldAnimate ? "node-enter" : undefined,
      style: {
        ...(node.style ?? {}),
        animationDelay: shouldAnimate ? `${Math.min(index * 50, 2000)}ms` : undefined,
      },
    }));

    // Add discovered sessions as dashed nodes below managed ones
    const maxY = managed.reduce((max, n) => Math.max(max, (n.position?.y ?? 0)), 0);
    const discovered = discoveredSessions.map((s, i) => ({
      id: `discovered-${s.id}`,
      type: "discoveredNode" as const,
      position: { x: 300, y: maxY + 200 + i * 150 },
      data: { session: s } as Record<string, unknown>,
    }));

    return [...managed, ...discovered] as Node[];
  }, [rawNodes, rawEdges, shouldAnimate, discoveredSessions]);

  const { setSelectedNode } = useNodeSelection();
  const { setSelection } = useDrawerSelection();
  const rigStamp = rigName?.trim() ? rigName : (rigId ? shortId(rigId) : null);

  const onNodeClick: NodeMouseHandler = useCallback(
    async (_event, node) => {
      if (!rigId) return;

      if (node.type === "podGroup" || node.type === "group") {
        setSelection({ type: "rig", rigId });
        return;
      }

      const nodeData = node.data as {
        logicalId: string;
        binding: { cmuxSurface?: string | null } | null;
      };

      // Set shared node selection (for detail panel)
      setSelectedNode({ rigId, logicalId: nodeData.logicalId });

      if (!nodeData.binding?.cmuxSurface) {
        showFocusMessage({ text: "Not bound to cmux surface", type: "info" });
        return;
      }

      try {
        const res = await fetch(
          `/api/rigs/${encodeURIComponent(rigId)}/nodes/${encodeURIComponent(nodeData.logicalId)}/focus`,
          { method: "POST" }
        );

        if (!res.ok) {
          showFocusMessage({ text: "Focus failed", type: "error" });
          return;
        }

        const result = await res.json();

        if (result.ok === false && result.code === "unavailable") {
          showFocusMessage({ text: "cmux not connected", type: "error" });
        } else if (result.ok) {
          showFocusMessage({ text: "Focused", type: "success" });
        } else {
          showFocusMessage({ text: "Focus failed", type: "error" });
        }
      } catch {
        showFocusMessage({ text: "Focus failed", type: "error" });
      }
    },
    [rigId, showFocusMessage, setSelectedNode, setSelection]
  );

  if (rigId === null) {
    return <div className="p-spacing-6 text-foreground-muted">No rig selected</div>;
  }

  if (loading) {
    return (
      <div className="p-spacing-6" data-testid="graph-loading">
        <div className="h-8 w-48 animate-pulse-tactical mb-spacing-4" />
        <div className="h-64 animate-pulse-tactical" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-spacing-6">
        <Alert data-testid="graph-error">
          <AlertDescription>Error: {error}</AlertDescription>
        </Alert>
      </div>
    );
  }

  if (rfNodes.length === 0) {
    return <EmptyTopologyGhost />;
  }

  return (
    <div
      className="w-full h-full relative"
      data-testid="graph-view"
      data-animated={shouldAnimate ? "true" : "false"}
    >
      {/* Registration marks on canvas */}
      <div className="absolute top-4 left-4 w-3 h-3 reg-mark"><div className="reg-tl" /></div>
      <div className="absolute top-4 right-4 w-3 h-3"><div className="reg-tr" /></div>
      <div className="absolute bottom-4 left-4 w-3 h-3"><div className="reg-bl" /></div>
      <div className="absolute bottom-4 right-4 w-3 h-3"><div className="reg-br" /></div>

      {/* Ambient rig stamp watermark */}
      {rigStamp && (
        <div data-testid="rig-stamp-watermark" className="stamp-watermark text-3xl left-[20%] top-[35%]">
          {rigStamp}
        </div>
      )}

      {reconnecting && (
        <div className="absolute top-spacing-4 right-spacing-4 z-20">
          <Alert>
            <AlertDescription className="text-warning">Reconnecting...</AlertDescription>
          </Alert>
        </div>
      )}
      {focusMessage && (
        <div className={`absolute top-spacing-4 left-spacing-4 z-20 px-spacing-4 py-spacing-2 font-mono text-[10px] border ${
          focusMessage.type === "success" ? "bg-white border-stone-900 text-stone-900" :
          focusMessage.type === "error" ? "bg-tertiary/10 border-tertiary text-tertiary" :
          "bg-white border-stone-300 text-stone-600"
        }`}>
          {focusMessage.text}
        </div>
      )}
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        nodesDraggable={false}
        selectionOnDrag={false}
        panOnDrag
        fitView
        fitViewOptions={{ padding: 0.16, maxZoom: 1.15 }}
        className="relative z-10"
        proOptions={{ hideAttribution: true }}
        minZoom={0.3}
        maxZoom={1.5}
      >
        <Controls />
      </ReactFlow>

      {/* Footer status pills */}
      <div className="absolute bottom-4 left-4 z-20 flex gap-spacing-2">
        <div className="bg-white/90 border border-stone-900 px-3 py-1 font-mono text-[10px] flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
          TOPOLOGY_ACTIVE
        </div>
      </div>
    </div>
  );
}
