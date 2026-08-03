// SPIKE — the MAINLINE style (founder-preferred, Hatchet reference):
// boxed nodes + straight box-drawing connector lines + arrowheads.
// Info lives INSIDE the node (name line + runtime · ctx% · pod meta line),
// status lives ON the node (border color + glyph), edge KIND is line COLOR
// (delegates=teal accent · collaborates=green ok · escalates=amber warn) —
// NO text labels on the graph (founder refinement). TIER-1 glyphs only.
import { GraphCanvas } from "../canvas.js";
import { edgeToken } from "../glyphs.js";
import type { GraphLayout, PlacedNode } from "../layout.js";
import type { Action, ResourceTarget } from "../../types.js";

export interface StyleContext {
  /** host/rig names for drill actions (the SAME Action vocabulary every
   * adapter dispatches — PIN-1) */
  host: string;
  rig: string;
  /** logicalId of the selected node (accent border, like Hatchet) */
  selected?: string | null;
}

export function drillAction(node: PlacedNode, ctx: StyleContext): Action {
  const target: ResourceTarget = {
    host: ctx.host,
    rig: ctx.rig,
    ...(node.node.data.podNamespace ? { pod: node.node.data.podNamespace } : {}),
  };
  return { type: "drill", resource: "agent", name: node.node.data.logicalId, target };
}

export function drawNodeBox(canvas: GraphCanvas, p: PlacedNode, ctx: StyleContext): void {
  const selected = ctx.selected === p.node.data.logicalId;
  const borderToken = selected ? "accent" : p.glyph.token;
  canvas.box(p.x, p.y, p.w, p.h, borderToken);
  canvas.text(p.x + 2, p.y + 1, p.glyph.glyph, p.glyph.token, true);
  canvas.text(p.x + 4, p.y + 1, p.node.data.logicalId, "bright", selected);
  if (p.glyph.overlay) canvas.text(p.x + 4 + p.node.data.logicalId.length + 2, p.y + 1, p.glyph.overlay, "warn", true);
  canvas.text(p.x + 2, p.y + 2, p.metaLine, "dim");
  // the WHOLE box is the hit surface — every row emits the same drill action
  const action = drillAction(p, ctx);
  for (let row = 0; row < p.h; row++) canvas.zone(p.y + row, p.x, p.x + p.w, action);
}

interface Arrow {
  x: number;
  y: number;
  ch: string;
  token: ReturnType<typeof edgeToken>;
}

/** straight orthogonal connector; the arrowhead is returned so the caller can
 * draw it LAST (it must survive the node boxes painting over line ends) */
export function drawEdge(canvas: GraphCanvas, from: PlacedNode, to: PlacedNode, kind: string, lane = 0, obstacles: PlacedNode[] = []): Arrow {
  const token = edgeToken(kind);
  const sy = from.y + 1;
  const ty = to.y + 1;
  if (to.x > from.x + from.w) {
    // rightward: out of source right edge, one corridor turn, into target left edge
    const sx = from.x + from.w;
    const corridor = to.x - 3 - lane * 2;
    canvas.hline(sx, corridor, sy, "─", token);
    if (sy !== ty) {
      canvas.vline(corridor, Math.min(sy, ty), Math.max(sy, ty), "│", token);
      canvas.set(corridor, sy, sy < ty ? "┐" : "┘", token);
      canvas.set(corridor, ty, sy < ty ? "└" : "┌", token);
    }
    canvas.hline(corridor + 1, to.x - 2, ty, "─", token);
    return { x: to.x - 1, y: ty, ch: "▸", token };
  }
  if (to.x + to.w < from.x) {
    // leftward back-edge (escalation): route UNDER the boxes so it never
    // crowds the delegation row — down, left along a low corridor, up into
    // the target's bottom edge (the mockup's curve, box-drawn). The vertical
    // legs pick columns that no OTHER box occupies (obstacle-aware).
    const belowY = Math.max(...[from, to, ...obstacles].map((p) => p.y + p.h)) + 1 + lane;
    const freeColumn = (box: PlacedNode, fromRight: boolean): number => {
      const candidates: number[] = [];
      for (let i = 2; i < box.w - 1; i++) candidates.push(fromRight ? box.x + box.w - 1 - i : box.x + i);
      for (const x of candidates) {
        const blocked = obstacles.some(
          (p) => p !== box && x >= p.x && x <= p.x + p.w - 1 && p.y + p.h > box.y + box.h && p.y <= belowY,
        );
        if (!blocked) return x;
      }
      return box.x + 2;
    };
    const exitX = freeColumn(from, false);
    const enterX = freeColumn(to, true);
    canvas.vline(exitX, from.y + from.h, belowY - 1, "│", token);
    canvas.set(exitX, belowY, "┘", token);
    canvas.hline(enterX + 1, exitX - 1, belowY, "─", token);
    canvas.set(enterX, belowY, "└", token);
    canvas.vline(enterX, to.y + to.h + 1, belowY - 1, "│", token);
    return { x: enterX, y: to.y + to.h, ch: "▴", token };
  }
  // same column: vertical connector
  const x = from.x + Math.min(4, from.w - 2);
  if (to.y > from.y) {
    canvas.vline(x, from.y + from.h, to.y - 2, "│", token);
    return { x, y: to.y - 1, ch: "▾", token };
  }
  canvas.vline(x, to.y + to.h + 1, from.y - 1, "│", token);
  return { x, y: to.y + to.h, ch: "▴", token };
}

export function renderHatchet(layout: GraphLayout, ctx: StyleContext, width: number): GraphCanvas {
  const canvas = new GraphCanvas(width);
  // edges first, boxes second (borders clean up line ends), arrowheads LAST
  const lanes = new Map<string, number>();
  const arrows: Arrow[] = [];
  for (const edge of layout.edges) {
    const from = layout.byId.get(edge.source);
    const to = layout.byId.get(edge.target);
    if (!from || !to) continue; // honest: an edge to an unknown node is not drawn as guesswork
    const laneKey = `${to.x}:${to.x + to.w < from.x ? "back" : "fwd"}`;
    const lane = lanes.get(laneKey) ?? 0;
    lanes.set(laneKey, lane + 1);
    arrows.push(drawEdge(canvas, from, to, edge.label, lane, layout.placed));
  }
  for (const p of layout.placed) drawNodeBox(canvas, p, ctx);
  for (const a of arrows) canvas.set(a.x, a.y, a.ch, a.token, true);
  return canvas;
}
