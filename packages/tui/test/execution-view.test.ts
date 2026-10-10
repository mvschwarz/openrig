import { execFileSync } from "node:child_process";
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

function executionKeys(lines: ReturnType<typeof executionContentLines>): string[] {
  const keys: string[] = [];
  for (const line of lines) {
    if (line.action?.type === "execution-open") keys.push(line.action.key);
    for (const zone of line.zones ?? []) if (zone.action.type === "execution-open") keys.push(zone.action.key);
  }
  return [...new Set(keys)];
}

describe("mission execution story — readable rows over the shipped projections", () => {
  it("keeps project daemon N/A out of lineage gaps and the SCOPES progress strip", () => {
    const fixture = executionFixture(1);
    fixture.q1_lanes = [];
    fixture.q4_ladder[0] = {
      slice_id: "OPR.0.5.8.1", dir: "01-slice",
      locked: { value: true }, built: { candidate_sha: "abcdef123" },
      reviewed: { value: true }, folded: { value: true },
      adopted: { value: "NOT_APPLICABLE", basis: "selected project has no daemon-source binding" },
    };
    for (const width of [58, 120]) {
      const detail = text(executionContentLines(fixture, executionScopes(1), [], "slice:OPR.0.5.8.1", width));
      expect(detail).toContain("N/A");
      expect(detail).toContain("daemon");
      const gap = text(executionContentLines(fixture, executionScopes(1), [], "evidence", width));
      expect(gap).not.toContain("live unconfirmed");
      const strip = text(executionSliceStripLines(fixture, "OPR.0.5.8.1", "01-slice", width));
      expect(strip).toContain("merged");
      expect(strip).not.toContain("live");
      expect(strip).not.toContain("unconfirmed");
      const project = { id: "demo", root: "/projects/demo", name: "Demo", sourcePath: null, missionsRoot: "/projects/demo/missions" };
      const snap: FleetSnapshot = { ...demoSnapshot(), execution: fixture, scopes: executionScopes(1),
        projects: { catalogPath: "/projects/workspace.yaml", projects: [project] }, projectRead: project };
      const view = createViewState({ instanceId: "projects", getSnapshot: () => snap });
      view.dispatch(parseCommand("projects"));
      view.dispatch({ type: "project-select", id: project.id });
      view.dispatch({ type: "scopes-mission-open", mission: fixture.mission! });
      view.dispatch({ type: "scopes-open", mission: fixture.mission!, slice: "01-slice" });
      const screen = renderScreen(view.get(), snap, { cols: width + 32, rows: 220 }).lines.join("\n");
      expect(screen).toContain("N/A");
      expect(screen).not.toMatch(/live.*undetermined/);
    }
  });

  it("shows authored admission and partial acceptance with provenance on mission, wave and slice pages at narrow widths", () => {
    const fixture = executionFixture();
    fixture.planning_guidance = [
      { label: "Integration decision", text: "Alpha core accepted; full contract remains open.", source: "/work/mission.yaml#arrangement.source.rule" },
      { label: "Admission", text: "Implement alpha before beta; investigation may overlap.", source: "/work/mission.yaml#arrangement.waves[0].admission", wave: "active-parallel" },
      { label: "Review", text: "Independent review must precede merge.", source: "/work/mission.yaml#arrangement.waves[0].review", wave: "active-parallel" },
      { label: "Exit", text: "Full contracts still need the cumulative journey.", source: "/work/mission.yaml#arrangement.waves[0].exit", wave: "active-parallel" },
    ];
    const facts = JSON.stringify(fixture);
    for (const width of [58, 120]) for (const key of [null, "group:wave:active-parallel", "slice:OPR.0.5.8.1"]) {
      const lines = executionContentLines(fixture, executionScopes(), [], key, width);
      const body = text(lines).replace(/\s+/g, " ");
      expect(body).toContain("Authored guidance");
      expect(body).toContain("Alpha core accepted; full contract remains open.");
      if (key) {
        expect(body).toContain("Implement alpha before beta; investigation may overlap.");
        expect(body).toContain("Full contracts still need the cumulative journey.");
      } else expect(executionKeys(lines)).toContain("group:wave:active-parallel");
      expect(body).toContain("/work/mission.yaml");
      if (key?.startsWith("group:")) expect(body).toContain("Independent review must precede merge.");
      // Full guidance wraps rather than disappearing behind a clipped card.
      expect(lines.filter(line => line.text.includes("Alpha core") || line.text.includes("Implement alpha")).every(line => line.text.length <= width)).toBe(true);
    }
    expect(JSON.stringify(fixture)).toBe(facts);
  });

  it("renders the selected JRN-03 mission grammar: glance summary, wave graph, and structured detail cards", () => {
    const overview = executionContentLines(executionFixture(), executionScopes(), [], null, 126);
    const body = text(overview);
    expect(body).toMatch(/NOW\s+/);
    expect(body).toMatch(/NEEDS HUMAN\s+/);
    expect(body).toMatch(/PROGRESS\s+/);
    expect(body).toMatch(/NEXT\s+/);
    expect(body).toMatch(/┌─ .*OPR\.0\.5\.8\.1/);
    expect(body).toContain("After: OPR.0.5.8.3");
    expect(body).toContain("└");
    const firstSlice = overview.find((line) => line.zones?.some((zone) => zone.action.type === "execution-open"));
    expect(firstSlice).toBeDefined();

    const detail = text(executionContentLines(executionFixture(), executionScopes(), [], "slice:OPR.0.5.8.1", 126));
    for (const title of ["OWNERSHIP", "EVIDENCE", "NEEDS YOU", "TYPED ROWS", "DEPENDENCIES"])
      expect(detail).toContain(title);
  });

  it("stacks every mission node at narrow width and leaves overflow to the content scroller", () => {
    const lines = executionContentLines(executionFixture(12), executionScopes(12), [], null, 58);
    const body = text(lines);
    expect(body).toContain("WAVE");
    expect(body).not.toMatch(/\d+ below|\+\d+ more/);
    expect(executionKeys(lines).filter((key) => key.startsWith("slice:"))).toHaveLength(12);
    expect(body.split("\n").every((line) => line.length <= 58)).toBe(true);
  });

  it("REGRESSION (founder journey): all slices declared done + no lanes + no repository must not render WAITING or glyph blobs", () => {
    const { execution, scopes } = installedStateFixture();
    const lines = executionContentLines(execution, scopes, [], null, 110 - 32);
    const body = text(lines);
    expect(body).not.toMatch(/WAITING/);
    expect(body).not.toMatch(GLYPH_BLOB);
    expect(body).not.toMatch(/\bp\d+\/\d+\b/);
    expect(body).not.toContain("@—");
    expect(body).not.toMatch(/\?\?/);
    // declared state is kept and attributed; the evidence gap is one compact mission-level drill
    expect(body).toContain("release-0.5.8 · OUTCOMES OPEN · 20 slices");
    expect(body).toContain("PROGRESS  0/20 outcomes complete · 0 working");
    const gap = lines.find((line) => line.text.includes("evidence gap"))!;
    expect(gap.text).toContain("provenance");
    expect(gap.text).toContain("evidence gap");
    expect(gap.action).toEqual({ type: "execution-open", key: "evidence" });
    expect(body.split("evidence gap").length - 1).toBe(1);
    // every wave header counts declared words, never a work-state verdict the projection did not make
    const headers = lines.filter((l) => l.text.includes("WAVE "));
    expect(headers.length).toBeGreaterThan(0);
    for (const line of headers) expect(line.text).toMatch(/\d+ declared done/);
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
    expect(body).toContain("release-0.5.8 · OUTCOMES OPEN · 4 slices");
    expect(body).toContain("PROGRESS  0/4 outcomes complete · 1 working · 1 waiting");
    expect(body).toContain("WAVE active-parallel · 2 slices · 1 working, 1 needs input");
    expect(body).toContain("WAVE foundation · 1 slice · 1 declared done");
    expect(body).toContain("WAVE next-unlock · 1 slice · 1 declared done");
    for (const id of ["OPR.0.5.8.1", "OPR.0.5.8.2", "OPR.0.5.8.3", "OPR.0.5.8.4"]) {
      expect(body.split(`┌─ ${id}`).length - 1, id).toBe(1);
    }
    expect(body).toContain("● working");
    expect(body).toContain("Owner: dev-1");
    expect(body).toContain("◐ needs input");
    expect(body).toContain("Owner: dev-2");
    expect(body).toContain("○ declared done");
    expect(body).not.toMatch(GLYPH_BLOB);
    expect(executionKeys(lines).filter((key) => key.startsWith("slice:"))).toHaveLength(4);
  });

  it("distinguishes retired and deferred slices from planned in fallback state", () => {
    const fixture = executionFixture();
    fixture.q1_lanes = [];
    const scopes = executionScopes(4, (index) => (index === 0 ? "active" : index === 1 ? "blocked" : "done"));
    // Slice 2 has stage "retired"
    scopes[0]!.slices[1]!.stage = "retired";
    // Slice 3 has status "deferred"
    scopes[0]!.slices[2]!.status = "closed-deferred";

    const overview = text(executionContentLines(fixture, scopes, [], null, 160));
    expect(overview).toContain("○ retired");
    expect(overview).toContain("○ deferred");
    expect(overview).not.toContain("2 planned");
  });

  it("qualifies slice completion while a release workflow is still waiting", () => {
    const fixture = executionFixture();
    fixture.q1_lanes = [];
    fixture.lifecycle_instances = [{ instance_id: "WF", status: "waiting", frontier_packets: [] }];
    const body = text(executionContentLines(fixture, executionScopes(4, () => "done"), [], null, 160));
    expect(body).toContain("Slices: OUTCOMES OPEN");
    expect(body).toContain("Mission lifecycle · waiting");
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
    const overview = text(executionContentLines(fixture, executionScopes(), [], null, 200));
    expect(overview).toContain("WORKFLOWS");
    expect(overview).toContain("left · in-progress · left@rig");
    expect(overview).toContain("right · blocked · right@rig");
    expect(overview).not.toContain("--current-packet");
    const body = text(executionContentLines(fixture, executionScopes(), [], "workflow:WF-LIFE", 200));
    expect(body).toContain("fixture red");
    expect(body).toContain("--occurrence Q-FAILED");
    expect(body).toContain("frontier packet Q-GHOST has no queue row");
    const work = text(executionContentLines(fixture, executionScopes(), [], "packet:Q-RIGHT", 200));
    expect(work).toContain("gate-2");
    expect(work).toContain("--current-packet Q-RIGHT");
  });

  it("shows the named project boundary and missing receipts before their frontier arrives", () => {
    const fixture = executionFixture();
    fixture.lifecycle_instances = [{ instance_id: "WF-PROFILE", status: "active", operation_key: "release",
      graph_source: { mode: "project-profile", profileSource: "/project.yaml#lifecycle.profiles.release" },
      boundary_obligations: [
        { stepId: "exact-cut-substance", required: true, state: "pending", receiptState: "missing", receipt: null },
        { stepId: "record-shipped", required: true, state: "closed", receiptState: "recorded", receipt: { evidenceRef: "proof/ship.md", actorSession: "orch@rig" } },
      ],
    }];
    const body = text(executionContentLines(fixture, executionScopes(), [], "workflow:WF-PROFILE", 120));
    expect(body).toContain("project-profile");
    expect(body).toContain("exact cut substance · required · pending · receipt missing");
    expect(body).toContain("record shipped · required · closed · receipt recorded");
    expect(body).toContain("proof/ship.md");
    expect(body).toContain("orch@rig");
    expect(body).toContain("does not establish acceptance");
  });

  it("keeps a typed acceptance action usable at every production terminal width", () => {
    const fixture = executionFixture();
    const candidate = "0123456789abcdef0123456789abcdef01234567";
    const evidence = "missions/release-0.5.9/slices/06-project-release-lifecycle/proof/review50-r2-CLEAR-27354de779a9a7d4311b910e56115df33d26295e.md";
    fixture.lifecycle_instances = [{
      instance_id: "WF-ACCEPTANCE",
      status: "active",
      operation_key: "release-acceptance",
      frontier_packets: [{
        packet_id: "qitem-acceptance-packet",
        step_id: "accept",
        owner: "review50-r2@v-openrig-build",
        queue_state: "in-progress",
        blocked_on: null,
        targeted_action: `rig workflow project --instance WF-ACCEPTANCE --current-packet qitem-acceptance-packet --exit done --actor-session review50-r2@v-openrig-build --acceptance-candidate '${candidate}' --acceptance-verdict 'CLEAR' --acceptance-evidence-ref '${evidence}'`,
      }],
      failure_occurrences: [],
      unknowns: [],
    }];
    const snap = {
      ...demoSnapshot(),
      scopes: executionScopes(),
      execution: fixture,
      executionMission: fixture.mission,
      hydratedAt: "2026-09-03T20:00:00.000Z",
    };
    for (const size of [{ cols: 84, rows: 28 }, { cols: 120, rows: 34 }, { cols: 160, rows: 42 }]) {
      const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
      view.dispatch(parseCommand(":scopes"));
      view.dispatch({ type: "scopes-mission-open", mission: fixture.mission });
      view.dispatch({ type: "execution-open", key: "packet:qitem-acceptance-packet" });

      let screen = renderScreen(view.get(), snap, size);
      view.dispatch({ type: "layout", contentMaxOffset: screen.contentMaxOffset, contentTargetCount: screen.contentTargets.length });
      let action: string | null = null;
      for (let offset = 0; offset <= screen.contentMaxOffset && action == null; offset++) {
        expect(screen.lines.every((line) => line.length <= size.cols), `${size.cols}x${size.rows}`).toBe(true);
        const content = screen.lines.map((line) => line.slice(screen.explorerWidth + 2).trimEnd());
        let cursor = content.findIndex((line) => line.trimStart().startsWith("action rig workflow project"));
        if (cursor >= 0) {
          let candidate = content[cursor]!.replace(/^\s*action /, "");
          while (candidate.endsWith("\\") && cursor + 1 < content.length && !content[cursor + 1]!.trimStart().startsWith("scroll ")) {
            candidate += `\n${content[++cursor]!}`;
          }
          if (!candidate.endsWith("\\")) action = candidate;
        }
        if (action == null && offset < screen.contentMaxOffset) {
          view.dispatch({ type: "content-scroll", delta: 1 });
          screen = renderScreen(view.get(), snap, size);
        }
      }
      expect(action, `${size.cols}x${size.rows}: complete action is scroll-reachable`).not.toBeNull();
      const argv = execFileSync("/bin/sh", ["-c", `set -- ${action}\nprintf '%s\\0' "$@"`])
        .toString()
        .split("\0")
        .filter(Boolean);
      expect(argv, `${size.cols}x${size.rows}`).toEqual([
        "rig", "workflow", "project",
        "--instance", "WF-ACCEPTANCE",
        "--current-packet", "qitem-acceptance-packet",
        "--exit", "done",
        "--actor-session", "review50-r2@v-openrig-build",
        "--acceptance-candidate", candidate,
        "--acceptance-verdict", "CLEAR",
        "--acceptance-evidence-ref", evidence,
      ]);
      expect(action, `${size.cols}x${size.rows}`).not.toContain("…");
    }
  });

  it("keeps terminal failure history visible without rendering an impossible resume command", () => {
    const fixture = executionFixture();
    fixture.lifecycle_instances = [{
      instance_id: "WF-ABORTED",
      status: "aborted",
      operation_key: "release-op",
      frontier_packets: [],
      failure_occurrences: [
        { occurrence_id: "Q-FAILED", step_id: "build", status: "unresolved", failure_reason: "historical failure", targeted_action: null },
      ],
      unknowns: [],
    }];
    const body = text(executionContentLines(fixture, executionScopes(), [], "workflow:WF-ABORTED", 200));
    expect(body).toContain("aborted");
    expect(body).toContain("Q-FAILED");
    expect(body).toContain("historical failure");
    expect(body).not.toContain("rig workflow resume");
  });

  it("keeps every graph drill affordance in bounds at 110 and 160 columns", () => {
    for (const width of [110 - 32, 160 - 32]) {
      const lines = executionContentLines(executionFixture(), executionScopes(), [], null, width);
      const drillable = lines.filter((line) => line.action);
      expect(executionKeys(lines).length).toBeGreaterThan(4);
      for (const line of drillable) {
        expect(line.text.endsWith("(open ▸)")).toBe(true);
        expect(line.text.length).toBeLessThanOrEqual(width);
      }
      for (const line of lines) for (const zone of line.zones ?? []) {
        expect(zone.start).toBeGreaterThanOrEqual(0);
        expect(zone.end).toBeLessThanOrEqual(width);
      }
    }
    const narrow = text(executionContentLines(executionFixture(), executionScopes(), [], null, 110 - 32));
    expect(narrow).toContain("● working");
    expect(narrow).toContain("Owner: dev-1");
    expect(narrow).toContain("◐ needs input");
    expect(narrow).toContain("Owner: dev-2");
    expect(narrow).toContain("evidence gap");
  });

  it("renders structured blockers as words with the blocker first and never [object Object]", () => {
    const fixture = executionFixture();
    const blocked = fixture.q2_sequencing[3]!;
    blocked["next_up"] = false;
    blocked["next_up_basis"] = "blocked rows present (qitem-20260902074725-404326e1)";
    blocked["blocked_on_rows"] = [{ qitem_id: "qitem-20260902074725-404326e1", blocked_on: "qitem-20260902074704-b1a445fa" }];
    const body = text(executionContentLines(fixture, executionScopes(), [], null, 160));
    expect(body).toContain("NEEDS HUMAN OPR.0.5.8.2");
    expect(body).not.toContain("NEEDS HUMAN OPR.0.5.8.2, OPR.0.5.8.4");
    expect(body).toContain("blocked");
    expect(body).toContain("WAVE next-unlock · 1 slice · 1 blocked");
    expect(body).not.toContain("[object Object]");
    const page = text(executionContentLines(fixture, [], [], "slice:OPR.0.5.8.4", 160));
    expect(page).toContain("blocked on:   qitem-20260902074725-404326e1 waits on qitem-20260902074704-b1a445fa");
  });

  it("keeps every slice in a large wave directly selectable without an omission door", () => {
    const fixture = executionFixture(14);
    const overview = executionContentLines(fixture, executionScopes(14), [], null, 160);
    expect(text(overview)).not.toMatch(/\+\d+ more|\d+ below|open all \d+ rows/);
    expect(executionKeys(overview).filter((key) => key.startsWith("slice:"))).toHaveLength(14);
    const page = executionContentLines(fixture, executionScopes(14), [], "group:wave:active-parallel", 160);
    expect(text(page)).toContain("wave active-parallel · all 12 rows");
    expect(text(page)).not.toMatch(/\+\d+ more/);
    expect(executionKeys(page).filter((key) => key.startsWith("slice:"))).toHaveLength(12);
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
    expect(body).toContain("OPR.0.5.8.3 · Slice 03 — Readable Name 3");
    expect(body).toContain("EVIDENCE · declared done · merged");
    expect(body).toContain("built:        fold00000");
    expect(body).toContain("merged:       yes · git merge-base");
    expect(body).toContain("live:         no · daemon build stamp differs");
    expect(body).toContain("review leg:   CLEAR · rev1-r2 · /proof/review.md");
    expect(body).toContain("next:         no next transition derived");
    expect(body).toContain("spec:         /work/OPR.0.5.8.3/SPEC.md");
    expect(body).toContain("DEPENDENCIES");
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
    expect(body).toContain("release-0.5.8 · OUTCOMES OPEN");
    expect(body).toContain("evidence gap");
    expect(body).not.toMatch(GLYPH_BLOB);
    expect(body).not.toContain("WAITING");
    const target = screen.contentTargets.find((t) => t.action.type === "execution-open" && t.action.key === "slice:OPR.0.5.8.1")!;
    view.dispatch(target.action);
    screen = renderScreen(view.get(), snap, { cols: 110, rows: 40 });
    body = screen.lines.join("\n");
    expect(body).toContain("01-slice · OPR.0.5.8.1 · release-0.5.8");
    expect(body).toContain("OWNERSHIP");
    expect(body).toContain("EVIDENCE · declared active");
    const reachable = [body];
    view.dispatch({ type: "layout", contentMaxOffset: screen.contentMaxOffset, contentTargetCount: screen.contentTargets.length });
    while (view.get().contentOffset < screen.contentMaxOffset) {
      view.dispatch({ type: "content-scroll", delta: 16 });
      screen = renderScreen(view.get(), snap, { cols: 110, rows: 40 });
      reachable.push(screen.lines.join("\n"));
    }
    body = reachable.join("\n");
    expect(body).toContain("── INTENT ");
    expect(body).toContain("── PROOF · 4/4 paired");
    expect(body).toContain("TYPED ROWS");
    view.dispatch({ type: "scopes-mission-open", mission: "release-0.5.8" });
    screen = renderScreen(view.get(), snap, { cols: 110, rows: 40 });
    const gap = screen.contentTargets.find((t) => (t.action as { key?: string }).key === "evidence")!;
    view.dispatch(gap.action);
    screen = renderScreen(view.get(), snap, { cols: 110, rows: 40 });
    expect(screen.lines.join("\n")).toContain("evidence gap · derived");
    view.dispatch({ type: "execution-close" });
    screen = renderScreen(view.get(), snap, { cols: 110, rows: 40 });
    expect(screen.lines.join("\n")).toContain("WAVE active-parallel");
    expect(view.get().executionOpen).toBeNull();
  });
});


