// PULSE view renderer (5.2 Wave B). REUSABLE, view-local row/section/lane
// renderers (plan §crash-cart-pre-work: crash-cart rides these). Reproduces the
// approved mock's structure/ordering/emphasis in the TUI idiom — glyph set
// ●/◌/⧗/▲/✓/○ and section wording are CONTRACT; theme tokens only (no invented
// colors — the ⧗ info accent uses the RESOLVED D4 info token, see PULSE_INFO_TOKEN).
import type { Token } from "../theme.js";
import type { Action } from "../types.js";
import type { PulseModel, PulseExceptionSection, PulseLane, PulseLaneRow } from "./pulse-model.js";

interface Seg { text: string; token?: Token; bold?: boolean; bg?: Token; inverse?: boolean }
interface Line { text: string; segs?: Seg[]; selected?: boolean }

/** Build a Line whose plain `text` is the concat of its segs (capture/width truth). */
function line(segs: Seg[], opts?: { selected?: boolean }): Line {
  return { text: segs.map((s) => s.text).join(""), segs, ...(opts?.selected ? { selected: true } : {}) };
}

// ── the top tab strip: [ PULSE ] TABLE OVERVIEW GRAPH PULSE (PULSE active) ──
export function renderPulseTabStrip(): Line {
  return line([
    { text: "[ PULSE ]", token: "dim" },
    { text: "  TABLE   OVERVIEW   GRAPH   " },
    // P2: the mock renders the ACTIVE tab in BOLD. Bold needs a color token to emit in
    // this pipeline (a bold-only seg is drawn plain by the segRows painter — the same
    // no-op class as the exception subject); the emphasis ink `bright` carries it.
    { text: "PULSE", token: "bright", bold: true },
  ]);
}

// ── an exception section: header (glyph LABEL (n)) + its rows ──
export function renderExceptionSection(section: PulseExceptionSection): Line[] {
  // DEFERRED read (PARKED): header WITHOUT a (n) count — a fabricated count
  // would falsely claim a ran join — plus one dim "read pending" line.
  if (section.pending) {
    return [
      line([{ text: `${section.glyph} ${section.label}`, token: section.token, bold: true }]),
      line([{ text: ` ${section.pending}`, token: "dim" }]),
    ];
  }
  const header = line([{ text: `${section.glyph} ${section.label} (${section.rows.length})`, token: section.token, bold: true }]);
  const rows = section.rows.map((r) =>
    line([
      { text: ` ${r.glyph} `, token: r.token },
      // Founder Option-1: the who/what SUBJECT leads in BOLD (the mock's <b>). Bold
      // needs a color token to render in this pipeline (a bold-only seg is drawn as
      // plain ink), so the emphasis ink `bright` carries it — the detail (claim)
      // stays plain, the age (meta) dim.
      { text: r.subject, token: "bright", bold: true },
      { text: r.claim },
      { text: r.meta, token: "dim" },
    ]),
  );
  return [header, ...rows];
}

// ── the three-lane split: a dim rule-row then fixed-width columns ──
const COL = [30, 26] as const; // NOW, JUST FINISHED CONTENT widths; UP NEXT takes the rest
// The 3-space inter-column gutter is RESERVED separately from the content pad, so
// it never collapses on a row whose content exactly fills its column (the mock's
// "✓ 14:02 slice-03 close-out" is exactly COL[1]). renderLanes lays the gutter as
// spaces; the rule row lays it as continuous dashes — same stride (COL[i] + 3).
const LANE_GUTTER = "   ";

function padEnd(s: string, w: number): string {
  return s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length);
}

/** The `── NOW (n) ──… JUST FINISHED (n) ──… UP NEXT (n) ──` rule row (dim). */
export function renderLaneRule(lanes: [PulseLane, PulseLane, PulseLane]): Line {
  const seg = (label: string, count: number, w: number): string => {
    // Keep the space after "(n)"; dashes begin AFTER it (mock: "── NOW (4) ───…").
    // Span the content width + the gutter so the dashes align with the columns.
    const head = `── ${label} (${count}) `;
    return head + "─".repeat(Math.max(0, w + LANE_GUTTER.length - head.length));
  };
  const text = seg(lanes[0].label, lanes[0].count, COL[0]) + seg(lanes[1].label, lanes[1].count, COL[1]) + `── ${lanes[2].label} (${lanes[2].count}) ` + "──────────";
  return line([{ text, token: "dim" }]);
}

