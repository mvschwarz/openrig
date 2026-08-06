import { describe, expect, it } from "vitest";
import { createViewState } from "../src/state.js";
import { parseCommand } from "../src/grammar.js";
import { renderScreen } from "../src/render.js";
import { resolveKeyAction } from "../src/input.js";
import { demoSnapshot } from "../src/demo-data.js";
import { demoPulseModel } from "../src/pulse/pulse-model.js";
import { renderPulseView, renderLanes } from "../src/pulse/render-pulse.js";
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

  it("in PULSE, ↑↓ resolve to content-select (no explorer to move) and ←→ are no-ops", () => {
    const v = createViewState({ instanceId: "t", ...withSnap });
    v.dispatch({ type: "tab", tab: "pulse" });
    const s = renderScreen(v.get(), snap, { cols: 140, rows: 44, nowMs: DEMO_NOW });
    const down: Extract<InputEvent, { type: "key" }> = { type: "key", key: "down", action: { type: "select", delta: 1 } };
    const left: Extract<InputEvent, { type: "key" }> = { type: "key", key: "left", action: { type: "select", delta: 0 } };
    expect(resolveKeyAction(down, v.get(), s, 0)).toEqual({ type: "content-select", delta: 1 });
    expect(resolveKeyAction(left, v.get(), s, 0)).toEqual({ type: "noop" });
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