describe("attributed proof provenance in the ordinary execution path", () => {
  function judged(kind = "artifact", state = "accepted") {
    const execution = executionFixture(1);
    execution.q1_lanes = [];
    execution.q4_ladder[0]!["built"] = { candidate_sha: "INDETERMINATE", basis: "no candidate:* tag on any row bound to this slice" };
    execution.readiness = {
      revision: "mission-revision", state: state === "accepted" ? "ready" : "unknown",
      slices: [{ scope: "01-slice", readiness: {
        configured: true, revision: "proof-revision", state: state === "accepted" ? "ready" : "unknown",
        issues: [], history: [{ ref: "proof/judgments/00000001.md", id: "receipt-1", verdict: "accept", previous: null }],
        items: [{ id: "item-1", index: 1, text: "An attributed outcome", state,
          reason: state === "unknown" ? "Evidence missing or changed; inspect the retained judgment" : "Observed outcome",
          judgment: { id: "receipt-1", actor: "judge@rig", at: "2026-09-09T05:00:00Z", verdict: "accept", previous: null,
            subject: { kind, ref: "outcome.md", ...(kind === "patch-equivalent" ? { comparison: "comparison.md" } : {}) },
            evidence: [{ ref: "outcome.md", sha256: "a".repeat(64) }] },
        }],
      } }],
    } as NonNullable<typeof execution.readiness>;
    return execution;
  }

  it.each(["artifact", "patch-equivalent", "commit"])("shows %s judgment from the execution revision without inventing code lineage", kind => {
    const execution = judged(kind);
    const overview = executionContentLines(execution, undefined, [], null, 100);
    expect(overview.find(line => line.text.includes("provenance"))?.action).toEqual({ type: "execution-open", key: "evidence" });
    expect(text(overview)).not.toContain("evidence gap 1/1 unknown");
    const page = text(executionContentLines(execution, undefined, [], "evidence", 100));
    for (const value of ["proof-revision", "ACCEPTED", kind, "outcome.md", "judge@rig", "receipt-1", "a".repeat(64)]) expect(page).toContain(value);
    if (kind === "patch-equivalent") expect(page).toContain("comparison.md");
    const slice = text(executionContentLines(execution, undefined, [], "slice:OPR.0.5.8.1", 100));
    expect(slice).toContain("ACCEPTED");
    expect(slice).toContain("judge@rig");
    expect(slice).toContain("CODE LINEAGE");
    expect(slice).toContain("undetermined");
    expect(text(executionSliceStripLines(execution, "OPR.0.5.8.1", "01-slice", 100))).toContain("proof ready");
  });

  it.each(["withdrawn", "rejected", "unknown"])("keeps %s disposition and retained receipt distinct from current acceptance", state => {
    const execution = judged("artifact", state);
    const body = text(executionContentLines(execution, undefined, [], "evidence", 100));
    expect(body).toContain(state.toUpperCase());
    expect(body).toContain("receipt-1");
    expect(body).not.toContain("ACCEPTED");
    if (state === "unknown") expect(body).toContain("Evidence missing or changed");
  });

  it("keeps configured missing judgments, invalid journals and legacy code gaps visible", () => {
    const execution = judged();
    const proof = execution.readiness!.slices[0]!.readiness;
    proof.items = []; proof.state = "unknown";
    (proof as typeof proof & { issues: string[] }).issues = ["journal_invalid: malformed or changed judgment"];
    const page = text(executionContentLines(execution, undefined, [], "evidence", 100));
    expect(page).toContain("journal_invalid");
    expect(page).toContain("UNKNOWN");
    delete execution.readiness;
    expect(text(executionContentLines(execution, undefined, [], "evidence", 100))).toContain("built unconfirmed");
  });
});


describe("slice source provenance", () => {
  it("reports the authoritative arrangement when it supersedes the legacy wave map", () => {
    const fixture = executionFixture();
    fixture.sources.wave_map = { row_id: "INDETERMINATE", superseded_by: "/work/mission.yaml + referenced slice.yaml files" };
    const body = text(executionContentLines(fixture, executionScopes(), [], "slice:OPR.0.5.8.1", 160));
    expect(body).toContain("wave map:     superseded by /work/mission.yaml");
    expect(body).not.toContain("wave map:     INDETERMINATE");
  });

  it("preserves the legacy row when no superseding source is served", () => {
    const fixture = executionFixture();
    fixture.q2_sequencing[0]!.source = { wave_map_row: "qitem-wave-map" };
    const body = text(executionContentLines(fixture, executionScopes(), [], "slice:OPR.0.5.8.1", 160));
    expect(body).toContain("wave map:     qitem-wave-map");
    expect(body).not.toContain("superseded by");
  });
});
