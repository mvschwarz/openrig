// Living Notes Packet 2 — /api/review route family e2e (OPR.0.4.4.20).
//
// Drives the gatherer -> pure composer -> routes path against REAL on-disk
// fixtures (C1-headed proof artifacts, C7 pinned names) + a real migrated
// SQLite DB, mirroring how server.ts wires deps through context middleware.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { streamItemsSchema } from "../src/db/migrations/023_stream_items.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { missionControlActionsSchema } from "../src/db/migrations/037_mission_control_actions.js";
import { queueItemSummarySchema } from "../src/db/migrations/044_queue_item_summary.js";
import { EventBus } from "../src/domain/event-bus.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { SliceIndexer } from "../src/domain/slices/slice-indexer.js";
import { ReviewGatherer } from "../src/domain/review/gather.js";
import { reviewRoutes } from "../src/routes/review.js";
import {
  makeFixtureWorkspace,
  writeFixtureSlice,
  writeFullGateSet,
  writeProofArtifact,
  type FixtureWorkspace,
} from "./review-fixtures.js";

const NOW = "2026-07-04T12:00:00.000Z";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeLineageRepo(root: string): { repo: string; oldSha: string; newSha: string } {
  const repo = path.join(root, "lineage-repo");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "review-test@example.test"]);
  git(repo, ["config", "user.name", "Review Test"]);
  let oldSha = "";
  for (let i = 0; i < 6; i++) {
    fs.writeFileSync(path.join(repo, "state.txt"), `state-${i}\n`);
    git(repo, ["add", "state.txt"]);
    git(repo, ["commit", "-q", "-m", `state ${i}`]);
    if (i === 0) {
      oldSha = git(repo, ["rev-parse", "HEAD"]);
    }
  }
  const newSha = git(repo, ["rev-parse", "HEAD"]);
  return { repo, oldSha, newSha };
}

