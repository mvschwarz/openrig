// S27 (OPR.0.5.6.27) — execution-view proof fixtures, RED-first.
//
// RED at base: every test below fails with ViewProjectorError view_not_found —
// "view 'execution' is not registered" — because the view does not exist at base
// (the proof contract's pinned reason). GREEN lands the built-in view.
//
// The fixture models the contract's acceptance shape: two lanes (one EC-3 baton
// carrying worktree_path=<real tmp git worktree>, one legacy baton without),
// one parked row with an armed wake, one candidate built-but-unfolded /
// folded-but-unadopted distinction via a real tmp git repo, a wave-map-v1 data
// row, and slice frontmatter carrying EC-1 depends_on + approved-spec-dial.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { queueTransitionWakesSchema } from "../src/db/migrations/073_queue_transition_wakes.js";
import { viewsCustomSchema } from "../src/db/migrations/030_views_custom.js";
import { EventBus } from "../src/domain/event-bus.js";
import { buildExecutionView, type ExecutionViewDeps } from "../src/domain/execution-view.js";
import { ViewProjector, ViewProjectorError } from "../src/domain/view-projector.js";
import { Hono } from "hono";
import { viewsRoutes } from "../src/routes/views.js";

const MISSION = "release-9.9";
const SEAT_A = "builder-a@exec-fixture";
const SEAT_B = "builder-b@exec-fixture";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function writeSpec(root: string, dir: string, frontmatter: string, body: string): string {
  const d = path.join(root, MISSION, "slices", dir);
  fs.mkdirSync(d, { recursive: true });
  const p = path.join(d, "SPEC.md");
  fs.writeFileSync(p, `---\n${frontmatter}\n---\n\n${body}\n`);
  return p;
}

