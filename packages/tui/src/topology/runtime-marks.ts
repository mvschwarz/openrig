// S19 MR2 (§A2+§A4, founder-directed) — the TUI renders the SAME runtime
// marks as the web UI, not cousins. The identity of record is
// packages/ui/src/components/graphics/RuntimeMark.tsx: clawd = a 16x16
// crispEdges pixel grid (body #ad6755, eyes #181818); Codex = the `>_`
// prompt mark; terminal = `>_` on a dark cell. This module derives the cell
// art FROM that grid (rect list transcribed 1:1 below) — never a redesign.
//
// Color: the marks need the web's exact RGB, so the theme gains mark tokens
// (truecolor exact; 256 nearest; 16-color value = a PLACEHOLDER pending the
// founder's degrade-fallback pick — carried in the mr7 packet, not silently
// decided).
import type { Token } from "../theme.js";

/** the RuntimeMark.tsx rect list, transcribed (x, y, w, h) */
const CLAWD_BODY_RECTS: Array<[number, number, number, number]> = [
  [3, 2, 10, 8], // body
  [1, 5, 2, 3], // left arm
  [13, 5, 2, 3], // right arm
  [4, 10, 2, 3], // legs
  [7, 10, 2, 3],
  [10, 10, 2, 3],
];
const CLAWD_EYE_RECTS: Array<[number, number, number, number]> = [
  [5, 4, 1, 2],
  [10, 4, 1, 2],
];

export type ClawdPixel = 0 | 1 | 2; // 0 empty · 1 body · 2 eye

/** the 16x16 pixel matrix, derived from the rect list (row-major) */
export function clawdGrid(): ClawdPixel[][] {
  const g: ClawdPixel[][] = Array.from({ length: 16 }, () => Array.from({ length: 16 }, () => 0 as ClawdPixel));
  for (const [x, y, w, h] of CLAWD_BODY_RECTS)
    for (let r = y; r < y + h; r++) for (let c = x; c < x + w; c++) g[r]![c] = 1;
  for (const [x, y, w, h] of CLAWD_EYE_RECTS)
    for (let r = y; r < y + h; r++) for (let c = x; c < x + w; c++) g[r]![c] = 2;
  return g;
}

export interface MarkSeg {
  text: string;
  token?: Token;
  bold?: boolean;
  /** background token for half/quadrant cells whose lower/other half differs */
  bg?: Token;
}

/** FAITHFUL form — 16 cells x 8 rows of half-blocks (▀ paints the top pixel
 * with fg and the bottom with bg): the detail-pane / prototype scale. */
export function clawdFaithfulRows(): MarkSeg[][] {
  const g = clawdGrid();
  const rows: MarkSeg[][] = [];
  for (let r = 0; r < 16; r += 2) {
    const segs: MarkSeg[] = [];
    for (let c = 0; c < 16; c++) {
      const top = g[r]![c]!;
      const bot = g[r + 1]![c]!;
      const tok = (p: ClawdPixel): Token | undefined => (p === 1 ? "clawd" : p === 2 ? "clawdEye" : undefined);
      if (top === 0 && bot === 0) segs.push({ text: " " });
      else if (top === bot) segs.push({ text: "█", token: tok(top) });
      else if (top === 0) segs.push({ text: "▄", token: tok(bot) });
      else if (bot === 0) segs.push({ text: "▀", token: tok(top) });
      else segs.push({ text: "▀", token: tok(top), bg: tok(bot) });
    }
    rows.push(segs);
  }
  return rows;
}

/** DOWNSCALED essence forms (~2-cell row marks) — CANDIDATES for the founder
 * pick (mr7); the shapes are majority-vote downsamples of the same grid, so
 * the family identity is derived, not invented. */
export function clawdMiniA(): MarkSeg[] {
  // 2 cells: quadrant-composed from a 4x4 downsample (each cell = 2x2 blocks)
  // reads as: solid head/body block + leg stubs
  return [
    { text: "▟", token: "clawd" },
    { text: "▙", token: "clawd" },
  ];
}

export function clawdMiniB(): MarkSeg[] {
  // 3 cells: body with arms — one more cell of essence
  return [
    { text: "▐", token: "clawd" },
    { text: "█", token: "clawd" },
    { text: "▌", token: "clawd" },
  ];
}

/** Codex: the `>_` prompt mark, light-on-dark (the web mark is `>_` in a
 * light circle; the terminal-cell form keeps the glyph pair). */
export function codexMark(): MarkSeg[] {
  return [
    { text: "❯", token: "markInk", bold: true },
    { text: "_", token: "markInk", bold: true },
  ];
}

/** terminal/tty runtime: dark cell + white `>_` — same family, inverted. */
export function terminalMark(): MarkSeg[] {
  return [
    { text: "❯", token: "bright", bg: "markBg", bold: true },
    { text: "_", token: "bright", bg: "markBg", bold: true },
  ];
}

/** the row-scale mark for a served runtime string (placeholder-safe default:
 * miniA for claude until the founder pick lands — swap point, one site) */
export function runtimeMarkSegs(runtime: string | null | undefined): MarkSeg[] {
  const r = (runtime ?? "").toLowerCase();
  if (r.startsWith("claude")) return clawdMiniA();
  if (r.startsWith("codex")) return codexMark();
  if (r === "terminal" || r === "tty" || r.startsWith("external")) return terminalMark();
  // unknown runtime: honest text token, dimmed — never a fabricated mark
  return [{ text: "?", token: "dim" }];
}

/** plain-text width of a mark (all marks are single-cell glyphs) */
export function markText(segs: MarkSeg[]): string {
  return segs.map((s) => s.text).join("");
}
