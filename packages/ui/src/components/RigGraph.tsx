import { useMemo, useCallback, useState, useRef, useEffect } from "react";
import { ReactFlow, Controls, type NodeTypes, type Node, type Edge, type NodeMouseHandler } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useRigGraph } from "../hooks/useRigGraph.js";
import { useRigEvents } from "../hooks/useRigEvents.js";
import { getEdgeStyle } from "@/lib/edge-styles";
import { RigNode } from "./RigNode.js";
import { Alert, AlertDescription } from "@/components/ui/alert";

const nodeTypes: NodeTypes = {
  rigNode: RigNode,
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

export function RigGraph({ rigId }: { rigId: string | null }) {
  const { data, isPending: loading, error: queryError } = useRigGraph(rigId ?? "");
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

  // Apply entrance animation to nodes via className
  const rfNodes = useMemo(() => {
    return (rawNodes as Node[]).map((node, index) => ({
      ...node,
      className: shouldAnimate ? "node-enter" : undefined,
      style: {
        ...(node.style ?? {}),
        animationDelay: shouldAnimate ? `${Math.min(index * 50, 2000)}ms` : undefined,
      },
    }));
  }, [rawNodes, shouldAnimate]);

  const onNodeClick: NodeMouseHandler = useCallback(
    async (_event, node) => {
      if (!rigId) return;

      const nodeData = node.data as {
        logicalId: string;
        binding: { cmuxSurface?: string | null } | null;
      };

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
    [rigId, showFocusMessage]
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
      {reconnecting && (
        <div className="absolute top-spacing-2 right-spacing-2 z-10">
          <Alert>
            <AlertDescription className="text-warning">Reconnecting...</AlertDescription>
          </Alert>
        </div>
      )}
      {focusMessage && (
        <div className={`absolute top-spacing-2 left-spacing-2 z-10 px-spacing-3 py-spacing-1 text-label-md font-mono ${
          focusMessage.type === "success" ? "bg-primary text-primary-foreground" :
          focusMessage.type === "error" ? "bg-destructive text-destructive-foreground" :
          "bg-surface-high text-foreground"
        }`}>
          {focusMessage.text}
        </div>
      )}
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        fitView
      >
        <Controls />
      </ReactFlow>
    </div>
  );
}
