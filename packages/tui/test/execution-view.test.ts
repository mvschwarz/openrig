import { describe, expect, it } from "vitest";
import { executionContentLines, executionSliceStripLines } from "../src/execution/execution-model.js";
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

function executionScopes(count = 4, status: (index: number) => string = (index) => (index === 0 ? "active" : "done")): NonNullable<FleetSnapshot["scopes"]> {
  const template = demoSnapshot().scopes![0]!.slices[0]!;
  return [{
    mission: "release-0.5.8",
    slices: Array.from({ length: count }, (_, index) => ({
      ...template,
      id: `OPR.0.5.8.${index + 1}`,
      dirName: `${String(index + 1).padStart(2, "0")}-slice`,
      displayName: `Slice ${String(index + 1).padStart(2, "0")} — Readable Name ${index + 1}`,
      status: status(index),
      proof: { paired: index === 1 ? 0 : 4, total: index === 1 ? 0 : 4 },
    })),
  }];
}

/** The installed 0.5.8 state that reopened the slice: every slice declared done, no live
 *  lanes, and no reachable repository — so reviewed/merged/live are INDETERMINATE for all. */
function installedStateFixture(count = 20): { execution: NonNullable<FleetSnapshot["execution"]>; scopes: NonNullable<FleetSnapshot["scopes"]> } {
  const execution = executionFixture(count);
  execution.q1_lanes = [];
  execution.q5_park = [];
  for (const item of execution.q2_sequencing) {
    item["next_up"] = "INDETERMINATE";
    item["next_up_basis"] = `own completion rung INDETERMINATE (${REPO_BASIS})`;
    item["next_up_rank"] = null;
    item["blocked_on_rows"] = [];
  }
  for (const item of execution.q4_ladder) {
    item["reviewed"] = { value: "INDETERMINATE", basis: "no repo context to resolve candidate identity through", legs: [] };
    item["folded"] = { value: "INDETERMINATE", basis: REPO_BASIS };
    item["adopted"] = { value: "INDETERMINATE", basis: REPO_BASIS };
  }
  return { execution, scopes: executionScopes(count, () => "done") };
}

const GLYPH_BLOB = /[○✓?]{5}/;

function text(lines: ReturnType<typeof executionContentLines>): string {
  return lines.map((line) => line.text).join("\n");
}

