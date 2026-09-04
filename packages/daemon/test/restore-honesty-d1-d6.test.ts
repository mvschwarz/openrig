// OPR.0.5.7.1 — RESTORE HONESTY, narrowed repair child D1+D6a (amended SPEC
// post-stamp sha256 a2fbcd795fa9bb215917027fc09d76628fd0308da480fd7ba803a0120b14ed61,
// A1 independently re-stamped; desk ruling qitem-20260829080039-c47a571e).
//
// D1 FOUR-WAY OCCUPANT TRUTH: the ONLY case where legacy inference may run is
// the WHOLE activeSessionIdByNode field being absent (a pre-convention
// snapshot). A PRESENT map with a null value, a MISSING node key, or a
// DANGLING id each fails LOUDLY with zero resume and zero replacement
// occupant — never newest-row-wins, never silently legacy. The fixture
// premise is EXPLICIT: every snapshot rewrite states its relation mode;
// nothing is cloned accidentally from capture.
//
// D6a UNCONDITIONAL ZERO REPLAY: an exact resume cannot replay startup or
// onboarding content, and replay-ONLY validation cannot block the resume
// (the incident's own discriminator: continuity never needed the replay
// container). A deliberate fresh launch still validates its replay inputs in
// full. The former replay opt-in surface is REMOVED WHOLE — the absence pin
// below proves no encoding of it survives in this child's source or tests.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type Database from "better-sqlite3";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { ClaudeResumeAdapter, ResumeResult } from "../src/adapters/claude-resume.js";
import type { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import type { Snapshot } from "../src/domain/types.js";
import { createFullTestDb } from "./helpers/test-app.js";

// Hand-authored ULIDs where lexical order is the trap: OLD sorts before NEW,
// so "latest = max id" (the retired defect) would pick NEW.
const ULID_OLD = "01ARZ3NDEKTSV4RRFFQ69G5AAA";
const ULID_MID = "01ARZ3NDEKTSV4RRFFQ69G5MMM";
const ULID_NEW = "01ARZ3NDEKTSV4RRFFQ69G5ZZZ";
const ULID_GONE = "01ARZ3NDEKTSV4RRFFQ69G5XXX"; // named by a dangling relation

function mockTmux(): TmuxAdapter {
  return {
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    getPaneCommand: vi.fn(async () => "claude"),
    capturePaneContent: vi.fn(async () => ""),
    listSessions: async () => [],
    listWindows: async () => [],
    listPanes: async () => [],
    hasSession: async () => false,
  } as unknown as TmuxAdapter;
}

function mockClaudeResume(result?: ResumeResult): ClaudeResumeAdapter {
  return {
    canResume: vi.fn((type: string | null) => type === "claude_name" || type === "claude_id"),
    resume: vi.fn(async () => result ?? { ok: true as const }),
  } as unknown as ClaudeResumeAdapter;
}

function mockCodexResume(): CodexResumeAdapter {
  return {
    canResume: vi.fn(() => false),
    resume: vi.fn(async () => ({ ok: true as const })),
  } as unknown as CodexResumeAdapter;
}

/** Content-channel spy adapter: `project` carries projection entries,
 *  `deliverStartup` carries startup files/actions. */
function spyRuntimeAdapter() {
  return {
    runtime: "claude-code",
    listInstalled: vi.fn(async () => []),
    project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
    deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
    checkReady: vi.fn(async () => ({ ready: true })),
    launchHarness: vi.fn(async () => ({ ok: true as const, resumeToken: "t", resumeType: "claude_id" })),
  };
}

/** The relation mode a fixture DECLARES — no state is ever cloned by accident
 *  from capture (the hidden-premise defect the repair ruling named). */
type RelationMode =
  | { mode: "field-absent" }
  | { mode: "explicit-null" }
  | { mode: "missing-node-key" }
  | { mode: "explicit-id"; id: string }
  | { mode: "dangling-id"; id: string };

describe("OPR.0.5.7.1 repair child — D1 four-way occupant truth + D6a unconditional zero replay", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let snapshotRepo: SnapshotRepository;
  let checkpointStore: CheckpointStore;
  let snapshotCapture: SnapshotCapture;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    snapshotRepo = new SnapshotRepository(db);
    checkpointStore = new CheckpointStore(db);
    snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
  });

  afterEach(() => {
    db.close();
  });

  function createOrchestrator(opts?: { claude?: ClaudeResumeAdapter; tmux?: TmuxAdapter }) {
    const tmux = opts?.tmux ?? mockTmux();
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    return new RestoreOrchestrator({
      db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
      checkpointStore, nodeLauncher, tmuxAdapter: tmux,
      claudeResume: opts?.claude ?? mockClaudeResume(),
      codexResume: mockCodexResume(),
    });
  }

  function seedSnapshot(opts?: { startupContext?: { entries: unknown[]; files: unknown[]; actions: unknown[] } }): { snap: Snapshot; nodeId: string } {
    const rig = rigRepo.createRig("r77");
    const node = rigRepo.addNode(rig.id, "seat", { role: "worker", runtime: "claude-code" });
    const sess = sessionRegistry.registerSession(node.id, "r77-seat");
    db.prepare("UPDATE sessions SET resume_type = ?, resume_token = ?, restore_policy = ? WHERE id = ?")
      .run("claude_name", "tok-seed", "resume_if_possible", sess.id);
    if (opts?.startupContext) {
      db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)")
        .run(node.id, JSON.stringify(opts.startupContext.entries), JSON.stringify(opts.startupContext.files), JSON.stringify(opts.startupContext.actions), "claude-code");
    }
    const snap = snapshotCapture.captureSnapshot(rig.id, "manual");
    sessionRegistry.updateStatus(sess.id, "exited");
    db.prepare("DELETE FROM bindings WHERE node_id = ?").run(node.id);
    return { snap, nodeId: node.id };
  }

  /** Rewrite the snapshot's session rows AND its relation state, both stated
   *  explicitly by the caller. */
  function rewriteSnapshot(
    snap: Snapshot,
    nodeId: string,
    rows: Array<{ id: string; status: string; token: string }>,
    relation: RelationMode,
  ): Snapshot {
    const data = JSON.parse(JSON.stringify(snap.data));
    const template = data.sessions.find((s: { nodeId: string }) => s.nodeId === nodeId);
    data.sessions = rows.map((r) => ({
      ...template,
      id: r.id,
      status: r.status,
      resumeType: "claude_name",
      resumeToken: r.token,
      restorePolicy: "resume_if_possible",
    }));
    // This suite pins compatibility with the predecessor relation field. A
    // freshly captured snapshot also carries the new tri-state relation, so
    // remove it before expressing each legacy relation premise below.
    delete data.activeOccupantsByNode;
    switch (relation.mode) {
      case "field-absent":
        delete data.activeSessionIdByNode;
        break;
      case "explicit-null":
        data.activeSessionIdByNode = { [nodeId]: null };
        break;
      case "missing-node-key":
        data.activeSessionIdByNode = { "some-other-node": null };
        break;
      case "explicit-id":
      case "dangling-id":
        data.activeSessionIdByNode = { [nodeId]: relation.id };
        break;
    }
    db.prepare("UPDATE snapshots SET data = ? WHERE id = ?").run(JSON.stringify(data), snap.id);
    const updated = snapshotRepo.getSnapshot(snap.id);
    if (!updated) throw new Error("expected updated snapshot");
    return updated;
  }

  const resumeTokenArg = (claude: ClaudeResumeAdapter, call = 0): unknown =>
    (claude.resume as ReturnType<typeof vi.fn>).mock.calls[call]?.[2];

  function expectLoudUnrecoverable(
    result: Awaited<ReturnType<RestoreOrchestrator["restore"]>>,
    claude: ClaudeResumeAdapter,
    naming?: string[],
  ) {
    expect(result.ok).toBe(true);
    if (result.ok) {
      const seat = result.result.nodes.find((n) => n.logicalId === "seat");
      expect(seat?.status).toBe("failed");
      const err = seat && "error" in seat ? String(seat.error) : "";
      expect(err.length).toBeGreaterThan(0);
      for (const term of naming ?? []) expect(err).toContain(term);
    }
    // Zero resume, zero replacement occupant: the seat's sessions are exactly
    // as the (stopped) prior state left them — nothing launched.
    expect(claude.resume).not.toHaveBeenCalled();
  }

  // ------------------------------------------------------------------ D1 ---

  it("D1-legacy-single: WHOLE field absent + a single row — legacy inference resolves it", async () => {
    const { snap, nodeId } = seedSnapshot();
    const fixed = rewriteSnapshot(snap, nodeId, [
      { id: ULID_OLD, status: "unknown", token: "tok-active" },
    ], { mode: "field-absent" });
    const claude = mockClaudeResume();
    const result = await createOrchestrator({ claude }).restore(fixed.id);
    expect(result.ok).toBe(true);
    expect(resumeTokenArg(claude)).toBe("tok-active");
  });

  it("D1-legacy-uniquely-running: field absent + several rows — the uniquely-running row wins, never the newest ULID", async () => {
    const { snap, nodeId } = seedSnapshot();
    const fixed = rewriteSnapshot(snap, nodeId, [
      { id: ULID_OLD, status: "exited", token: "tok-oldest" },
      { id: ULID_MID, status: "running", token: "tok-active" },
      { id: ULID_NEW, status: "superseded", token: "tok-stale" },
    ], { mode: "field-absent" });
    const claude = mockClaudeResume();
    const result = await createOrchestrator({ claude }).restore(fixed.id);
    expect(result.ok).toBe(true);
    expect(resumeTokenArg(claude)).toBe("tok-active");
  });

  it("D1-legacy-ambiguous: field absent + two running rows — loud unrecoverable, zero resume, zero replacement", async () => {
    const { snap, nodeId } = seedSnapshot();
    const fixed = rewriteSnapshot(snap, nodeId, [
      { id: ULID_OLD, status: "running", token: "tok-a" },
      { id: ULID_NEW, status: "running", token: "tok-b" },
    ], { mode: "field-absent" });
    const claude = mockClaudeResume();
    const result = await createOrchestrator({ claude }).restore(fixed.id);
    expectLoudUnrecoverable(result, claude, [ULID_OLD, ULID_NEW]);
  });

  it("D1-explicit-hit: a valid explicit relation is consumed directly, no status inference", async () => {
    const { snap, nodeId } = seedSnapshot();
    const fixed = rewriteSnapshot(snap, nodeId, [
      { id: ULID_OLD, status: "detached", token: "tok-active" },
      { id: ULID_NEW, status: "detached", token: "tok-stale" },
    ], { mode: "explicit-id", id: ULID_OLD });
    const claude = mockClaudeResume();
    const result = await createOrchestrator({ claude }).restore(fixed.id);
    expect(result.ok).toBe(true);
    expect(resumeTokenArg(claude)).toBe("tok-active");
  });

  it("D1-present-null: PRESENT map + explicit null with historical rows — loud unrecoverable, never silently legacy", async () => {
    const { snap, nodeId } = seedSnapshot();
    const fixed = rewriteSnapshot(snap, nodeId, [
      { id: ULID_OLD, status: "running", token: "tok-a" },
      { id: ULID_NEW, status: "superseded", token: "tok-b" },
    ], { mode: "explicit-null" });
    const claude = mockClaudeResume();
    const result = await createOrchestrator({ claude }).restore(fixed.id);
    expectLoudUnrecoverable(result, claude);
  });

  it("D1-missing-key: PRESENT map missing this node's key — loud unrecoverable, never silently legacy", async () => {
    const { snap, nodeId } = seedSnapshot();
    const fixed = rewriteSnapshot(snap, nodeId, [
      { id: ULID_OLD, status: "running", token: "tok-a" },
    ], { mode: "missing-node-key" });
    const claude = mockClaudeResume();
    const result = await createOrchestrator({ claude }).restore(fixed.id);
    expectLoudUnrecoverable(result, claude);
  });

  it("D1-dangling: a non-null relation naming no snapshot row — loud unrecoverable NAMING the offending relation", async () => {
    const { snap, nodeId } = seedSnapshot();
    const fixed = rewriteSnapshot(snap, nodeId, [
      { id: ULID_OLD, status: "running", token: "tok-a" },
    ], { mode: "dangling-id", id: ULID_GONE });
    const claude = mockClaudeResume();
    const result = await createOrchestrator({ claude }).restore(fixed.id);
    expectLoudUnrecoverable(result, claude, [ULID_GONE]);
  });

  it("D1-absence-pin: the max-ULID reduce stays gone from the production source (second encoding)", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = fs.readFileSync(path.join(here, "../src/domain/restore-orchestrator.ts"), "utf8");
    const hits = source.match(/s\.id > latest\.id \? s : latest/g) ?? [];
    expect(hits).toHaveLength(0);
  });

  it("D1-roundtrip: capture + JSON persistence preserves a valid explicit relation AND an explicit null", async () => {
    // (a) exactly one RUNNING session row: capture records it as the occupant.
    // (Desk ruling on 0ecd79a3: registerSession's default 'unknown' is a
    // fixture premise, not an occupant — capture semantics stay
    // exactly-one-running, so the fixture states the occupancy explicitly.)
    const rigA = rigRepo.createRig("rt-a");
    const nodeA = rigRepo.addNode(rigA.id, "seat", { role: "worker", runtime: "claude-code" });
    const sessA = sessionRegistry.registerSession(nodeA.id, "r78-seat");
    sessionRegistry.updateStatus(sessA.id, "running");
    const snapA = snapshotCapture.captureSnapshot(rigA.id, "manual");
    const rawA = db.prepare("SELECT data FROM snapshots WHERE id = ?").get(snapA.id) as { data: string };
    expect(JSON.parse(rawA.data).activeSessionIdByNode[nodeA.id]).toBe(sessA.id);

    // (b) several rows, none uniquely running: capture records an EXPLICIT
    // null (ambiguous at source, recorded honestly) and JSON keeps it.
    const rigB = rigRepo.createRig("rt-b");
    const nodeB = rigRepo.addNode(rigB.id, "seat", { role: "worker", runtime: "claude-code" });
    const s1 = sessionRegistry.registerSession(nodeB.id, "r79-seat");
    const s2 = sessionRegistry.registerSession(nodeB.id, "r79-seat-v2");
    sessionRegistry.updateStatus(s1.id, "running");
    sessionRegistry.updateStatus(s2.id, "running");
    const snapB = snapshotCapture.captureSnapshot(rigB.id, "manual");
    const rawB = db.prepare("SELECT data FROM snapshots WHERE id = ?").get(snapB.id) as { data: string };
    const mapB = JSON.parse(rawB.data).activeSessionIdByNode;
    expect(Object.prototype.hasOwnProperty.call(mapB, nodeB.id)).toBe(true);
    expect(mapB[nodeB.id]).toBeNull();
  });

  // ----------------------------------------------------------------- D6a ---

  const GHOST_CONTEXT = {
    entries: [{
      absolutePath: "/tmp/never-read/CLAUDE.md",
      relativePath: "CLAUDE.md",
      category: "memory",
      mergeStrategy: "managed_block",
      content: "STARTUP-GHOST-BLOCK",
    }],
    files: [{ path: "required-onboarding.md", absolutePath: "/tmp/never-read/required-onboarding.md", required: true, appliesOn: ["restore"] }],
    actions: [{ type: "send_text", text: "STARTUP-GHOST-PROMPT", idempotent: true }],
  };

  it("D6a-resume-unblocked: exact resume + MISSING required replay-only file SUCCEEDS and delivers zero content", async () => {
    const { snap, nodeId } = seedSnapshot({ startupContext: GHOST_CONTEXT });
    const fixed = rewriteSnapshot(snap, nodeId, [
      { id: ULID_OLD, status: "running", token: "tok-active" },
    ], { mode: "explicit-id", id: ULID_OLD });
    const claude = mockClaudeResume();
    const adapter = spyRuntimeAdapter();
    const result = await createOrchestrator({ claude }).restore(fixed.id, {
      adapters: { "claude-code": adapter },
      // The required replay file does not exist. Replay-only validation must
      // not block the resume: continuity never needed the replay container.
      fsOps: { exists: (p) => !p.includes("never-read") },
    });
    expect(result.ok).toBe(true);
    expect(claude.resume).toHaveBeenCalledTimes(1);
    expect(resumeTokenArg(claude)).toBe("tok-active");
    const projectedEntries = (adapter.project.mock.calls[0]?.[0]?.entries ?? []) as unknown[];
    expect(projectedEntries).toHaveLength(0);
    const delivered = adapter.deliverStartup.mock.calls.flatMap((c) => JSON.stringify(c[0] ?? ""));
    expect(delivered.join("")).not.toContain("STARTUP-GHOST");
  });

  it("D6a-fresh-still-validates: a deliberate fresh launch with the same missing required file still fails validation", async () => {
    const { snap, nodeId } = seedSnapshot({ startupContext: GHOST_CONTEXT });
    const fixed = rewriteSnapshot(snap, nodeId, [
      { id: ULID_OLD, status: "running", token: "tok-active" },
    ], { mode: "explicit-id", id: ULID_OLD });
    const adapter = spyRuntimeAdapter();
    const result = await createOrchestrator().restore(fixed.id, {
      adapters: { "claude-code": adapter },
      fsOps: { exists: (p) => !p.includes("never-read") },
      freshLogicalIds: ["seat"],
    });
    // Deliberate fresh CONSUMES the replay inputs, so their validation stands.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("pre_restore_validation_failed");
  });

  it("D6a-zero-content-pin: exact resume with intact startup context still delivers ZERO content (launch leg intact)", async () => {
    const { snap, nodeId } = seedSnapshot({ startupContext: GHOST_CONTEXT });
    const fixed = rewriteSnapshot(snap, nodeId, [
      { id: ULID_OLD, status: "running", token: "tok-active" },
    ], { mode: "explicit-id", id: ULID_OLD });
    const claude = mockClaudeResume();
    const adapter = spyRuntimeAdapter();
    const result = await createOrchestrator({ claude }).restore(fixed.id, {
      adapters: { "claude-code": adapter },
    });
    expect(result.ok).toBe(true);
    expect(claude.resume).toHaveBeenCalledTimes(1);
    const projectedEntries = (adapter.project.mock.calls[0]?.[0]?.entries ?? []) as unknown[];
    expect(projectedEntries).toHaveLength(0);
  });

  it("D6a-fresh-replay-floor: a deliberate fresh launch keeps its startup replay when inputs exist", async () => {
    const { snap, nodeId } = seedSnapshot({ startupContext: GHOST_CONTEXT });
    const fixed = rewriteSnapshot(snap, nodeId, [
      { id: ULID_OLD, status: "running", token: "tok-active" },
    ], { mode: "explicit-id", id: ULID_OLD });
    const adapter = spyRuntimeAdapter();
    const result = await createOrchestrator().restore(fixed.id, {
      adapters: { "claude-code": adapter },
      freshLogicalIds: ["seat"],
      // every replay input exists on this path
    });
    expect(result.ok).toBe(true);
    const projectedEntries = (adapter.project.mock.calls[0]?.[0]?.entries ?? []) as unknown[];
    expect(projectedEntries.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------- opt-in surface gone ---

  it("D6a-optin-absence-pin: no encoding of the removed replay opt-in survives in this child's source or tests", () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // The identifier is constructed, never spelled contiguously here.
    const camel = ["startup", "Replay", "Opt", "In"].join("");
    const snake = ["startup", "replay", "opt", "in"].join("_");
    const kebab = ["startup", "replay", "opt", "in"].join("-");
    const needle = new RegExp(`${camel}|${snake}|${kebab}`, "i");
    const surfaces = [
      "../src/domain/restore-orchestrator.ts",
      "../src/domain/snapshot-capture.ts",
      "../src/domain/types.ts",
      "./restore-honesty-d1-d6.test.ts",
      "./restore-orchestrator.test.ts",
    ];
    for (const rel of surfaces) {
      const bytes = fs.readFileSync(path.join(here, rel), "utf8");
      const hit = bytes.match(needle);
      expect(hit, `${rel} must carry no encoding of the removed opt-in surface (found: ${hit?.[0] ?? "none"})`).toBeNull();
    }
  });
});
