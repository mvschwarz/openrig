// Crash-cart cockpit RENDERER (5.2 Wave B, plan c015d9ed §C3) — model → rows, reproducing the
// approved mock (3d3c90a0) structure/ordering/emphasis in the TUI idiom. Glyph set ◌/▦/⏎/✓ and the
// section wording are CONTRACT; theme tokens only (no invented colors). Bold text carries a color
// token (`bright`) because a bold-only seg renders as plain ink in this pipeline.
import type { Token } from "../theme.js";
import type { Screen } from "../types.js";
import type { CrashCartModel } from "./crash-cart-model.js";

interface Seg {
  text: string;
  token?: Token;
  bold?: boolean;
  bg?: Token;
  inverse?: boolean;
}
interface Line {
  text: string;
  segs?: Seg[];
  selected?: boolean;
}

/** Build a Line whose plain `text` is the concat of its segs (capture/width truth). */
function line(segs: Seg[], opts?: { selected?: boolean }): Line {
  return { text: segs.map((s) => s.text).join(""), segs, ...(opts?.selected ? { selected: true } : {}) };
}

/** The daemon-down header: `◌ daemon not running` (warn) + the dim status tail. The uptime + reason
 *  slots render EXPLICIT honest-unknown text (PM ruling) — structure/ordering per the mock. */
export function renderCrashCartHeader(model: CrashCartModel): Line {
  const h = model.header;
  return line([
    { text: "◌ daemon not running", token: "warn" },
    {
      text: ` — last seen ${h.lastSeen} (uptime ${h.uptimeText}) · reason: ${h.reasonText}`,
      token: "dim",
    },
  ]);
}

/** `FOUND ON THIS HOST` + one row per rig: `▦ <name>  <n> seats · last active <t> · <r> sessions resumable`.
 *  Name column is padded to the widest name + a 4-space gap so the details align (the mock's fixed columns). */
export function renderFoundOnHost(model: CrashCartModel): Line[] {
  const out: Line[] = [line([{ text: "FOUND ON THIS HOST", token: "dim" }])];
  const nameCol = Math.max(0, ...model.foundOnHost.map((r) => r.name.length)) + 4;
  for (const r of model.foundOnHost) {
    const pad = " ".repeat(Math.max(0, nameCol - r.name.length));
    out.push(
      line([
        { text: " ▦ " },
        { text: r.name, token: "bright", bold: true },
        { text: pad },
        {
          text: `${r.seatCount} seats · last active ${r.lastActive} · ${r.resumableCount} sessions resumable`,
          token: "dim",
        },
      ]),
    );
  }
  return out;
}

/** `WHERE WORK STOPPED (from the durable ledgers)` + one `◌ <session> — qitem in-progress: "<summary>" (<t>)`
 *  per in-progress item, then always the `✓ everything else idle-clean at stop` closing line. */
export function renderWhereWorkStopped(model: CrashCartModel): Line[] {
  const out: Line[] = [
    line([
      { text: "WHERE WORK STOPPED", token: "dim" },
      { text: " (from the durable ledgers)", token: "dim" },
    ]),
  ];
  for (const w of model.whereWorkStopped) {
    out.push(
      line([
        { text: " ◌ ", token: "warn" },
        { text: w.session },
        { text: ` — qitem in-progress: "${w.summary}" (${w.time})`, token: "dim" },
      ]),
    );
  }
  out.push(line([{ text: " ✓ ", token: "ok" }, { text: "everything else idle-clean at stop" }]));
  return out;
}

/** The actions block: the highlighted primary `⏎ RESTORE EVERYTHING …` row + the secondary key row. */
export function renderActions(): Line[] {
  return [
    line(
      [
        {
          text: " ⏎ RESTORE EVERYTHING — daemon + kernel + all rigs, sessions resumed in their seats ",
          bg: "accent",
        },
      ],
      { selected: true },
    ),
    line([
      { text: "  s start daemon only  ·  i inspect a rig  ·  n new here? onboarding" },
      { text: " (policy menu lives here now)", token: "dim" },
    ]),
  ];
}

/** The whole crash-cart cockpit view: header → FOUND ON THIS HOST → WHERE WORK STOPPED → actions,
 *  blank-line separated (mock-verbatim ordering). */
export function renderCrashCartView(model: CrashCartModel): Line[] {
  return [
    renderCrashCartHeader(model),
    { text: "" },
    ...renderFoundOnHost(model),
    { text: "" },
    ...renderWhereWorkStopped(model),
    { text: "" },
    ...renderActions(),
  ];
}

/** Pad a line to width with trailing spaces; NEVER truncate (a truncated line would break the
 *  strip-invariant against its full-length segs). Over-width lines are left as-is. */
function padTo(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

export interface CrashCartScreenOptions {
  cols?: number;
  rows?: number;
}

/**
 * Wrap the cockpit view into a full-width Screen (no explorer split). Line 0 is left BENIGN (blank)
 * because stylize special-cases index 0; the content + its segRows start at index ≥ 1, painted by the
 * full-width segRows branch. plain(segs) === the (padded) line, so the strip-invariant holds.
 */
export function renderCrashCartScreen(model: CrashCartModel, options: CrashCartScreenOptions = {}): Screen {
  const cols = options.cols ?? 120;
  const view = renderCrashCartView(model);
  const lines: string[] = [""]; // benign line 0
  const segRows: NonNullable<Screen["segRows"]> = {};
  for (const item of view) {
    const y = lines.length + 1; // 1-based terminal row of the line about to be pushed
    lines.push(padTo(item.text, cols));
    if (item.segs) segRows[y] = item.segs;
  }
  return { lines, segRows, hitMap: [], contentTargets: [], contentMaxOffset: 0, explorerRows: [] };
}
