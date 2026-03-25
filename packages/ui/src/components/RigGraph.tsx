import { useMemo, useCallback, useState, useRef, useEffect } from "react";
import { ReactFlow, MiniMap, Controls, type NodeTypes, type Node, type Edge, type NodeMouseHandler } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useRigGraph } from "../hooks/useRigGraph.js";
import { useRigEvents } from "../hooks/useRigEvents.js";
import { RigNode } from "./RigNode.js";

const nodeTypes: NodeTypes = {
  rigNode: RigNode,
};

interface FocusMessage {
  text: string;
  type: "success" | "error" | "info";
}

export function RigGraph({ rigId }: { rigId: string | null }) {
  const { data, isPending: loading, error: queryError } = useRigGraph(rigId ?? "");
  const nodes = data?.nodes ?? [];
  const edges = data?.edges ?? [];
  const error = queryError?.message ?? null;
  const { reconnecting } = useRigEvents(rigId);
  const [focusMessage, setFocusMessage] = useState<FocusMessage | null>(null);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showFocusMessage = useCallback((msg: FocusMessage) => {
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current);
    }
    setFocusMessage(msg);
    dismissTimerRef.current = setTimeout(() => {
      setFocusMessage(null);
      dismissTimerRef.current = null;
    }, 3000);
  }, []);

  // Clear timer on unmount
  useEffect(() => {
    return () => {
      if (dismissTimerRef.current) {
        clearTimeout(dismissTimerRef.current);
      }
    };
  }, []);

  const rfNodes = useMemo(() => nodes as Node[], [nodes]);
  const rfEdges = useMemo(() => edges as Edge[], [edges]);

  const onNodeClick: NodeMouseHandler = useCallback(
    async (_event, node) => {
      if (!rigId) return;

      const data = node.data as {
        logicalId: string;
        binding: { cmuxSurface?: string | null } | null;
      };

      // Client-side guard: no binding or no cmuxSurface -> not bound
      if (!data.binding?.cmuxSurface) {
        showFocusMessage({ text: "Not bound to cmux surface", type: "info" });
        return;
      }

      try {
        const res = await fetch(
          `/api/rigs/${rigId}/nodes/${data.logicalId}/focus`,
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
    return <div>No rig selected</div>;
  }

  if (loading) {
    return <div>Loading...</div>;
  }

  if (error) {
    return <div>Error: {error}</div>;
  }

  if (rfNodes.length === 0) {
    return <div>No nodes in this rig</div>;
  }

  return (
    <div style={{ width: "100%", height: "100%", position: "relative" }}>
      {reconnecting && (
        <div style={{ position: "absolute", top: 8, right: 8, zIndex: 10, background: "#ffa500", color: "#fff", padding: "4px 8px", borderRadius: 4, fontSize: 12 }}>
          Reconnecting...
        </div>
      )}
      {focusMessage && (
        <div style={{ position: "absolute", top: 8, left: 8, zIndex: 10, background: focusMessage.type === "success" ? "#4caf50" : focusMessage.type === "error" ? "#f44336" : "#2196f3", color: "#fff", padding: "4px 8px", borderRadius: 4, fontSize: 12 }}>
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
        <MiniMap />
        <Controls />
      </ReactFlow>
    </div>
  );
}