describe("GET /api/review/*", () => {
  let ws: FixtureWorkspace;
  let db: Database.Database;
  let app: Hono;

  beforeEach(() => {
    ws = makeFixtureWorkspace();
    db = createDb(":memory:");
    migrate(db, [
      coreSchema,
      bindingsSessionsSchema,
      eventsSchema,
      streamItemsSchema,
      queueItemsSchema,
      queueTransitionsSchema,
      missionControlActionsSchema,
      queueItemSummarySchema,
    ]);
    const indexer = new SliceIndexer({ slicesRoot: ws.root, additionalSliceRoots: [], dogfoodEvidenceRoot: null, db });
    const gatherer = new ReviewGatherer({ db, indexer, gitRepoPath: null, now: () => NOW });
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("reviewGatherer" as never, gatherer);
      await next();
    });
    app.route("/api/review", reviewRoutes());
  });

  afterEach(() => {
    db.close();
    fs.rmSync(ws.root, { recursive: true, force: true });
  });

  function insertQitem(opts: { id: string; dest: string; state?: string; tags?: string[]; summary?: string | null; tier?: string | null }) {
    db.prepare(
      `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tier, tags, body, summary)
       VALUES (?, ?, ?, 'src@r', ?, ?, 'high', ?, ?, 'body', ?)`,
    ).run(opts.id, NOW, NOW, opts.dest, opts.state ?? "in-progress", opts.tier ?? null, JSON.stringify(opts.tags ?? []), opts.summary ?? null);
  }

  it("composes the ONE structure on the wire: intent verbatim, DELIVERED verified from the recorded QA comparison, no superseded keys", async () => {
    const dir = writeFixtureSlice(ws, "release-t", "20-green", {
      id: "OPR.T.20",
      intent: "Exactly these words.",
      prd: {
        miniReqs: ["one surface", "verified from recorded QA comparisons"],
        prdCheckboxes: [{ text: "the range probe", done: true }],
        proofContract: ["phone video"],
      },
      progressCheckboxes: [{ text: "the range probe", done: false }],
    });
    writeFullGateSet(dir, "20-green", "cand1234");
    writeProofArtifact(dir, {
      slice: "20-green",
      candidateSha: "cand1234",
      artifactType: "qa",
      verdict: "PASS",
      evidences: ["1"],
      selfCheck: "watched it against the mockup",
      fileName: "qa-2.md",
      mtime: new Date("2026-07-04T11:00:00Z"),
      body: "Comparison record.\n\n![phone journey](phone-journey.png)\n",
    });

    const res = await app.request("/api/review/slice/20-green");
    expect(res.status).toBe(200);
    const body = await res.json();
    for (const dead of ["sections", "acceptance", "compare", "join", "green", "locked"]) {
      expect(body, `superseded structure '${dead}' must not survive on the wire`).not.toHaveProperty(dead);
    }
    expect(body.intent.text).toBe("Exactly these words.");
    expect(body.intent.ssotPath).toBe("release-t/slices/20-green/README.md");
    expect(body.plan.concise.text).toContain("one surface");
    expect(body.phase).toBe("review");
    expect(body.lineage.mergeSha).toBeNull(); // UNMERGED lineage fact — explicit, never hidden
    expect(body.lineage.mainTip).toBe("unknown"); // honest degrade with no git repo bound
    expect(body.delivered.items).toHaveLength(1);
    expect(body.delivered.items[0]).toMatchObject({
      promised: { text: "phone video" },
      verified: "verified",
      note: "watched it against the mockup",
    });
    expect(body.delivered.items[0].proof).toEqual([
      { kind: "image", src: "proof/phone-journey.png", caption: "phone-journey.png" },
    ]);
    expect(body.delivered.proofDirPath).toBe("release-t/slices/20-green/proof");
  });

  it("routes a claimed-PASS ungated slice into confirm-faithful (regime 2), items stay missing", async () => {
    const dir = writeFixtureSlice(ws, "release-t", "21-claimed", {
      intent: "i",
      prd: { miniReqs: ["m"], proofContract: ["the thing"] },
    });
    fs.writeFileSync(`${dir}/PROOF.md`, "# Proof\n\nResult: PASS\n");

    const res = await app.request("/api/review/slice/21-claimed");
    const body = await res.json();
    expect(body.needsYou.items.some((i: { leg: string }) => i.leg === "confirm-faithful")).toBe(true);
    expect(body.delivered.items[0].verified).toBe("missing"); // a self-claim never verifies a deliverable
  });

  it("locks bind to the staged-approval stamps + the pinned audit shape; a rowless stamp renders UNVERIFIED", async () => {
    writeFixtureSlice(ws, "release-t", "26-locks", {
      id: "OPR.T.26",
      intent: "i",
      prd: { miniReqs: ["m"] },
      specApprovedBy: "planner@rig",
      specApprovedAt: "2026-07-03T00:00:00.000Z",
      approvedBy: "human@host",
      approvedAt: "2026-07-04T00:00:00.000Z",
      lockedArtifacts: [
        { name: "the PRD", path: "IMPLEMENTATION-PRD.md", kind: "spec" },
        { name: "drawer mockup", path: "mockups/drawer.png", kind: "mockup" },
      ],
    });
    // Only the SPEC approval has a matching audit row (the pinned
    // scope-approval audit_notes_json shape) -> plan.lock verified,
    // delivered.lock UNVERIFIED — visible, never a block.
    db.prepare(
      `INSERT INTO mission_control_actions (action_id, action_verb, actor_session, acted_at, audit_notes_json)
       VALUES ('act-1', 'approve', 'planner@rig', '2026-07-03T00:00:00.000Z', ?)`,
    ).run(JSON.stringify({ kind: "scope-approval", scope_tier: "slice", scope_id: "OPR.T.26", scope_path: "release-t/slices/26-locks", approval_scope: "spec", on_behalf_of: null }));

    const body = await (await app.request("/api/review/slice/26-locks")).json();
    expect(body.plan.lock).toEqual({ by: "planner@rig", at: "2026-07-03T00:00:00.000Z", auditVerified: true });
    expect(body.delivered.lock).toEqual({ by: "human@host", at: "2026-07-04T00:00:00.000Z", auditVerified: false });
    expect(body.phase).toBe("locked");
    expect(body.plan.lockedArtifacts).toEqual([
      { name: "the PRD", path: "IMPLEMENTATION-PRD.md", kind: "spec" },
      { name: "drawer mockup", path: "mockups/drawer.png", kind: "mockup" },
    ]);
    expect(body.plan.concise.media).toContainEqual({ kind: "image", src: "mockups/drawer.png", caption: "mockups/drawer.png" });
  });

  it("serves byte-identical responses on repeat composition (idempotence e2e)", async () => {
    writeFixtureSlice(ws, "release-t", "22-idem", { intent: "i", prd: { miniReqs: ["m"] } });
    const a = await (await app.request("/api/review/slice/22-idem")).text();
    const b = await (await app.request("/api/review/slice/22-idem")).text();
    expect(a).toBe(b);
  });

  it("closed historical qitems do not make a slice look actively building", async () => {
    writeFixtureSlice(ws, "release-t", "22-closed-qitem", { intent: "i", prd: { miniReqs: ["m"] } });
    insertQitem({ id: "q-closed", dest: "dev-a@rig", tags: ["slice:22-closed-qitem"], summary: "old handoff", state: "closed" });

    const body = await (await app.request("/api/review/slice/22-closed-qitem")).json();
    expect(body.phase).toBe("spec");
    expect(body.agents.rows).toHaveLength(0);
  });

  it("mission ledger replays the tracking-gap scenario omission-proof", async () => {
    for (const n of ["s1", "s2", "s3"]) {
      const dir = writeFixtureSlice(ws, "release-gap", n, { intent: "i", prd: { miniReqs: ["m"] } });
      writeFullGateSet(dir, n, `cand-${n}`);
    }
    writeFixtureSlice(ws, "release-gap", "s4-inflight", { intent: "i", prd: { miniReqs: ["m"] } });

    const res = await app.request("/api/review/mission/release-gap");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ledger).toHaveLength(4);
    expect(body.ledger.filter((r: { green: boolean }) => r.green)).toHaveLength(3);
    expect(body.cutComplete).toBe(false); // green-but-unmerged is never cut-complete
    expect(body.cutCompleteBasis).toContain("not cut-complete");
    expect(body.board).toHaveLength(4);
  });

  it("agents scope projection: slice-scoped membership, never rig co-residency", async () => {
    writeFixtureSlice(ws, "release-t", "23-agents", { intent: "i", prd: { miniReqs: ["m"] } });
    insertQitem({ id: "q1", dest: "dev-a@rig", tags: ["slice:23-agents"], summary: "building the thing" });
    insertQitem({ id: "q2", dest: "dev-b@rig", tags: ["slice:other-slice"], summary: "other work" });

    const res = await app.request("/api/review/agents?scope=slice:23-agents");
    expect(res.status).toBe(200);
    const band = await res.json();
    expect(band.rows).toHaveLength(1);
    expect(band.rows[0]).toMatchObject({ sessionName: "dev-a@rig", doing: "building the thing", holdsCount: 1, stateGlyph: "unknown" });

    const rig = await (await app.request("/api/review/agents?scope=rig")).json();
    expect(rig.rows.map((r: { sessionName: string }) => r.sessionName).sort()).toEqual(["dev-a@rig", "dev-b@rig"]);
  });

  it("validates the three-valued scope parameter", async () => {
    expect((await app.request("/api/review/agents?scope=pod:x")).status).toBe(400);
    expect((await app.request("/api/review/agents")).status).toBe(400);
    expect((await app.request("/api/review/agents?scope=slice:nope")).status).toBe(404);
  });

  it("human-routed slice-tagged qitems land in NEEDS YOU with the #6 actor/destination member", async () => {
    writeFixtureSlice(ws, "release-t", "24-needs", { intent: "i", prd: { miniReqs: ["m"] } });
    insertQitem({ id: "q-h", dest: "human-review@kernel", tags: ["slice:24-needs"], summary: "approve the cut", tier: "human-gate", state: "pending" });

    const body = await (await app.request("/api/review/slice/24-needs")).json();
    const item = body.needsYou.items.find((i: { qitemId: string | null }) => i.qitemId === "q-h");
    expect(item).toMatchObject({ summary: "approve the cut", destinationSession: "human-review@kernel", source: "agent" });
    expect(body.needsYou.provenance).toContain("computed from");
  });

  it("uses the latest-dropped candidate for both displayed lineage and git freshness facts", async () => {
    const { repo, oldSha, newSha } = makeLineageRepo(ws.root);
    const dir = writeFixtureSlice(ws, "release-t", "24-lineage", { intent: "i", prd: { miniReqs: ["m"] } });
    writeProofArtifact(dir, {
      slice: "24-lineage",
      candidateSha: oldSha,
      artifactType: "qa",
      verdict: "PASS",
      fileName: "a-old.md",
      mtime: new Date("2026-07-04T10:00:00Z"),
    });
    writeProofArtifact(dir, {
      slice: "24-lineage",
      candidateSha: newSha,
      artifactType: "qa",
      verdict: "PASS",
      fileName: "z-new.md",
      mtime: new Date("2026-07-04T11:00:00Z"),
    });

    const indexer = new SliceIndexer({ slicesRoot: ws.root, additionalSliceRoots: [], dogfoodEvidenceRoot: null, db });
    const gatherer = new ReviewGatherer({ db, indexer, gitRepoPath: repo, now: () => NOW });
    const gitApp = new Hono();
    gitApp.use("*", async (c, next) => {
      c.set("reviewGatherer" as never, gatherer);
      await next();
    });
    gitApp.route("/api/review", reviewRoutes());

    const body = await (await gitApp.request("/api/review/slice/24-lineage")).json();
    expect(body.lineage.candidateSha).toBe(newSha);
    expect(body.lineage.freshness).toBe("fresh");
    expect(body.lineage.staleBehind).toBeNull();
  });

  it("404s unknown slices and missions; proven-empty NEEDS YOU carries provenance", async () => {
    expect((await app.request("/api/review/slice/none")).status).toBe(404);
    expect((await app.request("/api/review/mission/none")).status).toBe(404);
    writeFixtureSlice(ws, "release-t", "25-empty", { intent: "i", prd: false });
    const body = await (await app.request("/api/review/slice/25-empty")).json();
    expect(body.phase).toBe("intent");
    expect(body.plan.concise.text).toBeNull(); // not specced — degrades, never synthesized
    expect(body.plan.ssotPath).toBeNull();
    expect(body.needsYou.provenance).toContain("0 attention items");
  });
});

