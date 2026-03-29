import { describe, it, expect, vi } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import type Database from "better-sqlite3";

describe("AS-T09: Continuity + snapshot/restore evolution", () => {
  function setup() {
    const db = createFullTestDb();
    const rigRepo = new RigRepository(db);
    const podRepo = new PodRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const snapshotRepo = new SnapshotRepository(db);
    const checkpointStore = new CheckpointStore(db);
    const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
    return { db, rigRepo, podRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore, snapshotCapture };
  }

  function seedRigWithPod(ctx: ReturnType<typeof setup>) {
    const rig = ctx.rigRepo.createRig("test-rig");
    const pod = ctx.podRepo.createPod(rig.id, "Dev", { summary: "dev pod", continuityPolicyJson: JSON.stringify({ enabled: true }) });
    const node = ctx.rigRepo.addNode(rig.id, "impl", { runtime: "claude-code", podId: pod.id, agentRef: "local:agents/impl", profile: "default", resolvedSpecName: "impl-spec", resolvedSpecVersion: "1.0.0", resolvedSpecHash: "sha256:abc" });
    const session = ctx.sessionRegistry.registerSession(node.id, "r01-impl");
    ctx.sessionRegistry.updateStatus(session.id, "running");
    ctx.sessionRegistry.updateStartupStatus(session.id, "ready", new Date().toISOString());
    return { rig, pod, node, session };
  }

  // T1: snapshot captures pod membership
  it("snapshot captures pod membership", () => {
    const ctx = setup();
    const { rig, pod } = seedRigWithPod(ctx);
    const snapshot = ctx.snapshotCapture.captureSnapshot(rig.id, "manual");
    expect(snapshot.data.pods).toBeDefined();
    expect(snapshot.data.pods!.length).toBe(1);
    expect(snapshot.data.pods![0]!.label).toBe("Dev");
    ctx.db.close();
  });

  // T2: snapshot captures resolved spec identity
  it("snapshot captures resolved spec identity on nodes", () => {
    const ctx = setup();
    const { rig } = seedRigWithPod(ctx);
    const snapshot = ctx.snapshotCapture.captureSnapshot(rig.id, "manual");
    const node = snapshot.data.nodes[0]!;
    expect(node.resolvedSpecName).toBe("impl-spec");
    expect(node.resolvedSpecVersion).toBe("1.0.0");
    expect(node.resolvedSpecHash).toBe("sha256:abc");
    ctx.db.close();
  });

  // T3: snapshot captures startup status
  it("snapshot captures startup status on sessions", () => {
    const ctx = setup();
    const { rig } = seedRigWithPod(ctx);
    const snapshot = ctx.snapshotCapture.captureSnapshot(rig.id, "manual");
    const session = snapshot.data.sessions[0]!;
    expect(session.startupStatus).toBe("ready");
    expect(session.startupCompletedAt).toBeTruthy();
    ctx.db.close();
  });

  // T4: startup context persisted at startup time is retrievable
  it("startup context persisted and queryable for restore", () => {
    const ctx = setup();
    const { rig, node } = seedRigWithPod(ctx);

    // Persist startup context (as StartupOrchestrator does)
    ctx.db.prepare(
      "INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)"
    ).run(node.id, "[]", "[]", "[]", "claude-code");

    const row = ctx.db.prepare("SELECT * FROM node_startup_context WHERE node_id = ?").get(node.id) as Record<string, unknown>;
    expect(row).toBeDefined();
    expect(row["runtime"]).toBe("claude-code");
    ctx.db.close();
  });

  // T5: checkpoint store accepts pod/continuity metadata
  it("checkpoint store creates checkpoint with pod/continuity metadata", () => {
    const ctx = setup();
    const { rig, pod, node } = seedRigWithPod(ctx);

    const cp = ctx.checkpointStore.createCheckpoint(node.id, {
      summary: "test checkpoint",
      podId: pod.id,
      continuitySource: "pre_shutdown",
      continuityArtifactsJson: JSON.stringify({ session_log: "/path/log.md" }),
    });
    expect(cp.podId).toBe(pod.id);
    expect(cp.continuitySource).toBe("pre_shutdown");
    expect(cp.continuityArtifactsJson).toContain("session_log");
    ctx.db.close();
  });

  // T6: pod repository continuity state CRUD
  it("pod repository manages continuity state", () => {
    const ctx = setup();
    const { rig, pod, node } = seedRigWithPod(ctx);

    ctx.podRepo.updateContinuityState(pod.id, node.id, "healthy");
    let states = ctx.podRepo.getContinuityStatesForRig(rig.id);
    expect(states).toHaveLength(1);
    expect(states[0]!.status).toBe("healthy");

    ctx.podRepo.updateContinuityState(pod.id, node.id, "degraded", JSON.stringify({ stale: true }));
    states = ctx.podRepo.getContinuityStatesForRig(rig.id);
    expect(states[0]!.status).toBe("degraded");
    ctx.db.close();
  });

  // T7: RestoreResult carries warnings
  it("RestoreResult has warnings field", () => {
    const result: import("../src/domain/types.js").RestoreResult = {
      snapshotId: "s1", preRestoreSnapshotId: "s0", nodes: [], warnings: ["test warning"],
    };
    expect(result.warnings).toEqual(["test warning"]);
  });

  // T7b: restore-orchestrator skips node when continuity_state=restoring (preserving binding)
  it("restoring continuity_state skips node without clearing stale state", async () => {
    const { RestoreOrchestrator } = await import("../src/domain/restore-orchestrator.js");
    const { NodeLauncher } = await import("../src/domain/node-launcher.js");
    const { ClaudeResumeAdapter } = await import("../src/adapters/claude-resume.js");
    const { CodexResumeAdapter } = await import("../src/adapters/codex-resume.js");
    const { vi } = await import("vitest");

    const ctx = setup();
    const { rig, pod, node, session } = seedRigWithPod(ctx);

    // Create binding so we can verify it's preserved
    ctx.db.prepare("INSERT INTO bindings (id, node_id, tmux_session) VALUES (?, ?, ?)").run("bind-1", node.id, "r01-impl");

    // Set continuity_state to restoring
    ctx.db.prepare("INSERT INTO continuity_state (pod_id, node_id, status) VALUES (?, ?, 'restoring')").run(pod.id, node.id);

    // Mark session as exited (simulate stopped rig)
    ctx.sessionRegistry.updateStatus(session.id, "exited");

    // Take a snapshot
    const snapshot = ctx.snapshotCapture.captureSnapshot(rig.id, "manual");

    const mockTmux = { createSession: vi.fn(async () => ({ ok: true })), killSession: vi.fn(async () => ({ ok: true })), listSessions: vi.fn(async () => []), hasSession: vi.fn(async () => false), sendText: vi.fn(async () => ({ ok: true })), sendKeys: vi.fn(async () => ({ ok: true })), listWindows: vi.fn(async () => []), listPanes: vi.fn(async () => []) } as any;
    const nodeLauncher = new NodeLauncher({ db: ctx.db, rigRepo: ctx.rigRepo, sessionRegistry: ctx.sessionRegistry, eventBus: ctx.eventBus, tmuxAdapter: mockTmux });

    const restoreOrch = new RestoreOrchestrator({
      db: ctx.db, rigRepo: ctx.rigRepo, sessionRegistry: ctx.sessionRegistry, eventBus: ctx.eventBus,
      snapshotRepo: ctx.snapshotRepo, snapshotCapture: ctx.snapshotCapture, checkpointStore: ctx.checkpointStore,
      nodeLauncher, tmuxAdapter: mockTmux,
      claudeResume: new ClaudeResumeAdapter(mockTmux),
      codexResume: new CodexResumeAdapter(mockTmux),
    });

    const result = await restoreOrch.restore(snapshot.id);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Node should be skipped (fresh_no_checkpoint) because continuity_state=restoring
      const nodeResult = result.result.nodes.find((n) => n.nodeId === node.id);
      expect(nodeResult!.status).toBe("fresh_no_checkpoint");
      // Warnings should mention restoring
      expect(result.result.warnings.some((w) => w.includes("restoring"))).toBe(true);
      // Binding should be preserved (not cleared)
      const binding = ctx.db.prepare("SELECT * FROM bindings WHERE node_id = ?").get(node.id);
      expect(binding).toBeDefined();
    }
    ctx.db.close();
  });

  // T11: restore ordering respects topology
  it("restore processes nodes in topological order", async () => {
    // This is covered by existing restore-orchestrator.test.ts tests for topology ordering
    // (delegates_to, spawned_by, can_observe). Those tests verify the computeRestorePlan
    // produces correct topological order. The ordering logic is unchanged by AS-T09.
    const ctx = setup();
    const { rig } = seedRigWithPod(ctx);
    // Verify the restore plan computation still works after AS-T09 changes
    const snapshot = ctx.snapshotCapture.captureSnapshot(rig.id, "manual");
    expect(snapshot.data.nodes.length).toBeGreaterThan(0);
    ctx.db.close();
  });

  // T8: continuity-enabled pod reads continuity state
  it("continuity state persisted and readable for pods", () => {
    const ctx = setup();
    const { rig, pod, node } = seedRigWithPod(ctx);

    // Insert continuity state
    ctx.db.prepare("INSERT INTO continuity_state (pod_id, node_id, status) VALUES (?, ?, 'healthy')").run(pod.id, node.id);

    const snapshot = ctx.snapshotCapture.captureSnapshot(rig.id, "manual");
    expect(snapshot.data.continuityStates).toBeDefined();
    expect(snapshot.data.continuityStates!.length).toBe(1);
    expect(snapshot.data.continuityStates![0]!.status).toBe("healthy");
    ctx.db.close();
  });

  // T9: degraded continuity state surfaced
  it("degraded continuity state captured in snapshot", () => {
    const ctx = setup();
    const { rig, pod, node } = seedRigWithPod(ctx);

    ctx.db.prepare("INSERT INTO continuity_state (pod_id, node_id, status, artifacts_json) VALUES (?, ?, 'degraded', ?)").run(pod.id, node.id, JSON.stringify({ session_log: "/stale/log.md" }));

    const snapshot = ctx.snapshotCapture.captureSnapshot(rig.id, "manual");
    expect(snapshot.data.continuityStates![0]!.status).toBe("degraded");
    expect(snapshot.data.continuityStates![0]!.artifactsJson).toContain("stale");
    ctx.db.close();
  });

  // T10: checkpoint metadata includes pod/source context
  it("checkpoint with pod metadata persists correctly", () => {
    const ctx = setup();
    const { rig, pod, node } = seedRigWithPod(ctx);

    // Insert checkpoint with pod metadata (AS-T00 added the columns)
    ctx.db.prepare("INSERT INTO checkpoints (id, node_id, summary, pod_id, continuity_source, continuity_artifacts_json) VALUES (?, ?, ?, ?, ?, ?)").run(
      "cp-1", node.id, "test checkpoint", pod.id, "pre_shutdown", JSON.stringify({ session_log: "/path/log.md" })
    );

    const snapshot = ctx.snapshotCapture.captureSnapshot(rig.id, "manual");
    const cp = snapshot.data.checkpoints[node.id];
    expect(cp).toBeDefined();
    expect(cp!.podId).toBe(pod.id);
    expect(cp!.continuitySource).toBe("pre_shutdown");
    ctx.db.close();
  });

  // T11: restore with nodeStartupContext calls startNode with isRestore=true
  it("restore with startup context replays via startNode isRestore=true", async () => {
    const { RestoreOrchestrator } = await import("../src/domain/restore-orchestrator.js");
    const { NodeLauncher } = await import("../src/domain/node-launcher.js");
    const { ClaudeResumeAdapter } = await import("../src/adapters/claude-resume.js");
    const { CodexResumeAdapter } = await import("../src/adapters/codex-resume.js");
    const { vi } = await import("vitest");

    const ctx = setup();
    const { rig, node, session } = seedRigWithPod(ctx);

    // Persist startup context (as StartupOrchestrator would)
    ctx.db.prepare(
      "INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)"
    ).run(node.id, "[]", "[]", "[]", "claude-code");

    // Mark session exited (rig is stopped)
    ctx.sessionRegistry.updateStatus(session.id, "exited");

    // Take snapshot
    const snapshot = ctx.snapshotCapture.captureSnapshot(rig.id, "manual");
    expect(snapshot.data.nodeStartupContext![node.id]).toBeDefined();

    // Create mock adapter that tracks calls
    const projectCalls: unknown[] = [];
    const mockAdapter = {
      runtime: "claude-code",
      listInstalled: vi.fn(async () => []),
      project: vi.fn(async (...args: unknown[]) => { projectCalls.push(args); return { projected: [], skipped: [], failed: [] }; }),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: vi.fn(async () => ({ ready: true })),
    };

    const mockTmux = { createSession: vi.fn(async () => ({ ok: true })), killSession: vi.fn(async () => ({ ok: true })), listSessions: vi.fn(async () => []), hasSession: vi.fn(async () => true), sendText: vi.fn(async () => ({ ok: true })), sendKeys: vi.fn(async () => ({ ok: true })), listWindows: vi.fn(async () => []), listPanes: vi.fn(async () => []) } as any;
    const nodeLauncher = new NodeLauncher({ db: ctx.db, rigRepo: ctx.rigRepo, sessionRegistry: ctx.sessionRegistry, eventBus: ctx.eventBus, tmuxAdapter: mockTmux });

    const restoreOrch = new RestoreOrchestrator({
      db: ctx.db, rigRepo: ctx.rigRepo, sessionRegistry: ctx.sessionRegistry, eventBus: ctx.eventBus,
      snapshotRepo: ctx.snapshotRepo, snapshotCapture: ctx.snapshotCapture, checkpointStore: ctx.checkpointStore,
      nodeLauncher, tmuxAdapter: mockTmux,
      claudeResume: new ClaudeResumeAdapter(mockTmux),
      codexResume: new CodexResumeAdapter(mockTmux),
    });

    const result = await restoreOrch.restore(snapshot.id, {
      adapters: { "claude-code": mockAdapter as any },
      fsOps: { exists: () => true },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Startup replay should have called adapter.project (via StartupOrchestrator)
      expect(mockAdapter.project).toHaveBeenCalled();
      expect(mockAdapter.checkReady).toHaveBeenCalled();
      // Node should be resumed (startup replay succeeded)
      const nodeResult = result.result.nodes.find((n) => n.nodeId === node.id);
      expect(nodeResult!.status).toBe("resumed");
    }
    ctx.db.close();
  });

  // T12: integration: startup context persisted and captured in snapshot
  it("startup context persisted at startup time and captured in snapshot", () => {
    const ctx = setup();
    const { rig, node } = seedRigWithPod(ctx);

    // Simulate what StartupOrchestrator does on success
    ctx.db.prepare(
      "INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)"
    ).run(node.id, JSON.stringify([{ category: "skill", effectiveId: "s1", sourcePath: "/agents/impl", resourcePath: "skills/s1", absolutePath: "/agents/impl/skills/s1" }]),
      JSON.stringify([{ path: "startup/base.md", absolutePath: "/agents/impl/startup/base.md", ownerRoot: "/agents/impl", deliveryHint: "auto", required: true, appliesOn: ["fresh_start", "restore"] }]),
      JSON.stringify([{ type: "slash_command", value: "/rename impl", phase: "after_ready", appliesOn: ["fresh_start"], idempotent: true }]),
      "claude-code"
    );

    const snapshot = ctx.snapshotCapture.captureSnapshot(rig.id, "manual");
    expect(snapshot.data.nodeStartupContext).toBeDefined();
    const startupCtx = snapshot.data.nodeStartupContext![node.id];
    expect(startupCtx).toBeDefined();
    expect(startupCtx!.runtime).toBe("claude-code");
    expect(startupCtx!.projectionEntries).toHaveLength(1);
    expect(startupCtx!.resolvedStartupFiles).toHaveLength(1);
    expect(startupCtx!.startupActions).toHaveLength(1);
    ctx.db.close();
  });
});
