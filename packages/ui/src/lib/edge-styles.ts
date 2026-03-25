import type { CSSProperties } from "react";

export interface EdgeStyleResult {
  style: CSSProperties;
  animated: boolean;
  type: string;
}

/**
 * Maps edge kind to React Flow edge style props per design-system.md §2.
 */
export function getEdgeStyle(kind: string): EdgeStyleResult {
  switch (kind) {
    case "delegates_to":
      return {
        style: { stroke: "hsl(var(--primary))", strokeWidth: 2 },
        animated: false,
        type: "smoothstep",
      };
    case "spawned_by":
      return {
        style: { stroke: "hsl(var(--primary))", strokeWidth: 2, strokeDasharray: "6 3" },
        animated: false,
        type: "smoothstep",
      };
    case "can_observe":
      return {
        style: { stroke: "hsl(var(--foreground-muted))", strokeWidth: 1.5, strokeDasharray: "2 2" },
        animated: false,
        type: "smoothstep",
      };
    case "uses":
      return {
        style: { stroke: "hsl(var(--accent))", strokeWidth: 1 },
        animated: false,
        type: "smoothstep",
      };
    default:
      return {
        style: { stroke: "hsl(var(--foreground-muted))", strokeWidth: 1 },
        animated: false,
        type: "smoothstep",
      };
  }
}
