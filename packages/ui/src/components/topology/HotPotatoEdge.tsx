import {
  BaseEdge,
  getBezierPath,
  type EdgeProps,
} from "@xyflow/react";
import type { HotPotatoEdgeData } from "../../lib/topology-activity.js";

export function HotPotatoEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  data,
}: EdgeProps) {
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  const edgeData = (data ?? {}) as HotPotatoEdgeData;
  const packet = edgeData.hotPotatoPacket ?? null;
  const crossRig = edgeData.hotPotatoCrossRig ?? false;
  const reducedMotion = edgeData.hotPotatoReducedMotion ?? false;
  const strokeWidth = packet ? (crossRig ? 1.25 : 2.25) : style?.strokeWidth;

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          ...style,
          strokeWidth,
          filter: packet ? "drop-shadow(0 0 3px rgba(16,185,129,0.22))" : style?.filter,
        }}
      />
      {packet ? (
        reducedMotion ? (
          <circle
            data-testid={`hot-potato-packet-${packet.id}`}
            data-reduced-motion="true"
            cx={targetX}
            cy={targetY}
            r={crossRig ? 5 : 6.5}
            stroke="rgba(255,255,255,0.88)"
            strokeWidth={crossRig ? 1.75 : 2.25}
            vectorEffect="non-scaling-stroke"
            className={crossRig ? "fill-stone-500" : "fill-emerald-600"}
          />
        ) : (
          <circle
            key={packet.id}
            data-testid={`hot-potato-packet-${packet.id}`}
            data-reduced-motion="false"
            r={crossRig ? 5 : 6.5}
            stroke="rgba(255,255,255,0.88)"
            strokeWidth={crossRig ? 1.75 : 2.25}
            vectorEffect="non-scaling-stroke"
            className={crossRig ? "fill-stone-500 hot-potato-packet-cross" : "fill-emerald-600 hot-potato-packet"}
          >
            <animateMotion
              dur={`${packet.durationMs}ms`}
              path={edgePath}
              fill="freeze"
              calcMode="spline"
              keySplines="0.2 0 0 1"
              keyTimes="0;1"
            />
          </circle>
        )
      ) : null}
    </>
  );
}
