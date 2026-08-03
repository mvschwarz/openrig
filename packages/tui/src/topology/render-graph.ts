// Slice-17 topology leg — the PRODUCTION style registry (narrowed from the
// spike per the FOUNDER STYLE VERDICT): hatchet = the shipped mainline
// (frame-01), braille = the conditional smooth style (frame-09) with its
// proven TIER-1 fallback. Frame-06 tree is RESERVED (deliberately NOT wired);
// flow/blocks stay spike-only. Every style renders the ONE served /graph
// projection over the SAME view-state (R7 + PIN-1).
import { GraphCanvas } from "./canvas.js";
import { layoutGraph } from "./layout.js";
import { renderHatchet, type StyleContext } from "./styles/hatchet.js";
import { renderBraille } from "./styles/braille.js";
import type { RigGraph } from "./graph-types.js";

export const GRAPH_STYLE_NAMES = ["hatchet", "braille", "braille-fallback"] as const;
export type GraphStyle = (typeof GRAPH_STYLE_NAMES)[number];

export function isGraphStyle(value: string): value is GraphStyle {
  return (GRAPH_STYLE_NAMES as readonly string[]).includes(value);
}

export function renderGraphStyle(style: string, graph: RigGraph, ctx: StyleContext, width: number): GraphCanvas {
  switch (style) {
    case "braille":
      return renderBraille(layoutGraph(graph, width), ctx, width, false);
    case "braille-fallback":
      return renderBraille(layoutGraph(graph, width), ctx, width, true);
    default:
      // hatchet is the mainline AND the unknown-style safety floor — the
      // reducer already rejects unknown names before render (one surface)
      return renderHatchet(layoutGraph(graph, width), ctx, width);
  }
}
