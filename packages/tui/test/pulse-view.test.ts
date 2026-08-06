import { describe, expect, it } from "vitest";
import { createViewState } from "../src/state.js";
import { parseCommand } from "../src/grammar.js";
import { renderScreen } from "../src/render.js";
import { resolveKeyAction } from "../src/input.js";
import { demoSnapshot } from "../src/demo-data.js";
import { demoPulseModel } from "../src/pulse/pulse-model.js";
import { renderPulseView, renderLanes } from "../src/pulse/render-pulse.js";
import { stylizeLines } from "../src/stylize.js";
import { createStyle } from "../src/theme.js";
import type { InputEvent } from "../src/types.js";

const snap = demoSnapshot();
const withSnap = { getSnapshot: () => snap };
// Fixed reader clock so the PARKED idle-duration (derived from the demo seat's
// lastActivityAt) renders deterministically — the demo guard last output 47m before.
const DEMO_NOW = Date.parse("2026-08-06T12:00:00.000Z");

describe("PULSE view (5.2 Wave B — increment 1: static skeleton from the approved mock)", () => {
  it("registers `pulse` as a reachable viewTab (tab pulse + dispatch)", () => {
    expect(parseCommand("tab pulse")).toEqual({ type: "tab", tab: "pulse" });
    const v = createViewState({ instanceId: "t", ...withSnap });
    v.dispatch({ type: "tab", tab: "pulse" });
    expect(v.get().viewTab).toBe("pulse");
    // pulse is a top-level VIEW MODE, not a section — the section is unchanged
    expect(v.get().section).toBe("topology");
  });

  it("renders LIVE exception sections from the snapshot + contract ordering (increment 2)", () => {
    const v = createViewState({ instanceId: "t", ...withSnap });
    v.dispatch({ type: "tab", tab: "pulse" });
    const body = renderScreen(v.get(), snap, { cols: 140, rows: 44, nowMs: DEMO_NOW }).lines.join("\n");

    // ▲ NEEDS YOU ← the demo attention read (subject from summary)
    expect(body).toContain("▲ NEEDS YOU (2)");
    expect(body).toContain("0.5.0 cut packet ready · waiting on you");
    expect(body).toContain("slice-20 routing pixels · waiting on you");
    // ◌ PARKED WITH BATON ← LIVE join: the demo in-progress qitem whose owner
    // (dev50-guard) is idle (terminalActive false) and NOT handed off; idle-duration
    // derived at the renderer from the seat's lastActivityAt (47m before DEMO_NOW).
    expect(body).toContain("◌ PARKED WITH BATON (1)");
    expect(body).toContain("dev50-guard@openrig-build");
    expect(body).toContain("47m idle");
    expect(body).toContain("no handoff");
    expect(body).not.toContain("idle-age read pending"); // placeholder gone — read is live
    // ⧗ BLOCKED ON AGENTS ← the demo state=blocked read, human-blocked item EXCLUDED
    expect(body).toContain("⧗ BLOCKED ON AGENTS (1)");
    expect(body).toContain("dev50-driver@openrig-build");
    // label==referent: the blocking AGENT is named (resolved blockerSession), NOT the qitem pointer
    expect(body).toContain("blocked on review-r1@openrig-build");
    expect(body).not.toContain("qitem-20260805-review");
    expect(body).toContain("terminal verdict for 51209941");
    expect(body).not.toContain("human sign-off pending"); // human-blocked → not here

    // ordering ▲ NEEDS YOU → ◌ PARKED → ⧗ BLOCKED → lanes is contract
    const iNeeds = body.indexOf("NEEDS YOU");
    const iParked = body.indexOf("PARKED WITH BATON");
    const iBlocked = body.indexOf("BLOCKED ON AGENTS");
    const iLanes = body.indexOf("JUST FINISHED");
    expect(iNeeds).toBeGreaterThanOrEqual(0);
    expect(iNeeds).toBeLessThan(iParked);
    expect(iParked).toBeLessThan(iBlocked);
    expect(iBlocked).toBeLessThan(iLanes);
  });

  it("builds the three lanes + footer LIVE from the demo snapshot (label==referent honesty)", () => {
    const v = createViewState({ instanceId: "t", ...withSnap });
    v.dispatch({ type: "tab", tab: "pulse" });
    const body = renderScreen(v.get(), snap, { cols: 140, rows: 44, nowMs: DEMO_NOW }).lines.join("\n");

    // NOW ← active seats (terminalActive true) ⋈ their in-progress work: driver,
    // planner, r1, lead (guard is idle → PARKED; qa null → excluded). The lane
    // shows the COMPACT logicalId (incr-4 r1 ruling — full session recovered on
    // drill-in); assert the compact seats + count here.
    expect(body).toContain("NOW (4)");
    expect(body).toContain("dev50.driver");
    expect(body).toContain("orch.lead");
    // JUST FINISHED ← done/handed-off, newest-FINISHED first (tsUpdated desc) + HH:MM
    expect(body).toContain("JUST FINISHED (3)");
    expect(body).toContain("11:44");
    expect(body).toContain("slice-03 close-out");
    expect(body).toContain("terminal CLEAR");
    expect(body).not.toContain("14:02"); // the old static mock time is gone
    // UP NEXT ← unclaimed pending in served order; SIX pending → cap-4 + "…", count 6
    expect(body).toContain("UP NEXT (6)");
    expect(body).toContain("RM ceremony");
    expect(body).toContain("51-02 scenario runner");
    expect(body).toContain("…"); // overflow marker (2 hidden pending)
    // FOOTER live: active=NOW(4) · parked=PARKED(1) · waiting-you=NEEDS YOU(2) · 2s ago
    expect(body).toContain("4 active · 1 parked · 2 waiting-you · updated 2s ago");
    // the old static lane content is GONE
    expect(body).not.toContain("slice 51-01 stub");
    expect(body).not.toContain("oversight.watch");
  });

  it("the tab strip carries the PULSE tab (top-level view set)", () => {
    const v = createViewState({ instanceId: "t", ...withSnap });
    v.dispatch({ type: "tab", tab: "pulse" });
    const body = renderScreen(v.get(), snap, { cols: 140, rows: 44 }).lines.join("\n");
    expect(body).toContain("PULSE");
  });

  it("preserves the mock's 3-space inter-column gutter on full-width rows + the rule's post-count space (r1 padding finding)", () => {
    const lines = renderPulseView(demoPulseModel()).map((l) => l.text);

    // (a) JUST FINISHED → UP NEXT gutter must NOT collapse when JF content fills
    //     the column ("✓ 14:02 slice-03 close-out" is exactly the col width): the
    //     mock keeps a 3-space gutter — "close-out   ○ 51-02".
    const laneRow = lines.find((l) => l.includes("slice-03 close-out"));
    expect(laneRow).toBeDefined();
    expect(laneRow).toContain("slice-03 close-out   ○ 51-02 scenario runner");

    // (b) the rule row keeps the space after each "(n)" before the dashes:
    //     mock "── NOW (4) ───… JUST FINISHED (3) ───…" (space, THEN dashes).
    const rule = lines.find((l) => l.includes("NOW (4)"));
    expect(rule).toBeDefined();
    expect(rule).toContain("NOW (4) ─");
    expect(rule).toContain("JUST FINISHED (3) ─");
    expect(rule).not.toContain("NOW (4)─"); // no dash flush against the paren
  });

  it("column ALIGNMENT holds when a live NOW label overflows: truncated with '…', never shoving the JUST FINISHED column (incr-3, real-data widths)", () => {
    const lanes: Parameters<typeof renderLanes>[0] = [
      { label: "NOW", count: 1, rows: [{ glyph: "●", token: "ok", label: "dev50-driver@openrig-build  a very long piece of active work that would overflow the lane" }] },
      { label: "JUST FINISHED", count: 1, rows: [{ glyph: "✓", token: "ok", time: "11:44", label: "JFMARK" }] },
      { label: "UP NEXT", count: 1, rows: [{ glyph: "○", token: "dim", label: "UPMARK" }] },
    ];
    const [row0] = renderLanes(lanes);
    // the NOW cell is truncated to exactly COL[0] (30) → the JF column begins at a
    // FIXED offset (30 + 3-space gutter = 33) instead of being shoved rightward
    expect(row0!.text.indexOf("✓ 11:44 JFMARK")).toBe(33);
    expect(row0!.text.slice(0, 30)).toContain("…"); // overflow signalled in-cell
    expect(row0!.text).toContain("UPMARK");
    // and the full active-work text is NOT smeared across the neighbouring column
    expect(row0!.text).not.toContain("overflow the lane");
  });

  it("registers the lane cells as content targets in column-major order (NOW first), each with its drill action", () => {
    const v = createViewState({ instanceId: "t", ...withSnap });
    v.dispatch({ type: "tab", tab: "pulse" });
    const s = renderScreen(v.get(), snap, { cols: 140, rows: 44, nowMs: DEMO_NOW });
    // demo NOW = driver/planner/r1/lead (4 active) → the first four targets are the
    // NOW column (column-major). driver resolves in the topology → an agent drill.
    expect(s.contentTargets.length).toBeGreaterThanOrEqual(4);
    expect(s.contentTargets[0]!.action).toEqual({ type: "drill", resource: "agent", name: "dev50.driver", target: { host: "vm-host", rig: "openrig-build", pod: "dev50" } });
    // a JUST FINISHED cell (guard's close-out) drills the seat that finished it
    const jf = s.contentTargets.find((t) => t.action.type === "drill" && t.action.name === "dev50.guard");
    expect(jf).toBeDefined();
  });

  it("↑↓ move the lane selection, painting the selected cell PER-CELL (not the whole zipped row)", () => {
    const v = createViewState({ instanceId: "t", ...withSnap });
    v.dispatch({ type: "tab", tab: "pulse" });
    v.dispatch({ type: "focus", pane: "content" }); // in-pane: the lane cursor shows on the focused content pane
    const opts = { cols: 140, rows: 44, nowMs: DEMO_NOW };
    let s = renderScreen(v.get(), snap, opts);
    v.dispatch({ type: "layout", contentMaxOffset: s.contentMaxOffset, contentTargetCount: s.contentTargets.length });
    s = renderScreen(v.get(), snap, opts);

    // default selection (0) = the first NOW cell; its line is accent-painted, but
    // only the NOW cell — the JF/UP-NEXT cells on the SAME zipped line are NOT, so
    // the line carries BOTH accent and non-accent segs (per-cell, not whole-row).
    const y0 = s.contentTargets[0]!.y;
    const segs0 = s.segRows![y0]!;
    expect(segs0.some((sg) => sg.bg === "accent")).toBe(true);
    expect(segs0.some((sg) => sg.bg !== "accent")).toBe(true);

    // move down one: selection follows to target[1], and target[0]'s cell clears.
    v.dispatch({ type: "content-select", delta: 1 });
    s = renderScreen(v.get(), snap, opts);
    const y1 = s.contentTargets[1]!.y;
    // the newly-selected cell paints…
    expect(s.segRows![y1]!.some((sg) => sg.bg === "accent")).toBe(true);
    // …and if target[1] is on a DIFFERENT line than target[0], target[0] clears.
    if (y1 !== y0) expect((s.segRows![y0] ?? []).some((sg) => sg.bg === "accent")).toBe(false);
  });

  it("Enter on the selected NOW seat drills to that AGENT — leaving PULSE, recovering the full identity the compact label dropped", () => {
    const v = createViewState({ instanceId: "t", ...withSnap });
    v.dispatch({ type: "tab", tab: "pulse" });
    v.dispatch({ type: "focus", pane: "content" }); // Enter drills the focused content pane's selected cell
    let s = renderScreen(v.get(), snap, { cols: 140, rows: 44, nowMs: DEMO_NOW });
    v.dispatch({ type: "layout", contentMaxOffset: s.contentMaxOffset, contentTargetCount: s.contentTargets.length });
    s = renderScreen(v.get(), snap, { cols: 140, rows: 44, nowMs: DEMO_NOW });

    const enter: Extract<InputEvent, { type: "key" }> = { type: "key", key: "enter", action: { type: "activate" } };
    const action = resolveKeyAction(enter, v.get(), s, 0);
    expect(action).toEqual({ type: "drill", resource: "agent", name: "dev50.driver", target: { host: "vm-host", rig: "openrig-build", pod: "dev50" } });
    // dispatching it navigates to the agent (full detail), leaving the pulse view
    v.dispatch(action!);
    expect(v.get().viewTab).toBe("table");
    expect(v.get().drill.at(-1)).toEqual({ kind: "agent", name: "dev50.driver" });
  });

  it("in PULSE (in-pane, founder Option-B): ←→ switch panes (the sidebar is the founder's action path) and ↑↓ move the focused pane — normal chrome input, no special-case", () => {
    const v = createViewState({ instanceId: "t", ...withSnap });
    v.dispatch({ type: "tab", tab: "pulse" });
    v.dispatch({ type: "focus", pane: "content" });
    const s = renderScreen(v.get(), snap, { cols: 140, rows: 44, nowMs: DEMO_NOW });
    const down: Extract<InputEvent, { type: "key" }> = { type: "key", key: "down", action: { type: "select", delta: 1 } };
    const left: Extract<InputEvent, { type: "key" }> = { type: "key", key: "left", action: { type: "select", delta: 0 } };
    // content-focused ↑↓ walks the lane cells; ← switches focus to the explorer sidebar
    expect(resolveKeyAction(down, v.get(), s, 0)).toEqual({ type: "content-select", delta: 1 });
    expect(resolveKeyAction(left, v.get(), s, 0)).toEqual({ type: "focus", pane: "explorer" });
  });

  it("renders without throwing, and the reusable renderer's counts match the model", () => {
    const v = createViewState({ instanceId: "t", ...withSnap });
    expect(() => renderScreen(v.get(), snap, { cols: 120, rows: 32 })).not.toThrow(); // default (table) still fine
    v.dispatch({ type: "tab", tab: "pulse" });
    expect(() => renderScreen(v.get(), snap, { cols: 120, rows: 32 })).not.toThrow();

    // honesty floor: lane header counts equal the referent set the model carries
    const model = demoPulseModel();
    for (const lane of model.lanes) {
      // NOTE: the mock's UP NEXT (5) shows 4 rows incl. the "…" overflow row —
      // the header count is the TRUE total, the rows are the rendered referent
      // (increment-1 fixture mirrors the mock exactly, overflow row included).
      expect(lane.rows.length).toBeGreaterThan(0);
    }
    expect(renderPulseView(model).length).toBeGreaterThan(10);
  });
});

