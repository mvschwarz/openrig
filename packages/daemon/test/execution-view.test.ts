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
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { queueTransitionWakesSchema } from "../src/db/migrations/073_queue_transition_wakes.js";
import { viewsCustomSchema } from "../src/db/migrations/030_views_custom.js";
import { EventBus } from "../src/domain/event-bus.js";
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

  function show(): Record<string, unknown> {
    const result = projector.show("execution", { mission: MISSION });
    expect(result.rowCount).toBe(1);
    return result.rows[0] as Record<string, unknown>;
  }

  it("answers the six questions in ONE read over the fixture rig (RED at base: the view does not exist)", () => {
    const doc = show();
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

  it("EC-3: the worktree_path field is Q1's join key; a legacy baton falls back marked fragile", () => {
    const doc = show();
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

  it("EC-2: Q3 derives {build_wave, review_model, planning_dial} from row/frontmatter data alone, citing the wave-map row", () => {
    const doc = show();
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

  it("Q2: EC-1 frontmatter edges + SOFT-AFTER line + blocked rows derive sequencing; absent EC-1 floors INDETERMINATE", () => {
    const doc = show();
    const q2 = doc.q2_sequencing as Record<string, unknown>[];
    const s32 = q2.find((s) => s.slice_id === "OPR.9.9.32")!;
    expect(s32.depends_on).toEqual(["OPR.9.9.31"]);
    expect(s32.soft_after).toEqual(["OPR.9.9.31"]);
    const s33 = q2.find((s) => s.slice_id === "OPR.9.9.33")!;
    expect(s33.depends_on).toBe("INDETERMINATE");
    expect(s33.next_up).toBe("INDETERMINATE");
    expect(String(s33.next_up_basis)).toContain("EC-1");
  });

  it("ladder honesty: folded derives from git at read time, adopted floors INDETERMINATE on a dev daemon, and no 'done' boolean exists", () => {
    const doc = show();
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

  it("Q1 consumes the ARBITRATED seat state (working): the superseded/stale-hook specimen cannot recur", () => {
    // The HOLD's live specimen: sessions.status superseded + a stale hook in the
    // parallel ingest store, while arbitration says working. Q1 must say working.
    db.prepare(`UPDATE sessions SET status = 'superseded' WHERE session_name = ?`).run(SEAT_A);
    const doc = show();
    const lane = (doc.q1_lanes as Record<string, unknown>[]).find((l) => l.slice === "OPR.9.9.31")!;
    const act = lane.activity as Record<string, unknown>;
    expect(act.activity).toBe("working");
    expect(String(act.source)).toContain("arbitrated");
    expect(act.decided_by).toBe("self-report");
  });

  it("Q1 passes through idle-at-prompt and unknown as canonical vocabulary, and floors INDETERMINATE only for a never-seen seat", () => {
    arbitratedBySession.set(SEAT_A, { activity: "idle-at-prompt", needsInput: { count: 0, reason: null }, decidedBy: "window-sampling", changedAt: "2026-08-29T21:59:10.000Z" });
    const idle = show();
    expect(((idle.q1_lanes as Record<string, unknown>[]).find((l) => l.slice === "OPR.9.9.31")!.activity as Record<string, unknown>).activity).toBe("idle-at-prompt");
    // 'unknown' is a CANONICAL member of the arbitrated vocabulary — passed
    // through as itself, never rewritten to INDETERMINATE.
    arbitratedBySession.set(SEAT_A, { activity: "unknown", needsInput: { count: 0, reason: null }, decidedBy: null, changedAt: "2026-08-29T21:59:20.000Z" });
    const unk = show();
    expect(((unk.q1_lanes as Record<string, unknown>[]).find((l) => l.slice === "OPR.9.9.31")!.activity as Record<string, unknown>).activity).toBe("unknown");
    // INDETERMINATE is reserved for NO arbitrated answer at all.
    arbitratedBySession.delete(SEAT_A);
    const gone = show();
    expect(((gone.q1_lanes as Record<string, unknown>[]).find((l) => l.slice === "OPR.9.9.31")!.activity as Record<string, unknown>).activity).toBe("INDETERMINATE");
  });

  it("Q1 carries needsInput separately — count and reason ride beside activity, never folded into it", () => {
    arbitratedBySession.set(SEAT_A, {
      activity: "working",
      needsInput: { count: 1, reason: "permission prompt" },
      decidedBy: "needs-input-chrome",
      changedAt: "2026-08-29T21:59:30.000Z",
    });
    const doc = show();
    const act = (doc.q1_lanes as Record<string, unknown>[]).find((l) => l.slice === "OPR.9.9.31")!.activity as Record<string, unknown>;
    expect(act.activity).toBe("working");
    expect((act.needs_input as Record<string, unknown>).count).toBe(1);
    expect((act.needs_input as Record<string, unknown>).reason).toBe("permission prompt");
  });

  it("Q6 idle capacity counts arbitrated idle-at-prompt seats with no needsInput, not sessions.status", () => {
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
    const doc = show();
    const idle = (doc.q6_parallelism as Record<string, unknown>).idle_seats_with_capacity as Record<string, unknown>;
    expect(idle.value).toBe(1);
    expect(String(idle.basis)).toContain("arbitrated");
  });

  it("Q4 joins candidate FORMS by commit identity: abbreviated built tag matches full and annotated artifacts; off-sha, malformed, and non-resolving inputs floor honestly", () => {
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
    const doc = show();
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

  it("Q2 honesty: own-completion INDETERMINATE never yields next_up=true, and terminal-row blockedOn does not govern dispatchability", () => {
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
    const doc = show();
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

  it("Q5 park_kind is the closed enum only: deliberate-with-wake | stalled | indeterminate", () => {
    // Give lane-31 real post-claim motion so its pickup derives 'working' —
    // the arm that leaked 'working' into park_kind on the live artifact.
    db.prepare(
      `INSERT INTO queue_transitions (transition_id, qitem_id, ts, state, transition_note, actor_session)
       VALUES (31002, 'qitem-lane-31', '2026-08-29T21:30:00.000Z', 'in-progress', 'progress note', '${SEAT_A}')`,
    ).run();
    const doc = show();
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

  it("park honesty: armed wake => deliberate-with-wake; removing the wake flips park_kind to INDETERMINATE, never idle/dead", () => {
    const before = show();
    const parkedBefore = (before.q5_park as Record<string, unknown>[]).find((p) => p.qitem_id === "qitem-parked-33")!;
    expect(parkedBefore.pickup_state).toBe("parked");
    expect(parkedBefore.park_kind).toBe("deliberate-with-wake");
    expect(parkedBefore.wake_target).toBe("wake-timer-33");
    db.prepare(`DELETE FROM queue_transition_wakes WHERE qitem_id = 'qitem-parked-33'`).run();
    const after = show();
    const parkedAfter = (after.q5_park as Record<string, unknown>[]).find((p) => p.qitem_id === "qitem-parked-33")!;
    // The DESIGN's park_kind enum is lowercase; the value floor stays honest.
    expect(parkedAfter.park_kind).toBe("indeterminate");
    expect(String(parkedAfter.park_kind_basis)).toContain("no armed wake");
  });

  it("INDETERMINATE floor: an unreachable worktree path renders INDETERMINATE for the git legs, never idle/dead/done", () => {
    db.prepare(`UPDATE queue_items SET body = ? WHERE qitem_id = 'qitem-lane-31'`).run(
      "Build 31.\nworktree_path=/nonexistent/severed/path\n",
    );
    const doc = show();
    const lane = (doc.q1_lanes as Record<string, unknown>[]).find((l) => l.slice === "OPR.9.9.31")!;
    expect(lane.branch).toBe("INDETERMINATE");
    expect(lane.head_sha).toBe("INDETERMINATE");
    expect(String(lane.join_basis)).toContain("unreachable");
    for (const forbidden of ["idle", "dead", "done"]) {
      expect(lane.branch).not.toBe(forbidden);
    }
  });

  it("trust stamps: derived_at + per-source asof on the response; every lane and sequencing cell carries its source id", () => {
    const doc = show();
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

  it("stays a registered-name error at base and a clean not-found for unknown names either way", () => {
    expect(() => projector.show("no-such-view")).toThrow(ViewProjectorError);
  });
});
