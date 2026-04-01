import type { CSSProperties } from "react";
import { MarkerType } from "@xyflow/react";

export interface EdgeStyleResult {
  style: CSSProperties;
  animated: boolean;
  type: string;
  pathOptions?: { borderRadius?: number; offset?: number };
  markerEnd: { type: MarkerType; color: string; width: number; height: number };
  label?: undefined;
}

const EDGE_COLOR = "#546073";
const ARROW = { type: MarkerType.ArrowClosed, color: EDGE_COLOR, width: 12, height: 12 };

/**
 * Edge styles for vellum paper aesthetic.
 * All edges use secondary blue (#546073) with arrow markers.
 * Relationship type communicated via line style, not labels.
 */
export function getEdgeStyle(kind: string): EdgeStyleResult {
  switch (kind) {
    case "delegates_to":
      return {
        style: { stroke: EDGE_COLOR, strokeWidth: 1.5 },
        animated: false,
        type: "smoothstep",
        pathOptions: { borderRadius: 18, offset: 20 },
        markerEnd: ARROW,
        label: undefined,
      };
    case "spawned_by":
      return {
        style: { stroke: EDGE_COLOR, strokeWidth: 1.5, strokeDasharray: "6 3" },
        animated: false,
        type: "smoothstep",
        pathOptions: { borderRadius: 18, offset: 20 },
        markerEnd: ARROW,
        label: undefined,
      };
    case "can_observe":
      return {
        style: { stroke: EDGE_COLOR, strokeWidth: 1, strokeDasharray: "4 2" },
        animated: false,
        type: "smoothstep",
        pathOptions: { borderRadius: 18, offset: 20 },
        markerEnd: ARROW,
        label: undefined,
      };
    case "uses":
      return {
        style: { stroke: EDGE_COLOR, strokeWidth: 1, strokeDasharray: "2 2" },
        animated: false,
        type: "smoothstep",
        pathOptions: { borderRadius: 18, offset: 20 },
        markerEnd: ARROW,
        label: undefined,
      };
    default:
      return {
        style: { stroke: EDGE_COLOR, strokeWidth: 1 },
        animated: false,
        type: "smoothstep",
        pathOptions: { borderRadius: 18, offset: 20 },
        markerEnd: ARROW,
        label: undefined,
      };
  }
}