describe("execution view — S27 (OPR.0.5.6.27)", () => {
  let db: Database.Database;
  let projector: ViewProjector;
  let tmp: string;
  let missionsRoot: string;
  let rigsRoot: string;
  let repoDir: string;
  let laneWorktree: string;
  let candidateSha: string;
  let branchName: string;
  let fixedNow: Date;
  // THE one activity oracle (S19's locked contract): SeatActivityService's
  // arbitrated seat-keyed read, faked per session. Q1/Q6 consume THIS — never
  // sessions.status and never the parallel AgentActivityStore ingest.
  let arbitratedBySession: Map<
    string,
    { activity: "working" | "idle-at-prompt" | "unknown"; needsInput: { count: number; reason: string | null }; decidedBy: string | null; changedAt: string }
  >;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "exec-view-"));
    missionsRoot = path.join(tmp, "missions");
    rigsRoot = path.join(tmp, "rigs");
    fixedNow = new Date("2026-08-29T22:00:00.000Z");

    // ---- tmp git repo: candidate = first commit (ancestor of main tip) ----
    repoDir = path.join(tmp, "repo");
    fs.mkdirSync(repoDir);
    git(repoDir, "init", "-q", "-b", "main");
    git(repoDir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "base");
    candidateSha = git(repoDir, "rev-parse", "HEAD");
    git(repoDir, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "tip");
    branchName = "lane-31";
    laneWorktree = path.join(tmp, "wt-lane31");
    git(repoDir, "worktree", "add", "-q", "-b", branchName, laneWorktree, "HEAD");

    // ---- slice fixtures (EC-1 fields present; 33 deliberately lacks them) ----
    writeSpec(
      missionsRoot,
      "31-alpha",
      [
        "id: OPR.9.9.31",
        "slice: 31-alpha",
        `mission: ${MISSION}`,
        "approved-spec-at: 2026-08-29T00:00:00.000Z",
        "approved-spec-by: desk@exec-fixture",
        "approved-spec-dial: P1",
        "depends_on: []",
      ].join("\n"),
      "## Intent\nalpha\n\n## Territory\nWRITES: x.\n",
    );
    writeSpec(
      missionsRoot,
      "32-beta",
      [
        "id: OPR.9.9.32",
        "slice: 32-beta",
        `mission: ${MISSION}`,
        "approved-spec-at: 2026-08-29T00:00:00.000Z",
        "approved-spec-dial: P2",
        'depends_on: ["OPR.9.9.31"]',
      ].join("\n"),
      "## Intent\nbeta\n\n## Territory\nWRITES: y.\n\nSOFT-AFTER: [OPR.9.9.31] — serialization fixture\n",
    );
    writeSpec(
      missionsRoot,
      "33-gamma",
      ["id: OPR.9.9.33", "slice: 33-gamma", `mission: ${MISSION}`].join("\n"),
      "## Intent\ngamma (no EC-1 fields — the INDETERMINATE arm)\n",
    );
    const missionDir = path.join(missionsRoot, MISSION);
    fs.writeFileSync(
      path.join(missionDir, "SPEC.md"),
      "---\nid: OPR.9.9\nmission: release-9.9\n---\n\n# Fixture mission\n",
    );
    fs.writeFileSync(path.join(missionDir, "mission.yaml"), [
      "schema: openrig.mission/v0alpha1",
      "kind: mission",
      "composition:",
      "  slices:",
      "    - { ref: slices/31-alpha/slice.yaml, order: 10, active: true }",
      "    - { ref: slices/32-beta/slice.yaml, order: 20, active: true }",
      "arrangement:",
      "  waves:",
      "    - id: WA",
      "      lanes:",
      "        dev: [OPR.9.9.31, OPR.9.9.32]",
      "      review_model: author-excluded-r1-r2-wave",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(missionDir, "slices", "31-alpha", "slice.yaml"), [
      "schema: openrig.slice/v0alpha1",
      "kind: slice",
      "execution:",
      "  wave: WA",
      "  depends_on: []",
      "",
    ].join("\n"));
    fs.writeFileSync(path.join(missionDir, "slices", "32-beta", "slice.yaml"), [
      "schema: openrig.slice/v0alpha1",
      "kind: slice",
      "execution:",
      "  wave: WA",
      "  depends_on: [OPR.9.9.31]",
      "",
    ].join("\n"));

    // ---- review-artifact registry fixture for slice 31 ----
    const reviewDir = path.join(rigsRoot, "exec-fixture", "state", "review-fixture");
    fs.mkdirSync(reviewDir, { recursive: true });
    fs.writeFileSync(
      path.join(reviewDir, "S31-verdict.md"),
      `---\nslice: 31-alpha\nartifact_type: rev1-r2\nverdict: CLEAR\ncandidate_sha: ${candidateSha}\n---\nCLEAR at fixture.\n`,
    );

    // ---- db ----
    db = createDb();
    migrate(db, [
      coreSchema,
      bindingsSessionsSchema,
      eventsSchema,
      queueItemsSchema,
      queueItemSummarySchema,
      queueTransitionsSchema,
      queueTransitionWakesSchema,
      viewsCustomSchema,
    ]);
    const bus = new EventBus(db);
    projector = new ViewProjector(db, bus);
    arbitratedBySession = new Map([
      [SEAT_A, { activity: "working", needsInput: { count: 0, reason: null }, decidedBy: "self-report", changedAt: "2026-08-29T21:59:00.000Z" }],
      [SEAT_B, { activity: "working", needsInput: { count: 0, reason: null }, decidedBy: "lifecycle-hooks", changedAt: "2026-08-29T21:59:00.000Z" }],
    ]);
    // Optional-call: at base the method does not exist — the RED then lands on
    // show("execution") with the pinned view_not_found, not on wiring.
    (projector as unknown as { setExecutionDeps?: (d: unknown) => void }).setExecutionDeps?.({
      db,
      slicesRoot: () => missionsRoot,
      rigsRoot: () => rigsRoot,
      buildInfo: { semver: null, commit: null, dirty: null, builtAt: null },
      now: () => fixedNow,
      seatActivity: {
        getSeatStateBySession: (sessionName: string) => arbitratedBySession.get(sessionName) ?? null,
      },
    });

    const insertRow = db.prepare(
      `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session,
                                state, priority, tier, tags, body, claimed_at, last_heartbeat, blocked_on)
       VALUES (?, ?, ?, ?, ?, ?, 'normal', 'light', ?, ?, ?, NULL, ?)`,
    );
    const t0 = "2026-08-29T21:00:00.000Z";
    // Lane 1 — EC-3 baton: worktree_path field on the body.
    insertRow.run(
      "qitem-lane-31", t0, t0, "lead@exec-fixture", SEAT_A, "in-progress",
      // Production shape: queue candidate tags are commonly ABBREVIATED.
      JSON.stringify([`mission:${MISSION}`, "slice:OPR.9.9.31", `candidate:${candidateSha.slice(0, 9)}`]),
      `Build 31.\nworktree_path=${laneWorktree}\n`, t0, null,
    );
    // Lane 2 — legacy baton: no worktree_path (fragile join).
    insertRow.run(
      "qitem-lane-32", t0, t0, "lead@exec-fixture", SEAT_B, "in-progress",
      JSON.stringify([`mission:${MISSION}`, "slice:OPR.9.9.32"]),
      "Build 32 (legacy baton).", t0, null,
    );
    // Parked row with an armed wake.
    insertRow.run(
      "qitem-parked-33", t0, t0, "lead@exec-fixture", SEAT_B, "blocked",
      JSON.stringify([`mission:${MISSION}`, "slice:OPR.9.9.33"]),
      "Parked on a real blocker.", t0, "qitem-blocker-x",
    );
    db.prepare(
      `INSERT INTO queue_transitions (transition_id, qitem_id, ts, state, transition_note, actor_session)
       VALUES (31001, 'qitem-parked-33', ?, 'blocked', 'parked', 'lead@exec-fixture')`,
    ).run(t0);
    db.prepare(
      `INSERT INTO queue_transition_wakes (transition_id, qitem_id, phase, wake_kind, wake_ref)
       VALUES (31001, 'qitem-parked-33', 'armed', 'timer', 'wake-timer-33')`,
    ).run();
    // Wave map data row (EC-2).
    insertRow.run(
      "qitem-wave-map", t0, t0, "lead@exec-fixture", "lead@exec-fixture", "done",
      JSON.stringify([`mission:${MISSION}`, "wave-map", "format:wave-map-v1"]),
      'Wave map.\n```json\n{"format":"wave-map-v1","mission":"release-9.9","waves":[{"id":"WA","slices":["OPR.9.9.31","OPR.9.9.32"],"serialized_order":["OPR.9.9.31","OPR.9.9.32"],"review_model":"author-excluded-r1-r2-wave"}]}\n```\n',
      null, null,
    );
    // Sessions: both seats present and running (nodes/rigs rows satisfy the FKs).
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('rig-x', 'exec-fixture')`).run();
    const insertNode = db.prepare(`INSERT INTO nodes (id, rig_id, logical_id) VALUES (?, 'rig-x', ?)`);
    insertNode.run("n-a", "builder-a");
    insertNode.run("n-b", "builder-b");
    const insertSession = db.prepare(
      `INSERT INTO sessions (id, node_id, session_name, status, last_seen_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insertSession.run("s-a", "n-a", SEAT_A, "running", t0, t0);
    insertSession.run("s-b", "n-b", SEAT_B, "running", t0, t0);
  });

  afterEach(() => {
    try {
      git(repoDir, "worktree", "remove", "--force", laneWorktree);
    } catch { /* fixture teardown best-effort */ }
    fs.rmSync(tmp, { recursive: true, force: true });
    db.close();
  });

  async function show(): Promise<Record<string, unknown>> {
    const result = await projector.show("execution", { mission: MISSION });
    expect(result.rowCount).toBe(1);
    return result.rows[0] as Record<string, unknown>;
  }

  it("answers the six questions in ONE read over the fixture rig (RED at base: the view does not exist)", async () => {
    const doc = await show();
    expect(doc.view).toBe("execution");
    expect(doc.mission).toBe(MISSION);
    for (const key of ["q1_lanes", "q2_sequencing", "q3_care", "q4_ladder", "q5_park", "q6_parallelism"]) {
      expect(doc, `six-question bar: ${key} present`).toHaveProperty(key);
    }
    const lanes = doc.q1_lanes as Record<string, unknown>[];
    expect(lanes.map((l) => l.slice).sort()).toEqual(["OPR.9.9.31", "OPR.9.9.32"]);
    const q6 = doc.q6_parallelism as Record<string, unknown>;
    expect(q6.lanes_live).toBe(2);
  });

  it("keeps indefinitely supported README-backed missions and slices on the execution board", async () => {
    const missionDir = path.join(missionsRoot, MISSION);
    fs.renameSync(path.join(missionDir, "SPEC.md"), path.join(missionDir, "README.md"));
    for (const slice of ["31-alpha", "32-beta", "33-gamma"]) {
      const dir = path.join(missionDir, "slices", slice);
      fs.renameSync(path.join(dir, "SPEC.md"), path.join(dir, "README.md"));
    }
    // Legacy dot-ID-only queue bindings need the mission README identity.
    db.prepare("UPDATE queue_items SET tags = replace(tags, ?, ?), body = replace(body, ?, ?)")
      .run(MISSION, "OPR.9.9", MISSION, "OPR.9.9");
    const doc = await show();
    const ladder = doc.q4_ladder as Record<string, unknown>[];
    expect(ladder).toHaveLength(3);
    const alpha = ladder.find(slice => slice.slice_id === "OPR.9.9.31")!;
    expect((alpha.locked as Record<string, unknown>).value).toBe(true);
    expect((alpha.built as Record<string, unknown>).resolved_commit).toBe(candidateSha);
    expect(doc.q1_lanes).toHaveLength(2);
  });

  it("prefers current SPEC files when a legacy README is also present", async () => {
    const missionDir = path.join(missionsRoot, MISSION);
    fs.writeFileSync(path.join(missionDir, "README.md"), "---\nid: OTHER.1\n---\nLegacy mission\n");
    fs.writeFileSync(path.join(missionDir, "slices", "31-alpha", "README.md"), "---\nid: OTHER.1.1\n---\nLegacy slice\n");
    const ladder = (await show()).q4_ladder as Record<string, unknown>[];
    expect(ladder.map(slice => slice.slice_id)).toEqual(["OPR.9.9.31", "OPR.9.9.32", "OPR.9.9.33"]);
  });

  it("defaults to the mission with real in-progress work before a newer planned release directory", async () => {
    fs.mkdirSync(path.join(missionsRoot, "release-10.0", "slices"), { recursive: true });
    const result = await projector.show("execution");
    expect((result.rows[0] as Record<string, unknown>).mission).toBe(MISSION);
  });

  it("accepts a unique body-only mission on the active row before the newer-directory fallback", async () => {
    fs.mkdirSync(path.join(missionsRoot, "release-10.0", "slices"), { recursive: true });
    db.prepare(`UPDATE queue_items SET state = 'done' WHERE qitem_id = 'qitem-lane-32'`).run();
    db.prepare(`UPDATE queue_items SET tags = ?, body = ? WHERE qitem_id = 'qitem-lane-31'`).run(
      JSON.stringify(["gate:qa"]),
      `Mission: ${MISSION}\nSlice: OPR.9.9.31\nworktree_path=${laneWorktree}\n`,
    );
    const result = await projector.show("execution");
    const doc = result.rows[0] as Record<string, unknown>;
    expect(doc.mission).toBe(MISSION);
    expect((doc.q1_lanes as Record<string, unknown>[]).map((lane) => lane.slice)).toContain("OPR.9.9.31");
  });

  it("includes a legacy id-form mission-tagged lane when the directory form is selected", async () => {
    db.prepare(`UPDATE queue_items SET tags = ? WHERE qitem_id = 'qitem-lane-31'`).run(
      JSON.stringify(["mission:OPR.9.9", "slice:OPR.9.9.31", `candidate:${candidateSha.slice(0, 9)}`]),
    );
    db.prepare(`UPDATE queue_items SET tags = ? WHERE qitem_id = 'qitem-wave-map'`).run(
      JSON.stringify(["mission:OPR.9.9", "wave-map", "format:wave-map-v1"]),
    );
    const doc = await show();
    expect((doc.q1_lanes as Record<string, unknown>[]).map((lane) => lane.qitem_id)).toContain("qitem-lane-31");
    expect(((doc.sources as Record<string, Record<string, unknown>>).wave_map).row).toBe("qitem-wave-map");
  });

  it("defaults an active legacy id-form mission tag to its canonical mission directory", async () => {
    fs.mkdirSync(path.join(missionsRoot, "release-10.0", "slices"), { recursive: true });
    db.prepare(`UPDATE queue_items SET state = 'done' WHERE qitem_id = 'qitem-lane-32'`).run();
    db.prepare(`UPDATE queue_items SET tags = ? WHERE qitem_id = 'qitem-lane-31'`).run(
      JSON.stringify(["mission:OPR.9.9", "slice:OPR.9.9.31", `candidate:${candidateSha.slice(0, 9)}`]),
    );
    const result = await projector.show("execution");
    const doc = result.rows[0] as Record<string, unknown>;
    expect(doc.mission).toBe(MISSION);
    expect((doc.q1_lanes as Record<string, unknown>[]).map((lane) => lane.qitem_id)).toContain("qitem-lane-31");
  });

  it("carries planned components separately from current queue ownership, including waiting and handoff", async () => {
    const file = path.join(missionsRoot, MISSION, "slices", "31-alpha", "slice.yaml");
    fs.appendFileSync(file, "sdlc:\n  components:\n    - { id: build.minimal-gap, owner: planned@fixture }\n");
    const read = async () => ((await show()).q2_sequencing as Record<string, unknown>[]).find(s => s.slice_id === "OPR.9.9.31")!;
    expect((await read()).planned_owners).toEqual([{ component: "build.minimal-gap", owner: "planned@fixture", source: fs.realpathSync(file) + "#sdlc.components[0].owner" }]);
    expect((await read()).work_rows).toEqual(expect.arrayContaining([expect.objectContaining({ qitem_id: "qitem-lane-31", seat: SEAT_A, state: "in-progress" })]));
    db.prepare("UPDATE queue_items SET state='blocked', blocked_on='external:review' WHERE qitem_id='qitem-lane-31'").run();
    expect((await read()).work_rows).toEqual(expect.arrayContaining([expect.objectContaining({ seat: SEAT_A, state: "blocked", blocked_on: "external:review" })]));
    db.prepare("UPDATE queue_items SET state='handed-off' WHERE qitem_id='qitem-lane-31'").run();
    expect(((await read()).work_rows as Record<string, unknown>[]).some(w => w.qitem_id === "qitem-lane-31")).toBe(false);
    expect((await read()).planned_owners).toHaveLength(1);
  });

  it("EC-3: the worktree_path field is Q1's join key; a legacy baton falls back marked fragile", async () => {
    const doc = await show();
    const lanes = doc.q1_lanes as Record<string, unknown>[];
    const ec3 = lanes.find((l) => l.slice === "OPR.9.9.31")!;
    expect(ec3.worktree_path).toBe(laneWorktree);
    expect(ec3.fragile_join).toBe(false);
    expect(ec3.branch).toBe(branchName);
    expect(ec3.head_sha).toBe(git(laneWorktree, "rev-parse", "HEAD"));
    const legacy = lanes.find((l) => l.slice === "OPR.9.9.32")!;
    expect(legacy.fragile_join).toBe(true);
    expect(legacy.worktree_path).toBe("INDETERMINATE");
    expect(String(legacy.join_basis)).toContain("EC-3 field absent");
  });

  it("EC-2: Q3 derives {build_wave, review_model, planning_dial} from row/frontmatter data alone, citing the wave-map row", async () => {
    const doc = await show();
    const q3 = doc.q3_care as Record<string, unknown>[];
    const s31 = q3.find((s) => s.slice_id === "OPR.9.9.31")!;
    expect(s31.build_wave).toBe("WA");
    expect(s31.review_model).toBe("author-excluded-r1-r2-wave");
    expect(s31.planning_dial).toBe("P1");
    expect((s31.source as Record<string, unknown>).wave_map_row).toBe("qitem-wave-map");
    // The no-data arm floors to INDETERMINATE, never a guess.
    const s33 = q3.find((s) => s.slice_id === "OPR.9.9.33")!;
    expect(s33.build_wave).toBe("INDETERMINATE");
    expect(s33.planning_dial).toBe("INDETERMINATE");
  });

  it("promotes mission/slice YAML ahead of a parity-matched legacy wave map and names the superseded authority", async () => {
    const doc = await show();
    const q2 = doc.q2_sequencing as Record<string, unknown>[];
    expect((q2.find((s) => s.slice_id === "OPR.9.9.31")?.source as Record<string, unknown>).arrangement_path)
      .toContain("31-alpha/slice.yaml");
    expect(q2.find((s) => s.slice_id === "OPR.9.9.32")?.depends_on).toEqual(["OPR.9.9.31"]);
    const q3 = doc.q3_care as Record<string, unknown>[];
    expect(q3.find((s) => s.slice_id === "OPR.9.9.31")?.build_wave).toBe("WA");
    const sources = doc.sources as Record<string, Record<string, unknown>>;
    expect(String(sources.arrangement?.basis)).toContain("mission.yaml");
    expect(String(sources.wave_map?.superseded_by)).toContain("mission.yaml");
    fs.unlinkSync(path.join(missionsRoot, MISSION, "mission.yaml"));
    const legacy = await show();
    const comparableQ2 = (value: Record<string, unknown>) => (value.q2_sequencing as Record<string, unknown>[]).map((item) => ({
      slice_id: item.slice_id,
      depends_on: item.depends_on,
    }));
    const comparableQ3 = (value: Record<string, unknown>) => (value.q3_care as Record<string, unknown>[]).map((item) => ({
      slice_id: item.slice_id,
      build_wave: item.build_wave,
      review_model: item.review_model,
    }));
    expect(comparableQ2(doc)).toEqual(comparableQ2(legacy));
    expect(comparableQ3(doc)).toEqual(comparableQ3(legacy));
  });

  it("returns current authored admission and partial-core guidance without deriving edges or acceptance from prose", async () => {
    const before = await show();
    const manifest = path.join(missionsRoot, MISSION, "mission.yaml");
    fs.appendFileSync(manifest, "  source:\n    rule: Alpha core accepted; full contract remains open.\n");
    fs.writeFileSync(manifest, fs.readFileSync(manifest, "utf8").replace(
      "      review_model: author-excluded-r1-r2-wave",
      "      review_model: author-excluded-r1-r2-wave\n      admission: Investigate beta early; implement alpha first.\n      review: Independently judge changed consequences.\n      exit: Both full contracts need the shared journey.",
    ));
    const current = await show();
    expect(current.planning_guidance).toEqual(expect.arrayContaining([
      { label: "Integration decision", text: "Alpha core accepted; full contract remains open.", source: manifest + "#arrangement.source.rule" },
      { label: "Admission", text: "Investigate beta early; implement alpha first.", source: manifest + "#arrangement.waves[0].admission", wave: "WA" },
    ]));
    for (const key of ["q1_lanes", "q2_sequencing", "q3_care", "q4_ladder", "readiness"])
      expect(current[key]).toEqual(before[key]);
    fs.writeFileSync(manifest, fs.readFileSync(manifest, "utf8").replace("Investigate beta early; implement alpha first.", "Defer beta pending the owning decision."));
    expect(JSON.stringify((await show()).planning_guidance)).toContain("Defer beta pending the owning decision.");
    fs.writeFileSync(manifest, "composition: [invalid");
    expect((await show()).planning_guidance).toEqual([]);
  });

  it("malformed YAML emits one named warning cell and falls back to the legacy arrangement without blanking the view", async () => {
    fs.writeFileSync(path.join(missionsRoot, MISSION, "mission.yaml"), "composition: [not: valid");
    const doc = await show();
    const q3 = doc.q3_care as Record<string, unknown>[];
    expect(q3.find((s) => s.slice_id === "OPR.9.9.31")?.build_wave).toBe("WA");
    expect(doc.q1_lanes).toBeInstanceOf(Array);
    const arrangement = (doc.sources as Record<string, Record<string, unknown>>).arrangement;
    expect(arrangement.value).toBe("INDETERMINATE");
    expect(String(arrangement.basis)).toMatch(/mission\.yaml[\s\S]*fallback/i);
  });

  it("missing optional YAML falls back silently to the legacy arrangement", async () => {
    fs.unlinkSync(path.join(missionsRoot, MISSION, "mission.yaml"));
    const doc = await show();
    const q3 = doc.q3_care as Record<string, unknown>[];
    expect(q3.find((s) => s.slice_id === "OPR.9.9.31")?.build_wave).toBe("WA");
    expect(JSON.stringify(doc.sources)).not.toMatch(/missing mission\.yaml/i);
  });

  it("Q2: EC-1 frontmatter edges + SOFT-AFTER line + blocked rows derive sequencing; absent EC-1 floors INDETERMINATE", async () => {
    const doc = await show();
    const q2 = doc.q2_sequencing as Record<string, unknown>[];
    const s32 = q2.find((s) => s.slice_id === "OPR.9.9.32")!;
    expect(s32.depends_on).toEqual(["OPR.9.9.31"]);
    expect(s32.soft_after).toEqual(["OPR.9.9.31"]);
    const s33 = q2.find((s) => s.slice_id === "OPR.9.9.33")!;
    expect(s33.depends_on).toBe("INDETERMINATE");
    expect(s33.next_up).toBe("INDETERMINATE");
    expect(String(s33.next_up_basis)).toContain("EC-1");
  });

  it("ladder honesty: folded derives from git at read time, adopted floors INDETERMINATE on a dev daemon, and no 'done' boolean exists", async () => {
    const doc = await show();
    const q4 = doc.q4_ladder as Record<string, unknown>[];
    const s31 = q4.find((s) => s.slice_id === "OPR.9.9.31")!;
    expect((s31.locked as Record<string, unknown>).value).toBe(true);
    // The built rung carries the tag's own (abbreviated) token plus the
    // commit-resolved identity.
    expect((s31.built as Record<string, unknown>).candidate_sha).toBe(candidateSha.slice(0, 9));
    expect((s31.built as Record<string, unknown>).resolved_commit).toBe(candidateSha);
    const folded = s31.folded as Record<string, unknown>;
    expect(folded.value).toBe(true);
    expect(String(folded.basis)).toContain("merge-base --is-ancestor");
    const adopted = s31.adopted as Record<string, unknown>;
    expect(adopted.value).toBe("INDETERMINATE");
    expect(String(adopted.basis)).toContain("dev run");
    const reviewed = s31.reviewed as Record<string, unknown>;
    expect(reviewed.value).toBe(true);
    expect((reviewed.legs as Record<string, unknown>[])[0].verdict).toBe("CLEAR");
    // "done" as a single boolean is pinned ABSENT from the schema.
    for (const entry of q4) {
      expect(Object.keys(entry)).not.toContain("done");
    }
  });

  it("Q1 consumes the ARBITRATED seat state (working): the superseded/stale-hook specimen cannot recur", async () => {
    // The HOLD's live specimen: sessions.status superseded + a stale hook in the
    // parallel ingest store, while arbitration says working. Q1 must say working.
    db.prepare(`UPDATE sessions SET status = 'superseded' WHERE session_name = ?`).run(SEAT_A);
    const doc = await show();
    const lane = (doc.q1_lanes as Record<string, unknown>[]).find((l) => l.slice === "OPR.9.9.31")!;
    const act = lane.activity as Record<string, unknown>;
    expect(act.activity).toBe("working");
    expect(String(act.source)).toContain("arbitrated");
    expect(act.decided_by).toBe("self-report");
  });

  it("Q1 passes through idle-at-prompt and unknown as canonical vocabulary, and floors INDETERMINATE only for a never-seen seat", async () => {
    arbitratedBySession.set(SEAT_A, { activity: "idle-at-prompt", needsInput: { count: 0, reason: null }, decidedBy: "window-sampling", changedAt: "2026-08-29T21:59:10.000Z" });
    const idle = await show();
    expect(((idle.q1_lanes as Record<string, unknown>[]).find((l) => l.slice === "OPR.9.9.31")!.activity as Record<string, unknown>).activity).toBe("idle-at-prompt");
    // 'unknown' is a CANONICAL member of the arbitrated vocabulary — passed
    // through as itself, never rewritten to INDETERMINATE.
    arbitratedBySession.set(SEAT_A, { activity: "unknown", needsInput: { count: 0, reason: null }, decidedBy: null, changedAt: "2026-08-29T21:59:20.000Z" });
    const unk = await show();
    expect(((unk.q1_lanes as Record<string, unknown>[]).find((l) => l.slice === "OPR.9.9.31")!.activity as Record<string, unknown>).activity).toBe("unknown");
    // INDETERMINATE is reserved for NO arbitrated answer at all.
    arbitratedBySession.delete(SEAT_A);
    const gone = await show();
    expect(((gone.q1_lanes as Record<string, unknown>[]).find((l) => l.slice === "OPR.9.9.31")!.activity as Record<string, unknown>).activity).toBe("INDETERMINATE");
  });

  it("Q1 carries needsInput separately — count and reason ride beside activity, never folded into it", async () => {
    arbitratedBySession.set(SEAT_A, {
      activity: "working",
      needsInput: { count: 1, reason: "permission prompt" },
      decidedBy: "needs-input-chrome",
      changedAt: "2026-08-29T21:59:30.000Z",
    });
    const doc = await show();
    const act = (doc.q1_lanes as Record<string, unknown>[]).find((l) => l.slice === "OPR.9.9.31")!.activity as Record<string, unknown>;
    expect(act.activity).toBe("working");
    expect((act.needs_input as Record<string, unknown>).count).toBe(1);
    expect((act.needs_input as Record<string, unknown>).reason).toBe("permission prompt");
  });

  it("Q6 idle capacity counts arbitrated idle-at-prompt seats with no needsInput, not sessions.status", async () => {
    // Seat C: arbitration says idle-at-prompt, no rows held — sessions.status
    // deliberately 'superseded' so any status approximation would count 0.
    const t0 = "2026-08-29T21:00:00.000Z";
    db.prepare(`INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n-c', 'rig-x', 'builder-c')`).run();
    db.prepare(
      `INSERT INTO sessions (id, node_id, session_name, status, last_seen_at, created_at) VALUES ('s-c', 'n-c', 'builder-c@exec-fixture', 'superseded', ?, ?)`,
    ).run(t0, t0);
    arbitratedBySession.set("builder-c@exec-fixture", { activity: "idle-at-prompt", needsInput: { count: 0, reason: null }, decidedBy: "window-sampling", changedAt: "2026-08-29T21:59:00.000Z" });
    // A needs-input seat is NOT capacity even when idle at the prompt.
    db.prepare(`INSERT INTO nodes (id, rig_id, logical_id) VALUES ('n-d', 'rig-x', 'builder-d')`).run();
    db.prepare(
      `INSERT INTO sessions (id, node_id, session_name, status, last_seen_at, created_at) VALUES ('s-d', 'n-d', 'builder-d@exec-fixture', 'running', ?, ?)`,
    ).run(t0, t0);
    arbitratedBySession.set("builder-d@exec-fixture", { activity: "idle-at-prompt", needsInput: { count: 1, reason: "usage limit" }, decidedBy: "needs-input-chrome", changedAt: "2026-08-29T21:59:00.000Z" });
    const doc = await show();
    const idle = (doc.q6_parallelism as Record<string, unknown>).idle_seats_with_capacity as Record<string, unknown>;
    expect(idle.value).toBe(1);
    expect(String(idle.basis)).toContain("arbitrated");
  });

  it("Q4 joins candidate FORMS by commit identity: abbreviated built tag matches full and annotated artifacts; off-sha, malformed, and non-resolving inputs floor honestly", async () => {
    const reviewDir = path.join(rigsRoot, "exec-fixture", "state", "review-fixture");
    // The S20 production specimen: an ANNOTATED artifact form at the same commit.
    fs.writeFileSync(
      path.join(reviewDir, "S31-annotated.md"),
      `---\nslice: 31-alpha\nartifact_type: rev1-r1\nverdict: CLEAR\ncandidate_sha: ${candidateSha.slice(0, 9)} (exact tip over base 0f0f0f0f0 == refs/heads/main)\n---\nCLEAR, annotated form.\n`,
    );
    // An old BLOCKING artifact at a DIFFERENT (non-resolving here) candidate must
    // neither clear nor poison the at-commit verdict.
    fs.writeFileSync(
      path.join(reviewDir, "S31-old-hold.md"),
      `---\nslice: 31-alpha\nartifact_type: rev1-r1\nverdict: BLOCKING\ncandidate_sha: 0000000000000000000000000000000000000000\n---\nHOLD at a dead candidate.\n`,
    );
    // Malformed input floors honestly (excluded with a basis, never matched).
    fs.writeFileSync(
      path.join(reviewDir, "S31-malformed.md"),
      `---\nslice: 31-alpha\nartifact_type: rev1-r2\nverdict: BLOCKING\ncandidate_sha: not-a-sha\n---\nMalformed candidate field.\n`,
    );
    const doc = await show();
    const q4 = doc.q4_ladder as Record<string, unknown>[];
    const s31 = q4.find((s) => s.slice_id === "OPR.9.9.31")!;
    const reviewed = s31.reviewed as Record<string, unknown>;
    // The built tag is abbreviated; the fixture's original artifact is FULL-sha;
    // the annotated one resolves to the same commit — both join, nothing else.
    expect(reviewed.value).toBe(true);
    expect((reviewed.legs as Record<string, unknown>[]).length).toBe(2);
    expect(String(reviewed.basis)).toContain("commit");
    // No built candidate => no commit to scope to => INDETERMINATE, never a verdict.
    const s33 = q4.find((s) => s.slice_id === "OPR.9.9.33")!;
    expect((s33.reviewed as Record<string, unknown>).value).toBe("INDETERMINATE");
    expect(String((s33.reviewed as Record<string, unknown>).basis)).toContain("candidate");
  });

  it("joins local proof review drops when the shared review registry is unavailable", async () => {
    fs.rmSync(rigsRoot, { recursive: true });
    const proof = path.join(missionsRoot, MISSION, "slices", "31-alpha", "proof");
    fs.mkdirSync(proof);
    const drop = path.join(proof, "rev1-r1.md");
    fs.writeFileSync(drop, `---\nslice: OPR.9.9.31\nartifact_type: rev1-r1\nverdict: CLEAR\ncandidate_sha: ${candidateSha}\n---\nLocal review.\n`);
    const local = ((await show()).q4_ladder as Record<string, unknown>[]).find(s => s.slice_id === "OPR.9.9.31")!.reviewed as Record<string, unknown>;
    expect(local.value).toBe(true);
    expect((local.legs as Record<string, unknown>[]).map(leg => leg.path)).toEqual([drop]);
    fs.writeFileSync(path.join(proof, "other-slice.md"), `---\nslice: OPR.9.9.32\nartifact_type: rev1-r2\nverdict: BLOCKING\ncandidate_sha: ${candidateSha}\n---\nOther slice.\n`);
    fs.writeFileSync(path.join(proof, "qa.md"), `---\nslice: OPR.9.9.31\nartifact_type: qa\nverdict: BLOCKING\ncandidate_sha: ${candidateSha}\n---\nQA is not a review leg.\n`);
    const controls = ((await show()).q4_ladder as Record<string, unknown>[]).find(s => s.slice_id === "OPR.9.9.31")!.reviewed as Record<string, unknown>;
    expect(controls.value).toBe(true);
    expect(controls.legs).toHaveLength(1);
    fs.writeFileSync(drop, fs.readFileSync(drop, "utf8").replace("verdict: CLEAR", "verdict: BLOCKING"));
    expect((((await show()).q4_ladder as Record<string, unknown>[]).find(s => s.slice_id === "OPR.9.9.31")!.reviewed as Record<string, unknown>).value).toBe(false);
    fs.writeFileSync(drop, fs.readFileSync(drop, "utf8").replace(candidateSha, "0000000000000000000000000000000000000000"));
    expect((((await show()).q4_ladder as Record<string, unknown>[]).find(s => s.slice_id === "OPR.9.9.31")!.reviewed as Record<string, unknown>).value).toBe("INDETERMINATE");
  });

  it("marks project daemon adoption inapplicable without using Git absence as its basis", async () => {
    for (const row of db.prepare("SELECT qitem_id, tags FROM queue_items").all() as {qitem_id: string; tags: string}[]) {
      db.prepare("UPDATE queue_items SET tags = ? WHERE qitem_id = ?").run(JSON.stringify([...JSON.parse(row.tags), "project:demo"]), row.qitem_id);
    }
    for (const daemonCommit of [candidateSha, "0000000000000000000000000000000000000000", null]) {
      const calls: string[][] = [];
      const deps = {
        db, slicesRoot: () => missionsRoot, rigsRoot: () => rigsRoot,
        buildInfo: { semver: null, commit: daemonCommit, dirty: null, builtAt: null },
        exec: (cmd: string, args: string[]) => {
          calls.push(args);
          return execFileSync(cmd, args, { encoding: "utf8" }).trim();
        },
      };
      const doc = await buildExecutionView(deps, { mission: MISSION, project: "demo" });
      for (const slice of doc.q4_ladder as Record<string, unknown>[]) {
        expect(slice.adopted).toMatchObject({ value: "NOT_APPLICABLE", basis: expect.stringContaining("selected project") });
      }
      expect(calls.filter(args => args.includes("merge-base")).every(args => args.at(-1) === "main")).toBe(true);
      expect((doc.sources as Record<string, unknown>).build_info).toMatchObject({
        commit: daemonCommit ?? "INDETERMINATE", basis: expect.stringContaining("OpenRig daemon"),
      });
      const legacy = await buildExecutionView(deps, { mission: MISSION });
      const first = (legacy.q4_ladder as Record<string, unknown>[]).find(s => s.slice_id === "OPR.9.9.31")!;
      expect((first.adopted as Record<string, unknown>).value).toBe(daemonCommit === candidateSha ? true : "INDETERMINATE");
    }
  });

  it("keeps real Git exit 1 false and observes a moved main ref on the next read", async () => {
    git(laneWorktree, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "unfolded");
    const unfolded = git(laneWorktree, "rev-parse", "HEAD");
    db.prepare("UPDATE queue_items SET tags = ? WHERE qitem_id = 'qitem-lane-31'")
      .run(JSON.stringify([`mission:${MISSION}`, "slice:OPR.9.9.31", `candidate:${unfolded}`]));
    projector.setExecutionDeps({ db, slicesRoot: () => missionsRoot, rigsRoot: () => rigsRoot,
      buildInfo: { semver: null, commit: candidateSha, dirty: null, builtAt: null } });
    const before = ((await show()).q4_ladder as Record<string, unknown>[]).find(s => s.slice_id === "OPR.9.9.31")!;
    expect(before).toMatchObject({ folded: { value: false }, adopted: { value: false } });
    git(repoDir, "update-ref", "refs/heads/main", unfolded);
    const after = ((await show()).q4_ladder as Record<string, unknown>[]).find(s => s.slice_id === "OPR.9.9.31")!;
    expect(after).toMatchObject({ folded: { value: true }, adopted: { value: false } });
  });

  it.each([
    [{ code: 1 }, false],
    [{ status: 1 }, false],
    [{ code: 128 }, "INDETERMINATE"],
    [{ code: null, killed: true, signal: "SIGTERM" }, "INDETERMINATE"],
  ])("serializes asynchronous Git checks and preserves failure meaning: %j", async (failure, value) => {
    let active = 0;
    let peak = 0;
    const calls: string[][] = [];
    const doc = await buildExecutionView({ db, slicesRoot: () => missionsRoot, rigsRoot: () => rigsRoot,
      buildInfo: { semver: null, commit: candidateSha, dirty: null, builtAt: null },
      exec: async (_cmd, args) => {
        calls.push(args);
        peak = Math.max(peak, ++active);
        try {
          await new Promise(resolve => setTimeout(resolve, 0));
          if (args.includes("merge-base")) throw Object.assign(new Error("fixture Git failure"), failure);
          return candidateSha;
        } finally { active--; }
      },
    }, { mission: MISSION });
    expect(peak).toBe(1);
    expect(active).toBe(0);
    expect(calls.some(args => args.includes("merge-base"))).toBe(true);
    const first = (doc.q4_ladder as Record<string, unknown>[]).find(s => s.slice_id === "OPR.9.9.31")!;
    expect(first).toMatchObject({ folded: { value }, adopted: { value } });
  });

  it("serves project N/A through the actual views route and projector", async () => {
    fs.writeFileSync(path.join(tmp, "project.yaml"), "id: demo\n");
    fs.writeFileSync(path.join(tmp, "SPEC.md"), "# Test project\n");
    fs.writeFileSync(path.join(missionsRoot, MISSION, "SPEC.md"), "# Test mission\n");
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("viewProjector" as never, projector);
      c.set("settingsStore" as never, { resolveOne: (key: string) => ({ value: key === "workspace.root" ? tmp : null }) });
      await next();
    });
    app.route("/api/views", viewsRoutes());
    const res = await app.request(`/api/views/execution?project=demo&mission=${MISSION}`);
    const result = await res.json();
    expect(res.status, JSON.stringify(result)).toBe(200);
    expect(result.rows[0].q4_ladder).toHaveLength(3);
    expect(result.rows[0].q4_ladder.every((s: {adopted: {value: string}}) => s.adopted.value === "NOT_APPLICABLE")).toBe(true);
    expect(result.rows[0].sources.build_info.basis).toContain("OpenRig daemon");
  });

  it("uses project-local review drops without joining unbound global artifacts", async () => {
    for (const row of db.prepare("SELECT qitem_id, tags FROM queue_items").all() as {qitem_id: string; tags: string}[]) {
      const tags = JSON.parse(row.tags) as string[];
      db.prepare("UPDATE queue_items SET tags = ? WHERE qitem_id = ?").run(JSON.stringify([...tags, "project:demo"]), row.qitem_id);
    }
    const proof = path.join(missionsRoot, MISSION, "slices", "31-alpha", "proof");
    fs.mkdirSync(proof);
    const drop = path.join(proof, "local-review.md");
    fs.writeFileSync(drop, `---\nslice: OPR.9.9.31\nartifact_type: adjudication\nverdict: CLEAR\ncandidate_sha: ${candidateSha}\n---\nProject local.\n`);
    fs.writeFileSync(path.join(rigsRoot, "exec-fixture", "state", "review-fixture", "S31-verdict.md"), `---\nslice: OPR.9.9.31\nartifact_type: rev1-r2\nverdict: BLOCKING\ncandidate_sha: ${candidateSha}\n---\nUnbound global record.\n`);
    const doc = await buildExecutionView({ db, slicesRoot: () => missionsRoot, rigsRoot: () => rigsRoot }, { mission: MISSION, project: "demo" });
    const local = (doc.q4_ladder as Record<string, unknown>[]).find(s => s.slice_id === "OPR.9.9.31")!.reviewed as Record<string, unknown>;
    expect(local.value).toBe(true);
    expect((local.legs as Record<string, unknown>[]).map(leg => leg.path)).toEqual([drop]);
  });

  it("Q2 honesty: own-completion INDETERMINATE never yields next_up=true, and terminal-row blockedOn does not govern dispatchability", async () => {
    // 34-delta: locked, unclaimed, EC-1 present, but NO candidate tag anywhere —
    // own folded is underivable, so dispatchability is INDETERMINATE, not true.
    writeSpec(
      missionsRoot,
      "34-delta",
      ["id: OPR.9.9.34", "slice: 34-delta", `mission: ${MISSION}`, "approved-spec-at: 2026-08-29T00:00:00.000Z", "depends_on: []"].join("\n"),
      "## Intent\ndelta\n",
    );
    // A DONE row with stale blockedOn naming slice 32 must not suppress 32's next_up.
    db.prepare(
      `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tier, tags, body, blocked_on)
       VALUES ('qitem-stale-done', '2026-08-29T20:00:00.000Z', '2026-08-29T20:00:00.000Z', 'lead@exec-fixture', 'builder-b@exec-fixture', 'done', 'normal', 'light', ?, 'closed long ago', 'qitem-ancient-blocker')`,
    ).run(JSON.stringify([`mission:${MISSION}`, "slice:OPR.9.9.32"]));
    // Free slice 32 of its live lane so only deps govern it.
    db.prepare(`UPDATE queue_items SET state = 'done', claimed_at = NULL WHERE qitem_id = 'qitem-lane-32'`).run();
    const doc = await show();
    const q2 = doc.q2_sequencing as Record<string, unknown>[];
    const s34 = q2.find((s) => s.slice_id === "OPR.9.9.34")!;
    expect(s34.next_up).toBe("INDETERMINATE");
    expect(String(s34.next_up_basis)).toContain("completion");
    const s32 = q2.find((s) => s.slice_id === "OPR.9.9.32")!;
    // The stale terminal-row blocker is record, not state: it must not appear.
    expect(s32.blocked_on_rows).toEqual([]);
    // 32 also carries no candidate: own completion is underivable, so
    // dispatchability is INDETERMINATE — never false FROM the stale blocker,
    // never true from ignorance.
    expect(s32.next_up).toBe("INDETERMINATE");
    expect(String(s32.next_up_basis)).toContain("completion");
  });

  it("Q5 park_kind is the closed enum only: deliberate-with-wake | stalled | indeterminate", async () => {
    // Give lane-31 real post-claim motion so its pickup derives 'working' —
    // the arm that leaked 'working' into park_kind on the live artifact.
    db.prepare(
      `INSERT INTO queue_transitions (transition_id, qitem_id, ts, state, transition_note, actor_session)
       VALUES (31002, 'qitem-lane-31', '2026-08-29T21:30:00.000Z', 'in-progress', 'progress note', '${SEAT_A}')`,
    ).run();
    const doc = await show();
    const rows = doc.q5_park as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThan(0);
    const lane31 = rows.find((p) => p.qitem_id === "qitem-lane-31")!;
    expect(lane31.pickup_state).toBe("working");
    for (const p of rows) {
      expect(["deliberate-with-wake", "stalled", "indeterminate"]).toContain(p.park_kind);
    }
  });

  it("RECEIVER: GET /api/views/execution?mission=… derives the full document through the HTTP route (not module-direct)", async () => {
    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("viewProjector" as never, projector);
      c.set("eventBus" as never, new EventBus(db));
      await next();
    });
    app.route("/api/views", viewsRoutes());
    const res = await app.request(`/api/views/execution?mission=${MISSION}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.rowCount).toBe(1);
    const doc = (body.rows as Record<string, unknown>[])[0]!;
    expect(doc.view).toBe("execution");
    expect(doc.mission).toBe(MISSION);
    expect((doc.q1_lanes as unknown[]).length).toBe(2);
  });

  it("park honesty: armed wake => deliberate-with-wake; removing the wake flips park_kind to INDETERMINATE, never idle/dead", async () => {
    const before = await show();
    const parkedBefore = (before.q5_park as Record<string, unknown>[]).find((p) => p.qitem_id === "qitem-parked-33")!;
    expect(parkedBefore.pickup_state).toBe("parked");
    expect(parkedBefore.park_kind).toBe("deliberate-with-wake");
    expect(parkedBefore.wake_target).toBe("wake-timer-33");
    db.prepare(`DELETE FROM queue_transition_wakes WHERE qitem_id = 'qitem-parked-33'`).run();
    const after = await show();
    const parkedAfter = (after.q5_park as Record<string, unknown>[]).find((p) => p.qitem_id === "qitem-parked-33")!;
    // The DESIGN's park_kind enum is lowercase; the value floor stays honest.
    expect(parkedAfter.park_kind).toBe("indeterminate");
    expect(String(parkedAfter.park_kind_basis)).toContain("no armed wake");
  });

  it("INDETERMINATE floor: an unreachable worktree path renders INDETERMINATE for the git legs, never idle/dead/done", async () => {
    db.prepare(`UPDATE queue_items SET body = ? WHERE qitem_id = 'qitem-lane-31'`).run(
      "Build 31.\nworktree_path=/nonexistent/severed/path\n",
    );
    const doc = await show();
    const lane = (doc.q1_lanes as Record<string, unknown>[]).find((l) => l.slice === "OPR.9.9.31")!;
    expect(lane.branch).toBe("INDETERMINATE");
    expect(lane.head_sha).toBe("INDETERMINATE");
    expect(String(lane.join_basis)).toContain("unreachable");
    for (const forbidden of ["idle", "dead", "done"]) {
      expect(lane.branch).not.toBe(forbidden);
    }
  });

  it("trust stamps: derived_at + per-source asof on the response; every lane and sequencing cell carries its source id", async () => {
    const doc = await show();
    expect(typeof doc.derived_at).toBe("string");
    const sources = doc.sources as Record<string, Record<string, unknown>>;
    for (const key of ["queue_db", "slice_frontmatter", "wave_map", "git", "build_info", "review_artifacts", "disk"]) {
      expect(sources, `source ${key}`).toHaveProperty(key);
      expect(sources[key].asof, `asof on ${key}`).toBeTruthy();
    }
    for (const lane of doc.q1_lanes as Record<string, unknown>[]) {
      expect((lane.source as Record<string, unknown>).qitem_id).toBeTruthy();
    }
    for (const s of doc.q2_sequencing as Record<string, unknown>[]) {
      expect((s.source as Record<string, unknown>).spec_path).toBeTruthy();
    }
  });

  it("derives folded rung against arrangement.source.integration_ref when declared, falling back to main", async () => {
    git(repoDir, "branch", "integration", "main~1");
    git(laneWorktree, "checkout", "-q", "integration");
    git(laneWorktree, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "integration-only");
    const integrationCandidate = git(laneWorktree, "rev-parse", "HEAD");
    git(laneWorktree, "checkout", "-q", branchName);

    db.prepare("UPDATE queue_items SET tags = ? WHERE qitem_id = 'qitem-lane-31'")
      .run(JSON.stringify([`mission:${MISSION}`, "slice:OPR.9.9.31", `candidate:${integrationCandidate}`]));

    // 1. Fallback with no declaration: ancestor of integration but not main tests false against main
    const fallbackDoc = await show();
    const fallbackSlice = (fallbackDoc.q4_ladder as Record<string, unknown>[]).find(s => s.slice_id === "OPR.9.9.31")!;
    expect((fallbackSlice.folded as Record<string, unknown>).value).toBe(false);
    expect(String((fallbackSlice.folded as Record<string, unknown>).basis)).toContain("merge-base --is-ancestor");
    expect(String((fallbackSlice.folded as Record<string, unknown>).basis)).toContain("main");

    // 2. Declared ref: tests ancestry against integration ref, basis names the ref, and next_up names it
    const missionYamlPath = path.join(missionsRoot, MISSION, "mission.yaml");
    const originalYaml = fs.readFileSync(missionYamlPath, "utf8");
    fs.writeFileSync(missionYamlPath, originalYaml + "\n  source:\n    integration_ref: integration\n");

    db.prepare("UPDATE queue_items SET state = 'done' WHERE qitem_id = 'qitem-lane-31'").run();

    const declaredDoc = await show();
    const declaredSlice = (declaredDoc.q4_ladder as Record<string, unknown>[]).find(s => s.slice_id === "OPR.9.9.31")!;
    expect((declaredSlice.folded as Record<string, unknown>).value).toBe(true);
    expect(String((declaredSlice.folded as Record<string, unknown>).basis)).toContain("merge-base --is-ancestor");
    expect(String((declaredSlice.folded as Record<string, unknown>).basis)).toContain("integration");
    const q2Slice = (declaredDoc.q2_sequencing as Record<string, unknown>[]).find(s => s.slice_id === "OPR.9.9.31")!;
    expect(q2Slice.next_up).toBe(false);
    expect(q2Slice.next_up_basis).toBe("own candidate already folded to integration — nothing left to dispatch");

    // 3. Unresolvable ref: gives INDETERMINATE result that names the ref, never false
    fs.writeFileSync(missionYamlPath, originalYaml + "\n  source:\n    integration_ref: unresolvable-branch\n");
    const unresolvableDoc = await show();
    const unresolvableSlice = (unresolvableDoc.q4_ladder as Record<string, unknown>[]).find(s => s.slice_id === "OPR.9.9.31")!;
    expect((unresolvableSlice.folded as Record<string, unknown>).value).toBe("INDETERMINATE");
    expect(String((unresolvableSlice.folded as Record<string, unknown>).basis)).toContain("unresolvable-branch");

    // 4. Invalid ref name: rejects ref starting with '-', '@', components starting with '.', or ending with '.lock'
    // Keeps unusable declaration indeterminate naming the ref, rather than falling back to main
    db.prepare("UPDATE queue_items SET state = 'done' WHERE qitem_id = 'qitem-lane-32'").run();
    for (const badRef of ["-invalid-branch", "@", "refs/heads/.bad", "refs/bad.lock/foo"]) {
      fs.writeFileSync(missionYamlPath, originalYaml + `\n  source:\n    integration_ref: "${badRef}"\n`);
      const invalidDoc = await show();
      const sources = invalidDoc.sources as Record<string, Record<string, unknown>>;
      expect(sources.arrangement.value).toBe("INDETERMINATE");
      expect(String(sources.arrangement.basis)).toMatch(/arrangement\.source\.integration_ref must be a valid Git ref name/);
      const invalidSlice = (invalidDoc.q4_ladder as Record<string, unknown>[]).find(s => s.slice_id === "OPR.9.9.31")!;
      expect((invalidSlice.folded as Record<string, unknown>).value).toBe("INDETERMINATE");
      expect(String((invalidSlice.folded as Record<string, unknown>).basis)).toContain(badRef);
      const q2Invalid = (invalidDoc.q2_sequencing as Record<string, unknown>[]).find(s => s.slice_id === "OPR.9.9.31")!;
      expect(q2Invalid.next_up).toBe("INDETERMINATE");
      expect(String(q2Invalid.next_up_basis)).toContain(badRef);
      // Same-mission dependency: 32 depends on 31
      const q2Dep = (invalidDoc.q2_sequencing as Record<string, unknown>[]).find(s => s.slice_id === "OPR.9.9.32")!;
      expect(q2Dep.next_up).toBe("INDETERMINATE");
      expect(String(q2Dep.next_up_basis)).toContain(badRef);
    }

    // 5. Unrelated arrangement-validation failure: valid declared ref beside invalid waves does not fall back to main
    const invalidWavesYaml = [
      "schema: openrig.mission/v0alpha1",
      "kind: mission",
      "composition:",
      "  slices:",
      "    - { ref: slices/31-alpha/slice.yaml, order: 10, active: true }",
      "    - { ref: slices/32-beta/slice.yaml, order: 20, active: true }",
      "arrangement:",
      "  source:",
      "    integration_ref: integration",
      "  waves: not-a-list",
      "",
    ].join("\n");
    fs.writeFileSync(missionYamlPath, invalidWavesYaml);
    const unrelatedDoc = await show();
    const unrelatedSources = unrelatedDoc.sources as Record<string, Record<string, unknown>>;
    expect(unrelatedSources.arrangement.value).toBe("INDETERMINATE");
    expect(String(unrelatedSources.arrangement.basis)).toContain("arrangement.waves is not a list");
    const unrelatedSlice = (unrelatedDoc.q4_ladder as Record<string, unknown>[]).find(s => s.slice_id === "OPR.9.9.31")!;
    expect((unrelatedSlice.folded as Record<string, unknown>).value).toBe("INDETERMINATE");
    expect(String((unrelatedSlice.folded as Record<string, unknown>).basis)).toContain("integration");
    const q2Unrelated = (unrelatedDoc.q2_sequencing as Record<string, unknown>[]).find(s => s.slice_id === "OPR.9.9.31")!;
    expect(q2Unrelated.next_up).toBe("INDETERMINATE");
    expect(String(q2Unrelated.next_up_basis)).toContain("integration");
    const q2UnrelatedDep = (unrelatedDoc.q2_sequencing as Record<string, unknown>[]).find(s => s.slice_id === "OPR.9.9.32")!;
    expect(q2UnrelatedDep.next_up).toBe("INDETERMINATE");
    expect(String(q2UnrelatedDep.next_up_basis)).toContain("integration");

    // 5b. Unrelated composition-validation failure: valid declared ref beside invalid composition does not fall back to main
    const invalidCompositionYaml = [
      "schema: openrig.mission/v0alpha1",
      "kind: mission",
      "composition: not-a-mapping",
      "arrangement:",
      "  source:",
      "    integration_ref: integration",
      "",
    ].join("\n");
    fs.writeFileSync(missionYamlPath, invalidCompositionYaml);
    const compDoc = await show();
    const compSources = compDoc.sources as Record<string, Record<string, unknown>>;
    expect(compSources.arrangement.value).toBe("INDETERMINATE");
    const compSlice = (compDoc.q4_ladder as Record<string, unknown>[]).find(s => s.slice_id === "OPR.9.9.31")!;
    expect((compSlice.folded as Record<string, unknown>).value).toBe("INDETERMINATE");
    expect(String((compSlice.folded as Record<string, unknown>).basis)).toContain("integration");
    const q2Comp = (compDoc.q2_sequencing as Record<string, unknown>[]).find(s => s.slice_id === "OPR.9.9.31")!;
    expect(q2Comp.next_up).toBe("INDETERMINATE");
    expect(String(q2Comp.next_up_basis)).toContain("integration");

    // 6. Pin error texts: absent ref keeps legacy error text without ref context, adopted rung stays without ref context, declared ref includes ref context
    const failingExec: ExecutionViewDeps["exec"] = async (cmd, args) => {
      if (cmd === "git" && args?.includes("merge-base")) {
        throw new Error("simulated merge-base failure");
      }
      return { stdout: "", stderr: "" };
    };
    (projector as unknown as { setExecutionDeps: (d: unknown) => void }).setExecutionDeps({
      db,
      slicesRoot: () => missionsRoot,
      rigsRoot: () => rigsRoot,
      buildInfo: { semver: null, commit: "adopt-commit-sha", dirty: null, builtAt: null },
      now: () => fixedNow,
      seatActivity: { getSeatStateBySession: (s: string) => arbitratedBySession.get(s) ?? null },
      exec: failingExec,
    });

    // 6a. No ref declared -> folded and adopted error texts have NO ref context
    fs.writeFileSync(missionYamlPath, originalYaml);
    const legacyErrDoc = await show();
    const legacySlice = (legacyErrDoc.q4_ladder as Record<string, unknown>[]).find(s => s.slice_id === "OPR.9.9.31")!;
    expect((legacySlice.folded as Record<string, unknown>).basis).toBe(
      `merge-base failed in ${laneWorktree}: simulated merge-base failure`,
    );
    expect((legacySlice.adopted as Record<string, unknown>).basis).toBe(
      `merge-base failed in ${laneWorktree}: simulated merge-base failure`,
    );

    // 6b. Declared ref -> folded error text includes (<ref>), adopted rung stays without ref context
    fs.writeFileSync(missionYamlPath, originalYaml + "\n  source:\n    integration_ref: integration\n");
    const declaredErrDoc = await show();
    const declaredErrSlice = (declaredErrDoc.q4_ladder as Record<string, unknown>[]).find(s => s.slice_id === "OPR.9.9.31")!;
    expect((declaredErrSlice.folded as Record<string, unknown>).basis).toBe(
      `merge-base failed in ${laneWorktree} (integration): simulated merge-base failure`,
    );
    expect((declaredErrSlice.adopted as Record<string, unknown>).basis).toBe(
      `merge-base failed in ${laneWorktree}: simulated merge-base failure`,
    );
  });

  it("stays a registered-name error at base and a clean not-found for unknown names either way", () => {
    expect(() => projector.show("no-such-view")).toThrow(ViewProjectorError);
  });
});