// ── increment 5: live refresh-seam + motion budget, reconciled to the founder's
// Option-B in-pane layout. These pins assert the STYLIZED terminal output (the
// layer every earlier pulse pin skipped — they inspected the pre-stylize Screen,
// which is why the paint no-op slipped through). In-pane, per-cell segs paint via
// the NORMAL split-pane path; content SELECTION renders as accent-bg (mock `.sel`
// affordance) while the sidebar's own selected row uses inverse — so BG (48;2) is
// a CLEAN content-selection signal, but "no inverse" checks scope to the content
// segRows (the sidebar selection legitimately carries inverse). ─────────────────
describe("PULSE view (5.2 Wave B — increment 5: live refresh-seam + motion budget, in-pane)", () => {
  const truecolor = createStyle("truecolor");
  const INV = /(?:\x1b\[|;)7(?:;|m)/; // a standalone inverse SGR param (7), not the "7" inside a color triple
  const BG = /48;2;/; // a truecolor background SGR
  const OPTS = { cols: 140, rows: 44, nowMs: DEMO_NOW, colorMode: "truecolor" as const };
  const agentKey = (a: Extract<InputEvent, never> | { type: string; name?: string; target?: { host: string; rig: string; pod: string } }): string =>
    `agent:${a.target!.host}/${a.target!.rig}/${a.target!.pod}/${a.name}`;
  // content-only inverse: the flashed CELL segs (segRows is the content half),
  // excluding the sidebar's selected-row inverse highlight on the left
  const contentInverse = (s: ReturnType<typeof renderScreen>): boolean =>
    Object.values(s.segRows ?? {}).some((segs) => segs.some((g) => g.inverse));

  // focus the content pane (the lane cursor lives there), settle the layout, then
  // re-render — mirroring the entry loop
  function primed(selectMoves = 0, extra: Record<string, unknown> = {}) {
    const v = createViewState({ instanceId: "t", ...withSnap });
    v.dispatch({ type: "tab", tab: "pulse" });
    v.dispatch({ type: "focus", pane: "content" });
    let s = renderScreen(v.get(), snap, { ...OPTS, ...extra });
    v.dispatch({ type: "layout", contentMaxOffset: s.contentMaxOffset, contentTargetCount: s.contentTargets.length });
    for (let i = 0; i < selectMoves; i++) v.dispatch({ type: "content-select", delta: 1 });
    s = renderScreen(v.get(), snap, { ...OPTS, ...extra });
    return { v, s };
  }

  it("F0: the selected NOW cell's accent bg PAINTS in the stylized in-pane output (via the normal split-pane path, not just the pre-stylize Screen)", () => {
    const { s } = primed();
    const y0 = s.contentTargets[0]!.y;
    // the pre-stylize Screen carried the seg since incr-4 — this always passed
    expect(s.segRows![y0]!.some((sg) => sg.bg === "accent")).toBe(true);
    // …and now it RENDERS: in-pane the content segs paint through the split-pane
    // segRows path (the full-width no-op is gone — the bypass no longer exists).
    const painted = stylizeLines(s, truecolor);
    expect(BG.test(painted[y0 - 1]!)).toBe(true);
  });

  it("F2: a NOW seat's in-window fresh-output flash inverts ITS cell only (per-cell), rendered in the stylized output", () => {
    // select row 1 so the FLASH (on row 0) is isolated from the selection paint
    const { v } = primed(1);
    const targets = renderScreen(v.get(), snap, OPTS).contentTargets;
    const driver = targets[0]!; // NOW row 0 = dev50.driver (unselected now)
    const key = agentKey(driver.action as never);
    const s = renderScreen(v.get(), snap, { ...OPTS, load: { inFlight: false, settled: true }, rowFlashes: [{ key, at: DEMO_NOW }] });
    const painted = stylizeLines(s, truecolor);
    const dy = driver.y;
    // per-cell at the model layer: the flashed line carries BOTH inverse (NOW cell)
    // and non-inverse (JF/UP-NEXT siblings + gutters) segs — not a whole-row flash
    const segs = s.segRows![dy]!;
    expect(segs.some((sg) => sg.inverse)).toBe(true);
    expect(segs.some((sg) => !sg.inverse)).toBe(true);
    // …and it RENDERS (the layer the prior pins never reached)
    expect(INV.test(painted[dy - 1]!)).toBe(true);
    // the SELECTED cell (row 1) is accent-painted but NOT inverted — flash and
    // selection are visually distinct, co-existing without conflation
    const sy = s.contentTargets[1]!.y;
    expect(BG.test(painted[sy - 1]!)).toBe(true);
    expect(INV.test(painted[sy - 1]!)).toBe(false);
  });

  it("F2 budget: a flash whose seat is in JUST FINISHED (not NOW) moves nothing — motion is scoped to the NOW live-update region", () => {
    const { s: s0 } = primed();
    const jf = s0.contentTargets.find((t) => (t.action as { name?: string }).name === "dev50.guard"); // guard's close-out lives in JF
    expect(jf).toBeDefined();
    const key = agentKey(jf!.action as never);
    const { v } = primed();
    const s = renderScreen(v.get(), snap, { ...OPTS, load: { inFlight: false, settled: true }, rowFlashes: [{ key, at: DEMO_NOW }] });
    // the seat's key matches, but only lane 0 (NOW) flashes → no CONTENT cell inverts
    expect(contentInverse(s)).toBe(false);
  });

  it("F2 window: an EXPIRED flash (older than the 600ms window) does not invert", () => {
    const { v } = primed(1);
    const driver = renderScreen(v.get(), snap, OPTS).contentTargets[0]!;
    const key = agentKey(driver.action as never);
    const s = renderScreen(v.get(), snap, { ...OPTS, load: { inFlight: false, settled: true }, rowFlashes: [{ key, at: DEMO_NOW - 700 }] });
    expect(contentInverse(s)).toBe(false);
  });

  it("F3 reduced-motion twin: under reduced motion the flash is SUPPRESSED (no inverse), the seat is still shown", () => {
    const prev = process.env["OPENRIG_REDUCED_MOTION"];
    process.env["OPENRIG_REDUCED_MOTION"] = "1";
    try {
      const { v } = primed(1);
      const driver = renderScreen(v.get(), snap, OPTS).contentTargets[0]!;
      const key = agentKey(driver.action as never);
      const s = renderScreen(v.get(), snap, { ...OPTS, load: { inFlight: false, settled: true }, rowFlashes: [{ key, at: DEMO_NOW }] });
      expect(contentInverse(s)).toBe(false); // no motion in the content pane
      expect(s.lines[driver.y - 1]!).toContain("dev50.driver"); // state still shown, honestly
      expect(s.motionActive).toBe(false); // reduced kills the redraw loop
    } finally {
      if (prev === undefined) delete process.env["OPENRIG_REDUCED_MOTION"];
      else process.env["OPENRIG_REDUCED_MOTION"] = prev;
    }
  });

  it("F1: an active NOW flash sets motionActive (bounded-expiry redraw); a settled frame with no flash is calm", () => {
    const { v } = primed(1);
    const driver = renderScreen(v.get(), snap, OPTS).contentTargets[0]!;
    const key = agentKey(driver.action as never);
    const hot = renderScreen(v.get(), snap, { ...OPTS, load: { inFlight: false, settled: true }, rowFlashes: [{ key, at: DEMO_NOW }] });
    expect(hot.motionActive).toBe(true);
    const calm = renderScreen(v.get(), snap, { ...OPTS, load: { inFlight: false, settled: true }, rowFlashes: [] });
    expect(calm.motionActive).toBe(false);
  });

  it("F1: while the FIRST load is in flight (!settled) an honest loading indicator shows + motionActive; a settled empty frame is calm", () => {
    const { v } = primed();
    const loading = renderScreen(v.get(), snap, { ...OPTS, load: { inFlight: true, settled: false } });
    const status = loading.lines.find((l) => l.startsWith("[t]"));
    expect(status).toBeDefined();
    expect(status!.toLowerCase()).toContain("loading");
    expect(loading.motionActive).toBe(true);
    const settled = renderScreen(v.get(), snap, { ...OPTS, load: { inFlight: false, settled: true } });
    const settledStatus = settled.lines.find((l) => l.startsWith("[t]"));
    expect(settledStatus!.toLowerCase()).not.toContain("loading"); // empty-strip-is-calm
  });

  it("F3 reader-clock discipline: the footer 'updated Ns ago' + the PARKED idle age RE-DERIVE on the same snapshot as the reader clock advances (no cached staleness)", () => {
    const { v } = primed();
    const foot = (nowMs: number) => renderScreen(v.get(), snap, { ...OPTS, nowMs }).lines.find((l) => l.includes("active ·") && l.includes("updated"))!;
    const t0 = foot(DEMO_NOW);
    const t1 = foot(DEMO_NOW + 90_000);
    expect(t0).not.toEqual(t1); // the "updated Ns ago" advanced — the derivation is live, not stamped once
    expect(t1).toContain("updated");
  });
});