function laneCell(row: PulseLaneRow | undefined, w: number): Seg[] {
  if (!row) return [{ text: padEnd("", w) }];
  const glyph = `${row.glyph} `;
  const time = row.time ? `${row.time} ` : "";
  // TRUNCATE the (variable) label to the cell budget so a long REAL label never
  // overflows and shoves the next column out of alignment — the mock's fixed
  // three-lane columns are a render contract. A cut is signalled with a trailing
  // "…" (honest truncation, not a silent drop); the full value stays on drill-in.
  const avail = Math.max(0, w - glyph.length - time.length);
  let label = row.label;
  if (label.length > avail) label = avail > 0 ? label.slice(0, avail - 1) + "…" : "";
  const segs: Seg[] = [{ text: glyph, token: row.token }];
  if (row.time) segs.push({ text: time, token: "dim" });
  segs.push({ text: label, token: row.time ? undefined : row.token === "ok" ? "dim" : row.token });
  // pad the cell to its CONTENT width (plain trailing spaces); the inter-column
  // gutter is added by renderLanes so it is guaranteed even when body === w.
  const pad = w - glyph.length - time.length - label.length;
  if (pad > 0) segs.push({ text: " ".repeat(pad) });
  // SELECTION is PER-CELL (incr-4): a selected lane row accent-bgs only ITS cell,
  // never the whole zipped terminal row (which spans all three lanes) — so the
  // highlight names one entity, not one row-across-three-columns. incr-5 adds the
  // fresh-output FLASH the same way: an inverse on THIS cell only (the live-update
  // region moves; siblings stay calm). Selection (bg) and flash (inverse) compose
  // and stay visually distinct when both land on one cell.
  if (!row.selected && !row.flashed) return segs;
  return segs.map((s) => ({
    ...s,
    ...(row.selected ? { bg: "accent" as const } : {}),
    ...(row.flashed ? { inverse: true as const } : {}),
  }));
}

// Content-cell widths reused by pulseLaneTargets to place selection/hit spans;
// the last lane (UP NEXT) takes the fixed 40-col tail (see renderLanes).
const UP_NEXT_WIDTH = 40;

/** Zip the three lanes into aligned column rows (max lane length). Selection is
 * carried on the individual PulseLaneRow (painted per-cell by laneCell), NOT at
 * the line level, so a selected cell highlights one lane only. */
export function renderLanes(lanes: [PulseLane, PulseLane, PulseLane]): Line[] {
  const rows = Math.max(...lanes.map((l) => l.rows.length));
  const out: Line[] = [];
  const gutter: Seg = { text: LANE_GUTTER };
  for (let i = 0; i < rows; i += 1) {
    const cells = [laneCell(lanes[0].rows[i], COL[0]), laneCell(lanes[1].rows[i], COL[1]), laneCell(lanes[2].rows[i], UP_NEXT_WIDTH)];
    // gutter reserved BETWEEN columns (never collapses on a full-width row); the
    // last column (UP NEXT) takes no trailing gutter.
    out.push(line([...cells[0]!, gutter, ...cells[1]!, gutter, ...cells[2]!]));
  }
  return out;
}

/** One selectable lane cell: its position in renderPulseView's line list, its
 * lane column's fixed x-span (1-based terminal columns), and the drill Action. */
export interface PulseLaneTarget {
  lane: number; // 0=NOW, 1=JUST FINISHED, 2=UP NEXT
  row: number; // index within that lane's rows
  lineIndex: number; // 0-based line within renderPulseView(model) output
  x1: number;
  x2: number;
  action: Action;
}

/** The selectable lane cells in COLUMN-MAJOR order (all NOW rows, then JUST
 * FINISHED, then UP NEXT) — the flat domain PULSE selection walks with ↑↓, each
 * mapped to its line index in renderPulseView's output and its lane's fixed
 * column x-span. Rows with no action (the "…" overflow marker) are omitted; they
 * are not entities. This is the ONE place that knows the view's vertical layout,
 * so render.ts never re-derives the offset math. */
export function pulseLaneTargets(model: PulseModel): PulseLaneTarget[] {
  const exceptionLines = model.exceptions.reduce((n, s) => n + renderExceptionSection(s).length, 0);
  // renderPulseView layout: [tabStrip, blank] + exceptions + [blank, laneRule] + laneRows + footer
  const laneStart = 2 + exceptionLines + 2;
  const g = LANE_GUTTER.length;
  const starts = [0, COL[0] + g, COL[0] + g + COL[1] + g]; // text col where each lane's cell begins
  const widths = [COL[0], COL[1], UP_NEXT_WIDTH];
  const out: PulseLaneTarget[] = [];
  model.lanes.forEach((lane, li) =>
    lane.rows.forEach((row, ri) => {
      if (!row.action) return; // overflow marker / actionless rows are not targets
      out.push({ lane: li, row: ri, lineIndex: laneStart + ri, x1: starts[li]! + 1, x2: starts[li]! + widths[li]!, action: row.action });
    }),
  );
  return out;
}

export function renderPulseFooter(f: PulseModel["footer"]): Line {
  return line([{ text: `${f.active} active · ${f.parked} parked · ${f.waitingYou} waiting-you · updated ${f.updatedAgo}`, token: "dim" }]);
}

/** The whole PULSE view (increment 1: static from demoPulseModel). REUSABLE parts above. */
export function renderPulseView(model: PulseModel): Line[] {
  const out: Line[] = [renderPulseTabStrip(), { text: "" }];
  // EMPTY section is omitted entirely by the model (empty-strip-is-silence); we
  // render exactly the sections present.
  for (const section of model.exceptions) out.push(...renderExceptionSection(section));
  out.push({ text: "" });
  out.push(renderLaneRule(model.lanes));
  out.push(...renderLanes(model.lanes));
  out.push(renderPulseFooter(model.footer));
  return out;
}
