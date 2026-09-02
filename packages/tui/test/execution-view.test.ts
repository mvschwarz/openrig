import { describe, expect, it } from "vitest";
import { executionContentLines } from "../src/execution/execution-model.js";
import { demoSnapshot } from "../src/demo-data.js";
import { renderScreen } from "../src/render.js";
import { createViewState } from "../src/state.js";
import { parseCommand } from "../src/grammar.js";
import type { FleetSnapshot } from "../src/types.js";

const REPO_BASIS = "no reachable repo context (no EC-3 worktree on the board)";

/** A projection shaped like the live daemon's: slice 1 is claimed and working, slice 2
 *  is idle with a needs-input flag and a parked row, slice 3 is folded, the rest are
 *  built-or-unrecorded with the ladder above build INDETERMINATE for one shared reason. */
function executionFixture(count = 4): NonNullable<FleetSnapshot["execution"]> {
  const ids = Array.from({ length: count }, (_, index) => `OPR.0.5.8.${index + 1}`);
  const built = (index: number) => index % 2 === 0 ? { candidate_sha: `sha${index}00000000`, resolved_commit: "INDETERMINATE", basis: `candidate:* tag on row qitem-${index + 1}` } : { candidate_sha: "INDETERMINATE", basis: "no candidate:* tag on any row bound to this slice" };
  return {
    view: "execution",
    mission: "release-0.5.8",
    derived_at: "2026-09-01T21:00:00.000Z",
    sources: {
      queue_db: { asof: "2026-09-01T21:00:00.000Z", basis: "queue_items at read time" },
      arrangement: { manifest: "/work/mission.yaml", basis: "mission.yaml composition order" },
      git: { basis: "no reachable repo context" },
      build_info: { commit: "257f47e93bdc48b8142f32135cafdbc748fccc46" },
    },
    q1_lanes: ids.slice(0, 2).map((slice, index) => ({
      qitem_id: `qitem-${index + 1}`,
      slice,
      seat: `dev-${index + 1}@rig`,
      worktree_path: "INDETERMINATE",
      branch: "INDETERMINATE",
      head_sha: "INDETERMINATE",
      fragile_join: true,
      join_basis: "row/branch naming only (EC-3 field absent — legacy baton)",
      activity: {
        activity: index === 0 ? "working" : "idle-at-prompt",
        needs_input: { count: index === 1 ? 1 : 0, reason: index === 1 ? "permission prompt" : null },
        decided_by: index === 0 ? "self-report" : "window-sampling",
        changed_at: "2026-09-01T20:58:12.000Z",
      },
      pickup: { state: index === 0 ? "working" : "parked" },
      source: { qitem_id: `qitem-${index + 1}` },
    })),
    q2_sequencing: ids.map((slice, index) => ({
      slice_id: slice,
      dir: `${String(index + 1).padStart(2, "0")}-slice`,
      depends_on: index === 3 ? [ids[2]] : [],
      blocked_on_rows: [],
      next_up: index < 2 ? false : index === 3 ? true : "INDETERMINATE",
      next_up_basis: index < 2 ? "already claimed in-progress" : index === 3 ? "deps met, unclaimed" : `own completion rung INDETERMINATE (${REPO_BASIS})`,
      next_up_rank: index === 3 ? 1 : null,
      source: { spec_path: `/work/${slice}/SPEC.md`, arrangement_path: `/work/${slice}/slice.yaml`, wave_map_row: "INDETERMINATE" },
    })),
    q3_care: ids.map((slice) => ({ slice_id: slice, build_wave: "first-parallel", review_model: "INDETERMINATE", planning_dial: "INDETERMINATE" })),
    q4_ladder: ids.map((slice, index) => ({
      slice_id: slice,
      dir: `${String(index + 1).padStart(2, "0")}-slice`,
      locked: { value: false, basis: "no approved-spec-at in frontmatter" },
      built: index === 2 ? { candidate_sha: "fold000000", resolved_commit: "fold000000", basis: "candidate:* tag on row qitem-9" } : built(index),
      reviewed: index === 2
        ? { value: true, basis: "/proof/review.md", legs: [{ path: "/proof/review.md", verdict: "CLEAR", artifact_type: "rev1-r2", candidate_sha: "fold000000" }] }
        : { value: "INDETERMINATE", basis: REPO_BASIS, legs: [] },
      folded: index === 2 ? { value: true, basis: "git merge-base" } : { value: "INDETERMINATE", basis: REPO_BASIS },
      adopted: index === 2 ? { value: false, basis: "daemon build stamp differs" } : { value: "INDETERMINATE", basis: REPO_BASIS },
    })),
    q5_park: [
      { qitem_id: "qitem-1", pickup_state: "working", park_kind: "indeterminate", park_kind_basis: "no armed wake row", wake_target: null, age_minutes: 3, source: { qitem_id: "qitem-1" } },
      { qitem_id: "qitem-2", pickup_state: "parked", park_kind: "indeterminate", park_kind_basis: "no armed wake row", wake_target: null, age_minutes: 41, source: { qitem_id: "qitem-2" } },
    ],
    q6_parallelism: { lanes_live: 2, lanes_possible: 1, idle_seats_with_capacity: { value: 7, basis: "arbitrated idle-at-prompt" } },
  };
}