// OPR.0.4.4.22 — GET /api/review/rig (the rig-scope standalone altitude root).
describe("GET /api/review/rig (OPR.0.4.4.22)", () => {
  let ws: FixtureWorkspace;
  let db: Database.Database;
  let app: Hono;

  beforeEach(() => {
    ws = makeFixtureWorkspace();
    db = createDb(":memory:");
    migrate(db, [
      coreSchema,
      bindingsSessionsSchema,
      eventsSchema,
      streamItemsSchema,
      queueItemsSchema,
      queueTransitionsSchema,
      missionControlActionsSchema,
      queueItemSummarySchema,
    ]);
    const indexer = new SliceIndexer({ slicesRoot: ws.root, additionalSliceRoots: [], dogfoodEvidenceRoot: null, db });
    const gatherer = new ReviewGatherer({ db, indexer, gitRepoPath: null, now: () => NOW });
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("reviewGatherer" as never, gatherer);
      await next();
    });
    app.route("/api/review", reviewRoutes());
  });

  afterEach(() => {
    db.close();
    fs.rmSync(ws.root, { recursive: true, force: true });
  });

  function insert(opts: {
    id: string;
    dest: string;
    state?: string;
    tags?: string[];
    summary?: string | null;
    tier?: string | null;
    tsUpdated?: string;
    closureRequiredAt?: string | null;
  }) {
    db.prepare(
      `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, tier, tags, body, summary, closure_required_at)
       VALUES (?, ?, ?, 'src@r', ?, ?, 'high', ?, ?, 'body', ?, ?)`,
    ).run(
      opts.id,
      NOW,
      opts.tsUpdated ?? NOW,
      opts.dest,
      opts.state ?? "in-progress",
      opts.tier ?? null,
      JSON.stringify(opts.tags ?? []),
      opts.summary ?? null,
      opts.closureRequiredAt ?? null,
    );
  }

  function insertTransition(opts: { qitemId: string; ts: string; actor: string; closureReason?: string; closureTarget?: string }) {
    db.prepare(
      `INSERT INTO queue_transitions (qitem_id, ts, state, actor_session, closure_reason, closure_target)
       VALUES (?, ?, 'handed-off', ?, ?, ?)`,
    ).run(opts.qitemId, opts.ts, opts.actor, opts.closureReason ?? null, opts.closureTarget ?? null);
  }

  it("composes roster + park + health + settled in one root; C6 summaries as labels", async () => {
    insert({ id: "q-hold", dest: "driver@r", tags: ["slice:20-x"], summary: "building the follow-mode half" });
    insert({ id: "q-park", dest: "planner@r", state: "blocked", tags: ["slice:20-x"], summary: "waiting on your call", tier: "human-gate" });
    db.prepare("UPDATE queue_items SET blocked_on = 'human-review@kernel' WHERE qitem_id = 'q-park'").run();
    insertTransition({ qitemId: "q-done", ts: NOW, actor: "driver@r", closureReason: "handed_off_to", closureTarget: "qa@r" });

    const res = await app.request("/api/review/rig");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope).toBe("rig");
    const sessions = body.agents.rows.map((r: { sessionName: string }) => r.sessionName);
    expect(sessions).toContain("driver@r");
    const driverRow = body.agents.rows.find((r: { sessionName: string }) => r.sessionName === "driver@r");
    expect(driverRow.doing).toBe("building the follow-mode half");
    // No activity relay in this fixture -> honest unknown, never guessed.
    expect(driverRow.stateGlyph).toBe("unknown");
    // The park lands in NEEDS YOU.
    expect(body.needsYou.items.some((i: { summary: string }) => i.summary === "waiting on your call")).toBe(true);
    const parkedRow = body.agents.rows.find((r: { sessionName: string }) => r.sessionName === "planner@r");
    expect(parkedRow).toMatchObject({ stateGlyph: "parked", doing: "waiting on your call" });
    // Health + SETTLED agree (same transitions query).
    expect(body.agents.coordinationHealth).toContain("1 handoffs today");
    expect(body.settled).toHaveLength(1);
    expect(body.settled[0]).toMatchObject({ fromSession: "driver@r", toSession: "qa@r" });
  });

  it("keeps human-routed qitems in NEEDS YOU without turning the human seat into an AGENTS row", async () => {
    insert({ id: "q-human", dest: "human-review@kernel", tags: ["slice:20-x"], summary: "approve the demo", tier: "human-gate", state: "pending" });

    const body = await (await app.request("/api/review/rig")).json();
    expect(body.needsYou.items.some((i: { qitemId: string | null }) => i.qitemId === "q-human")).toBe(true);
    expect(body.agents.rows.some((r: { sessionName: string }) => r.sessionName === "human-review@kernel")).toBe(false);
  });

  it("recently-holding: an agent whose slice-tagged item closed TODAY appears with 'no tracked work item'", async () => {
    insert({ id: "q-closed", dest: "qa1@r", state: "done", tags: ["slice:20-x"], summary: "done work", tsUpdated: NOW });
    const res = await app.request("/api/review/rig");
    const body = await res.json();
    const row = body.agents.rows.find((r: { sessionName: string }) => r.sessionName === "qa1@r");
    expect(row).toBeDefined();
    expect(row.doing).toBe("no tracked work item");
    expect(row.holdsCount).toBe(0);
  });

  it("non-human overdue in-progress slice work appears as a derived NEEDS YOU exception and the health count", async () => {
    insert({
      id: "q-overdue",
      dest: "driver@r",
      tags: ["slice:20-x"],
      summary: "late handoff",
      closureRequiredAt: "2026-07-04T11:00:00.000Z",
    });

    const res = await app.request("/api/review/rig");
    const body = await res.json();
    expect(body.agents.coordinationHealth).toContain("1 overdue");
    const overdue = body.needsYou.items.find((i: { derived?: { kind: string } | null; qitemId: string | null }) => i.qitemId === null && i.derived?.kind === "overdue");
    expect(overdue).toMatchObject({ summary: "late handoff is overdue", where: "rig" });
  });

  it("activity telemetry uses the composer clock + event time so idle-with-work proof is stable", async () => {
    insert({ id: "q-idle", dest: "driver@r", tags: ["slice:20-x"], summary: "holding work while idle" });
    db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'rig-one')").run();
    db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime) VALUES ('node-1', 'rig-1', 'driver', 'codex')").run();
    db.prepare("INSERT INTO sessions (id, node_id, session_name, status, created_at) VALUES ('sess-1', 'node-1', 'driver@r', 'running', ?)").run(NOW);
    const eventBus = new EventBus(db);
    eventBus.emit({
      type: "agent.activity",
      rigId: "rig-1",
      nodeId: "node-1",
      sessionName: "driver@r",
      runtime: "codex",
      activity: {
        state: "idle",
        reason: "idle_prompt",
        evidenceSource: "runtime_hook",
        sampledAt: "2026-07-04T11:13:00.000Z",
        evidence: "idle_prompt",
        eventAt: "2026-07-04T11:13:00.000Z",
        fallback: false,
        stale: false,
      },
    });
    const indexer = new SliceIndexer({ slicesRoot: ws.root, additionalSliceRoots: [], dogfoodEvidenceRoot: null, db });
    const activityStore = new AgentActivityStore({
      db,
      eventBus,
      now: () => new Date("2030-01-01T00:00:00.000Z"),
      freshnessMs: 10 * 365 * 24 * 60 * 60 * 1000,
    });
    const gatherer = new ReviewGatherer({ db, indexer, gitRepoPath: null, activityStore, now: () => NOW });
    const activityApp = new Hono();
    activityApp.use("*", async (c, next) => {
      c.set("reviewGatherer" as never, gatherer);
      await next();
    });
    activityApp.route("/api/review", reviewRoutes());

    const a = await (await activityApp.request("/api/review/rig")).json();
    const b = await (await activityApp.request("/api/review/rig")).json();
    const row = a.agents.rows.find((r: { sessionName: string }) => r.sessionName === "driver@r");
    expect(row).toMatchObject({ stateGlyph: "idle", runtime: "codex" });
    expect(row.exception).toMatchObject({ kind: "stuck", evidence: "idle 47m >= 30m default · holds 1" });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("proven-empty rig renders provenance with the display window, never blank", async () => {
    const res = await app.request("/api/review/rig");
    const body = await res.json();
    expect(body.agents.rows).toHaveLength(0);
    expect(body.agents.provenance).toContain("window: today");
    expect(body.settledProvenance).toContain("0 handoffs today");
  });

  it("idempotent: two requests over unchanged inputs return byte-identical bodies", async () => {
    insert({ id: "q-1", dest: "a@r", tags: ["slice:s"], summary: "s" });
    const a = await (await app.request("/api/review/rig")).text();
    const b = await (await app.request("/api/review/rig")).text();
    expect(a).toBe(b);
  });

  it("503 when the composer is unwired (honest error, not empty)", async () => {
    const bare = new Hono();
    bare.route("/api/review", reviewRoutes());
    const res = await bare.request("/api/review/rig");
    expect(res.status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// qitem-ccf87c0d amended gate — composeMission composite-operation load
// contract. On 75245ed6, composeMission runs a cold list() (one 2-scan
// batch) then gatherSlice()->indexer.get() once per uncached mission slice
// (one MORE 2-scan batch each): 2 + 2N MEMBERSHIP scans — 82 at 40 slices
// (guard-reproduced; the exact inventory is 204 total queue reads, of which
// 82 are membership — see the matcher doc below). The contract: one mission
// compose = a CONSTANT number of membership-scan executions.
// ---------------------------------------------------------------------------

describe("qitem-ccf87c0d — composeMission MEMBERSHIP-scan load contract", () => {
  /** Count EXECUTIONS (.all/.iterate/.get) of the MEMBERSHIP-SCAN shapes —
   *  the statement class the batch/scope fix owns, counted by NAMED shape
   *  (guard audit trail; inventory at 40 slices/1 row: these two shapes are
   *  41+41=82 pre-fix, exactly the 2+2N regression; the OTHER 122 queue
   *  reads are pre-existing Review projections — 82x attention/agent
   *  projection reads, 40x hasActiveQitem `state IN … AND tags LIKE ?` —
   *  present on parent 7b19b73e and untouched by the locked fix, so
   *  counting them would make the constant-scan contract unsatisfiable
   *  in scope):
   *    (a) typed membership scan  — tags LIKE '%slice:%'
   *    (b) batch fallback scan    — FROM queue_items with NO WHERE clause
   *    (c) legacy per-slice tiers — WHERE tags LIKE ? ORDER BY / body LIKE ?
   *  INSERT seeding and PK point lookups (WHERE qitem_id IN) pass through. */
  function instrumentMembershipScans(target: Database.Database): () => number {
    let n = 0;
    const origPrepare = target.prepare.bind(target);
    (target as unknown as { prepare: (sql: string) => unknown }).prepare = (sql: string) => {
      const stmt = origPrepare(sql) as unknown as Record<string, (...a: unknown[]) => unknown>;
      const flat = sql.replace(/\s+/g, " ");
      const isMembershipScan = /from queue_items/i.test(flat)
        && !/^\s*insert/i.test(flat)
        && (
          /tags LIKE '%slice:%'/i.test(flat)
          || !/ where /i.test(flat)
          || /where tags like \? order by/i.test(flat)
          || /where body like \?/i.test(flat)
        );
      if (!isMembershipScan) return stmt;
      return {
        all: (...a: unknown[]) => { n++; return stmt.all!(...a); },
        iterate: (...a: unknown[]) => { n++; return stmt.iterate!(...a); },
        get: (...a: unknown[]) => { n++; return stmt.get!(...a); },
        run: (...a: unknown[]) => stmt.run!(...a),
      };
    };
    return () => n;
  }

  it("one composeMission over 40 indexed slices executes <= 4 membership queue scans AND composes all 40 ledger entries", () => {
    const db = createDb();
    migrate(db, [
      coreSchema, bindingsSessionsSchema, eventsSchema, streamItemsSchema,
      queueItemsSchema, queueTransitionsSchema, missionControlActionsSchema,
      queueItemSummarySchema,
    ]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-load', 'rig')`).run();
    // Guard repro shape: exactly one queue row (matches no slice, so no
    // per-slice IN lookups fire — the count isolates the scan class).
    db.prepare(
      `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, priority, body)
       VALUES ('q-lone', '2026-07-04T00:00:00.000Z', '2026-07-04T00:00:00.000Z', 'a@r', 'b@r', 'done', 'routine', 'fixture')`,
    ).run();
    const ws = makeFixtureWorkspace();
    for (let i = 0; i < 40; i++) {
      writeFixtureSlice(ws, "load-mission", `ld-${String(i).padStart(2, "0")}-topic`, {});
    }
    const indexer = new SliceIndexer({ slicesRoot: ws.root, dogfoodEvidenceRoot: null, db });
    const scans = instrumentMembershipScans(db);
    const gatherer = new ReviewGatherer({ db, indexer, gitRepoPath: null, now: () => NOW });
    const composed = gatherer.composeMission("load-mission");
    expect(composed).toBeTruthy();
    expect(composed!.ledger).toHaveLength(40); // semantic: every slice composed
    // Pre-fix on 75245ed6: 2 (cold list batch) + 40x2 (one batch per
    // uncached gatherSlice get) = 82 membership scans. Contract: constant.
    expect(scans()).toBeLessThanOrEqual(4);
    db.close();
    fs.rmSync(ws.root, { recursive: true, force: true });
  });
});
