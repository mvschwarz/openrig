// PULSE view renderer (5.2 Wave B). REUSABLE, view-local row/section/lane
// renderers (plan §crash-cart-pre-work: crash-cart rides these). Reproduces the
// approved mock's structure/ordering/emphasis in the TUI idiom — glyph set
// ●/◌/⧗/▲/✓/○ and section wording are CONTRACT; theme tokens only (no invented
// colors — the ⧗ info accent is a routed D4 gap, see PULSE_INFO_TOKEN).
import type { Token } from "../theme.js";
import type { PulseModel, PulseExceptionSection, PulseLane, PulseLaneRow } from "./pulse-model.js";

interface Seg { text: string; token?: Token; bold?: boolean; bg?: Token }
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
    { text: "PULSE", bold: true },
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
      { text: r.subject, bold: true },
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
  const body = `${glyph}${time}${row.label}`;
  const segs: Seg[] = [{ text: glyph, token: row.token }];
  if (row.time) segs.push({ text: time, token: "dim" });
  segs.push({ text: row.label, token: row.time ? undefined : row.token === "ok" ? "dim" : row.token });
  // pad the cell to its CONTENT width (plain trailing spaces); the inter-column
  // gutter is added by renderLanes so it is guaranteed even when body === w.
  const pad = w - body.length;
  if (pad > 0) segs.push({ text: " ".repeat(pad) });
  return segs;
}

/** Zip the three lanes into aligned column rows (max lane length). */
export function renderLanes(lanes: [PulseLane, PulseLane, PulseLane]): Line[] {
  const rows = Math.max(...lanes.map((l) => l.rows.length));
  const out: Line[] = [];
  const gutter: Seg = { text: LANE_GUTTER };
  for (let i = 0; i < rows; i += 1) {
    const cells = [laneCell(lanes[0].rows[i], COL[0]), laneCell(lanes[1].rows[i], COL[1]), laneCell(lanes[2].rows[i], 40)];
    const selected = lanes.some((l) => l.rows[i]?.selected);
    // gutter reserved BETWEEN columns (never collapses on a full-width row); the
    // last column (UP NEXT) takes no trailing gutter.
    out.push(line([...cells[0]!, gutter, ...cells[1]!, gutter, ...cells[2]!], { selected }));
  }
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
