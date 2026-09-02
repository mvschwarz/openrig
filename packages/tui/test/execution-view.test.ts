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
    q3_care: ids.map((slice, index) => ({
      slice_id: slice,
      build_wave: index === 2 ? "foundation" : index === 3 ? "next-unlock" : "active-parallel",
      review_model: "INDETERMINATE",
      planning_dial: "INDETERMINATE",
    })),
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

function executionScopes(count = 4): NonNullable<FleetSnapshot["scopes"]> {
  const template = demoSnapshot().scopes![0]!.slices[0]!;
  return [{
    mission: "release-0.5.8",
    slices: Array.from({ length: count }, (_, index) => ({
      ...template,
      id: `OPR.0.5.8.${index + 1}`,
      dirName: `${String(index + 1).padStart(2, "0")}-slice`,
      displayName: `${index + 1}-slice`,
    })),
  }];
}

function text(lines: ReturnType<typeof executionContentLines>): string {
  return lines.map((line) => line.text).join("\n");
}

describe("mission execution story — one wave/dependency spine from the shipped projection", () => {
  it("shows each slice exactly once, grouped in wave order, with done/now/next/problem and real assignments", () => {
    const lines = executionContentLines(executionFixture(), executionScopes(), [], null, 160);
    const body = text(lines);
    expect(body).toContain("release-0.5.8 EXECUTION");
    expect(body).toContain("WAVE active-parallel · ATTENTION · 2 slices");
    expect(body).toContain("WAVE foundation · DONE · 1 slice");
    expect(body).toContain("WAVE next-unlock · NEXT · 1 slice");
    for (const id of ["OPR.0.5.8.1", "OPR.0.5.8.2", "OPR.0.5.8.3", "OPR.0.5.8.4"])
      expect(body.split(id).length - 1, id).toBe(1);
    expect(body).toContain("● OPR.0.5.8.1 ○✓??? p2/9 NOW @dev-1@rig · →reviewed");
    expect(body).toContain("⚑ OPR.0.5.8.2 ○???? p2/9 ATTENTION @dev-2@rig · !permission prompt →locked");
    expect(body).toContain("✓ OPR.0.5.8.3 ○✓✓✓○ p2/9 DONE @— · →adopted");
    expect(body).toContain("→ OPR.0.5.8.4 ○???? p2/9 NEXT @— · →unlocked");
    expect(lines.filter((line) => line.action?.type === "scopes-open")).toHaveLength(4);
  });

  it("keeps the path legible and every drill affordance in bounds at 110 and 160 columns", () => {
    for (const width of [110, 160]) {
      const lines = executionContentLines(executionFixture(), [], [], null, width);
      const drillable = lines.filter((line) => line.action);
      expect(drillable.length).toBeGreaterThan(4);
      expect(text(lines)).toContain("spine: ✓ done · ● now · → next · ⚑ problem");
      for (const line of drillable) {
        expect(line.text.endsWith("(open ▸)")).toBe(true);
        expect(line.text.length).toBeLessThanOrEqual(width);
      }
    }
  });

  it("keeps path, real assignment, next unlock, and inline problem visible in full 110/160-column screens", () => {
    const demo = demoSnapshot();
    const snap = { ...demo, scopes: [...demo.scopes!, ...executionScopes()], execution: executionFixture() };
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch(parseCommand(":scopes"));
    view.dispatch({ type: "scopes-mission-open", mission: "release-0.5.8" });
    for (const cols of [110, 160]) {
      const body = renderScreen(view.get(), snap, { cols, rows: 50 }).lines.join("\n");
      expect(body).toContain("release-0.5.8 EXECUTION");
      expect(body).toContain("OPR.0.5.8.1");
      expect(body).toContain("dev-1@rig");
      expect(body).toContain("p2/9");
      expect(body).toContain("reviewed");
      expect(body).toContain("permission prompt");
      expect(body).toContain("unlocked");
    }
  });

  it("renders structured blockers inline with the blocker first and never [object Object]", () => {
    const fixture = executionFixture();
    const blocked = fixture.q2_sequencing[3]!;
    blocked["next_up"] = false;
    blocked["next_up_basis"] = "blocked rows present (qitem-20260902074725-404326e1)";
    blocked["blocked_on_rows"] = [{ qitem_id: "qitem-20260902074725-404326e1", blocked_on: "qitem-20260902074704-b1a445fa" }];
    const body = text(executionContentLines(fixture, [], [], null, 160));
    expect(body).toContain("⚑ OPR.0.5.8.4 ○???? p? ATTENTION @— · !waits on qitem-20260902074704-b1a445fa →blocked");
    expect(body).not.toContain("[object Object]");
    const demo = demoSnapshot();
    const snap = { ...demo, scopes: [...demo.scopes!, ...executionScopes()], execution: fixture };
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch(parseCommand(":scopes"));
    view.dispatch({ type: "scopes-mission-open", mission: "release-0.5.8" });
    const narrow = renderScreen(view.get(), snap, { cols: 110, rows: 50 }).lines.join("\n");
    expect(narrow).toContain("→blocked");
    expect(narrow).toContain("!qitem-20260902074704");
    const page = text(executionContentLines(fixture, [], [], "slice:OPR.0.5.8.4", 160));
    expect(page).toContain("blocked on:  qitem-20260902074725-404326e1 waits on qitem-20260902074704-b1a445fa");
  });

  it("bounds a large wave behind one door and keeps every hidden slice selectable", () => {
    const fixture = executionFixture(14);
    const overview = executionContentLines(fixture, [], [], null, 160);
    const door = overview.find((line) => line.text.includes("open all 12 rows in wave active-parallel"))!;
    expect(door.action).toEqual({ type: "execution-open", key: "group:wave:active-parallel" });
    expect(overview.length).toBeLessThanOrEqual(20);
    const page = executionContentLines(fixture, [], [], "group:wave:active-parallel", 160);
    expect(text(page)).toContain("wave active-parallel · all 12 rows");
    expect(page.filter((line) => line.action?.type === "scopes-open" || line.action?.type === "execution-open")).toHaveLength(12);
  });

  it("tells pending, failed, and served-empty projection reads apart", () => {
    const failure = text(executionContentLines(null, [], ["execution: daemon read failed: GET /api/views/execution → 500"], null, 100));
    expect(failure).toContain("execution projection unavailable — execution: daemon read failed");
    expect(text(executionContentLines(null, [], [], null, 100, true))).toContain("read pending");
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

  it("renders through a SCOPES mission selection, opens rich slice detail, and preserves source drills", () => {
    const demo = demoSnapshot();
    const scopes = [...demo.scopes!, ...executionScopes()];
    const snap = { ...demo, scopes, execution: executionFixture() };
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch(parseCommand(":scopes"));
    view.dispatch({ type: "scopes-mission-open", mission: "release-0.5.8" });
    let screen = renderScreen(view.get(), snap, { cols: 160, rows: 40 });
    expect(screen.lines.join("\n")).toContain("release-0.5.8 EXECUTION");
    const target = screen.contentTargets.find((t) => t.action.type === "scopes-open")!;
    view.dispatch(target.action);
    screen = renderScreen(view.get(), snap, { cols: 160, rows: 40 });
    expect(screen.lines.join("\n")).toContain("INTENT (verbatim)");
    expect(screen.lines.join("\n")).toContain("EXECUTION · ● NOW");
    expect(screen.lines.join("\n")).toContain("assignment");
    view.dispatch({ type: "scopes-mission-open", mission: "release-0.5.8" });
    screen = renderScreen(view.get(), snap, { cols: 160, rows: 40 });
    const sources = screen.contentTargets.find((t) => (t.action as { key?: string }).key === "sources")!;
    view.dispatch(sources.action);
    screen = renderScreen(view.get(), snap, { cols: 160, rows: 40 });
    expect(screen.lines.join("\n")).toContain("sources behind release-0.5.8");
    view.dispatch({ type: "execution-close" });
    screen = renderScreen(view.get(), snap, { cols: 160, rows: 40 });
    expect(screen.lines.join("\n")).toContain("WAVE active-parallel");
    expect(view.get().executionOpen).toBeNull();
  });
});