function text(lines: ReturnType<typeof executionContentLines>): string {
  return lines.map((line) => line.text).join("\n");
}

describe("execution overview — DONE / NOW / NEXT / ATTENTION from the shipped projection", () => {
  it("renders the four groups with a header naming the mission, derivation time and daemon build", () => {
    const lines = executionContentLines(executionFixture(), demoSnapshot().scopes, [], null, 100);
    const body = text(lines);
    expect(body).toContain("release-0.5.8 · derived 21:00:00Z · daemon build 257f47e93 · 4 slices");
    for (const group of ["DONE", "NOW", "NEXT", "ATTENTION"]) expect(body).toContain(`── ${group}`);
    expect(body).not.toContain("qitem body");
    const actions = lines.filter((line) => line.action);
    expect(actions.length).toBeGreaterThan(0);
    expect(actions.every((line) => line.action?.type === "execution-open")).toBe(true);
  });

  it("DONE counts true rungs only, lists the highest rung first, and summarises not-started slices in one line", () => {
    const body = text(executionContentLines(executionFixture(), [], [], null, 160));
    expect(body).toContain("DONE  locked 0 · built 2 · reviewed 1 · folded 1 · adopted 0");
    expect(body).toContain("ladder lock·build·review·fold·adopt · ✓ yes ○ no ? undetermined");
    const done = body.slice(body.indexOf("── DONE"), body.indexOf("── NOW"));
    const rows = done.split("\n").filter((line) => line.includes("(open ▸)"));
    expect(rows[0]).toContain("OPR.0.5.8.3");
    expect(rows[0]).toContain("○✓✓✓○");
    expect(rows[0]).toContain("folded");
    expect(rows[1]).toContain("OPR.0.5.8.1");
    expect(rows[1]).toContain("built sha000000");
    expect(rows[1]).toContain("wave first-parallel");
    expect(done).toContain("2 slices with no rung reached");
    // the not-started slices are NOT listed as ladder rows
    expect(rows.some((line) => line.includes("OPR.0.5.8.2 "))).toBe(false);
  });

  it("NOW passes the arbitrated activity and its decider through verbatim, with the needs-input reason", () => {
    const body = text(executionContentLines(executionFixture(), [], [], null, 160));
    const now = body.slice(body.indexOf("── NOW"), body.indexOf("── NEXT"));
    expect(now).toContain("2 lanes live · idle seats with capacity 7");
    expect(now).toContain("● OPR.0.5.8.1  dev-1@rig  working · by self-report 20:58:12Z");
    expect(now).toContain("⚑ OPR.0.5.8.2  dev-2@rig  idle-at-prompt · by window-sampling 20:58:12Z · needs input: permission prompt");
  });

  it("NEXT lists eligible slices with their met dependencies and groups every not-eligible reason with a count", () => {
    const body = text(executionContentLines(executionFixture(), [], [], null, 160));
    const next = body.slice(body.indexOf("── NEXT"), body.indexOf("── ATTENTION"));
    expect(next).toContain("NEXT  1 eligible · 3 not eligible");
    expect(next).toContain("→ OPR.0.5.8.4  after OPR.0.5.8.3 (met) · wave first-parallel");
    expect(next).toContain("2 · already claimed in-progress");
    expect(next).toContain(`1 ? undetermined — own completion rung INDETERMINATE (${REPO_BASIS})`);
  });

  it("ATTENTION lists needs-input and parked rows individually and names each blind spot once, at the first undetermined rung", () => {
    const body = text(executionContentLines(executionFixture(), [], [], null, 160));
    const attention = body.slice(body.indexOf("── ATTENTION"));
    expect(attention).toContain("ATTENTION  5");
    expect(attention).toContain("⚑ OPR.0.5.8.2  dev-2@rig  needs input: permission prompt");
    expect(attention).toContain("⚑ OPR.0.5.8.2  pickup parked · indeterminate · 41m since claim");
    expect(attention).toContain("△ 2 lanes on a fragile join — row/branch naming only (EC-3 field absent — legacy baton) · OPR.0.5.8.1, OPR.0.5.8.2");
    // slices 2 and 4 have no candidate: the blind spot is BUILD, and fold/adopt are not repeated
    expect(attention).toContain("? 2 slices build undetermined — no candidate:* tag on any row bound to this slice");
    // slice 1 is built, so its first undetermined rung is REVIEWED; slice 3 is fully determined
    expect(attention).toContain(`? 1 slice reviewed undetermined — ${REPO_BASIS}`);
    expect(attention.split(REPO_BASIS).length - 1).toBe(1);
    expect(attention).not.toContain("folded undetermined");
    expect(attention).not.toContain("OPR.0.5.8.1 · INDETERMINATE");
  });

  it("renders structured blocked_on_rows as the row → blocker relation, never [object Object] (QA finding)", () => {
    const fixture = executionFixture();
    const blocked = fixture.q2_sequencing[3]!;
    blocked["next_up"] = false;
    blocked["next_up_basis"] = "blocked rows present (qitem-20260902074725-404326e1)";
    blocked["blocked_on_rows"] = [{ qitem_id: "qitem-20260902074725-404326e1", blocked_on: "qitem-20260902074704-b1a445fa" }];
    const body = text(executionContentLines(fixture, [], [], null, 160));
    const next = body.slice(body.indexOf("── NEXT"), body.indexOf("── ATTENTION"));
    expect(next).toContain("NEXT  0 eligible · 1 blocked · 3 not eligible");
    expect(next).toContain("⧗ OPR.0.5.8.4  waits on qitem-20260902074704-b1a445fa · own row qitem-20260902074725-404326e1");
    expect(body).not.toContain("[object Object]");
    // at 110 columns the blocker id itself must survive the clamp
    const narrow = text(executionContentLines(fixture, [], [], null, 78));
    expect(narrow).toContain("⧗ OPR.0.5.8.4  waits on qitem-20260902074704-b1a445fa");
    expect(narrow).not.toContain("[object Object]");
    const page = text(executionContentLines(fixture, [], [], "slice:OPR.0.5.8.4", 160));
    expect(page).toContain("blocked on:  qitem-20260902074725-404326e1 waits on qitem-20260902074704-b1a445fa");
    expect(page).not.toContain("[object Object]");
  });

  it("clamps long rows to the pane width so the open affordance always survives", () => {
    const lines = executionContentLines(executionFixture(), [], [], null, 80);
    const drillable = lines.filter((line) => line.action);
    expect(drillable.length).toBeGreaterThan(3);
    for (const line of drillable) {
      expect(line.text.endsWith("(open ▸)")).toBe(true);
      expect(line.text.length).toBeLessThanOrEqual(80);
    }
    expect(drillable.some((line) => line.text.includes("…"))).toBe(true);
  });

  it("caps a 40-slice projection to one glance with explicit plus-N overflow rows", () => {
    const lines = executionContentLines(executionFixture(40), [], [], null, 100);
    expect(lines.length).toBeLessThanOrEqual(34);
    expect(lines.some((line) => /\+\d+ more/.test(line.text))).toBe(true);
  });

  it("the +N more overflow row is a door: it opens the whole group with every hidden row drillable (R2 finding)", () => {
    // 14 slices → every even index is built → 7 reached rows in DONE, 5 shown, 2 hidden
    const fixture = executionFixture(14);
    const overview = executionContentLines(fixture, [], [], null, 160);
    const door = overview.find((line) => /\+2 more/.test(line.text))!;
    expect(door.text).toContain("+2 more — open all 7 DONE rows");
    expect(door.action).toEqual({ type: "execution-open", key: "group:done" });
    const doneStart = overview.findIndex((l) => l.text.includes("── DONE"));
    const nowStart = overview.findIndex((l) => l.text.includes("── NOW"));
    const shownIds = overview.slice(doneStart, nowStart).filter((l) => l.action?.type === "execution-open" && (l.action as { key: string }).key.startsWith("slice:")).map((l) => (l.action as { key: string }).key);
    expect(shownIds).toHaveLength(5);

    const page = executionContentLines(fixture, [], [], "group:done", 160);
    expect(text(page)).toContain("all 7 DONE rows");
    expect(text(page)).toContain("esc back");
    expect(text(page)).not.toMatch(/\+\d+ more/);
    const pageIds = page.filter((l) => l.action?.type === "execution-open" && (l.action as { key: string }).key.startsWith("slice:")).map((l) => (l.action as { key: string }).key);
    expect(pageIds).toHaveLength(7);
    // the two hidden slices are exactly the ones the overview did not show, and each is its own drill
    const hidden = pageIds.filter((key) => !shownIds.includes(key));
    expect(hidden).toEqual(["slice:OPR.0.5.8.11", "slice:OPR.0.5.8.13"]);
    for (const key of hidden) expect(text(executionContentLines(fixture, [], [], key, 160))).toContain("ladder · reached");

    // esc from the group page returns to the overview through the same close action
    const snap = { ...demoSnapshot(), execution: fixture };
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch(parseCommand(":execution"));
    view.dispatch(door.action!);
    expect(view.get().executionOpen).toBe("group:done");
    let screen = renderScreen(view.get(), snap, { cols: 160, rows: 40 });
    expect(screen.lines.join("\n")).toContain("all 7 DONE rows");
    view.dispatch({ type: "execution-close" });
    screen = renderScreen(view.get(), snap, { cols: 160, rows: 40 });
    expect(view.get().executionOpen).toBeNull();
    expect(screen.lines.join("\n")).toContain("+2 more — open all 7 DONE rows");
  });

  it("degrades a failed execution fetch to one warning instead of blanking the section", () => {
    const lines = executionContentLines(null, [], ["execution: daemon read failed: GET /api/views/execution → 500"], null, 100);
    expect(text(lines)).toContain("execution projection unavailable — execution: daemon read failed");
  });

  it("tells pending, failed, and served-empty apart instead of calling all three unavailable", () => {
    expect(text(executionContentLines(null, [], [], null, 100, true))).toContain("read pending");
    expect(text(executionContentLines(null, [], [], null, 100, true))).not.toContain("unavailable");
    expect(text(executionContentLines(null, [], [], null, 100, false))).toContain("served no row");
  });
});

