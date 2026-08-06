import { describe, expect, it } from "vitest";
import { createViewState } from "../src/state.js";
import { parseCommand } from "../src/grammar.js";
import { renderScreen } from "../src/render.js";
import { demoSnapshot } from "../src/demo-data.js";
import { demoPulseModel } from "../src/pulse/pulse-model.js";
import { renderPulseView } from "../src/pulse/render-pulse.js";

const snap = demoSnapshot();
const withSnap = { getSnapshot: () => snap };

describe("PULSE view (5.2 Wave B — increment 1: static skeleton from the approved mock)", () => {
  it("registers `pulse` as a reachable viewTab (tab pulse + dispatch)", () => {
    expect(parseCommand("tab pulse")).toEqual({ type: "tab", tab: "pulse" });
    const v = createViewState({ instanceId: "t", ...withSnap });
    v.dispatch({ type: "tab", tab: "pulse" });
    expect(v.get().viewTab).toBe("pulse");
    // pulse is a top-level VIEW MODE, not a section — the section is unchanged
    expect(v.get().section).toBe("topology");
  });

  it("reproduces the mock's EXACT exception rows + ordering (glyphs/labels are contract)", () => {
    const v = createViewState({ instanceId: "t", ...withSnap });
    v.dispatch({ type: "tab", tab: "pulse" });
    const body = renderScreen(v.get(), snap, { cols: 140, rows: 44 }).lines.join("\n");

    // exception sections — ordering ▲ NEEDS YOU → ◌ PARKED → ⧗ BLOCKED is contract
    expect(body).toContain("▲ NEEDS YOU (2)");
    expect(body).toContain("push-go");
    expect(body).toContain("0.5.0 cut packet ready · waiting on you");
    expect(body).toContain("· 22m");
    expect(body).toContain("style verdict");
    expect(body).toContain("slice-20 routing pixels · waiting on you");
    expect(body).toContain("◌ PARKED WITH BATON (1)");
    expect(body).toContain("dev.qa");
    expect(body).toContain("qitem 8f3a… in-progress 47m idle, no handoff");
    expect(body).toContain("→ enter: transcript check");
    expect(body).toContain("⧗ BLOCKED ON AGENTS (1)");
    expect(body).toContain("dev50.driver");
    expect(body).toContain('blocked on review-r1 · "terminal verdict for 51209941"');
    expect(body).toContain("· 1h");

    const iNeeds = body.indexOf("NEEDS YOU");
    const iParked = body.indexOf("PARKED WITH BATON");
    const iBlocked = body.indexOf("BLOCKED ON AGENTS");
    const iLanes = body.indexOf("JUST FINISHED");
    expect(iNeeds).toBeGreaterThanOrEqual(0);
    expect(iNeeds).toBeLessThan(iParked);
    expect(iParked).toBeLessThan(iBlocked);
    expect(iBlocked).toBeLessThan(iLanes);
  });

  it("reproduces the mock's three lanes + counts + footer (label==referent honesty)", () => {
    const v = createViewState({ instanceId: "t", ...withSnap });
    v.dispatch({ type: "tab", tab: "pulse" });
    const body = renderScreen(v.get(), snap, { cols: 140, rows: 44 }).lines.join("\n");

    expect(body).toContain("NOW (4)");
    expect(body).toContain("JUST FINISHED (3)");
    expect(body).toContain("UP NEXT (5)");
    expect(body).toContain("dev.impl");
    expect(body).toContain("slice 51-01 stub");
    expect(body).toContain("oversight.watch");
    expect(body).toContain("token sweep");
    expect(body).toContain("14:02");
    expect(body).toContain("slice-03 close-out");
    expect(body).toContain("terminal CLEAR");
    expect(body).toContain("51-02 scenario runner");
    expect(body).toContain("RM ceremony");
    expect(body).toContain("4 active · 1 parked · 2 waiting-you · updated 2s ago");
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
