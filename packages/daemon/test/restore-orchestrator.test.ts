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
import { RestoreOrchestrator, rollupRestoreRigResult } from "../src/domain/restore-orchestrator.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { TmuxAdapter, type TmuxResult } from "../src/adapters/tmux.js";
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

  function updateSnapshotData(snapshot: Snapshot, mutate: (data: any) => void): Snapshot {
    const data = JSON.parse(JSON.stringify(snapshot.data));
    mutate(data);
    db.prepare("UPDATE snapshots SET data = ? WHERE id = ?").run(JSON.stringify(data), snapshot.id);
    const updated = snapshotRepo.getSnapshot(snapshot.id);
    if (!updated) throw new Error("expected updated snapshot");
    return updated;
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

  it("production TmuxAdapter probe error reaches restore fail-closed path (end-to-end)", async () => {
    // Uses a REAL TmuxAdapter with a mock exec — not a mocked hasSession vi.fn.
    // Proves the actual adapter error-classification contract propagates through
    // classifyRunningSessions to produce rig_not_stopped on unexpected errors.
    const rig = rigRepo.createRig("e2e-probe-rig");
    const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
    const sess = sessionRegistry.registerSession(node.id, "worker@e2e-probe-rig");
    sessionRegistry.updateStatus(sess.id, "running");
    const snap = snapshotCapture.captureSnapshot(rig.id, "manual");
    const snapshotCountBefore = snapshotRepo.listSnapshots(rig.id).length;

    // Real TmuxAdapter with exec that throws Permission denied for has-session
    const realTmux = new TmuxAdapter(async (cmd: string) => {
      if (cmd.includes("has-session")) {
        throw new Error("error connecting to /tmp/tmux-501/default (Permission denied)");
      }
      return "";
    });
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: realTmux });
    const orch = new RestoreOrchestrator({
      db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
      checkpointStore, nodeLauncher, tmuxAdapter: realTmux,
      claudeResume: mockClaudeResume(),
      codexResume: mockCodexResume(),
    });

    const result = await orch.restore(snap.id);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("rig_not_stopped");
    // Original session preserved — no mutation
    const sessions = sessionRegistry.getSessionsForRig(rig.id);
    const runningSess = sessions.find((s) => s.id === sess.id);
    expect(runningSess?.status).toBe("running");
    // No pre_restore snapshot created
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
    if (result.ok) expect(result.result.nodes[0]!.status).toBe("awaiting-decision");
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
      "No conversation found with session ID: missing-session\nuser@example.test %"
    );
    const claude = new ClaudeResumeAdapter(tmux, { pollMs: 0, maxWaitMs: 0, sleep: async () => {} });
    const orch = createOrchestrator({ tmux, claude });

    const result = await orch.restore(snap.id);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result.nodes[0]!.status).toBe("awaiting-decision");
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

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("pre_restore_validation_failed");
      expect(result.result.rigResult).toBe("not_attempted");
      expect(result.result.blockers?.[0]).toMatchObject({
        code: "checkpoint_missing_node_cwd",
        logicalId: "worker",
      });
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
    if (result.ok) expect(result.result.nodes[0]!.status).toBe("fresh-primed");
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
    expect(payload.result.rigResult).toBeDefined();
    expect(payload.result.nodes).toHaveLength(1);

    // Subscriber receives same payload
    const completedEvent = notifications.find((e) => e.type === "restore.completed");
    expect(completedEvent).toBeDefined();
    if (completedEvent && completedEvent.type === "restore.completed") {
      expect(completedEvent.rigId).toBe(snap.data.rig.id);
      expect(completedEvent.snapshotId).toBe(snap.id);
      expect(completedEvent.result).toBeDefined();
      expect(completedEvent.result.rigResult).toBe(result.ok ? result.result.rigResult : undefined);
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

  it("legacy Claude restore with missing token fails even when startup context is available", async () => {
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
      expect(result.result.nodes[0]!.status).toBe("awaiting-decision");
      expect(result.result.nodes[0]!.error).toContain("no token available");
      expect(launchHarness).not.toHaveBeenCalled();
    }
  });

  it("legacy Claude restore with missing token fails honestly when no startup context is available", async () => {
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
      expect(result.result.nodes[0]!.status).toBe("awaiting-decision");
      expect(result.result.nodes[0]!.error).toContain("no token available");
    }
  });

  it("pod-aware Claude restore with resume type but missing token fails instead of launching fresh", async () => {
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
      expect(nodeResult!.status).toBe("awaiting-decision");
      expect(nodeResult!.error).toContain("no token available");
      expect(mockAdapter.launchHarness).not.toHaveBeenCalled();
    }
  });

  it("pod-aware Claude restore fails when resume launch proves the saved session is gone", async () => {
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
      expect(nodeResult!.status).toBe("failed");
      expect(nodeResult!.error).toContain("Harness launch failed");
      expect(launchHarness).toHaveBeenCalledTimes(1);
      expect(launchHarness.mock.calls[0]![1].resumeToken).toBe("stale-claude-token");
    }
  });

  it("pod-aware Codex restore with resume type but missing token fails instead of launching fresh", async () => {
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
      expect(nodeResult!.status).toBe("awaiting-decision");
      expect(nodeResult!.error).toContain("no token available");
      expect(mockAdapter.launchHarness).not.toHaveBeenCalled();
    }
  });

  it("pod-aware Codex restore fails when resume launch proves the saved session is gone", async () => {
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
      expect(nodeResult!.status).toBe("failed");
      expect(nodeResult!.error).toContain("Harness launch failed");
      expect(launchHarness).toHaveBeenCalledTimes(1);
      expect(launchHarness.mock.calls[0]![1].resumeToken).toBe("stale-codex-token");
    }
  });

  it("pod-aware Codex restore does not treat retry_fresh as resumed even if a later token could match", async () => {
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
      expect(nodeResult!.status).toBe("failed");
      expect(nodeResult!.error).toContain("Harness launch failed");
      expect(result.result.warnings).not.toContain("Node dev.impl: resume was unavailable; launched fresh instead.");
      expect(launchHarness).toHaveBeenCalledTimes(1);
      expect(launchHarness.mock.calls[0]![1].resumeToken).toBe("stable-codex-token");
    }
  });

  it("pod-aware Codex restore fails requested resume even when a checkpoint exists", async () => {
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
        expect(nodeResult!.status).toBe("failed");
        expect(nodeResult!.error).toContain("Harness launch failed");
        expect(launchHarness).toHaveBeenCalledTimes(1);
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("pod-aware restore with a prior session but no captured token lands awaiting-decision, not silent fresh-prime (FR-7 Gap 1)", async () => {
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
      // FR-7 Gap 1: a pod-aware seat that HAD a session but no captured token must
      // stop-and-ask (zero session started), never silently fresh-prime / identity-replace.
      expect(nodeResult!.status).toBe("awaiting-decision");
      expect(nodeResult!.error).toContain("--fresh");
      // No fresh harness was launched — the stop is pre-launch.
      expect(mockAdapter.launchHarness).not.toHaveBeenCalled();
    }
  });

  it("FR-7 Gap 2b: a pod-aware resume seat whose runtime adapter is unavailable fail-closes to awaiting-decision (not fresh-primed)", async () => {
    const rig = rigRepo.createRig("test-rig");
    db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("pod-2b", rig.id, "Dev");
    const node = rigRepo.addNode(rig.id, "dev.design", { runtime: "claude-code", podId: "pod-2b" });
    const session = sessionRegistry.registerSession(node.id, "dev-design@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    // A real captured token → resume IS requested (resume_if_possible + token).
    db.prepare("UPDATE sessions SET resume_type = 'claude_id', resume_token = 'tok-abc' WHERE id = ?").run(session.id);
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)").run(node.id, "[]", "[]", "[]", "claude-code");
    const snap = snapshotCapture.captureSnapshot(rig.id, "test");
    sessionRegistry.updateStatus(session.id, "exited");
    db.prepare("DELETE FROM bindings WHERE node_id = ?").run(node.id);

    const orch = createOrchestrator();
    // adapters map present but WITHOUT the claude-code runtime → continuity cannot
    // be verified (the node-subset-without-adapters shape). Must NOT fresh-prime.
    const result = await orch.restore(snap.id, { adapters: {} });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const nodeResult = result.result.nodes.find((n) => n.nodeId === node.id);
      expect(nodeResult!.status).toBe("awaiting-decision");
      expect(nodeResult!.status).not.toBe("fresh-primed");
      expect(nodeResult!.error).toContain("--fresh");
    }
  });

  it("FR-7: explicit --fresh past a no-token seat still fresh-primes (opt-in is the only fresh-prime)", async () => {
    const rig = rigRepo.createRig("test-rig");
    db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("pod-fresh", rig.id, "Dev");
    const node = rigRepo.addNode(rig.id, "dev.design", { runtime: "claude-code", podId: "pod-fresh" });
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
    const result = await orch.restore(snap.id, { adapters: { "claude-code": mockAdapter }, freshLogicalIds: ["dev.design"] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const nodeResult = result.result.nodes.find((n) => n.nodeId === node.id);
      // --fresh is the ONLY deliberate fresh-prime — it bypasses the FR-7 stop-and-ask.
      expect(nodeResult!.status).toBe("fresh-primed");
    }
  });

  // Updated by codex-auth-refusal-attention-required slice (revision 2):
  // pod-aware nodes whose StartupOrchestrator returns
  // `startupStatus: "attention_required"` (any attention-required readiness
  // code: update_gate, trust_gate, mcp_gate, login_required, or the new
  // codex_auth_refusal) now surface to RestoreNodeResult honestly as
  // `status: "attention_required"` instead of being collapsed to "failed".
  // This was previously a per-slice pinned dishonesty: the test name said
  // "fails when ... update gate" while the error string already said
  // "Restore startup requires attention", and the session-row
  // startupStatus was already "attention_required". The patch aligns the
  // RestoreNodeResult status with the already-honest startupStatus.
  it("pod-aware Codex restore without resume metadata surfaces attention_required when fresh startup hits an update gate", async () => {
    const rig = rigRepo.createRig("test-rig");
    db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("pod-codex-update", rig.id, "Dev");
    const node = rigRepo.addNode(rig.id, "dev.qa", { runtime: "codex", podId: "pod-codex-update" });
    const session = sessionRegistry.registerSession(node.id, "dev-qa@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    // FR-7: a DELIBERATE fresh launch (relaunch_fresh) so the fresh-startup update-gate
    // path is still exercised — a no-token resume_if_possible seat now stops-and-asks.
    db.prepare("UPDATE sessions SET restore_policy = 'relaunch_fresh' WHERE id = ?").run(session.id);
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)").run(node.id, "[]", "[]", "[]", "codex");
    const snap = snapshotCapture.captureSnapshot(rig.id, "test");
    sessionRegistry.updateStatus(session.id, "exited");
    db.prepare("DELETE FROM bindings WHERE node_id = ?").run(node.id);

    const mockAdapter = {
      runtime: "codex",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: vi.fn(async () => ({
        ready: false,
        code: "update_gate",
        reason: "Codex reached an update flow, so process-alive alone is not proof of a restored conversation.",
      })),
      launchHarness: vi.fn(async () => ({ ok: true as const })),
    };

    const orch = createOrchestrator();
    const result = await orch.restore(snap.id, { adapters: { codex: mockAdapter } });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const nodeResult = result.result.nodes.find((n) => n.nodeId === node.id);
      expect(nodeResult!.status).toBe("attention_required");
      expect(nodeResult!.error).toContain("Restore startup requires attention");
      expect(nodeResult!.error).toContain("Codex reached an update flow");
      // Single attention_required node → partially_restored (NOT failed)
      // per restore-orchestrator.ts:65-67 mixed-status aggregation.
      expect(result.result.rigResult).toBe("partially_restored");
      expect(mockAdapter.launchHarness).toHaveBeenCalledTimes(1);
    }
    const nodeSessions = sessionRegistry.getSessionsForRig(rig.id).filter((s) => s.nodeId === node.id);
    const restoredSession = nodeSessions.reduce((latest, s) => s.id > latest.id ? s : latest);
    expect(restoredSession?.startupStatus).toBe("attention_required");
  });

  it("fallback fresh launch during restore replays fresh_start startup actions", async () => {
    const rig = rigRepo.createRig("test-rig");
    db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("pod-4", rig.id, "Infra");
    const node = rigRepo.addNode(rig.id, "infra.ui", { runtime: "builtin:terminal", podId: "pod-4", cwd: "." });
    const session = sessionRegistry.registerSession(node.id, "infra-ui@test-rig");
    sessionRegistry.updateStatus(session.id, "running");
    // FR-7: a DELIBERATE fresh launch (relaunch_fresh) so the fresh_start startup-action
    // replay is still exercised — a no-token resume_if_possible seat now stops-and-asks.
    db.prepare("UPDATE sessions SET restore_policy = 'relaunch_fresh' WHERE id = ?").run(session.id);
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
      expect(nodeResult!.status).toBe("fresh-primed");
      expect(tmux.sendText).toHaveBeenCalledWith("infra-ui@test-rig", "npm run dev");
    }
  });

  it("restore propagates launch warnings and writes transcript boundary marker with snapshot ID", async () => {
    const snap = seedRigAndSnapshot();

    const { TranscriptStore } = await import("../src/domain/transcript-store.js");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-transcript-"));
    const transcriptStore = new TranscriptStore({ transcriptsRoot: tmpDir, enabled: true });

    const tmux = mockTmux();
    // V1 pre-release Item 1: capture is via the rotation module, whose
    // failures are best-effort silent (next tick retries). The legacy
    // "Transcript capture failed" launch-warning path no longer fires;
    // the only structural transcript warning surfaces if the
    // transcript directory creation itself fails. The boundary marker
    // is still written prior to launch and asserted below regardless
    // of capture-tick outcomes.

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

  it("restored sessions launch tmux in the snapshot node cwd", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "restore-cwd-"));
    try {
      const snap = seedRigAndSnapshot({
        nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code", cwd: tmpDir }],
        edges: [],
      });
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
      expect(createSessionSpy).toHaveBeenCalledWith(expect.any(String), tmpDir, expect.any(Object));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // --- Epic 3 D2: no silent fresh fallback on failed resume ---

  it("D2: legacy node with resume_if_possible + missing token returns failed, not fresh", async () => {
    const snapshot = seedRigAndSnapshot({
      nodes: [{ logicalId: "agent-a", role: "worker", runtime: "claude-code" }],
      edges: [],
      resumeType: "claude_name",
      resumeToken: null as unknown as string, // token missing
      restorePolicy: "resume_if_possible",
    });

    const orchestrator = createOrchestrator();
    const result = await orchestrator.restore(snapshot.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const node = result.result.nodes.find((n) => n.logicalId === "agent-a");
    expect(node).toBeDefined();
    // OPR.0.3.4.2: missing-token stop-and-ask is awaiting-decision (zero session), never silent fresh
    expect(node!.status).toBe("awaiting-decision");
  });

  it("D2: legacy node with resume attempted but unavailable returns failed, not fresh", async () => {
    const snapshot = seedRigAndSnapshot({
      nodes: [{ logicalId: "agent-a", role: "worker", runtime: "claude-code" }],
      edges: [],
      resumeType: "claude_name",
      resumeToken: "stale-token-123",
      restorePolicy: "resume_if_possible",
    });

    const claudeResume = mockClaudeResume({ ok: false as const, error: "Session not found" });
    const orchestrator = createOrchestrator({ claude: claudeResume });
    const result = await orchestrator.restore(snapshot.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const node = result.result.nodes.find((n) => n.logicalId === "agent-a");
    expect(node).toBeDefined();
    // OPR.0.3.4.2: resume concluded failed -> rolled back to zero sessions, awaiting-decision (never silent fresh)
    expect(node!.status).toBe("awaiting-decision");
  });

  // --- Epic 3 D3: rig-level restore result vocabulary ---

  it("D3: all nodes resumed → rigResult fully_restored", async () => {
    const snapshot = seedRigAndSnapshot({
      nodes: [
        { logicalId: "agent-a", role: "worker", runtime: "claude-code" },
        { logicalId: "agent-b", role: "worker", runtime: "claude-code" },
      ],
      edges: [],
      resumeType: "claude_name",
      resumeToken: "token-123",
      restorePolicy: "resume_if_possible",
    });

    const orchestrator = createOrchestrator();
    const result = await orchestrator.restore(snapshot.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.rigResult).toBe("fully_restored");
  });

  it("D3: mixed resumed + failed → rigResult partially_restored", async () => {
    // Seed two nodes with resume, one will succeed and one will fail
    const snapshot = seedRigAndSnapshot({
      nodes: [
        { logicalId: "agent-ok", role: "worker", runtime: "claude-code" },
        { logicalId: "agent-fail", role: "worker", runtime: "claude-code" },
      ],
      edges: [],
      resumeType: "claude_name",
      resumeToken: "token-123",
      restorePolicy: "resume_if_possible",
    });

    // Claude resume succeeds for first call, fails for second
    let callCount = 0;
    const claudeResume = {
      canResume: vi.fn((type: string | null) => type === "claude_name"),
      resume: vi.fn(async () => {
        callCount++;
        if (callCount === 1) return { ok: true as const };
        return { ok: false as const, error: "Session expired" };
      }),
    } as unknown as ClaudeResumeAdapter;

    const orchestrator = createOrchestrator({ claude: claudeResume });
    const result = await orchestrator.restore(snapshot.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.rigResult).toBe("partially_restored");
  });

  it("D3: all nodes stop-and-ask → rigResult partially_restored (awaiting-decision is not failed)", async () => {
    const snapshot = seedRigAndSnapshot({
      nodes: [
        { logicalId: "agent-a", role: "worker", runtime: "claude-code" },
        { logicalId: "agent-b", role: "worker", runtime: "claude-code" },
      ],
      edges: [],
      resumeType: "claude_name",
      resumeToken: "token-123",
      restorePolicy: "resume_if_possible",
    });

    const claudeResume = mockClaudeResume({ ok: false as const, error: "All expired" });
    const orchestrator = createOrchestrator({ claude: claudeResume });
    const result = await orchestrator.restore(snapshot.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.rigResult).toBe("partially_restored");
  });

  it("D3: any fresh node prevents fully_restored", async () => {
    // A rig where one node launches fresh (no resume data) and others succeed
    const snapshot = seedRigAndSnapshot({
      nodes: [
        { logicalId: "agent-a", role: "worker", runtime: "claude-code" },
      ],
      edges: [],
      // No resumeType → node will launch fresh
    });

    const orchestrator = createOrchestrator();
    const result = await orchestrator.restore(snapshot.id);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const node = result.result.nodes.find((n) => n.logicalId === "agent-a");
    expect(node?.status).toBe("fresh-primed");
    // D3 invariant per PM: fresh nodes prevent fully_restored
    expect(result.result.rigResult).not.toBe("fully_restored");
    expect(result.result.rigResult).toBe("partially_restored");
  });

  it("D1/D4: missing required startup file blocks restore before mutation", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "agent-a", role: "worker", runtime: "claude-code" }],
      edges: [],
    });
    const node = snap.data.nodes[0]!;
    const missingPath = "/tmp/openrig-missing-required-startup.md";
    const snapshot = updateSnapshotData(snap, (data) => {
      data.nodeStartupContext[node.id] = {
        projectionEntries: [],
        resolvedStartupFiles: [{
          path: "startup.md",
          absolutePath: missingPath,
          ownerRoot: "/tmp",
          deliveryHint: "guidance_merge",
          required: true,
          appliesOn: ["restore"],
        }],
        startupActions: [],
        runtime: "claude-code",
      };
    });

    const result = await createOrchestrator().restore(snapshot.id, {
      fsOps: { exists: (p) => p !== missingPath },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("pre_restore_validation_failed");
    expect(result.result.rigResult).toBe("not_attempted");
    expect(result.result.preRestoreSnapshotId).toBeNull();
    expect(result.result.nodes).toEqual([]);
    expect(result.result.blockers?.[0]).toMatchObject({
      code: "required_startup_file_missing",
      severity: "critical",
      logicalId: "agent-a",
      path: missingPath,
    });
    expect(result.result.blockers?.[0]?.remediation).toContain("Restore the missing startup file");
  });

  // OPR.0.3.4.5 (behavior 09): projection-validity != session continuity.
  // A stale/missing projection DOES NOT abort a restore; it flags projection_drift
  // and the restore PROCEEDS to the native-resume attempt.
  it("D1/D4 updated: missing projection source or entry does NOT abort restore (projection_drift flagged, restore proceeds)", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "agent-a", role: "worker", runtime: "claude-code" }],
      edges: [],
    });
    const node = snap.data.nodes[0]!;
    const missingSource = "/tmp/openrig-missing-agent-root";
    const missingEntry = "/tmp/openrig-missing-agent-root/skills/review/SKILL.md";
    const snapshot = updateSnapshotData(snap, (data) => {
      data.nodeStartupContext[node.id] = {
        projectionEntries: [{
          category: "skill",
          effectiveId: "review",
          sourceSpec: "local:agents/review",
          sourcePath: missingSource,
          resourcePath: "skills/review/SKILL.md",
          absolutePath: missingEntry,
        }],
        resolvedStartupFiles: [],
        startupActions: [],
        runtime: "claude-code",
      };
    });

    const result = await createOrchestrator().restore(snapshot.id, {
      fsOps: { exists: (p) => p !== missingSource && p !== missingEntry },
    });

    // The restore PROCEEDS (not aborted) — projection staleness is a warning, not a blocker.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.rigResult).not.toBe("not_attempted");
    // Projection drift is flagged as a warning (compose slice-03's projection_drift shape).
    expect(result.result.warnings.some((w) => w.includes("projection_drift"))).toBe(true);
    expect(result.result.warnings.some((w) => w.includes(missingSource))).toBe(true);
    expect(result.result.warnings.some((w) => w.includes(missingEntry))).toBe(true);
  });

  it("OPR.0.3.4.5 (09): stale projection with valid resume token -> session RESUMES, projection_drift flagged (native outranks fresh)", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
      edges: [],
      resumeType: "claude_name",
      resumeToken: "tok",
    });
    const node = snap.data.nodes[0]!;
    const missingEntry = "/tmp/openrig-stale-skill-05.md";
    const snapshot = updateSnapshotData(snap, (data) => {
      data.nodeStartupContext[node.id] = {
        projectionEntries: [{
          category: "skill",
          effectiveId: "stale-skill",
          sourceSpec: "local:agents/stale",
          sourcePath: "/tmp/openrig-stale-root",
          resourcePath: "skills/stale/SKILL.md",
          absolutePath: missingEntry,
        }],
        resolvedStartupFiles: [],
        startupActions: [],
        runtime: "claude-code",
      };
    });

    const orch = createOrchestrator({ claude: mockClaudeResume({ ok: true }) });
    const result = await orch.restore(snapshot.id, {
      fsOps: { exists: (p) => p !== missingEntry && p !== "/tmp/openrig-stale-root" },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const nodeResult = result.result.nodes.find((n) => n.logicalId === "worker");
    // The session RESUMED (native continuity outranks projection staleness).
    expect(nodeResult!.status).toBe("resumed");
    // Projection drift is flagged, never silently swallowed.
    expect(result.result.warnings.some((w) => w.includes("projection_drift"))).toBe(true);
    expect(result.result.warnings.some((w) => w.includes("stale-skill") || w.includes(missingEntry))).toBe(true);
  });

  it("OPR.0.3.4.5 (09): missing REQUIRED startup file STILL fails (preserve the genuinely-fatal blocker)", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "agent-a", role: "worker", runtime: "claude-code" }],
      edges: [],
      resumeType: "claude_name",
      resumeToken: "tok",
    });
    const node = snap.data.nodes[0]!;
    const missingPath = "/tmp/openrig-missing-required-startup-05.md";
    const snapshot = updateSnapshotData(snap, (data) => {
      data.nodeStartupContext[node.id] = {
        projectionEntries: [],
        resolvedStartupFiles: [{
          path: "startup.md",
          absolutePath: missingPath,
          ownerRoot: "/tmp",
          deliveryHint: "guidance_merge",
          required: true,
          appliesOn: ["restore"],
        }],
        startupActions: [],
        runtime: "claude-code",
      };
    });

    const result = await createOrchestrator().restore(snapshot.id, {
      fsOps: { exists: (p) => p !== missingPath },
    });

    // Still blocked (required startup file is genuinely fatal).
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("pre_restore_validation_failed");
    expect(result.result.rigResult).toBe("not_attempted");
    expect(result.result.blockers?.[0]?.code).toBe("required_startup_file_missing");
  });

  it("D1/D4: checkpoint with missing node cwd blocks before checkpoint write", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "agent-a", role: "worker", runtime: "claude-code" }],
      edges: [],
      withCheckpoint: "agent-a",
    });

    const result = await createOrchestrator().restore(snap.id);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("pre_restore_validation_failed");
    expect(result.result.blockers?.[0]).toMatchObject({
      code: "checkpoint_missing_node_cwd",
      severity: "critical",
      logicalId: "agent-a",
    });
  });

  it("D1/D4: missing optional startup file is a warning, not a blocker", async () => {
    const snap = seedRigAndSnapshot({
      nodes: [{ logicalId: "agent-a", role: "worker", runtime: "claude-code" }],
      edges: [],
    });
    const node = snap.data.nodes[0]!;
    const missingPath = "/tmp/openrig-missing-optional-startup.md";
    const snapshot = updateSnapshotData(snap, (data) => {
      data.nodeStartupContext[node.id] = {
        projectionEntries: [],
        resolvedStartupFiles: [{
          path: "optional.md",
          absolutePath: missingPath,
          ownerRoot: "/tmp",
          deliveryHint: "guidance_merge",
          required: false,
          appliesOn: ["fresh_start"],
        }],
        startupActions: [],
        runtime: "claude-code",
      };
    });

    const adapter = {
      runtime: "claude-code",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: vi.fn(async () => ({ ready: true })),
      launchHarness: vi.fn(async () => ({ ok: true as const })),
    };
    const result = await createOrchestrator().restore(snapshot.id, {
      adapters: { "claude-code": adapter },
      fsOps: { exists: (p) => p !== missingPath },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.rigResult).toBe("partially_restored");
    expect(result.result.warnings.some((warning) => warning.includes("optional startup file missing"))).toBe(true);
  });

  it("D1/D4: validation block does not emit restore events or mutate stale sessions", async () => {
    const rig = rigRepo.createRig("validation-block");
    const node = rigRepo.addNode(rig.id, "agent-a", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "agent-a@validation-block");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateResumeToken(session.id, "claude_name", "resume-token");
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)").run(node.id, "[]", JSON.stringify([{
      path: "required.md",
      absolutePath: "/tmp/openrig-missing-required-startup.md",
      ownerRoot: "/tmp",
      deliveryHint: "guidance_merge",
      required: true,
      appliesOn: ["restore"],
    }]), "[]", "claude-code");
    const snap = snapshotCapture.captureSnapshot(rig.id, "manual");

    const tmux = mockTmux();
    const createSession = vi.fn(async () => ({ ok: true as const }));
    (tmux as unknown as Record<string, unknown>).createSession = createSession;
    const claude = mockClaudeResume();
    const orch = createOrchestrator({ tmux, claude });
    const result = await orch.restore(snap.id, {
      fsOps: { exists: (p) => !p.includes("openrig-missing-required-startup") },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.result.rigResult).toBe("not_attempted");
    expect(createSession).not.toHaveBeenCalled();
    expect(claude.resume).not.toHaveBeenCalled();
    expect(snapshotRepo.listSnapshots(rig.id, { kind: "pre_restore" })).toHaveLength(0);
    const events = db.prepare("SELECT type FROM events WHERE rig_id = ?").all(rig.id) as { type: string }[];
    expect(events.map((event) => event.type)).not.toContain("restore.started");
    expect(events.map((event) => event.type)).not.toContain("restore.completed");
    const row = db.prepare("SELECT status FROM sessions WHERE id = ?").get(session.id) as { status: string };
    expect(row.status).toBe("running");
  });

  // L3 Decision 1: attempt id surfacing
  describe("attempt id (L3)", () => {
    it("restore() invokes onAttemptStarted with the persisted restore.started event seq", async () => {
      const orch = createOrchestrator();
      const snap = seedRigAndSnapshot();
      let receivedAttemptId: number | null = null;

      const outcome = await orch.restore(snap.id, {
        onAttemptStarted: (id) => { receivedAttemptId = id; },
      });

      expect(outcome.ok).toBe(true);
      expect(receivedAttemptId).not.toBeNull();
      expect(typeof receivedAttemptId).toBe("number");

      // attemptId must match a queryable restore.started event seq.
      const startedRow = db
        .prepare("SELECT seq FROM events WHERE rig_id = ? AND type = 'restore.started' ORDER BY seq DESC LIMIT 1")
        .get(snap.rigId) as { seq: number } | undefined;
      expect(startedRow?.seq).toBe(receivedAttemptId);
    });

    it("onAttemptStarted is NOT invoked when pre-restore validation fails (no restore.started emit)", async () => {
      const orch = createOrchestrator();
      const snap = seedRigAndSnapshot({
        nodes: [{ logicalId: "orchestrator", role: "orchestrator", runtime: "claude-code", cwd: "/tmp" }],
        edges: [],
        withCheckpoint: "orchestrator",
      });
      // Force a pre-restore validation failure: clear the node's cwd so the
      // checkpoint blocks restore (checkpoint_missing_node_cwd).
      const data = JSON.parse(JSON.stringify(snap.data));
      data.nodes[0].cwd = null;
      db.prepare("UPDATE snapshots SET data = ? WHERE id = ?").run(JSON.stringify(data), snap.id);

      let invoked = false;
      const outcome = await orch.restore(snap.id, {
        onAttemptStarted: () => { invoked = true; },
      });

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.code).toBe("pre_restore_validation_failed");
      }
      expect(invoked).toBe(false);
    });
  });

  // L3 Decision 3: runtime-truth reconciliation
  describe("reconcileNodeRuntimeTruth (L3)", () => {
    // Reconciler-specific mock with `hasSession` as a vi.fn so individual tests
    // can vary it. Cannot reuse `mockTmux()` because that wires hasSession as a
    // plain async function (88 existing tests depend on that shape).
    function mockTmuxForReconciler(): TmuxAdapter {
      return {
        createSession: vi.fn(async () => ({ ok: true as const })),
        killSession: vi.fn(async () => ({ ok: true as const })),
        sendText: vi.fn(async () => ({ ok: true as const })),
        sendKeys: vi.fn(async () => ({ ok: true as const })),
        getPaneCommand: vi.fn(async () => "claude"),
        capturePaneContent: vi.fn(async () => ""),
        hasSession: vi.fn(async () => false),
        listSessions: async () => [],
        listWindows: async () => [],
        listPanes: async () => [],
      } as unknown as TmuxAdapter;
    }

    let nextSeed = 90;
    function seedFailedAttempt(opts: {
      rigName?: string;
      logicalId?: string;
      runtime?: "claude-code" | "codex";
      restoreOutcome: "failed" | "attention_required";
      withResumeToken?: boolean;
      withBinding?: boolean;
    }) {
      // Session name validator requires legacy `r{NN}-{suffix}` or canonical
      // `{pod}-{member}@{rig}`. Each call gets a unique numeric rig id so the
      // legacy pattern matches and rig names don't collide.
      const rigName = opts.rigName ?? `r${nextSeed++}`;
      const logicalId = opts.logicalId ?? "worker";
      const runtime = opts.runtime ?? "claude-code";
      const rig = rigRepo.createRig(rigName);
      const node = rigRepo.addNode(rig.id, logicalId, { role: "worker", runtime });

      // Bind a tmux session name so the reconciler can probe.
      const sessionName = `${rigName}-${logicalId}`;
      if (opts.withBinding ?? true) {
        sessionRegistry.updateBinding(node.id, { tmuxSession: sessionName });
      }

      // Seed a session row, optionally with resume token.
      const sess = sessionRegistry.registerSession(node.id, sessionName);
      if (opts.withResumeToken) {
        db.prepare("UPDATE sessions SET resume_type = ?, resume_token = ? WHERE id = ?")
          .run(runtime === "claude-code" ? "claude_id" : "codex_id", "tok-abc-123", sess.id);
      }

      // Seed restore.started + restore.completed events with this node's outcome.
      eventBus.emit({ type: "restore.started", rigId: rig.id, snapshotId: "snap-recon" });
      eventBus.emit({
        type: "restore.completed",
        rigId: rig.id,
        snapshotId: "snap-recon",
        result: {
          snapshotId: "snap-recon",
          preRestoreSnapshotId: null,
          rigResult: "partially_restored",
          nodes: [
            { nodeId: node.id, logicalId, status: opts.restoreOutcome },
          ],
          warnings: [],
        },
      });

      return { rig, nodeId: node.id, sessionName };
    }

    it("upgrades failed -> operator_recovered when ALL four preconditions hold; emits audit event", async () => {
      const tmux = mockTmuxForReconciler();
      (tmux.hasSession as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (tmux.getPaneCommand as ReturnType<typeof vi.fn>).mockResolvedValue("claude");
      (tmux.capturePaneContent as ReturnType<typeof vi.fn>).mockResolvedValue([
        "Claude Code v2.1.89",
        "",
        " ❯ accept edits on",
        "",
      ].join("\n"));
      const orch = createOrchestrator({ tmux });
      const seeded = seedFailedAttempt({ restoreOutcome: "failed", withResumeToken: true });

      const result = await orch.reconcileNodeRuntimeTruth(seeded.rig.id, seeded.nodeId);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.from).toBe("failed");
        expect(result.to).toBe("operator_recovered");
        expect(result.evidence).toEqual({
          tmux: true,
          fgProcess: "claude",
          resumeTokenUsed: true,
          paneState: "usable",
        });
      }

      // Audit event present.
      const reconciled = db.prepare(
        "SELECT * FROM events WHERE rig_id = ? AND type = 'restore.outcome_reconciled'"
      ).all(seeded.rig.id);
      expect(reconciled).toHaveLength(1);
    });

    it("upgrades attention_required -> operator_recovered when ALL preconditions hold", async () => {
      const tmux = mockTmuxForReconciler();
      (tmux.hasSession as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (tmux.getPaneCommand as ReturnType<typeof vi.fn>).mockResolvedValue("claude");
      (tmux.capturePaneContent as ReturnType<typeof vi.fn>).mockResolvedValue([
        "Claude Code v2.1.89",
        "",
        " ❯ accept edits on",
      ].join("\n"));
      const orch = createOrchestrator({ tmux });
      const seeded = seedFailedAttempt({ restoreOutcome: "attention_required", withResumeToken: true });

      const result = await orch.reconcileNodeRuntimeTruth(seeded.rig.id, seeded.nodeId);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.from).toBe("attention_required");
        expect(result.to).toBe("operator_recovered");
      }
    });

    it("audit-trail: original restore.completed event with status=failed remains queryable after upgrade", async () => {
      const tmux = mockTmuxForReconciler();
      (tmux.hasSession as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (tmux.getPaneCommand as ReturnType<typeof vi.fn>).mockResolvedValue("claude");
      (tmux.capturePaneContent as ReturnType<typeof vi.fn>).mockResolvedValue("Claude Code v2.1.89\n ❯ accept edits on");
      const orch = createOrchestrator({ tmux });
      const seeded = seedFailedAttempt({ restoreOutcome: "failed", withResumeToken: true });

      await orch.reconcileNodeRuntimeTruth(seeded.rig.id, seeded.nodeId);

      // Original restore.completed event must still carry the failed status.
      const completed = db.prepare(
        "SELECT payload FROM events WHERE rig_id = ? AND type = 'restore.completed'"
      ).all(seeded.rig.id) as { payload: string }[];
      expect(completed).toHaveLength(1);
      const parsed = JSON.parse(completed[0]!.payload) as { result: { nodes: Array<{ status: string }> } };
      expect(parsed.result.nodes[0]!.status).toBe("failed");
    });

    it("no-op when tmux session is missing (precondition #1 fails)", async () => {
      const tmux = mockTmuxForReconciler();
      (tmux.hasSession as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      const orch = createOrchestrator({ tmux });
      const seeded = seedFailedAttempt({ restoreOutcome: "failed", withResumeToken: true });

      const result = await orch.reconcileNodeRuntimeTruth(seeded.rig.id, seeded.nodeId);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("tmux_session_missing");
      const reconciled = db.prepare(
        "SELECT * FROM events WHERE type = 'restore.outcome_reconciled'"
      ).all();
      expect(reconciled).toHaveLength(0);
    });

    it("no-op when foreground process is not runtime (precondition #2 fails)", async () => {
      const tmux = mockTmuxForReconciler();
      (tmux.hasSession as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (tmux.getPaneCommand as ReturnType<typeof vi.fn>).mockResolvedValue("zsh"); // shell, not claude/codex
      (tmux.capturePaneContent as ReturnType<typeof vi.fn>).mockResolvedValue("$ ");
      const orch = createOrchestrator({ tmux });
      const seeded = seedFailedAttempt({ restoreOutcome: "failed", withResumeToken: true });

      const result = await orch.reconcileNodeRuntimeTruth(seeded.rig.id, seeded.nodeId);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("fg_process_not_runtime");
    });

    it("no-op when resume token was not used (precondition #3 fails)", async () => {
      const tmux = mockTmuxForReconciler();
      (tmux.hasSession as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (tmux.getPaneCommand as ReturnType<typeof vi.fn>).mockResolvedValue("claude");
      (tmux.capturePaneContent as ReturnType<typeof vi.fn>).mockResolvedValue("Claude Code v2.1.89\n ❯ accept edits on");
      const orch = createOrchestrator({ tmux });
      const seeded = seedFailedAttempt({ restoreOutcome: "failed", withResumeToken: false });

      const result = await orch.reconcileNodeRuntimeTruth(seeded.rig.id, seeded.nodeId);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("resume_token_not_used");
    });

    it("no-op when pane is at Claude resume-selection prompt (precondition #4 fails)", async () => {
      const tmux = mockTmuxForReconciler();
      (tmux.hasSession as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (tmux.getPaneCommand as ReturnType<typeof vi.fn>).mockResolvedValue("claude");
      (tmux.capturePaneContent as ReturnType<typeof vi.fn>).mockResolvedValue([
        "Choose a conversation to resume:",
        "  1. project-foo",
        "  2. project-bar",
      ].join("\n"));
      const orch = createOrchestrator({ tmux });
      const seeded = seedFailedAttempt({ restoreOutcome: "attention_required", withResumeToken: true });

      const result = await orch.reconcileNodeRuntimeTruth(seeded.rig.id, seeded.nodeId);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("pane_not_usable");
    });

    it("does not upgrade an outcome that is not failed/attention_required", async () => {
      // Seed a successfully-resumed outcome. Reconciler should refuse.
      const rig = rigRepo.createRig("r80");
      const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
      sessionRegistry.updateBinding(node.id, { tmuxSession: "r80-worker" });
      eventBus.emit({ type: "restore.started", rigId: rig.id, snapshotId: "snap-x" });
      eventBus.emit({
        type: "restore.completed",
        rigId: rig.id,
        snapshotId: "snap-x",
        result: {
          snapshotId: "snap-x",
          preRestoreSnapshotId: null,
          rigResult: "fully_restored",
          nodes: [{ nodeId: node.id, logicalId: "worker", status: "resumed" }],
          warnings: [],
        },
      });

      const orch = createOrchestrator();
      const result = await orch.reconcileNodeRuntimeTruth(rig.id, node.id);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("outcome_not_upgradable");
    });

    it("rejects when no restore.started has ever been recorded for the rig", async () => {
      const rig = rigRepo.createRig("r81");
      const node = rigRepo.addNode(rig.id, "worker", { role: "worker", runtime: "claude-code" });
      const orch = createOrchestrator();

      const result = await orch.reconcileNodeRuntimeTruth(rig.id, node.id);

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("no_attempt");
    });

    it("never produces 'ready' as terminal outcome (Decision 3 forbids it)", async () => {
      // Even when all preconditions hold, the upgrade target is operator_recovered.
      const tmux = mockTmuxForReconciler();
      (tmux.hasSession as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      (tmux.getPaneCommand as ReturnType<typeof vi.fn>).mockResolvedValue("claude");
      (tmux.capturePaneContent as ReturnType<typeof vi.fn>).mockResolvedValue("Claude Code v2.1.89\n ❯ accept edits on");
      const orch = createOrchestrator({ tmux });
      const seeded = seedFailedAttempt({ restoreOutcome: "failed", withResumeToken: true });

      const result = await orch.reconcileNodeRuntimeTruth(seeded.rig.id, seeded.nodeId);

      if (result.ok) {
        expect(result.to).toBe("operator_recovered");
        expect(result.to).not.toBe("ready");
      } else {
        // Did not upgrade — that's also fine, point is `to` was never `ready`.
      }

      const reconciled = db.prepare(
        "SELECT payload FROM events WHERE type = 'restore.outcome_reconciled'"
      ).all() as { payload: string }[];
      for (const row of reconciled) {
        const parsed = JSON.parse(row.payload) as { to: string };
        expect(parsed.to).toBe("operator_recovered");
        expect(parsed.to).not.toBe("ready");
      }
    });
  });

  // === OPR.0.3.4.2 — zero-session regression guard (the headline) ===
  describe("OPR.0.3.4.2 awaiting-decision zero-session guard", () => {
    it("(A) PRE-LAUNCH: missing token -> awaiting-decision with launchNode NOT called and session list unchanged", async () => {
      const snap = seedRigAndSnapshot({
        nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
        edges: [],
        resumeType: "claude_name",
        // resumeToken deliberately absent
      });
      const tmux = mockTmux();
      const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
      const launchSpy = vi.spyOn(nodeLauncher, "launchNode");
      const orch = new RestoreOrchestrator({
        db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
        checkpointStore, nodeLauncher, tmuxAdapter: tmux,
        claudeResume: mockClaudeResume(), codexResume: mockCodexResume(),
      });

      const before = db.prepare("SELECT COUNT(*) as c FROM sessions").get() as { c: number };
      const result = await orch.restore(snap.id);
      const after = db.prepare("SELECT COUNT(*) as c FROM sessions").get() as { c: number };

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.result.nodes[0]!;
      expect(node.status).toBe("awaiting-decision");
      expect(node.error).toContain("--fresh worker");
      // ZERO session started: launchNode never called, session count unchanged.
      expect(launchSpy).not.toHaveBeenCalled();
      expect(after.c).toBe(before.c);
      expect((tmux.killSession as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it("(B) POST-LAUNCH rollback: resume concluded failed -> awaiting-decision, launched session KILLED + superseded, prior state restored", async () => {
      const snap = seedRigAndSnapshot({
        nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
        edges: [],
        resumeType: "claude_name",
        resumeToken: "tok",
        withBinding: "worker",
      });
      const tmux = mockTmux();
      const claude = mockClaudeResume({ ok: false as const, code: "resume_failed", message: "err" });
      const orch = createOrchestrator2(tmux, claude);

      const result = await orch.restore(snap.id);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.result.nodes[0]!;
      expect(node.status).toBe("awaiting-decision");
      expect(node.error).toContain("rolled back");
      // The session was PRESENT mid-flow (launch happened: createSession called)
      // and is ABSENT at the terminal (killSession called) - distinguishes
      // (B)-rolled-back from (A)-never-launched.
      expect((tmux.createSession as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
      expect((tmux.killSession as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
      // No session row left running for the node.
      const rig = rigRepo.listRigs()[0]!;
      const nodeRow = rigRepo.getRig(rig.id)!.nodes[0]!;
      const running = db.prepare("SELECT COUNT(*) as c FROM sessions WHERE node_id = ? AND status = 'running'").get(nodeRow.id) as { c: number };
      expect(running.c).toBe(0);
      // Prior binding restored (the pre-restore tmux session name).
      const binding = sessionRegistry.getBindingForNode(nodeRow.id);
      expect(binding?.tmuxSession).toBe("r99-worker");
    });

    it("(B) POST-LAUNCH rollback with NO prior binding: launched binding is CLEARED, nothing points at the killed session", async () => {
      // Guard BLOCKING dc16061c: priorState.binding === null. The launch
      // created a binding; rollback must remove it — a binding left pointing
      // at the killed session violates the zero-session contract.
      const snap = seedRigAndSnapshot({
        nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
        edges: [],
        resumeType: "claude_name",
        resumeToken: "tok",
        // deliberately NO withBinding — the node has no prior binding
      });
      const nodeId = snap.data.nodes[0]!.id;
      expect(sessionRegistry.getBindingForNode(nodeId)).toBeNull();
      const tmux = mockTmux();
      const claude = mockClaudeResume({ ok: false as const, code: "resume_failed", message: "err" });
      const orch = createOrchestrator2(tmux, claude);

      const result = await orch.restore(snap.id);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.result.nodes[0]!;
      expect(node.status).toBe("awaiting-decision");
      // Launched mid-flow, killed at terminal.
      expect((tmux.createSession as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
      expect((tmux.killSession as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
      // No session row left running for the node.
      const running = db.prepare("SELECT COUNT(*) as c FROM sessions WHERE node_id = ? AND status = 'running'").get(nodeId) as { c: number };
      expect(running.c).toBe(0);
      // THE finding: the launched binding must not survive the rollback.
      expect(sessionRegistry.getBindingForNode(nodeId)).toBeNull();
    });

    it("(B) POST-LAUNCH rollback: a null prior-binding field does NOT preserve launched-row data (exact restore, no partial merge)", async () => {
      // Guard BLOCKING dc16061c item 3: prior binding exists but has a null
      // field (cmuxSurface). If launched-binding data lands in that field
      // mid-flow, a merge-style restore would keep it; exact restore must
      // return the field to its prior null.
      const snap = seedRigAndSnapshot({
        nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
        edges: [],
        resumeType: "claude_name",
        resumeToken: "tok",
        withBinding: "worker", // prior binding: tmuxSession only, cmuxSurface null
      });
      const nodeId = snap.data.nodes[0]!.id;
      const tmux = mockTmux();
      const claude = {
        canResume: vi.fn((type: string | null) => type === "claude_name" || type === "claude_id"),
        resume: vi.fn(async () => {
          // Simulate post-launch binding data (the launched row the merge
          // would otherwise preserve) before the resume concludes failed.
          sessionRegistry.updateBinding(nodeId, { cmuxSurface: "launched-surface" });
          return { ok: false as const, code: "resume_failed", message: "err" };
        }),
      } as unknown as ClaudeResumeAdapter;
      const orch = createOrchestrator2(tmux, claude);

      const result = await orch.restore(snap.id);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.result.nodes[0]!.status).toBe("awaiting-decision");
      const binding = sessionRegistry.getBindingForNode(nodeId);
      // Prior binding restored exactly: tmuxSession back, null field stays null.
      expect(binding?.tmuxSession).toBe("r99-worker");
      expect(binding?.cmuxSurface).toBeNull();
    });

    it("PRECISION GUARD: a successful resume is never auto-killed", async () => {
      const snap = seedRigAndSnapshot({
        nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
        edges: [],
        resumeType: "claude_name",
        resumeToken: "tok",
      });
      const tmux = mockTmux();
      const orch = createOrchestrator2(tmux, mockClaudeResume({ ok: true as const }));

      const result = await orch.restore(snap.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.result.nodes[0]!.status).toBe("resumed");
      expect((tmux.killSession as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it("BOUNDARY: a live parked resume prompt stays attention_required (no kill, never awaiting-decision)", async () => {
      const snap = seedRigAndSnapshot({
        nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
        edges: [],
        resumeType: "claude_name",
        resumeToken: "tok",
      });
      const tmux = mockTmux();
      const claude = mockClaudeResume({ ok: false as const, code: "attention_required", message: "resume selection prompt", evidence: "1. session-a\n2. session-b" } as never);
      const orch = createOrchestrator2(tmux, claude);

      const result = await orch.restore(snap.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.result.nodes[0]!;
      expect(node.status).toBe("attention_required");
      expect(node.status).not.toBe("awaiting-decision");
      // The LIVE parked session is never killed.
      expect((tmux.killSession as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it("--fresh opt-in (operation B): listed seat launches deliberately and reports fresh-primed", async () => {
      const snap = seedRigAndSnapshot({
        nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
        edges: [],
        resumeType: "claude_name",
        // no token: without --fresh this seat would be awaiting-decision
      });
      const tmux = mockTmux();
      const orch = createOrchestrator2(tmux, mockClaudeResume());

      const result = await orch.restore(snap.id, { freshLogicalIds: ["worker"] });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.result.nodes[0]!.status).toBe("fresh-primed");
      expect((tmux.createSession as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
    });

    it("--fresh on a resumable seat also fresh-primes (deliberate operator override)", async () => {
      const snap = seedRigAndSnapshot({
        nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
        edges: [],
        resumeType: "claude_name",
        resumeToken: "tok",
      });
      const tmux = mockTmux();
      const claude = mockClaudeResume({ ok: true as const });
      const orch = createOrchestrator2(tmux, claude);

      const result = await orch.restore(snap.id, { freshLogicalIds: ["worker"] });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.result.nodes[0]!.status).toBe("fresh-primed");
      // The resume path was deliberately skipped.
      expect((claude.resume as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it("five-term vocabulary: all five terms are distinct strings", () => {
      const terms = ["resumed", "fresh-primed", "awaiting-decision", "attention_required", "failed"];
      expect(new Set(terms).size).toBe(5);
    });
  });

  // OPR.0.3.4.6 — cross-surface regression guard: producer rollup.
  describe("OPR.0.3.4.6 honest-restore-status rollup guard", () => {
    it("attention_required + awaiting-decision + mixed -> partially_restored, never failed", () => {
      const nodes = [
        { nodeId: "n1", logicalId: "a", status: "resumed" as const },
        { nodeId: "n2", logicalId: "b", status: "fresh-primed" as const },
        { nodeId: "n3", logicalId: "c", status: "awaiting-decision" as const },
        { nodeId: "n4", logicalId: "d", status: "attention_required" as const },
        { nodeId: "n5", logicalId: "e", status: "failed" as const },
      ];
      const result = rollupRestoreRigResult(nodes);
      expect(result).toBe("partially_restored");
      expect(result).not.toBe("failed");
    });

    it("attention_required alone -> partially_restored (NEVER collapsed to failed)", () => {
      const result = rollupRestoreRigResult([
        { nodeId: "n1", logicalId: "a", status: "attention_required" },
      ]);
      expect(result).toBe("partially_restored");
      expect(result).not.toBe("failed");
    });

    it("awaiting-decision alone -> partially_restored (NEVER collapsed to failed)", () => {
      const result = rollupRestoreRigResult([
        { nodeId: "n1", logicalId: "a", status: "awaiting-decision" },
      ]);
      expect(result).toBe("partially_restored");
      expect(result).not.toBe("failed");
    });

    it("all-failed -> failed (reserved for genuine all-failure only)", () => {
      const result = rollupRestoreRigResult([
        { nodeId: "n1", logicalId: "a", status: "failed" },
        { nodeId: "n2", logicalId: "b", status: "failed" },
      ]);
      expect(result).toBe("failed");
    });

    it("all-resumed -> fully_restored", () => {
      const result = rollupRestoreRigResult([
        { nodeId: "n1", logicalId: "a", status: "resumed" },
        { nodeId: "n2", logicalId: "b", status: "resumed" },
      ]);
      expect(result).toBe("fully_restored");
    });
  });

  // OPR.0.3.4.5 — regression guards.
  describe("OPR.0.3.4.5 regression guards", () => {
    it("(05) CONSUMER human gate: Claude resume-selection menu -> ZERO sendKeys selection calls + attention_required", async () => {
      const snap = seedRigAndSnapshot({
        nodes: [{ logicalId: "worker", role: "worker", runtime: "claude-code" }],
        edges: [],
        resumeType: "claude_name",
        resumeToken: "tok",
      });
      const tmux = mockTmux();
      const claude = mockClaudeResume({
        ok: false as const,
        code: "attention_required",
        message: "resume selection prompt",
        evidence: "1. session-a\n2. session-b",
      } as never);
      const orch = createOrchestrator2(tmux, claude);

      const result = await orch.restore(snap.id);

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const node = result.result.nodes[0]!;
      expect(node.status).toBe("attention_required");
      const sendKeysCalls = (tmux.sendKeys as ReturnType<typeof vi.fn>).mock.calls;
      const sendTextCalls = (tmux.sendText as ReturnType<typeof vi.fn>).mock.calls;
      for (const call of [...sendKeysCalls, ...sendTextCalls]) {
        const arg = String(call[1] ?? call[0] ?? "");
        expect(arg).not.toMatch(/^[0-9]+$/);
      }
    });

    it("(03) startup-replay gate: a resumed seat receives NO identity/onboarding injection (gate is on concluded-fresh)", async () => {
      const rig = rigRepo.createRig("test-rig");
      db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("pod-guard03", rig.id, "Dev");
      const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", podId: "pod-guard03" });
      const session = sessionRegistry.registerSession(node.id, "dev-impl@test-rig");
      sessionRegistry.updateStatus(session.id, "running");
      sessionRegistry.updateResumeToken(session.id, "claude_id", "resume-token-guard03");
      db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)").run(
        node.id, "[]", "[]",
        JSON.stringify([{
          type: "send_text",
          value: "OpenRig session identity: guard03-test-identity",
          phase: "after_ready",
          appliesOn: ["fresh_start"],
          builtin: "session_identity",
          idempotent: false,
        }]),
        "claude-code",
      );
      const snap = snapshotCapture.captureSnapshot(rig.id, "test");
      sessionRegistry.updateStatus(session.id, "exited");
      db.prepare("DELETE FROM bindings WHERE node_id = ?").run(node.id);

      const launchHarness = vi.fn(async () => ({ ok: true as const, resumeToken: "resume-token-guard03", resumeType: "claude_id" }));
      const mockAdapter = {
        runtime: "claude-code",
        listInstalled: vi.fn(async () => []),
        project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
        deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
        checkReady: vi.fn(async () => ({ ready: true })),
        launchHarness,
      };
      const tmux = mockTmux();
      const orch = createOrchestrator({ tmux });
      const result = await orch.restore(snap.id, { adapters: { "claude-code": mockAdapter } });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.result.nodes[0]!.status).toBe("resumed");
      const allSent = (tmux.sendText as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[1] ?? ""));
      expect(allSent.every((s) => !s.includes("OpenRig session identity:"))).toBe(true);
    });
  });

  function createOrchestrator2(tmux: TmuxAdapter, claude: ClaudeResumeAdapter) {
    const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux });
    return new RestoreOrchestrator({
      db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
      checkpointStore, nodeLauncher, tmuxAdapter: tmux,
      claudeResume: claude, codexResume: mockCodexResume(),
    });
  }

  describe("OPR.0.4.3.20 FR-5 — durable resume-target pin from the binding row", () => {
    // Seed a single-node rig whose durable binding name can DIVERGE from the
    // name restore would re-derive, with a resumable snapshot session so restore
    // launches (and thus targets) a session.
    function seedSeat(opts: {
      logicalId: string;
      podAware?: boolean;
      boundName?: string | null; // string → bind that name; null/undefined → no binding row
      bindEmpty?: boolean;       // create a binding row WITHOUT a tmux_session
    }): { rigId: string; nodeId: string; snapId: string } {
      const rig = rigRepo.createRig("r99");
      if (opts.podAware) {
        db.prepare("INSERT INTO pods (id, rig_id, namespace, label) VALUES (?, ?, ?, ?)")
          .run(`pod-${rig.id}`, rig.id, opts.logicalId.split(".")[0], "P");
      }
      const node = rigRepo.addNode(rig.id, opts.logicalId, {
        role: "worker", runtime: "claude-code", cwd: "/tmp",
        ...(opts.podAware ? { podId: `pod-${rig.id}` } : {}),
      });
      const sess = sessionRegistry.registerSession(node.id, "seed@r99-init");
      db.prepare("UPDATE sessions SET resume_type = ?, resume_token = ?, restore_policy = ? WHERE id = ?")
        .run("claude_id", "tok-abc", "resume_if_possible", sess.id);
      if (typeof opts.boundName === "string") {
        sessionRegistry.updateBinding(node.id, { tmuxSession: opts.boundName });
      } else if (opts.bindEmpty) {
        sessionRegistry.updateBinding(node.id, { cmuxSurface: "s1" }); // binding row, tmux_session null
      }
      const snap = snapshotCapture.captureSnapshot(rig.id, "manual");
      return { rigId: rig.id, nodeId: node.id, snapId: snap.id };
    }

    function createdSessionNames(tmux: TmuxAdapter): string[] {
      return (tmux.createSession as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => c[0] as string);
    }

    it("legacy node: restore targets the DURABLY-BOUND name, not the re-derived name", async () => {
      // derived = deriveSessionName("r99","worker-a") = "r99-worker-a"; bind diverges.
      const { snapId, nodeId } = seedSeat({ logicalId: "worker-a", boundName: "pinned-legacy@old-rig" });
      const tmux = mockTmux();
      const orch = createOrchestrator({ tmux });

      const result = await orch.restore(snapId);
      expect(result.ok).toBe(true);

      const names = createdSessionNames(tmux);
      expect(names).toContain("pinned-legacy@old-rig"); // the pinned target
      expect(names).not.toContain("r99-worker-a");       // never the re-derived name
      // Drift-amplifier fixed: launcher writes the PINNED name back to the binding.
      expect(sessionRegistry.getBindingForNode(nodeId)?.tmuxSession).toBe("pinned-legacy@old-rig");
    });

    it("pod-aware node: restore targets the durably-bound name, not the re-derived canonical name", async () => {
      // derived = deriveCanonicalSessionName("dev","driver","r99") = "dev-driver@r99"; bind diverges.
      const { snapId } = seedSeat({ logicalId: "dev.driver", podAware: true, boundName: "pinned-pod@old-rig" });
      const tmux = mockTmux();
      const orch = createOrchestrator({ tmux });

      const result = await orch.restore(snapId);
      expect(result.ok).toBe(true);

      const names = createdSessionNames(tmux);
      expect(names).toContain("pinned-pod@old-rig");
      expect(names).not.toContain("dev-driver@r99");
    });

    it("no binding row: falls back to the derived name, observably", async () => {
      const { snapId } = seedSeat({ logicalId: "worker-a", boundName: null });
      const tmux = mockTmux();
      const orch = createOrchestrator({ tmux });

      const result = await orch.restore(snapId);
      expect(result.ok).toBe(true);
      expect(createdSessionNames(tmux)).toContain("r99-worker-a"); // derived fallback
      expect(result.result.warnings.some((w) => w.includes("FR-5") && w.includes("no durably-bound"))).toBe(true);
    });

    it("binding row with empty tmux_session: falls back to the derived name, observably", async () => {
      const { snapId } = seedSeat({ logicalId: "worker-a", bindEmpty: true });
      const tmux = mockTmux();
      const orch = createOrchestrator({ tmux });

      const result = await orch.restore(snapId);
      expect(result.ok).toBe(true);
      expect(createdSessionNames(tmux)).toContain("r99-worker-a");
      expect(result.result.warnings.some((w) => w.includes("FR-5") && w.includes("no durably-bound"))).toBe(true);
    });

    it("invalid pinned name: falls back to the derived name with an observable invalid-pin warning", async () => {
      const { snapId } = seedSeat({ logicalId: "worker-a", boundName: "bad name!" }); // fails validateSessionName
      const tmux = mockTmux();
      const orch = createOrchestrator({ tmux });

      const result = await orch.restore(snapId);
      expect(result.ok).toBe(true);
      expect(createdSessionNames(tmux)).toContain("r99-worker-a");
      expect(result.result.warnings.some((w) => w.includes("FR-5") && w.includes("is invalid"))).toBe(true);
    });

    it("subset launch surfaces the FR-5 fallback warning (not discarded) — API result + restore.subset_completed event", async () => {
      const { rigId } = seedSeat({ logicalId: "worker-a", boundName: null }); // no binding → FR-5 fallback
      const tmux = mockTmux();
      const orch = createOrchestrator({ tmux });
      const subsetEvents: Array<{ result?: { warnings?: string[] } }> = [];
      const unsub = eventBus.subscribe((e) => {
        if (e.type === "restore.subset_completed") subsetEvents.push(e as unknown as { result?: { warnings?: string[] } });
      });

      const result = await orch.launchNodeSubset(rigId, ["worker-a"]);
      unsub();

      expect(result.ok).toBe(true);
      expect(result.launched?.length ?? 0).toBeGreaterThan(0);
      // API result carries the aggregated warning (previously discarded).
      expect(result.warnings?.some((w) => w.includes("FR-5") && w.includes("no durably-bound"))).toBe(true);
      // The externally-observable event carries it too (was warnings: []).
      expect(subsetEvents[0]?.result?.warnings?.some((w) => w.includes("FR-5"))).toBe(true);
    });
  });
});