describe("mission execution story — readable rows over the shipped projections", () => {
  it("REGRESSION (founder journey): all slices declared done + no lanes + no repository must not render WAITING or glyph blobs", () => {
    const { execution, scopes } = installedStateFixture();
    const lines = executionContentLines(execution, scopes, [], null, 110 - 32);
    const body = text(lines);
    expect(body).not.toMatch(/WAITING/);
    expect(body).not.toMatch(GLYPH_BLOB);
    expect(body).not.toMatch(/\bp\d+\/\d+\b/);
    expect(body).not.toContain("@—");
    expect(body).not.toMatch(/\?\?/);
    // declared state is kept and attributed; the evidence gap is one mission-level line with a drill
    expect(body).toContain("declared in slice files: 20 done");
    expect(body).toContain("live now: 0 working");
    const gap = lines.find((line) => line.text.includes("evidence gap"))!;
    expect(gap.text).toContain("evidence gap — no repository reachable; declared state shown  (open ▸)");
    expect(gap.action).toEqual({ type: "execution-open", key: "evidence" });
    expect(lines.find((line) => line.text.includes("unconfirmed for"))?.text).toBe(
      "    evidence unconfirmed for 20 of 20 slices (unknown, not waiting)",
    );
    expect(body.split("evidence gap").length - 1).toBe(1);
    // every wave header counts declared words, never a work-state verdict the projection did not make
    const headers = lines.filter((l) => l.text.includes("── wave "));
    expect(headers.length).toBeGreaterThan(0);
    for (const line of headers) expect(line.text).toMatch(/\d+ done ─/);
    // the gap page names the basis and lists affected slices, each its own drill
    const page = executionContentLines(execution, scopes, [], "evidence", 160);
    expect(text(page)).toContain("git:         no reachable repo context");
    // each blind spot is named once at the FIRST unconfirmed rung with its own basis
    expect(text(page)).toContain("reviewed unconfirmed for 10 slices");
    expect(text(page)).toContain("basis:       no repo context to resolve candidate identity through");
    expect(text(page)).toContain("built unconfirmed for 10 slices");
    expect(text(page)).toContain("basis:       no candidate:* tag on any row bound to this slice");
    expect(page.filter((line) => line.action?.type === "execution-open" && (line.action as { key: string }).key.startsWith("slice:")).length).toBe(20);
  });

  it("shows each slice once, in wave order, as ordinary words with real assignment, evidence, proof, and next", () => {
    const lines = executionContentLines(executionFixture(), executionScopes(), [], null, 160);
    const body = text(lines);
    expect(body).toContain("release-0.5.8 EXECUTION · 4 slices");
    expect(body).toContain("declared in slice files: 3 done, 1 active · live now: 1 working, 1 with a problem");
    expect(body).toContain("wave active-parallel · 2 slices · 1 working, 1 needs input");
    expect(body).toContain("wave foundation · 1 slice · 1 done");
    expect(body).toContain("wave next-unlock · 1 slice · 1 done");
    for (const id of ["OPR.0.5.8.1", "OPR.0.5.8.2", "OPR.0.5.8.3", "OPR.0.5.8.4"]) expect(body.split(id).length - 1, id).toBe(1);
    expect(body).toContain("working      OPR.0.5.8.1  Readable Name 1 · dev-1 (self-report) · built sha000000 · proof 4 of 4");
    expect(body).toContain("needs input  OPR.0.5.8.2  Readable Name 2 · dev-2 (window-sampling) · needs input: permission prompt · no candidate recorded · no proof contract");
    expect(body).toContain("done         OPR.0.5.8.3  Readable Name 3 · merged · proof 4 of 4");
    expect(body).toContain("done         OPR.0.5.8.4  Readable Name 4 · ready to start · no candidate recorded · proof 4 of 4");
    expect(body).not.toMatch(GLYPH_BLOB);
    expect(lines.filter((line) => line.action?.type === "scopes-open")).toHaveLength(4);
  });

  it("renders every lifecycle frontier packet, unresolved occurrence, and named unknown", () => {
    const fixture = executionFixture();
    fixture.lifecycle_instances = [{
      instance_id: "WF-LIFE",
      status: "active",
      operation_key: "release-op",
      frontier_packets: [
        { packet_id: "Q-LEFT", step_id: "left", owner: "left@rig", queue_state: "in-progress", blocked_on: null, targeted_action: "rig workflow project --instance WF-LIFE --current-packet Q-LEFT" },
        { packet_id: "Q-RIGHT", step_id: "right", owner: "right@rig", queue_state: "blocked", blocked_on: "gate-2", targeted_action: "rig workflow project --instance WF-LIFE --current-packet Q-RIGHT" },
      ],
      failure_occurrences: [
        { occurrence_id: "Q-FAILED", step_id: "build", status: "unresolved", failure_reason: "fixture red", targeted_action: "rig workflow resume WF-LIFE --occurrence Q-FAILED --actor-session <you>" },
      ],
      unknowns: ["frontier packet Q-GHOST has no queue row"],
    }];
    const body = text(executionContentLines(fixture, executionScopes(), [], null, 200));
    expect(body).toContain("LIFECYCLE · 1 instance");
    expect(body).toContain("WF-LIFE · active · key release-op");
    expect(body).toContain("left · left@rig · in-progress · packet Q-LEFT");
    expect(body).toContain("right · right@rig · blocked · packet Q-RIGHT");
    expect(body).toContain("blocked on gate-2");
    expect(body).toContain("occurrence Q-FAILED · fixture red");
    expect(body).toContain("--occurrence Q-FAILED");
    expect(body).toContain("? frontier packet Q-GHOST has no queue row");
  });

  it("keeps every drill affordance in bounds at 110 and 160 columns and drops the name before the facts", () => {
    for (const width of [110 - 32, 160 - 32]) {
      const lines = executionContentLines(executionFixture(), executionScopes(), [], null, width);
      const drillable = lines.filter((line) => line.action);
      expect(drillable.length).toBeGreaterThan(4);
      for (const line of drillable) {
        expect(line.text.endsWith("(open ▸)")).toBe(true);
        expect(line.text.length).toBeLessThanOrEqual(width);
      }
    }
    // at 110 columns the assignee's decider goes first, then whole facts from the end —
    // never a fact clipped mid-word; assignee, evidence, proof and the problem reason survive
    const narrow = text(executionContentLines(executionFixture(), executionScopes(), [], null, 110 - 32));
    expect(narrow).toContain("working      OPR.0.5.8.1  dev-1 · built sha000000 · proof 4 of 4  (open ▸)");
    expect(narrow).toContain("needs input  OPR.0.5.8.2  dev-2 · needs input: permission prompt  (open ▸)");
    expect(narrow).toContain("evidence gap — no repository reachable; declared state shown  (open ▸)");
    expect(narrow).not.toMatch(/…  \(open ▸\)/);
  });

  it("renders structured blockers as words with the blocker first and never [object Object]", () => {
    const fixture = executionFixture();
    const blocked = fixture.q2_sequencing[3]!;
    blocked["next_up"] = false;
    blocked["next_up_basis"] = "blocked rows present (qitem-20260902074725-404326e1)";
    blocked["blocked_on_rows"] = [{ qitem_id: "qitem-20260902074725-404326e1", blocked_on: "qitem-20260902074704-b1a445fa" }];
    const body = text(executionContentLines(fixture, executionScopes(), [], null, 160));
    expect(body).toContain("blocked      OPR.0.5.8.4  Readable Name 4 · waits on qitem-20260902074704-b1a445fa");
    expect(body).toContain("wave next-unlock · 1 slice · 1 blocked");
    expect(body).not.toContain("[object Object]");
    const page = text(executionContentLines(fixture, [], [], "slice:OPR.0.5.8.4", 160));
    expect(page).toContain("blocked on:  qitem-20260902074725-404326e1 waits on qitem-20260902074704-b1a445fa");
  });

  it("bounds a large wave behind one door and keeps every hidden slice selectable", () => {
    const fixture = executionFixture(14);
    const overview = executionContentLines(fixture, executionScopes(14), [], null, 160);
    const door = overview.find((line) => line.text.includes("open all 12 rows in wave active-parallel"))!;
    expect(door.action).toEqual({ type: "execution-open", key: "group:wave:active-parallel" });
    expect(overview.length).toBeLessThanOrEqual(20);
    const page = executionContentLines(fixture, executionScopes(14), [], "group:wave:active-parallel", 160);
    expect(text(page)).toContain("wave active-parallel · all 12 rows");
    expect(text(page)).not.toMatch(/\+\d+ more/);
    expect(page.filter((line) => line.action?.type === "scopes-open")).toHaveLength(12);
  });

  it("tells pending, failed, and served-empty projection reads apart", () => {
    const failure = text(executionContentLines(null, [], ["execution: daemon read failed: GET /api/views/execution → 500"], null, 100));
    expect(failure).toContain("execution projection unavailable — execution: daemon read failed");
    expect(text(executionContentLines(null, [], [], null, 100, true))).toContain("read pending");
    expect(text(executionContentLines(null, [], [], null, 100, false))).toContain("served no row");
  });
});