describe("execution drill — one page from source, esc back", () => {
  it("a slice page shows every rung with its basis, sequencing, proof, and the lane it is on", () => {
    const body = text(executionContentLines(executionFixture(), demoSnapshot().scopes, [], "slice:OPR.0.5.8.3", 100));
    expect(body).toContain("OPR.0.5.8.3 — 03-slice");
    expect(body).toContain("ladder · reached: folded");
    expect(body).toContain("built     ✓ fold00000");
    expect(body).toContain("basis: git merge-base");
    expect(body).toContain("review leg CLEAR · rev1-r2 · /proof/review.md");
    expect(body).toContain("next up:     INDETERMINATE — own completion rung INDETERMINATE");
    expect(body).toContain("spec:        /work/OPR.0.5.8.3/SPEC.md");
    expect(body).toContain("esc back");
  });

  it("a lane page names the qitem, seat, activity oracle, and the fragile repo join", () => {
    const body = text(executionContentLines(executionFixture(), [], [], "lane:qitem-2", 100));
    expect(body).toContain("lane OPR.0.5.8.2 · dev-2@rig");
    expect(body).toContain("needs input: 1 · permission prompt");
    expect(body).toContain("repo join · FRAGILE");
    expect(body).toContain("worktree:    INDETERMINATE");
    expect(body).toContain("kind:        indeterminate");
    expect(body).toContain("41 min since claim");
  });

  it("a basis page lists the affected slices, each opening its own page", () => {
    const lines = executionContentLines(executionFixture(), [], [], "basis:build:no candidate:* tag on any row bound to this slice", 100);
    expect(text(lines)).toContain("affected (2)");
    const items = lines.filter((line) => line.action?.type === "execution-open");
    expect(items.map((line) => (line.action as { key: string }).key)).toEqual(["slice:OPR.0.5.8.2", "slice:OPR.0.5.8.4"]);
  });

  it("an opened key that the fresh snapshot no longer holds says so instead of blanking", () => {
    const body = text(executionContentLines(executionFixture(), [], [], "lane:qitem-gone", 100));
    expect(body).toContain("lane:qitem-gone is not in the current snapshot");
    expect(body).toContain("esc back");
  });

  it("renders through the public :execution section, opens the selected row, and execution-close returns to the overview", () => {
    const snap = { ...demoSnapshot(), execution: executionFixture() };
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    expect(view.dispatch(parseCommand(":execution")).lastError).toBeNull();
    let screen = renderScreen(view.get(), snap, { cols: 160, rows: 40 });
    expect(screen.lines.join("\n")).toContain("ATTENTION");
    const target = screen.contentTargets.find((t) => (t.action as { key?: string }).key?.startsWith("slice:"))!;
    view.dispatch(target.action);
    screen = renderScreen(view.get(), snap, { cols: 160, rows: 40 });
    expect(screen.lines.join("\n")).toContain("ladder · reached");
    expect(screen.lines.join("\n")).toContain("esc back");
    view.dispatch({ type: "execution-close" });
    screen = renderScreen(view.get(), snap, { cols: 160, rows: 40 });
    expect(screen.lines.join("\n")).toContain("── DONE");
    expect(view.get().executionOpen).toBeNull();
  });
});
