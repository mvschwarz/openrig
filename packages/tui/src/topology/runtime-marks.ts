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

/** quadrant-block downsample: the 16x16 grid → cols x rows cells, each cell
 * a 2x2 quadrant whose quadrants are majority-vote body coverage of their
 * source region. PROVABLY grid-derived (guard finding 4) — the mini forms
 * are OUTPUTS of this function, never hand-picked glyphs. Honest limit: the
 * 1px eyes are below majority threshold at these scales and vanish — that
 * fidelity fact is part of the mr7 packet, not hidden. */
const QUADRANT_CHARS: Record<number, string> = {
  0b0000: " ", 0b0001: "▗", 0b0010: "▖", 0b0011: "▄", 0b0100: "▝", 0b0101: "▐",
  0b0110: "▞", 0b0111: "▟", 0b1000: "▘", 0b1001: "▚", 0b1010: "▌", 0b1011: "▙",
  0b1100: "▀", 0b1101: "▜", 0b1110: "▛", 0b1111: "█",
};

export function clawdDownsample(cols: number, rows: number): MarkSeg[][] {
  const g = clawdGrid();
  const cellW = 16 / cols;
  const cellH = 16 / rows;
  const covered = (x0: number, y0: number, x1: number, y1: number): boolean => {
    let body = 0;
    let total = 0;
    for (let y = Math.floor(y0); y < Math.ceil(y1); y++)
      for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
        total++;
        if (g[y]![x]! !== 0) body++;
      }
    return total > 0 && body * 2 >= total; // majority vote
  };
  const out: MarkSeg[][] = [];
  for (let r = 0; r < rows; r++) {
    const segs: MarkSeg[] = [];
    for (let c = 0; c < cols; c++) {
      const x0 = c * cellW;
      const y0 = r * cellH;
      const bits =
        (covered(x0, y0, x0 + cellW / 2, y0 + cellH / 2) ? 0b1000 : 0) |
        (covered(x0 + cellW / 2, y0, x0 + cellW, y0 + cellH / 2) ? 0b0100 : 0) |
        (covered(x0, y0 + cellH / 2, x0 + cellW / 2, y0 + cellH) ? 0b0010 : 0) |
        (covered(x0 + cellW / 2, y0 + cellH / 2, x0 + cellW, y0 + cellH) ? 0b0001 : 0);
      const ch = QUADRANT_CHARS[bits]!;
      segs.push(ch === " " ? { text: " " } : { text: ch, token: "clawd" });
    }
    out.push(segs);
  }
  return out;
}

/** FOUNDER ROUND-2 DESIGN (2026-08-04 via pm-lead): the row mark is a flat
 * claude-terracotta BLOCK with two short dark vertical eye bars centered —
 * no limbs/legs; color + face ARE the mark at 2-cell size. Exact source
 * values: body #ad6755, eyes #181818 (RuntimeMark.tsx). */
export function clawdFounderMark(): MarkSeg[] {
  // superseded by clawdSquareMark (round-3: wide-rect center-bunch REJECTED);
  // kept for the decision-record lineage only
  return [
    { text: "╹", token: "clawdEye", bg: "clawd" },
    { text: "╹", token: "clawdEye", bg: "clawd" },
  ];
}

/** ROUND-3 LOCKED clawd row mark, round-4 quadrant-geometry correction (guard
 * finding 1): a SQUARE (2 cells ≈ square at cell aspect) with two quarter-
 * block EYES clearly APART — cell 1 carries the OUTER-LEFT quadrant (▘
 * U+2598 QUADRANT UPPER LEFT) and cell 2 the OUTER-RIGHT (▝ U+259D QUADRANT
 * UPPER RIGHT), so the inner half of BOTH cells is pure terracotta field and
 * the eyes flank a real center gap. (The prior ▝▘ order put the inner-right
 * and inner-left quadrants together AT the center seam — the rejected
 * center-bunched form.) Eyes sit high like the source grid; dark #181818 eyes
 * ON the #ad6755 terracotta field. */
export function clawdSquareMark(): MarkSeg[] {
  return [
    { text: "▘", token: "clawdEye", bg: "clawd" },
    { text: "▝", token: "clawdEye", bg: "clawd" },
  ];
}

/** ROUND-3 codex blue-hint CANDIDATES (LOOK choice a — UNPICKED; the shipped
 * mark stays the approved plain form until the authenticated pick): each
 * variant uses the OFFICIAL sampled #6867aa (token codexBlue), never a
 * remembered value. */
export function codexHintVariants(): Record<"chevron" | "outline" | "none", MarkSeg[]> {
  return {
    none: codexMark(),
    chevron: [
      { text: ">", token: "codexBlue", bold: true },
      { text: "_", token: "markInk", bold: true },
    ],
    outline: [
      { text: "▕", token: "codexBlue" },
      { text: ">", token: "markInk", bold: true },
      { text: "_", token: "markInk", bold: true },
      { text: "▏", token: "codexBlue" },
    ],
  };
}

/** row-mark CANDIDATES for the mr7 pick — both are downsample outputs */
export function clawdMiniA(): MarkSeg[] {
  return clawdDownsample(2, 1)[0]!;
}

export function clawdMiniB(): MarkSeg[] {
  return clawdDownsample(3, 1)[0]!;
}

/** Codex: the `>_` prompt mark, light-on-dark (the web mark is `>_` in a
 * light circle; the terminal-cell form keeps the glyph pair). */
export function codexMark(): MarkSeg[] {
  // the LOCKED token is `>_` (web mark verbatim); any restyling (e.g. ❯) is
  // a founder-LOOK question, not a driver choice (guard finding 4)
  return [
    { text: ">", token: "markInk", bold: true },
    { text: "_", token: "markInk", bold: true },
  ];
}

/** terminal/tty runtime: dark cell + white `>_` — same family, inverted. */
export function terminalMark(): MarkSeg[] {
  return [
    { text: ">", token: "bright", bg: "markBg", bold: true },
    { text: "_", token: "bright", bg: "markBg", bold: true },
  ];
}

/** the row-scale mark for a served runtime string (placeholder-safe default:
 * miniA for claude until the founder pick lands — swap point, one site) */
export function runtimeMarkSegs(runtime: string | null | undefined): MarkSeg[] {
  const r = (runtime ?? "").toLowerCase();
  if (r.startsWith("claude")) return clawdSquareMark(); // round-3 locked square
  if (r.startsWith("codex")) return codexMark();
  if (r === "terminal" || r === "tty" || r.startsWith("external")) return terminalMark();
  // unknown runtime: honest text token, dimmed — never a fabricated mark
  return [{ text: "?", token: "dim" }];
}

/** plain-text width of a mark (all marks are single-cell glyphs) */
export function markText(segs: MarkSeg[]): string {
  return segs.map((s) => s.text).join("");
}