describe("execution drill — one page from source, esc back", () => {
  it("a slice page shows declared vs evidence, every rung in words with its basis, sequencing, proof, and the lane", () => {
    const body = text(executionContentLines(executionFixture(), executionScopes(), [], "slice:OPR.0.5.8.3", 100));
    expect(body).toContain("OPR.0.5.8.3 — Readable Name 3");
    expect(body).toContain("declared done · evidence merged");
    expect(body).toContain("built        fold00000");
    expect(body).toContain("merged       yes");
    expect(body).toContain("live         no");
    expect(body).toContain("basis: git merge-base");
    expect(body).toContain("review leg CLEAR · rev1-r2 · /proof/review.md");
    expect(body).toContain("next up:     INDETERMINATE — own completion rung INDETERMINATE");
    expect(body).toContain("spec:        /work/OPR.0.5.8.3/SPEC.md");
    expect(body).not.toMatch(GLYPH_BLOB);
    expect(body).toContain("esc back");
  });

  it("a lane page names the qitem, seat, activity oracle, and the fragile repo join", () => {
    const body = text(executionContentLines(executionFixture(), [], [], "lane:qitem-2", 100));
    expect(body).toContain("lane OPR.0.5.8.2 · dev-2@rig");
    expect(body).toContain("needs input: 1 · permission prompt");
    expect(body).toContain("repo join · FRAGILE");
    expect(body).toContain("worktree:    INDETERMINATE");
    expect(body).toContain("41 min since claim");
  });

  it("an opened key that the fresh snapshot no longer holds says so instead of blanking", () => {
    const body = text(executionContentLines(executionFixture(), [], [], "lane:qitem-gone", 100));
    expect(body).toContain("lane:qitem-gone is not in the current snapshot");
    expect(body).toContain("esc back");
  });

  it("the slice strip keeps declared and evidence apart and never invents an assignment", () => {
    const { execution } = installedStateFixture(4);
    const strip = text(executionSliceStripLines(execution, "OPR.0.5.8.1", "01-slice", 200, "done"));
    expect(strip).toContain("EXECUTION · no claimed lane · wave active-parallel");
    expect(strip).toContain("declared    done (slice file)");
    expect(strip).toContain("evidence    built sha000000 · reviewed / merged / live unconfirmed (no repo context to resolve candidate identity through)  (open ▸)");
    expect(strip).toContain("assignment  none — no claimed lane");
    expect(strip).toContain("next        none — declared done");
    expect(strip).not.toMatch(/WAITING|[○✓?]{5}/);
    const live = text(executionSliceStripLines(executionFixture(), "OPR.0.5.8.1", "01-slice", 120, "active"));
    expect(live).toContain("EXECUTION · working · wave active-parallel");
    expect(live).toContain("assignment  dev-1@rig · working (self-report)");
  });

  it("renders through a SCOPES mission selection, opens rich slice detail, and preserves source drills", () => {
    const demo = demoSnapshot();
    const scopes = [...demo.scopes!, ...executionScopes()];
    const snap = { ...demo, scopes, execution: executionFixture(), executionMission: "release-0.5.8", hydratedAt: "2026-09-01T21:00:00.000Z" };
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch(parseCommand(":scopes"));
    view.dispatch({ type: "scopes-mission-open", mission: "release-0.5.8" });
    let screen = renderScreen(view.get(), snap, { cols: 110, rows: 40 });
    let body = screen.lines.join("\n");
    expect(body).toContain("release-0.5.8 EXECUTION");
    expect(body).toContain("evidence gap");
    expect(body).not.toMatch(GLYPH_BLOB);
    expect(body).not.toContain("WAITING");
    const target = screen.contentTargets.find((t) => t.action.type === "scopes-open")!;
    view.dispatch(target.action);
    screen = renderScreen(view.get(), snap, { cols: 110, rows: 40 });
    body = screen.lines.join("\n");
    expect(body).toContain("INTENT (verbatim)");
    expect(body).toContain("EXECUTION · working");
    expect(body).toContain("declared    active (slice file)");
    view.dispatch({ type: "scopes-mission-open", mission: "release-0.5.8" });
    screen = renderScreen(view.get(), snap, { cols: 110, rows: 40 });
    const gap = screen.contentTargets.find((t) => (t.action as { key?: string }).key === "evidence")!;
    view.dispatch(gap.action);
    screen = renderScreen(view.get(), snap, { cols: 110, rows: 40 });
    expect(screen.lines.join("\n")).toContain("evidence gap · derived");
    view.dispatch({ type: "execution-close" });
    screen = renderScreen(view.get(), snap, { cols: 110, rows: 40 });
    expect(screen.lines.join("\n")).toContain("wave active-parallel");
    expect(view.get().executionOpen).toBeNull();
  });
});
