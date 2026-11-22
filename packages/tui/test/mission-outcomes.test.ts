import { expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { readMissionReadiness, readSliceReadiness, recordJudgment } from "../../daemon/src/domain/proof/judgments.js";
import { executionContentLines, type ExecutionViewSnap } from "../src/execution/execution-model.js";
import { demoSnapshot } from "../src/demo-data.js";
import { createViewState } from "../src/state.js";
import { renderScreen } from "../src/render.js";

it.each([[140, 42], [80, 24]])("native judgments drive outcomes, queue drives work, and first-screen boxes survive at %ix%i", (cols, rows) => {
  const root = mkdtempSync(join(tmpdir(), "ux-outcomes-"));
  const missions = join(root, "missions"), mission = join(missions, "trial");
  const write = (file: string, value: unknown) => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, typeof value === "string" ? value : YAML.stringify(value)); };
  write(join(root, "project.yaml"), { kind: "project", metadata: { id: "trial" }, proofPolicy: { judges: ["judge@fixture"] }, missions: { root: "missions" } });
  write(join(mission, "mission.yaml"), { kind: "mission", metadata: { name: "trial", status: "active" }, composition: { slices: ["one", "two"].map((id, i) => ({ ref: `slices/${id}/slice.yaml`, order: i, active: true })) } });
  for (const id of ["one", "two"]) {
    write(join(mission, "slices", id, "slice.yaml"), { kind: "slice", metadata: { id }, execution: { depends_on: id === "two" ? ["one"] : [] } });
    write(join(mission, "slices", id, "SPEC.md"), `---\nid: ${id}\nstatus: done\n---\n# ${id}\n\n## Proof contract\n- [x] Verify ${id}.\n`);
    write(join(mission, "slices", id, "proof/evidence.md"), "Measured fixture evidence\n");
  }
  const original = readFileSync(join(mission, "mission.yaml"), "utf8");
  const snap = demoSnapshot();
  const template = snap.scopes![0]!.slices[0]!;
  snap.scopes = [{ mission: "trial", slices: ["one", "two"].map(id => ({ ...template, id, dirName: id, displayName: `Useful outcome ${id}`, status: "active", proof: { total: 1, paired: 1 } })) }];
  const execution: ExecutionViewSnap = { view: "execution", mission: "trial", sources: {}, q1_lanes: [], q2_sequencing: ["one", "two"].map(id => ({ slice_id: id, dir: id, depends_on: id === "two" ? ["one"] : [], work_rows: [], planned_owners: [{ component: "build.minimal-gap", owner: "planned@fixture", source: "slice.yaml#sdlc" }] })), q3_care: ["one", "two"].map(id => ({ slice_id: id, build_wave: "correction" })), q4_ladder: ["one", "two"].map(id => ({ slice_id: id, dir: id, folded: { value: true } })), q5_park: [], planning_guidance: [{ label: "Integration decision", text: "LONG PROCESS PROSE ".repeat(30), source: "mission.yaml" }] };
  const view = createViewState({ instanceId: "outcomes", getSnapshot: () => snap });
  view.dispatch({ type: "jump", section: "scopes" }); view.dispatch({ type: "scopes-mission-open", mission: "trial" });
  const body = () => {
    execution.readiness = readMissionReadiness(mission); snap.execution = execution;
    return executionContentLines(execution, snap.scopes, [], null, cols - 32).map(line => line.text).join("\n");
  };
  const judge = (id: string, verdict: "accept" | "withdraw") => {
    const item = readSliceReadiness(join(mission, "slices", id)).items[0]!;
    recordJudgment(missions, { scope: `trial/slices/${id}`, item: item.id, verdict, reason: "Fixture judgment", evidence: ["proof/evidence.md"], expectedRevision: item.revision, expectedPrevious: item.judgment?.id ?? null }, "judge@fixture", "transport:v1");
  };
  try {
    execution.q2_sequencing[0]!.next_up = true;
    expect(body()).toContain("OUTCOMES OPEN"); expect(body()).toContain("Planned: planned");
    expect(body()).toContain("NEXT      one · ready to start");
    expect(body()).not.toContain("OUTCOMES COMPLETE"); // checked evidence + folded code do not accept an outcome
    expect(execution.readiness).toMatchObject({ state: "not-ready", activeSlices: 2 });
    expect(body()).not.toContain("no active slice"); // active work that isn't ready keeps its reading
    execution.q1_lanes = [{ slice: "one", seat: "actual@fixture", qitem_id: "q1", activity: { activity: "working" } }];
    execution.q2_sequencing[0]!.work_rows = [{ qitem_id: "q1", seat: "actual@fixture", state: "in-progress", summary: "Build readable mission overview" }];
    expect(body()).toContain("Owner: actual"); expect(body()).toContain("working");
    execution.q1_lanes[0]!.activity = { activity: "idle-at-prompt" };
    expect(body()).toContain("assigned"); expect(body()).not.toContain("1 working");
    execution.q2_sequencing[0]!.blocked_on_rows = [{ qitem_id: "q1", blocked_on: "review@fixture" }];
    expect(body()).toContain("blocked"); expect(body()).toContain("waits on review@fixture");
    execution.q1_lanes = []; execution.q2_sequencing[0]!.work_rows = []; execution.q2_sequencing[0]!.blocked_on_rows = [];
    expect(body()).not.toContain("OUTCOMES COMPLETE"); // handoff alone is not outcome acceptance
    judge("one", "accept"); judge("two", "accept");
    expect(body()).toContain("OUTCOMES COMPLETE"); expect(body()).toContain("active · separate from outcomes");
    expect(body()).toContain("NEXT      outcomes complete; release");
    expect(body()).toContain("PROGRESS  2/2 outcomes complete");
    judge("one", "withdraw"); expect(body()).toContain("OUTCOMES OPEN"); expect(body()).toContain("reopened");
    execution.q2_sequencing[0]!.work_rows = [{ qitem_id: "reopened", seat: "actual@fixture", state: "in-progress", summary: "Correct reopened outcome" }];
    expect(body()).toContain("NOW       one · actual · assigned");
    expect(body()).toContain("NEXT      await current work; outcomes remain");
    expect(body()).toContain("PROGRESS  1/2 outcomes complete");
    expect(body()).toContain("OUTCOMES OPEN");
    execution.q2_sequencing[0]!.blocked_on_rows = [{ qitem_id: "reopened", blocked_on: "review@fixture" }];
    expect(body()).toContain("NOW       one · actual · blocked");
    expect(body()).toContain("waits on review@fixture");
    expect(body()).toContain("NEXT      await current work; outcomes remain");
    execution.q2_sequencing[0]!.blocked_on_rows = [];
    const screen = renderScreen(view.get(), snap, { cols, rows });
    const text = screen.lines.join("\n");
    expect(text).toContain("┌"); expect(text).toContain("└"); expect(text).toContain("After:");
    const prose = text.indexOf("LONG PROCESS PROSE");
    if (prose >= 0) expect(text.indexOf("└")).toBeLessThan(prose);
    expect(screen.contentTargets.some(t => t.action.type === "execution-open" && t.action.key === "slice:one")).toBe(true);
    expect(readFileSync(join(mission, "mission.yaml"), "utf8")).toBe(original);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it.each(["empty", "unknown-assigned", "unknown-unassigned"])("does not infer complete outcomes from %s data", kind => {
  const empty = kind === "empty", assigned = kind === "unknown-assigned";
  const execution: ExecutionViewSnap = {
    view: "execution", mission: "trial", sources: {}, q1_lanes: [], q5_park: [],
    q2_sequencing: empty ? [] : [{ slice_id: "one", next_up: "INDETERMINATE", work_rows: assigned ? [{ seat: "actual@fixture", state: "in-progress" }] : [] }],
    q4_ladder: empty ? [] : [{ slice_id: "one" }],
  };
  const text = executionContentLines(execution, undefined, [], null, 120).map(line => line.text).join("\n");
  expect(text).toContain("OUTCOMES OPEN");
  expect(text).toContain(`PROGRESS  0/${empty ? 0 : 1} outcomes complete`);
  expect(text).toContain("LIFECYCLE unknown · separate from outcomes");
  expect(text).toContain(assigned ? "NOW       one · actual · assigned" : "NOW       no open slice work in this read");
  expect(text).toContain(empty ? "NEXT      next eligibility unknown" : assigned ? "NEXT      await current work; outcomes remain open" : "NEXT      one · dependency eligibility unknown");
  if (!empty) expect(text).toContain("1 proof unknown");
});

it("names a mission with no active slice instead of leaving it to read as open work (#3614)", () => {
  const root = mkdtempSync(join(tmpdir(), "ux-no-active-"));
  const mission = join(root, "missions", "trial");
  const write = (file: string, value: unknown) => { mkdirSync(join(file, ".."), { recursive: true }); writeFileSync(file, typeof value === "string" ? value : YAML.stringify(value)); };
  const composition = (active: boolean) => write(join(mission, "mission.yaml"), { kind: "mission", metadata: { name: "trial", status: "complete" }, composition: { slices: [{ ref: "slices/one/slice.yaml", order: 1, active }] } });
  write(join(mission, "slices", "one", "slice.yaml"), { kind: "slice", metadata: { id: "one" }, execution: { depends_on: [] } });
  write(join(mission, "slices", "one", "SPEC.md"), "---\nid: one\nstatus: done\n---\n# one\n\n## Proof contract\n- [x] Verify one.\n");
  const execution: ExecutionViewSnap = { view: "execution", mission: "trial", sources: {}, q1_lanes: [], q2_sequencing: [], q4_ladder: [], q5_park: [] };
  const text = () => { execution.readiness = readMissionReadiness(mission); return executionContentLines(execution, undefined, [], null, 120).map(line => line.text).join("\n"); };
  const line = "ACTIVE    no active slice in mission.yaml · nothing is being judged";
  try {
    composition(false);
    expect(execution.readiness = readMissionReadiness(mission)).toMatchObject({ state: "not-ready", activeSlices: 0 });
    expect(text()).toContain(line);
    expect(text()).toContain("LIFECYCLE complete · separate from outcomes");
    composition(true);
    expect(text()).not.toContain("no active slice");
    rmSync(join(mission, "mission.yaml"));
    expect(text()).not.toContain("no active slice"); // legacy keeps its own reading
  } finally { rmSync(root, { recursive: true, force: true }); }
});
