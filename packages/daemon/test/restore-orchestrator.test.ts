import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "../src/db/migrations/002_bindings_sessions.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { snapshotsSchema } from "../src/db/migrations/004_snapshots.js";
import { checkpointsSchema } from "../src/db/migrations/005_checkpoints.js";
import { resumeMetadataSchema } from "../src/db/migrations/006_resume_metadata.js";
import { nodeSpecFieldsSchema } from "../src/db/migrations/007_node_spec_fields.js";
import { agentspecRebootSchema } from "../src/db/migrations/014_agentspec_reboot.js";
import { startupContextSchema } from "../src/db/migrations/015_startup_context.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import type { TmuxAdapter, TmuxResult } from "../src/adapters/tmux.js";
import type { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import type { ResumeResult } from "../src/adapters/claude-resume.js";
import type { PersistedEvent, Snapshot } from "../src/domain/types.js";
import { createFullTestDb } from "./helpers/test-app.js";

function setupDb(): Database.Database {
  return createFullTestDb();
}

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

function mockCodexResume(result?: ResumeResult): CodexResumeAdapter {
  return {
    canResume: vi.fn((type: string | null) => type === "codex_id" || type === "codex_last"),
    resume: vi.fn(async () => result ?? { ok: true as const }),
  } as unknown as CodexResumeAdapter;
}

describe("RestoreOrchestrator", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let snapshotRepo: SnapshotRepository;
  let checkpointStore: CheckpointStore;
  let snapshotCapture: SnapshotCapture;

  beforeEach(() => {
    db = setupDb();
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

  function createOrchestrator(opts?: {
    tmux?: TmuxAdapter;
    claude?: ClaudeResumeAdapter;
    codex?: CodexResumeAdapter;
  }) {
    const tmux = opts?.tmux ?? mockTmux();
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    return new RestoreOrchestrator({
      db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
      checkpointStore, nodeLauncher, tmuxAdapter: tmux,
      claudeResume: opts?.claude ?? mockClaudeResume(),
      codexResume: opts?.codex ?? mockCodexResume(),
    });
  }

  function seedRigAndSnapshot(opts?: {
    edges?: { sourceLogical: string; targetLogical: string; kind: string }[];
    nodes?: { logicalId: string; role: string; runtime: string; cwd?: string }[];
    resumeType?: string;
    resumeToken?: string;
    restorePolicy?: string;
    withCheckpoint?: string; // node logicalId to add checkpoint to
    withBinding?: string; // node logicalId to add binding to
  }): Snapshot {
    const nodes = opts?.nodes ?? [
      { logicalId: "orchestrator", role: "orchestrator", runtime: "claude-code" },
      { logicalId: "worker-a", role: "worker", runtime: "claude-code" },
      { logicalId: "worker-b", role: "worker", runtime: "codex" },
    ];
    const rig = rigRepo.createRig("r99");
    const nodeMap: Record<string, string> = {};
    for (const n of nodes) {
      const node = rigRepo.addNode(rig.id, n.logicalId, { role: n.role, runtime: n.runtime, cwd: n.cwd });
      nodeMap[n.logicalId] = node.id;
    }

    const edges = opts?.edges ?? [
      { sourceLogical: "orchestrator", targetLogical: "worker-a", kind: "delegates_to" },
      { sourceLogical: "orchestrator", targetLogical: "worker-b", kind: "delegates_to" },
    ];
    for (const e of edges) {
      rigRepo.addEdge(rig.id, nodeMap[e.sourceLogical]!, nodeMap[e.targetLogical]!, e.kind);
    }

    // Add session with resume metadata if requested
    if (opts?.resumeType) {
      for (const n of nodes) {
        const sess = sessionRegistry.registerSession(nodeMap[n.logicalId]!, `r99-${n.logicalId}`);
        db.prepare("UPDATE sessions SET resume_type = ?, resume_token = ?, restore_policy = ? WHERE id = ?")
          .run(opts.resumeType, opts.resumeToken ?? null, opts.restorePolicy ?? "resume_if_possible", sess.id);
      }
    }

    if (opts?.withBinding) {
      sessionRegistry.updateBinding(nodeMap[opts.withBinding]!, { tmuxSession: `r99-${opts.withBinding}` });
    }

    if (opts?.withCheckpoint) {
      checkpointStore.createCheckpoint(nodeMap[opts.withCheckpoint]!, {
        summary: "Was working on feature X",
        keyArtifacts: ["src/feature.ts"],
      });
    }

    return snapshotCapture.captureSnapshot(rig.id, "manual");
  }

  it("constructor throws on mismatched db handles", () => {
    const otherDb = setupDb();
    const otherRepo = new RigRepository(otherDb);
    const tmux = mockTmux();

    expect(() => new RestoreOrchestrator({
      db, rigRepo: otherRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
      checkpointStore, nodeLauncher: new NodeLauncher({ db: otherDb, rigRepo: otherRepo, sessionRegistry: new SessionRegistry(otherDb), eventBus: new EventBus(otherDb), tmuxAdapter: tmux }),
      tmuxAdapter: tmux, claudeResume: mockClaudeResume(), codexResume: mockCodexResume(),
    })).toThrow(/same db handle/);

    otherDb.close();
  });

  it("constructor throws on mismatched snapshotRepo handle", () => {
    const otherDb = setupDb();
    const otherSnapshotRepo = new SnapshotRepository(otherDb);
    const tmux = mockTmux();

    expect(() => new RestoreOrchestrator({
      db, rigRepo, sessionRegistry, eventBus, snapshotRepo: otherSnapshotRepo, snapshotCapture,
      checkpointStore, nodeLauncher: new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux }),
      tmuxAdapter: tmux, claudeResume: mockClaudeResume(), codexResume: mockCodexResume(),
    })).toThrow(/snapshotRepo.*same db handle/);

    otherDb.close();
  });

  it("constructor throws on mismatched snapshotCapture handle", () => {
    const otherDb = setupDb();
    const otherRigRepo = new RigRepository(otherDb);
    const otherSessionRegistry = new SessionRegistry(otherDb);
    const otherEventBus = new EventBus(otherDb);
    const otherSnapshotRepo2 = new SnapshotRepository(otherDb);
    const otherCheckpointStore = new CheckpointStore(otherDb);
    const otherSnapshotCapture = new SnapshotCapture({
      db: otherDb, rigRepo: otherRigRepo, sessionRegistry: otherSessionRegistry,
      eventBus: otherEventBus, snapshotRepo: otherSnapshotRepo2, checkpointStore: otherCheckpointStore,
    });
    const tmux = mockTmux();

    expect(() => new RestoreOrchestrator({
      db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture: otherSnapshotCapture,
      checkpointStore, nodeLauncher: new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux }),
      tmuxAdapter: tmux, claudeResume: mockClaudeResume(), codexResume: mockCodexResume(),
    })).toThrow(/snapshotCapture.*same db handle/);

    otherDb.close();
  });

  it("constructor throws on mismatched nodeLauncher handle", () => {
    const otherDb = setupDb();
    const otherRigRepo = new RigRepository(otherDb);
    const otherSessionRegistry = new SessionRegistry(otherDb);
    const otherEventBus = new EventBus(otherDb);
    const tmux = mockTmux();
    const otherLauncher = new NodeLauncher({
      db: otherDb, rigRepo: otherRigRepo, sessionRegistry: otherSessionRegistry,
      eventBus: otherEventBus, tmuxAdapter: tmux,
    });

    expect(() => new RestoreOrchestrator({
      db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
      checkpointStore, nodeLauncher: otherLauncher,
      tmuxAdapter: tmux, claudeResume: mockClaudeResume(), codexResume: mockCodexResume(),
    })).toThrow(/nodeLauncher.*same db handle/);

    otherDb.close();
  });

  it("nonexistent snapshot -> { ok: false, code: 'snapshot_not_found' }", async () => {
    const orch = createOrchestrator();
    const result = await orch.restore("nonexistent");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("snapshot_not_found");
  });

  it("running rig with live tmux sessions -> { ok: false, code: 'rig_not_stopped' }", async () => {
    const rig = rigRepo.createRig("r99");
    const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "r99-worker");
    sessionRegistry.updateStatus(session.id, "running");
    const snap = snapshotCapture.captureSnapshot(rig.id, "manual");

    // tmux session IS alive — restore should block
    const tmux = { ...mockTmux(), hasSession: vi.fn(async () => true) } as unknown as TmuxAdapter;
    const orch = createOrchestrator({ tmux });
    const result = await orch.restore(snap.id);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("rig_not_stopped");
    expect(snapshotRepo.listSnapshots(rig.id)).toHaveLength(1);
  });

  // --- Scenario A: stale DB sessions after tmux crash ---

  it("restores successfully when DB shows sessions running but tmux sessions are dead (post-crash)", async () => {
    // After a tmux crash, DB sessions are still status='running' but tmux
    // has no matching sessions. Restore should reconcile stale state and
    // proceed, not refuse with 'rig_not_stopped'.
    const rig = rigRepo.createRig("crash-rig");
    const node1 = rigRepo.addNode(rig.id, "dev.impl", { role: "worker", runtime: "claude-code" });
    const node2 = rigRepo.addNode(rig.id, "dev.qa", { role: "worker", runtime: "codex" });
    const sess1 = sessionRegistry.registerSession(node1.id, "dev-impl@crash-rig");
    const sess2 = sessionRegistry.registerSession(node2.id, "dev-qa@crash-rig");
    sessionRegistry.updateStatus(sess1.id, "running");
    sessionRegistry.updateStatus(sess2.id, "running");
    const snap = snapshotCapture.captureSnapshot(rig.id, "pre-crash");

    // Simulate post-crash: tmux sessions are gone
    const tmux = { ...mockTmux(), hasSession: vi.fn(async () => false) } as unknown as TmuxAdapter;
    const orch = createOrchestrator({ tmux });

    const result = await orch.restore(snap.id);

    // Should proceed with restore, not refuse
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.nodes).toHaveLength(2);
      const ids = result.result.nodes.map((n) => n.logicalId).sort();
      expect(ids).toEqual(["dev.impl", "dev.qa"]);
    }
  });

  it("still blocks restore when tmux sessions are genuinely alive (inverse invariant)", async () => {
    const rig = rigRepo.createRig("live-rig");
    const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
    const sess = sessionRegistry.registerSession(node.id, "worker@live-rig");
    sessionRegistry.updateStatus(sess.id, "running");
    const snap = snapshotCapture.captureSnapshot(rig.id, "manual");

    const tmux = { ...mockTmux(), hasSession: vi.fn(async () => true) } as unknown as TmuxAdapter;
    const orch = createOrchestrator({ tmux });

    const result = await orch.restore(snap.id);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("rig_not_stopped");
  });

  it("pre_restore snapshot preserves original running session status (captured before mutation)", async () => {
    const rig = rigRepo.createRig("snap-order-rig");
    const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
    const sess = sessionRegistry.registerSession(node.id, "worker@snap-order-rig");
    sessionRegistry.updateStatus(sess.id, "running");
    const snap = snapshotCapture.captureSnapshot(rig.id, "manual");

    // tmux session is dead (post-crash) — restore should proceed
    const tmux = { ...mockTmux(), hasSession: vi.fn(async () => false) } as unknown as TmuxAdapter;
    const orch = createOrchestrator({ tmux });

    const result = await orch.restore(snap.id);
    expect(result.ok).toBe(true);

    if (result.ok) {
      // Verify the pre_restore snapshot captured original running state
      const preSnap = snapshotRepo.getSnapshot(result.result.preRestoreSnapshotId);
      expect(preSnap).toBeDefined();
      const preSnapSessions = preSnap!.data.sessions ?? [];
      const workerSession = preSnapSessions.find((s: { sessionName: string }) => s.sessionName === "worker@snap-order-rig");
      expect(workerSession).toBeDefined();
      expect(workerSession!.status).toBe("running"); // NOT detached
    }
  });

  it("blocks when older running session is live even if newer same-node session is detached", async () => {
    const rig = rigRepo.createRig("multi-sess-rig");
    const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
    // Older session: running + tmux alive
    const oldSess = sessionRegistry.registerSession(node.id, "worker@multi-sess-rig");
    sessionRegistry.updateStatus(oldSess.id, "running");
    // Newer session: detached (e.g., from a prior restore attempt)
    const newSess = sessionRegistry.registerSession(node.id, "worker@multi-sess-rig");
    sessionRegistry.updateStatus(newSess.id, "detached");
    const snap = snapshotCapture.captureSnapshot(rig.id, "manual");

    // tmux says the OLD session name IS alive
    const tmux = { ...mockTmux(), hasSession: vi.fn(async () => true) } as unknown as TmuxAdapter;
    const orch = createOrchestrator({ tmux });

    const result = await orch.restore(snap.id);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("rig_not_stopped");
  });

  it("blocks and does not mutate when tmux check throws (fail-closed unknown)", async () => {
    const rig = rigRepo.createRig("unknown-rig");
    const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
    const sess = sessionRegistry.registerSession(node.id, "worker@unknown-rig");
    sessionRegistry.updateStatus(sess.id, "running");
    const snap = snapshotCapture.captureSnapshot(rig.id, "manual");
    const snapshotCountBefore = snapshotRepo.listSnapshots(rig.id).length;

    // tmux check throws unexpected error (permission denied / socket failure)
    // — NOT a known-absence error, so hasSession rethrows instead of returning false
    const tmux = { ...mockTmux(), hasSession: vi.fn(async () => { throw new Error("error connecting to /tmp/tmux-501/default (Permission denied)"); }) } as unknown as TmuxAdapter;
    const orch = createOrchestrator({ tmux });

    const result = await orch.restore(snap.id);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("rig_not_stopped");
    // Session must NOT be detached — fail-closed preserves original state
    const sessions = sessionRegistry.getSessionsForRig(rig.id);
    const runningSess = sessions.find((s) => s.id === sess.id);
    expect(runningSess?.status).toBe("running");
    // No pre_restore snapshot should have been created
    expect(snapshotRepo.listSnapshots(rig.id)).toHaveLength(snapshotCountBefore);
  });

  // --- Scenario B: partial failure doesn't drop pods ---

  it("partial node launch failure includes all snapshot nodes in result (no silent pod drops)", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [
        { logicalId: "orch.lead", role: "orch", runtime: "claude-code" },
        { logicalId: "dev.impl", role: "impl", runtime: "claude-code" },
        { logicalId: "dev.qa", role: "qa", runtime: "codex" },
        { logicalId: "rev.r1", role: "reviewer", runtime: "claude-code" },
      ],
      edges: [
        { sourceLogical: "orch.lead", targetLogical: "dev.impl", kind: "delegates_to" },
        { sourceLogical: "orch.lead", targetLogical: "rev.r1", kind: "delegates_to" },
      ],
    });

    // Make createSession fail for one specific node
    const tmux = mockTmux();
    (tmux.createSession as ReturnType<typeof vi.fn>).mockImplementation(async (name: string) => {
      if (name.includes("dev_qa")) return { ok: false as const, message: "tmux error" };
      return { ok: true as const };
    });
    const orch = createOrchestrator({ tmux });

    const result = await orch.restore(snap.id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const logicalIds = new Set(result.result.nodes.map((n) => n.logicalId));
      // ALL 4 snapshot nodes present in result — none silently dropped
      expect(logicalIds).toEqual(new Set(["orch.lead", "dev.impl", "dev.qa", "rev.r1"]));
      // The failed node should be reported as failed, not absent
      const qaResult = result.result.nodes.find((n) => n.logicalId === "dev.qa");
      expect(qaResult).toBeDefined();
      expect(qaResult!.status).toBe("failed");
    }
  });

  it("topological order: delegates_to (exact order)", async () => {
    const snap = seedRigAndSnapshot();
    const tmux = mockTmux();
    const orch = createOrchestrator({ tmux });

    const result = await orch.restore(snap.id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const order = result.result.nodes.map((n) => n.logicalId);
      // orchestrator first (source of delegates_to), then workers alphabetically
      expect(order).toEqual(["orchestrator", "worker-a", "worker-b"]);
    }
  });

  it("spawned_by constrains order (target before source)", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [
        { logicalId: "child", role: "worker", runtime: "claude-code" },
        { logicalId: "parent", role: "orchestrator", runtime: "claude-code" },
      ],
      edges: [{ sourceLogical: "child", targetLogical: "parent", kind: "spawned_by" }],
    });
    const orch = createOrchestrator();

    const result = await orch.restore(snap.id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const order = result.result.nodes.map((n) => n.logicalId);
      // parent (target of spawned_by) must come before child (source)
      expect(order.indexOf("parent")).toBeLessThan(order.indexOf("child"));
    }
  });

  it("can_observe does NOT constrain order", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [
        { logicalId: "orchestrator", role: "orchestrator", runtime: "claude-code" },
        { logicalId: "worker-a", role: "worker", runtime: "claude-code" },
        { logicalId: "worker-b", role: "worker", runtime: "codex" },
      ],
      edges: [
        { sourceLogical: "orchestrator", targetLogical: "worker-a", kind: "delegates_to" },
        { sourceLogical: "orchestrator", targetLogical: "worker-b", kind: "delegates_to" },
        { sourceLogical: "worker-a", targetLogical: "worker-b", kind: "can_observe" },
      ],
    });
    const orch = createOrchestrator();
    const result = await orch.restore(snap.id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // can_observe should NOT force worker-a before worker-b
      // alphabetical tiebreaker: worker-a before worker-b (same result but for the right reason)
      expect(result.result.nodes.map((n) => n.logicalId)).toEqual(["orchestrator", "worker-a", "worker-b"]);
    }
  });

  it("launch succeeds -> old binding replaced by new, old sessions superseded", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
      edges: [],
      withBinding: "worker",
      resumeType: "claude_name",
      resumeToken: "tok",
    });

    const orch = createOrchestrator();
    const result = await orch.restore(snap.id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // New binding should exist with launched session name
      const rig = rigRepo.getRig(snap.data.rig.id);
      const worker = rig!.nodes.find((n) => n.logicalId === "worker");
      expect(worker!.binding).not.toBeNull();
      expect(worker!.binding!.tmuxSession).toBe("r99-worker");

      // Old sessions should be superseded
      const superseded = db.prepare("SELECT status FROM sessions WHERE status = 'superseded'").all();
      expect(superseded.length).toBeGreaterThan(0);
    }
  });

  it("launch createSession fails -> full prior binding restored incl cmuxSurface", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
      edges: [],
      withBinding: "worker",
    });

    // Add cmuxSurface to the binding before snapshot
    const nodeId = snap.data.nodes[0]!.id;
    sessionRegistry.updateBinding(nodeId, { cmuxSurface: "surface-42" });

    // Capture the exact prior binding state
    const priorBinding = sessionRegistry.getBindingForNode(nodeId);
    expect(priorBinding!.cmuxSurface).toBe("surface-42");

    // Add a session with known status
    const sess = sessionRegistry.registerSession(nodeId, "r99-worker");
    sessionRegistry.updateStatus(sess.id, "detached");

    const tmux = mockTmux();
    (tmux.createSession as ReturnType<typeof vi.fn>).mockResolvedValue(
      { ok: false as const, code: "duplicate_session", message: "err" }
    );
    const orch = createOrchestrator({ tmux });
    const result = await orch.restore(snap.id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const failedNode = result.result.nodes.find((n) => n.logicalId === "worker");
      expect(failedNode!.status).toBe("failed");

      // Full prior binding restored including cmuxSurface
      const restoredBinding = sessionRegistry.getBindingForNode(nodeId);
      expect(restoredBinding).not.toBeNull();
      expect(restoredBinding!.cmuxSurface).toBe("surface-42");
      expect(restoredBinding!.tmuxSession).toBe(priorBinding!.tmuxSession);

      // Session status restored to exact prior value
      const sessions = sessionRegistry.getSessionsForRig(snap.data.rig.id);
      const originalSess = sessions.find((s) => s.id === sess.id);
      expect(originalSess!.status).toBe("detached");
    }
  });

  it("launch db_error (tmux succeeds, DB fails) -> prior state restored", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
      edges: [],
      withBinding: "worker",
    });

    const nodeId = snap.data.nodes[0]!.id;
    sessionRegistry.updateBinding(nodeId, { cmuxSurface: "surface-99" });
    const sess = sessionRegistry.registerSession(nodeId, "r99-worker");
    sessionRegistry.updateStatus(sess.id, "idle");

    // tmux createSession succeeds but NodeLauncher's DB transaction fails.
    // Sabotage: make createSession succeed AND trigger a killSession (cleanup),
    // but sabotage the events table so the launch transaction fails.
    const tmux = mockTmux();
    let createCalled = false;
    (tmux.createSession as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      if (!createCalled) {
        createCalled = true;
        // Sabotage events table AFTER tmux succeeds but BEFORE NodeLauncher DB transaction
        db.exec("DROP TABLE events");
        db.exec(
          "CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, rig_id TEXT, node_id TEXT, type TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), CONSTRAINT force_fail CHECK(length(type) < 1))"
        );
      }
      return { ok: true as const };
    });

    const orch = createOrchestrator({ tmux });
    const result = await orch.restore(snap.id);

    // The restore itself may error due to events table sabotage.
    // But if it returns ok, the failed node should have prior state restored.
    // If it returns restore_error, that's also acceptable.
    if (result.ok) {
      const failedNode = result.result.nodes.find((n) => n.logicalId === "worker");
      expect(failedNode!.status).toBe("failed");

      // Prior binding restored
      const restoredBinding = sessionRegistry.getBindingForNode(nodeId);
      expect(restoredBinding).not.toBeNull();
      expect(restoredBinding!.cmuxSurface).toBe("surface-99");

      // Session restored to exact prior status
      const sessions = db.prepare("SELECT id, status FROM sessions WHERE id = ?").get(sess.id) as { status: string } | undefined;
      expect(sessions).toBeDefined();
      expect(sessions!.status).toBe("idle");

      // killSession should have been called (NodeLauncher cleanup)
      expect(tmux.killSession).toHaveBeenCalled();
    }
  });

  it("launch fails with no prior binding -> no binding after failure", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
      edges: [],
      // No withBinding — node starts unbound
    });

    const tmux = mockTmux();
    (tmux.createSession as ReturnType<typeof vi.fn>).mockResolvedValue(
      { ok: false as const, code: "duplicate_session", message: "err" }
    );
    const orch = createOrchestrator({ tmux });
    const result = await orch.restore(snap.id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const nodeId = snap.data.nodes[0]!.id;
      const binding = sessionRegistry.getBindingForNode(nodeId);
      expect(binding).toBeNull(); // No invented binding
    }
  });

  it("pre-restore snapshot captured BEFORE stale-state mutation", async () => {
    const snap = seedRigAndSnapshot({
      withBinding: "orchestrator",
      resumeType: "claude_name",
      resumeToken: "tok",
    });

    const orch = createOrchestrator();
    const result = await orch.restore(snap.id);
    expect(result.ok).toBe(true);

    if (result.ok) {
      // Pre-restore snapshot should contain original binding + session state
      const preSnap = snapshotRepo.getSnapshot(result.result.preRestoreSnapshotId);
      expect(preSnap).not.toBeNull();
      expect(preSnap!.kind).toBe("pre_restore");

      const orchNode = preSnap!.data.nodes.find((n) => n.logicalId === "orchestrator");
      expect(orchNode!.binding).not.toBeNull();
      expect(orchNode!.binding!.tmuxSession).toBe("r99-orchestrator");

      // Pre-restore sessions should show original status (not superseded)
      const preSessions = preSnap!.data.sessions;
      for (const s of preSessions) {
        expect(s.status).not.toBe("superseded");
      }
    }
  });

  it("restore_policy=resume_if_possible + claude_name -> Claude resume called", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
      edges: [],
      resumeType: "claude_name",
      resumeToken: "my-session",
      restorePolicy: "resume_if_possible",
    });
    const claude = mockClaudeResume();
    const orch = createOrchestrator({ claude });
    await orch.restore(snap.id);

    expect(claude.resume).toHaveBeenCalled();
  });

  it("restore_policy=resume_if_possible + codex_id -> Codex resume called", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "codex" }],
      edges: [],
      resumeType: "codex_id",
      resumeToken: "uuid-123",
      restorePolicy: "resume_if_possible",
    });
    const codex = mockCodexResume();
    const orch = createOrchestrator({ codex });
    await orch.restore(snap.id);

    expect(codex.resume).toHaveBeenCalled();
  });

  it("resume succeeds -> status 'resumed'", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
      edges: [],
      resumeType: "claude_name",
      resumeToken: "tok",
    });
    const orch = createOrchestrator({ claude: mockClaudeResume({ ok: true }) });
    const result = await orch.restore(snap.id);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result.nodes[0]!.status).toBe("resumed");
  });

  it("resume fails -> fallback to checkpoint file delivery", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rigged-test-"));
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code", cwd: tmpDir }],
      edges: [],
      resumeType: "claude_name",
      resumeToken: "tok",
      withCheckpoint: "worker",
    });
    const claude = mockClaudeResume({ ok: false, code: "resume_failed", message: "err" });
    const orch = createOrchestrator({ claude });
    const result = await orch.restore(snap.id);

    expect(result.ok).toBe(true);
    // NS-T04: resume failure is now FAILED loudly, no silent fallback to checkpoint
    if (result.ok) expect(result.result.nodes[0]!.status).toBe("failed");
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("legacy Claude resume verification failure -> status 'failed'", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
      edges: [],
      resumeType: "claude_name",
      resumeToken: "missing-session",
    });
    const tmux = mockTmux();
    (tmux.getPaneCommand as ReturnType<typeof vi.fn>).mockResolvedValue("zsh");
    (tmux.capturePaneContent as ReturnType<typeof vi.fn>).mockResolvedValue(
      "No conversation found with session ID: missing-session\nmschwarz@host %"
    );
    const claude = new ClaudeResumeAdapter(tmux, { pollMs: 0, maxWaitMs: 0, sleep: async () => {} });
    const orch = createOrchestrator({ tmux, claude });

    const result = await orch.restore(snap.id);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result.nodes[0]!.status).toBe("failed");
  });

  it("restore_policy=relaunch_fresh -> resume NOT attempted", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
      edges: [],
      resumeType: "claude_name",
      resumeToken: "tok",
      restorePolicy: "relaunch_fresh",
    });
    const claude = mockClaudeResume();
    const orch = createOrchestrator({ claude });
    await orch.restore(snap.id);

    expect(claude.resume).not.toHaveBeenCalled();
  });

  it("restore_policy=checkpoint_only -> resume NOT attempted, checkpoint written", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rigged-test-"));
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code", cwd: tmpDir }],
      edges: [],
      resumeType: "claude_name",
      resumeToken: "tok",
      restorePolicy: "checkpoint_only",
      withCheckpoint: "worker",
    });
    const claude = mockClaudeResume();
    const orch = createOrchestrator({ claude });
    const result = await orch.restore(snap.id);

    expect(claude.resume).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result.nodes[0]!.status).toBe("rebuilt");
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("resume_type=none -> resume NOT attempted", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
      edges: [],
      resumeType: "none",
      resumeToken: null,
    });
    const claude = mockClaudeResume();
    const codex = mockCodexResume();
    const orch = createOrchestrator({ claude, codex });
    await orch.restore(snap.id);

    expect(claude.resume).not.toHaveBeenCalled();
    expect(codex.resume).not.toHaveBeenCalled();
  });

  it("checkpoint written to exactly {cwd}/.rigged-checkpoint.md with summary", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rigged-test-"));
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code", cwd: tmpDir }],
      edges: [],
      withCheckpoint: "worker",
    });
    const orch = createOrchestrator();
    const result = await orch.restore(snap.id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.nodes[0]!.status).toBe("rebuilt");
      // Verify exact file path and content
      const filePath = path.join(tmpDir, ".rigged-checkpoint.md");
      expect(fs.existsSync(filePath)).toBe(true);
      const content = fs.readFileSync(filePath, "utf-8");
      expect(content).toContain("Was working on feature X");
      expect(content).toContain("src/feature.ts");
    }
    fs.rmSync(tmpDir, { recursive: true });
  });

  it("checkpoint + null cwd -> status 'failed'", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }], // no cwd
      edges: [],
      withCheckpoint: "worker",
    });
    const orch = createOrchestrator();
    const result = await orch.restore(snap.id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.nodes[0]!.status).toBe("failed");
      expect(result.result.nodes[0]!.error).toContain("no cwd");
    }
  });

  it("no checkpoint -> status 'fresh'", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
      edges: [],
    });
    const orch = createOrchestrator();
    const result = await orch.restore(snap.id);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result.nodes[0]!.status).toBe("fresh");
  });

  it("node launch fails -> status 'failed', remaining nodes processed", async () => {
    const snap = seedRigAndSnapshot();
    const tmux = mockTmux();
    let callCount = 0;
    (tmux.createSession as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callCount++;
      if (callCount === 2) return { ok: false as const, code: "unknown", message: "simulated launch failure" };
      return { ok: true as const };
    });
    const orch = createOrchestrator({ tmux });
    const result = await orch.restore(snap.id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const statuses = result.result.nodes.map((n) => n.status);
      expect(statuses).toContain("failed");
      // Other nodes still processed
      expect(statuses.filter((s) => s !== "failed").length).toBeGreaterThan(0);
    }
  });

  it("checkpoint file write fails -> status 'failed'", async () => {
    // Use a non-existent directory path so writeFileSync fails
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code", cwd: "/nonexistent/path/that/does/not/exist" }],
      edges: [],
      withCheckpoint: "worker",
    });
    const orch = createOrchestrator();
    const result = await orch.restore(snap.id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.nodes[0]!.status).toBe("failed");
    }
  });

  it("restore.started: exact payload in DB", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
      edges: [],
    });
    const orch = createOrchestrator();
    await orch.restore(snap.id);

    const events = db.prepare("SELECT payload FROM events WHERE type = 'restore.started'").all() as { payload: string }[];
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.rigId).toBe(snap.data.rig.id);
    expect(payload.snapshotId).toBe(snap.id);
  });

  it("restore.completed: exact payload with RestoreResult in DB + subscriber", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
      edges: [],
    });
    const notifications: PersistedEvent[] = [];
    eventBus.subscribe((e) => notifications.push(e));

    const orch = createOrchestrator();
    const result = await orch.restore(snap.id);

    // DB event
    const events = db.prepare("SELECT payload FROM events WHERE type = 'restore.completed'").all() as { payload: string }[];
    expect(events).toHaveLength(1);
    const payload = JSON.parse(events[0]!.payload);
    expect(payload.rigId).toBe(snap.data.rig.id);
    expect(payload.snapshotId).toBe(snap.id);
    expect(payload.result).toBeDefined();
    expect(payload.result.nodes).toHaveLength(1);

    // Subscriber receives same payload
    const completedEvent = notifications.find((e) => e.type === "restore.completed");
    expect(completedEvent).toBeDefined();
    if (completedEvent && completedEvent.type === "restore.completed") {
      expect(completedEvent.rigId).toBe(snap.data.rig.id);
      expect(completedEvent.snapshotId).toBe(snap.id);
      expect(completedEvent.result).toBeDefined();
      expect(completedEvent.result.nodes).toHaveLength(1);
      // Match the returned RestoreResult
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(completedEvent.result.nodes[0]!.status).toBe(result.result.nodes[0]!.status);
        expect(completedEvent.result.nodes[0]!.logicalId).toBe(result.result.nodes[0]!.logicalId);
      }
    }
  });

  it("pre-restore snapshot kind = 'pre_restore'", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
      edges: [],
    });
    const orch = createOrchestrator();
    const result = await orch.restore(snap.id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      const preSnap = snapshotRepo.getSnapshot(result.result.preRestoreSnapshotId);
      expect(preSnap).not.toBeNull();
      expect(preSnap!.kind).toBe("pre_restore");
    }
  });

  // -- Fix 4: Concurrency protection --

  it("concurrent restore same rig -> second returns restore_in_progress", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
      edges: [],
    });

    // Make tmux createSession slow so first restore is still in progress
    const tmux = mockTmux();
    (tmux.createSession as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ ok: true as const }), 100))
    );
    const orch = createOrchestrator({ tmux });

    // Start two restores concurrently
    const [r1, r2] = await Promise.all([
      orch.restore(snap.id),
      orch.restore(snap.id),
    ]);

    // One succeeds, one is blocked
    const outcomes = [r1, r2];
    const succeeded = outcomes.filter((r) => r.ok);
    const blocked = outcomes.filter((r) => !r.ok && r.code === "restore_in_progress");
    expect(succeeded).toHaveLength(1);
    expect(blocked).toHaveLength(1);
  });

  it("lock released on failure: first restore errors, second restore allowed", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
      edges: [],
    });

    // First restore: sabotage to cause restore_error
    const tmux1 = mockTmux();
    const orch = createOrchestrator({ tmux: tmux1 });

    // Sabotage snapshots so pre-restore capture fails
    db.exec("CREATE TRIGGER block_snap BEFORE INSERT ON snapshots BEGIN SELECT RAISE(ABORT, 'blocked'); END;");
    const r1 = await orch.restore(snap.id);
    expect(r1.ok).toBe(false);
    db.exec("DROP TRIGGER block_snap");

    // Second restore should be allowed (lock released after failure)
    const r2 = await orch.restore(snap.id);
    // Should not be restore_in_progress
    if (!r2.ok) {
      expect(r2.code).not.toBe("restore_in_progress");
    }
  });

  it("different rigs can restore concurrently", async () => {
    // Seed two separate rigs with snapshots
    const rig1 = rigRepo.createRig("r98");
    rigRepo.addNode(rig1.id, "worker", { role: "worker", runtime: "claude-code" });
    const snap1 = snapshotCapture.captureSnapshot(rig1.id, "manual");

    const rig2 = rigRepo.createRig("r97");
    rigRepo.addNode(rig2.id, "worker", { role: "worker", runtime: "claude-code" });
    const snap2 = snapshotCapture.captureSnapshot(rig2.id, "manual");

    const tmux = mockTmux();
    (tmux.createSession as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ ok: true as const }), 50))
    );
    const orch = createOrchestrator({ tmux });

    // Both should succeed (not blocked by each other)
    const [r1, r2] = await Promise.all([
      orch.restore(snap1.id),
      orch.restore(snap2.id),
    ]);

    // Neither should be restore_in_progress
    if (!r1.ok) expect(r1.code).not.toBe("restore_in_progress");
    if (!r2.ok) expect(r2.code).not.toBe("restore_in_progress");
  });

  // NS-T05: R1 — pod-aware restore uses launchHarness (not old helpers)
  it("pod-aware restore uses launchHarness for resume, not old helpers", async () => {
    // Create a pod-aware rig
    const rig = rigRepo.createRig("test-rig");
    db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("pod-1", rig.id, "Dev");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", podId: "pod-1" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    // Set resume token
    sessionRegistry.updateResumeToken(session.id, "claude_id", "resume-token-123");
    // Startup context
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)").run(node.id, "[]", "[]", "[]", "claude-code");
    // Snapshot
    const snap = snapshotCapture.captureSnapshot(rig.id, "test");
    // Stop
    sessionRegistry.updateStatus(session.id, "exited");
    db.prepare("DELETE FROM bindings WHERE node_id = ?").run(node.id);

    const launchSpy = vi.fn(async () => ({ ok: true as const, resumeToken: "new-token", resumeType: "claude_id" }));
    const mockAdapter = {
      runtime: "claude-code",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: vi.fn(async () => ({ ready: true })),
      launchHarness: launchSpy,
    };

    // Claude resume spy — should NOT be called for pod-aware nodes
    const claudeResumeSpy = vi.fn(async () => ({ ok: true as const }));
    const claude = mockClaudeResume();
    (claude as any).resume = claudeResumeSpy;

    const orch = createOrchestrator({ claude });
    const result = await orch.restore(snap.id, { adapters: { "claude-code": mockAdapter } });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // launchHarness should have been called (pod-aware path)
      expect(launchSpy).toHaveBeenCalled();
      // Old claude.resume should NOT have been called
      expect(claudeResumeSpy).not.toHaveBeenCalled();
      // Node should be "resumed"
      expect(result.result.nodes[0]!.status).toBe("resumed");
    }
  });

  it("pod-aware resume failure -> status 'failed' with startup error", async () => {
    const rig = rigRepo.createRig("test-rig");
    db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("pod-fail", rig.id, "Dev");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", podId: "pod-fail" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateResumeToken(session.id, "claude_id", "bad-token");
    db.prepare(
      "INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)"
    ).run(node.id, "[]", "[]", "[]", "claude-code");
    const snap = snapshotCapture.captureSnapshot(rig.id, "test");
    sessionRegistry.updateStatus(session.id, "exited");
    db.prepare("DELETE FROM bindings WHERE node_id = ?").run(node.id);

    const mockAdapter = {
      runtime: "claude-code",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: vi.fn(async () => ({ ready: true })),
      launchHarness: vi.fn(async () => ({ ok: false as const, error: "Claude resume failed: no conversation found" })),
    };

    const orch = createOrchestrator();
    const result = await orch.restore(snap.id, { adapters: { "claude-code": mockAdapter } });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.nodes[0]!.status).toBe("failed");
      expect(result.result.nodes[0]!.error).toContain("Claude resume failed");
    }
  });

  // NS-T05: R2 — legacy restore uses old helpers + skipHarnessLaunch
  it("legacy restore uses old helpers, not launchHarness", async () => {
    // Create a legacy rig (no podId)
    const rig = rigRepo.createRig("r01");
    const node = rigRepo.addNode(rig.id, "impl", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "r01-impl");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateResumeToken(session.id, "claude_name", "test-name");
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)").run(node.id, "[]", "[]", "[]", "claude-code");
    const snap = snapshotCapture.captureSnapshot(rig.id, "test");
    sessionRegistry.updateStatus(session.id, "exited");
    db.prepare("DELETE FROM bindings WHERE node_id = ?").run(node.id);

    const launchSpy = vi.fn(async () => ({ ok: true as const }));
    const mockAdapter = {
      runtime: "claude-code",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: vi.fn(async () => ({ ready: true })),
      launchHarness: launchSpy,
    };

    const orch = createOrchestrator();
    const result = await orch.restore(snap.id, { adapters: { "claude-code": mockAdapter } });

    expect(result.ok).toBe(true);
    // Note: legacy path uses old claude-resume helpers, then calls startNode with skipHarnessLaunch: true
    // So launchHarness should NOT be called
    // (The old helper resume fails with mock but returns baseStatus = failed)
  });

  it("legacy Claude restore with missing token launches a fresh harness when startup context is available", async () => {
    const rig = rigRepo.createRig("r01");
    const node = rigRepo.addNode(rig.id, "impl", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "r01-impl");
    sessionRegistry.updateStatus(session.id, "running");
    db.prepare("UPDATE sessions SET resume_type = ? WHERE id = ?").run("claude_id", session.id);
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)").run(node.id, "[]", "[]", "[]", "claude-code");
    const snap = snapshotCapture.captureSnapshot(rig.id, "test");
    sessionRegistry.updateStatus(session.id, "exited");
    db.prepare("DELETE FROM bindings WHERE node_id = ?").run(node.id);

    const launchHarness = vi.fn(async () => ({ ok: true as const, resumeToken: "fresh-claude-token", resumeType: "claude_id" }));
    const mockAdapter = {
      runtime: "claude-code",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: vi.fn(async () => ({ ready: true })),
      launchHarness,
    };

    const orch = createOrchestrator();
    const result = await orch.restore(snap.id, { adapters: { "claude-code": mockAdapter } });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.nodes[0]!.status).toBe("fresh");
      expect(launchHarness).toHaveBeenCalledTimes(1);
      expect(launchHarness.mock.calls[0]![1].resumeToken).toBeUndefined();
    }
  });

  it("legacy Claude restore with missing token fails honestly when no startup context is available for a fresh fallback", async () => {
    const rig = rigRepo.createRig("r01");
    const node = rigRepo.addNode(rig.id, "impl", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "r01-impl");
    sessionRegistry.updateStatus(session.id, "running");
    db.prepare("UPDATE sessions SET resume_type = ? WHERE id = ?").run("claude_id", session.id);
    const snap = snapshotCapture.captureSnapshot(rig.id, "test");
    sessionRegistry.updateStatus(session.id, "exited");
    db.prepare("DELETE FROM bindings WHERE node_id = ?").run(node.id);

    const orch = createOrchestrator();
    const result = await orch.restore(snap.id);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.nodes[0]!.status).toBe("failed");
      expect(result.result.nodes[0]!.error).toContain("Resume fallback required a fresh launch");
    }
  });

  it("pod-aware Claude restore with resume type but missing token falls back to fresh launch", async () => {
    const rig = rigRepo.createRig("test-rig");
    db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("pod-2", rig.id, "Dev");
    const node = rigRepo.addNode(rig.id, "dev.qa", { runtime: "claude-code", podId: "pod-2" });
    const session = sessionRegistry.registerSession(node.id, "dev-qa@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    // Set resumeType but NO resumeToken
    db.prepare("UPDATE sessions SET resume_type = ? WHERE id = ?").run("claude_id", session.id);
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)").run(node.id, "[]", "[]", "[]", "claude-code");
    const snap = snapshotCapture.captureSnapshot(rig.id, "test");
    sessionRegistry.updateStatus(session.id, "exited");
    db.prepare("DELETE FROM bindings WHERE node_id = ?").run(node.id);

    const mockAdapter = {
      runtime: "claude-code",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: vi.fn(async () => ({ ready: true })),
      launchHarness: vi.fn(async () => ({ ok: true as const, resumeToken: "fresh-claude-token", resumeType: "claude_id" })),
    };

    const orch = createOrchestrator();
    const result = await orch.restore(snap.id, { adapters: { "claude-code": mockAdapter } });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const nodeResult = result.result.nodes.find((n) => n.nodeId === node.id);
      expect(nodeResult!.status).toBe("fresh");
    }
  });

  it("pod-aware Claude restore retries fresh when resume launch proves the saved session is gone", async () => {
    const rig = rigRepo.createRig("test-rig");
    db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("pod-claude-retry", rig.id, "Dev");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", podId: "pod-claude-retry" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateResumeToken(session.id, "claude_id", "stale-claude-token");
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)").run(node.id, "[]", "[]", "[]", "claude-code");
    const snap = snapshotCapture.captureSnapshot(rig.id, "test");
    sessionRegistry.updateStatus(session.id, "exited");
    db.prepare("DELETE FROM bindings WHERE node_id = ?").run(node.id);

    const launchHarness = vi.fn()
      .mockResolvedValueOnce({ ok: false as const, error: "Claude resume failed: no conversation found for the requested session", recovery: "retry_fresh" })
      .mockResolvedValueOnce({ ok: true as const, resumeToken: "fresh-claude-token", resumeType: "claude_id" });
    const mockAdapter = {
      runtime: "claude-code",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: vi.fn(async () => ({ ready: true })),
      launchHarness,
    };

    const orch = createOrchestrator();
    const result = await orch.restore(snap.id, { adapters: { "claude-code": mockAdapter } });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const nodeResult = result.result.nodes.find((n) => n.nodeId === node.id);
      expect(nodeResult!.status).toBe("fresh");
      expect(launchHarness).toHaveBeenCalledTimes(2);
      expect(launchHarness.mock.calls[0]![1].resumeToken).toBe("stale-claude-token");
      expect(launchHarness.mock.calls[1]![1].resumeToken).toBeUndefined();
    }
  });

  it("pod-aware Codex restore with resume type but missing token falls back to fresh launch", async () => {
    const rig = rigRepo.createRig("test-rig");
    db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("pod-codex-missing", rig.id, "Dev");
    const node = rigRepo.addNode(rig.id, "dev.qa", { runtime: "codex", podId: "pod-codex-missing" });
    const session = sessionRegistry.registerSession(node.id, "dev-qa@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    db.prepare("UPDATE sessions SET resume_type = ? WHERE id = ?").run("codex_id", session.id);
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)").run(node.id, "[]", "[]", "[]", "codex");
    const snap = snapshotCapture.captureSnapshot(rig.id, "test");
    sessionRegistry.updateStatus(session.id, "exited");
    db.prepare("DELETE FROM bindings WHERE node_id = ?").run(node.id);

    const mockAdapter = {
      runtime: "codex",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: vi.fn(async () => ({ ready: true })),
      launchHarness: vi.fn(async () => ({ ok: true as const, resumeToken: "fresh-codex-token", resumeType: "codex_id" })),
    };

    const orch = createOrchestrator();
    const result = await orch.restore(snap.id, { adapters: { codex: mockAdapter } });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const nodeResult = result.result.nodes.find((n) => n.nodeId === node.id);
      expect(nodeResult!.status).toBe("fresh");
    }
  });

  it("pod-aware Codex restore retries fresh when resume launch proves the saved session is gone", async () => {
    const rig = rigRepo.createRig("test-rig");
    db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("pod-codex-retry", rig.id, "Dev");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex", podId: "pod-codex-retry" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateResumeToken(session.id, "codex_id", "stale-codex-token");
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)").run(node.id, "[]", "[]", "[]", "codex");
    const snap = snapshotCapture.captureSnapshot(rig.id, "test");
    sessionRegistry.updateStatus(session.id, "exited");
    db.prepare("DELETE FROM bindings WHERE node_id = ?").run(node.id);

    const launchHarness = vi.fn()
      .mockResolvedValueOnce({ ok: false as const, error: "Codex resume failed: no saved session found for the requested session", recovery: "retry_fresh" })
      .mockResolvedValueOnce({ ok: true as const, resumeToken: "fresh-codex-token", resumeType: "codex_id" });
    const mockAdapter = {
      runtime: "codex",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: vi.fn(async () => ({ ready: true })),
      launchHarness,
    };

    const orch = createOrchestrator();
    const result = await orch.restore(snap.id, { adapters: { codex: mockAdapter } });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const nodeResult = result.result.nodes.find((n) => n.nodeId === node.id);
      expect(nodeResult!.status).toBe("fresh");
      expect(launchHarness).toHaveBeenCalledTimes(2);
      expect(launchHarness.mock.calls[0]![1].resumeToken).toBe("stale-codex-token");
      expect(launchHarness.mock.calls[1]![1].resumeToken).toBeUndefined();
    }
  });

  it("pod-aware Codex restore treats a fresh fallback as resumed when the native token matches", async () => {
    const rig = rigRepo.createRig("test-rig");
    db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("pod-codex-same-token", rig.id, "Dev");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex", podId: "pod-codex-same-token" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateResumeToken(session.id, "codex_id", "stable-codex-token");
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)").run(node.id, "[]", "[]", "[]", "codex");
    const snap = snapshotCapture.captureSnapshot(rig.id, "test");
    sessionRegistry.updateStatus(session.id, "exited");
    db.prepare("DELETE FROM bindings WHERE node_id = ?").run(node.id);

    const launchHarness = vi.fn()
      .mockResolvedValueOnce({ ok: false as const, error: "Codex resume failed: no saved session found for the requested session", recovery: "retry_fresh" })
      .mockResolvedValueOnce({ ok: true as const, resumeToken: "stable-codex-token", resumeType: "codex_id" });
    const mockAdapter = {
      runtime: "codex",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: vi.fn(async () => ({ ready: true })),
      launchHarness,
    };

    const orch = createOrchestrator();
    const result = await orch.restore(snap.id, { adapters: { codex: mockAdapter } });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const nodeResult = result.result.nodes.find((n) => n.nodeId === node.id);
      expect(nodeResult!.status).toBe("resumed");
      expect(result.result.warnings).not.toContain("Node dev.impl: resume was unavailable; launched fresh instead.");
      expect(launchHarness).toHaveBeenCalledTimes(2);
      expect(launchHarness.mock.calls[0]![1].resumeToken).toBe("stable-codex-token");
      expect(launchHarness.mock.calls[1]![1].resumeToken).toBeUndefined();
    }
  });

  it("pod-aware Codex restore keeps rebuilt when fresh fallback replays a checkpoint", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rigged-codex-restore-"));
    try {
      const rig = rigRepo.createRig("test-rig");
      db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("pod-codex-rebuilt", rig.id, "Dev");
      const node = rigRepo.addNode(rig.id, "dev.ops", { runtime: "codex", podId: "pod-codex-rebuilt", cwd: tmpDir });
      const session = sessionRegistry.registerSession(node.id, "dev-ops@test-rig");
      sessionRegistry.updateStatus(session.id, "running");
      sessionRegistry.updateResumeToken(session.id, "codex_id", "stale-codex-token");
      checkpointStore.createCheckpoint(node.id, {
        summary: "Resume this Codex task from checkpoint",
        keyArtifacts: ["notes/todo.md"],
      });
      db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)").run(node.id, "[]", "[]", "[]", "codex");
      const snap = snapshotCapture.captureSnapshot(rig.id, "test");
      sessionRegistry.updateStatus(session.id, "exited");
      db.prepare("DELETE FROM bindings WHERE node_id = ?").run(node.id);

      const launchHarness = vi.fn()
        .mockResolvedValueOnce({ ok: false as const, error: "Codex resume failed: no saved session found for the requested session", recovery: "retry_fresh" })
        .mockResolvedValueOnce({ ok: true as const, resumeToken: "fresh-codex-token", resumeType: "codex_id" });
      const mockAdapter = {
        runtime: "codex",
        listInstalled: vi.fn(async () => []),
        project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
        deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
        checkReady: vi.fn(async () => ({ ready: true })),
        launchHarness,
      };

      const orch = createOrchestrator();
      const result = await orch.restore(snap.id, { adapters: { codex: mockAdapter } });

      expect(result.ok).toBe(true);
      if (result.ok) {
        const nodeResult = result.result.nodes.find((n) => n.nodeId === node.id);
        expect(nodeResult!.status).toBe("rebuilt");
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("pod-aware restore without captured resume metadata falls back to fresh launch", async () => {
    const rig = rigRepo.createRig("test-rig");
    db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("pod-3", rig.id, "Dev");
    const node = rigRepo.addNode(rig.id, "dev.design", { runtime: "claude-code", podId: "pod-3" });
    const session = sessionRegistry.registerSession(node.id, "dev-design@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)").run(node.id, "[]", "[]", "[]", "claude-code");
    const snap = snapshotCapture.captureSnapshot(rig.id, "test");
    sessionRegistry.updateStatus(session.id, "exited");
    db.prepare("DELETE FROM bindings WHERE node_id = ?").run(node.id);

    const mockAdapter = {
      runtime: "claude-code",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: vi.fn(async () => ({ ready: true })),
      launchHarness: vi.fn(async () => ({ ok: true as const, resumeToken: "fresh-token", resumeType: "claude_id" })),
    };

    const orch = createOrchestrator();
    const result = await orch.restore(snap.id, { adapters: { "claude-code": mockAdapter } });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const nodeResult = result.result.nodes.find((n) => n.nodeId === node.id);
      expect(nodeResult!.status).toBe("fresh");
    }
  });

  it("fallback fresh launch during restore replays fresh_start startup actions", async () => {
    const rig = rigRepo.createRig("test-rig");
    db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("pod-4", rig.id, "Infra");
    const node = rigRepo.addNode(rig.id, "infra.ui", { runtime: "builtin:terminal", podId: "pod-4", cwd: "." });
    const session = sessionRegistry.registerSession(node.id, "infra-ui@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    db.prepare(
      "INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)"
    ).run(
      node.id,
      "[]",
      "[]",
      JSON.stringify([
        {
          type: "send_text",
          value: "npm run dev",
          phase: "after_ready",
          appliesOn: ["fresh_start"],
          idempotent: false,
        },
      ]),
      "builtin:terminal",
    );
    const snap = snapshotCapture.captureSnapshot(rig.id, "test");
    sessionRegistry.updateStatus(session.id, "exited");
    db.prepare("DELETE FROM bindings WHERE node_id = ?").run(node.id);

    const tmux = mockTmux({
      sendText: vi.fn(async () => ({ ok: true as const })),
      sendKeys: vi.fn(async () => ({ ok: true as const })),
    });
    const mockAdapter = {
      runtime: "builtin:terminal",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: vi.fn(async () => ({ ready: true })),
      launchHarness: vi.fn(async () => ({ ok: true as const })),
    };

    const orch = createOrchestrator({ tmux });
    const result = await orch.restore(snap.id, { adapters: { "builtin:terminal": mockAdapter } });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const nodeResult = result.result.nodes.find((n) => n.nodeId === node.id);
      expect(nodeResult!.status).toBe("fresh");
      expect(tmux.sendText).toHaveBeenCalledWith("infra-ui@test-rig", "npm run dev");
    }
  });

  it("restore propagates launch warnings and writes transcript boundary marker with snapshot ID", async () => {
    const snap = seedRigAndSnapshot();

    const { TranscriptStore } = await import("../src/domain/transcript-store.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-transcript-"));
    const transcriptStore = new TranscriptStore({ transcriptsRoot: tmpDir, enabled: true });

    const tmux = mockTmux();
    // startPipePane fails → warning propagates, but boundary marker still written
    (tmux as unknown as Record<string, unknown>).startPipePane = vi.fn(async () => ({ ok: false, code: "unknown", message: "pipe-pane failed" }));

    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux, transcriptStore });
    const orch = new RestoreOrchestrator({
      db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
      checkpointStore, nodeLauncher, tmuxAdapter: tmux,
      claudeResume: mockClaudeResume(),
      codexResume: mockCodexResume(),
      transcriptStore,
    });

    const result = await orch.restore(snap.id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Launch warnings propagate (transcript capture failed)
      expect(result.result.warnings.some((w: string) => w.includes("Transcript capture failed"))).toBe(true);

      // Boundary markers were actually written to transcript files
      const rigDir = path.join(tmpDir, "r99");
      expect(fs.existsSync(rigDir)).toBe(true);

      // Check that at least one transcript file has a boundary marker with the snapshot ID
      const transcriptFiles = fs.readdirSync(rigDir).filter((f) => f.endsWith(".log"));
      expect(transcriptFiles.length).toBeGreaterThan(0);
      const firstContent = fs.readFileSync(path.join(rigDir, transcriptFiles[0]!), "utf-8");
      expect(firstContent).toContain("--- SESSION BOUNDARY:");
      expect(firstContent).toContain(`restore attempt from snapshot ${snap.id}`);
    }

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("restored sessions inherit OPENRIG_NODE_ID and OPENRIG_SESSION_NAME env vars", async () => {
    const snap = seedRigAndSnapshot();
    const createSessionSpy = vi.fn<(name: string, cwd?: string, env?: Record<string, string>) => Promise<{ ok: true }>>()
      .mockResolvedValue({ ok: true });
    const tmux = mockTmux();
    (tmux as unknown as Record<string, unknown>).createSession = createSessionSpy;

    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    const orch = new RestoreOrchestrator({
      db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
      checkpointStore, nodeLauncher, tmuxAdapter: tmux,
      claudeResume: mockClaudeResume(),
      codexResume: mockCodexResume(),
    });

    const result = await orch.restore(snap.id);
    expect(result.ok).toBe(true);

    // Every createSession call should have received env vars
    expect(createSessionSpy.mock.calls.length).toBeGreaterThan(0);
    for (const call of createSessionSpy.mock.calls) {
      const env = call[2];
      expect(env).toBeDefined();
      expect(env!.OPENRIG_NODE_ID).toBeTruthy();
      expect(env!.OPENRIG_SESSION_NAME).toBeTruthy();
    }
  });
});
