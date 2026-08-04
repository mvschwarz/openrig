// SPIKE — `--style braille`: the optional smooth end (TIER-2, modern
// terminals). Same boxed nodes as the Hatchet mainline; edges drawn at 2×4
// sub-cell resolution as braille dot runs. DEMOTED by the founder refinement
// to an optional style — the proven TIER-1 fallback IS renderHatchet (same
// layout, box-drawing edges), so degrading loses smoothness, never meaning.
import { GraphCanvas } from "../canvas.js";
import { edgeToken } from "../glyphs.js";
import type { GraphLayout } from "../layout.js";
import type { StyleContext } from "./hatchet.js";
import { drawNodeBox, renderHatchet } from "./hatchet.js";
import type { Token } from "../../theme.js";

// braille dot bits by (subCol 0-1, subRow 0-3)
const DOT_BITS = [
  [0x01, 0x02, 0x04, 0x40],
  [0x08, 0x10, 0x20, 0x80],
] as const;

class BrailleField {
  private cells = new Map<string, { bits: number; token: Token }>();

  setDot(px: number, py: number, token: Token): void {
    const cellX = Math.floor(px / 2);
    const cellY = Math.floor(py / 4);
    const key = `${cellX},${cellY}`;
    const bits = DOT_BITS[px % 2]![py % 4]!;
    const existing = this.cells.get(key);
    this.cells.set(key, { bits: (existing?.bits ?? 0) | bits, token: existing?.token ?? token });
  }

  line(x1: number, y1: number, x2: number, y2: number, token: Token): void {
    const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1), 1);
    for (let i = 0; i <= steps; i++) {
      this.setDot(Math.round(x1 + ((x2 - x1) * i) / steps), Math.round(y1 + ((y2 - y1) * i) / steps), token);
    }
  }

  blit(canvas: GraphCanvas): void {
    for (const [key, cell] of this.cells) {
      const [x, y] = key.split(",").map(Number) as [number, number];
      if (canvas.charAt(x, y) !== " " || canvas.isProtected(x, y)) continue; // never dot boxes/text
      canvas.set(x, y, String.fromCharCode(0x2800 + cell.bits), cell.token);
    }
  }
}

export function renderBraille(layout: GraphLayout, ctx: StyleContext, width: number, tier1Fallback: boolean): GraphCanvas {
  if (tier1Fallback) return renderHatchet(layout, ctx, width); // the PROVEN fallback path
  // DRAW ORDER = the hatchet semantics (pm kickback: opacity must be a CLASS
  // invariant, never a draw-order artifact): (1) box-drawing edge runs first,
  // (2) OPAQUE boxes clear any pass-through segment, (3) the braille field
  // blits last but is protected-cell-aware, (4) arrowheads last of all.
  const canvas = new GraphCanvas(width);
  const field = new BrailleField();
  const arrows: Array<{ x: number; y: number; ch: string; token: ReturnType<typeof edgeToken> }> = [];
  for (const edge of layout.edges) {
    const from = layout.byId.get(edge.source);
    const to = layout.byId.get(edge.target);
    if (!from || !to) continue;
    const token = edgeToken(edge.label);
    const rightward = to.x > from.x;
    const txCell = rightward ? to.x - 1 : to.x + to.w;
    if (from.y === to.y) {
      // CLEAN-BOX refinement: a straight horizontal is already straight —
      // box-drawing ─ aligns mid-cell with the arrowhead (braille ⠤ sits low
      // and kinks the junction); braille earns its keep on DIAGONALS only.
      const [x1, x2] = rightward ? [from.x + from.w, txCell - 1] : [txCell + 1, from.x - 1];
      canvas.hline(x1, x2, from.y + 1, "─", token);
    } else {
      const sx = (rightward ? from.x + from.w : from.x - 1) * 2;
      const sy = (from.y + 1) * 4 + 2;
      const tx = txCell * 2 + (rightward ? 0 : 1);
      const ty = (to.y + 1) * 4 + 2;
      field.line(sx, sy, tx, ty, token);
    }
    arrows.push({ x: txCell, y: to.y + 1, ch: rightward ? "▸" : "◂", token });
  }
  for (const p of layout.placed) drawNodeBox(canvas, p, ctx);
  field.blit(canvas); // protected-aware: never dots a box cell
  for (const a of arrows) if (!canvas.isProtected(a.x, a.y)) canvas.set(a.x, a.y, a.ch, a.token, true);
  canvas.text(2, canvas.height + 1, "braille sub-cell edges · TIER-2 (modern terminals) · fallback = hatchet box-drawing", "dim");
  return canvas;
}
