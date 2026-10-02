import { describe, it, expect, vi } from "vitest";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { PodRigInstantiator } from "../src/domain/rigspec-instantiator.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { resolveNodeConfig, type ResolutionContext } from "../src/domain/profile-resolver.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { mockShellCommand } from "./helpers/shell-command-mock.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import type { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import type { ResolvedAgentSpec } from "../src/domain/agent-resolver.js";
import type { RigSpecPodMember } from "../src/domain/types.js";

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

function mockFs() {
  const store: Record<string, string> = {};
  return {
    readFile: (p: string) => store[p] ?? "",
    writeFile: (p: string, c: string) => { store[p] = c; },
    exists: (p: string) => p in store,
    mkdirp: () => {},
    copyFile: () => {},
    listFiles: () => [],
  };
}

function mockResolvedSpec(preferences?: { runtime?: string; model?: string; effort?: string }): ResolvedAgentSpec {
  return {
    spec: {
      name: "worker-agent",
      version: "1.0.0",
      imports: [],
      startup: { files: [], actions: [] },
      profiles: {
        reasoner: {
          preferences,
          uses: { skills: [], guidance: [], subagents: [], plugins: [], runtimeResources: [] },
        },
      },
      resources: { skills: [], guidance: [], subagents: [], plugins: [], runtimeResources: [] },
    },
    sourcePath: "/agents/worker",
    hash: "sha256:test1234",
  };
}

describe("Effort Lifecycle E2E: profile -> launch -> snapshot -> restore (#75)", () => {
  it("Claude: resolves effort from profile, persists on node, launches with --effort, snapshots, and restores with effort", async () => {
    const ctx = setup();
    const rig = ctx.rigRepo.createRig("e2e-rig");
    const pod = ctx.podRepo.createPod(rig.id, "dev", "Dev", {});

    const member: RigSpecPodMember = {
      id: "analyst",
      agentRef: "local:agents/analyst",
      profile: "reasoner",
      runtime: "claude-code",
      cwd: "/workspace",
    };

    // 1. Profile resolution: effort resolves from profile preferences
    const resCtx: ResolutionContext = {
      baseSpec: mockResolvedSpec({ runtime: "claude-code", model: "claude-3-7-sonnet-20250219", effort: "high" }),
      importedSpecs: [],
      collisions: [],
      profileName: "reasoner",
      member,
      pod: { id: "dev", label: "Dev", members: [member], edges: [] },
      rig: { version: "0.2", name: "e2e-rig", pods: [], edges: [] },
    };
    const configResult = resolveNodeConfig(resCtx);
    expect(configResult.ok).toBe(true);
    if (!configResult.ok) throw new Error("Config resolution failed");
    expect(configResult.config.effort).toBe("high");

    // 2. Add node persisting effective effort into SQLite
    const node = ctx.rigRepo.addNode(rig.id, "analyst", {
      runtime: "claude-code",
      agentRef: member.agentRef,
      profile: member.profile,
      model: configResult.config.model,
      effort: configResult.config.effort,
      cwd: configResult.config.cwd,
    });

    // Verify database column effort was populated
    const dbNode = ctx.rigRepo.getRig(rig.id)!.nodes.find((n) => n.id === node.id);
    expect(dbNode).toBeDefined();
    expect(dbNode!.effort).toBe("high");

    // 3. Launch verification: Claude runtime adapter includes --effort high
    const tmux = mockShellCommand({
      sendText: vi.fn(async () => ({ ok: true as const })),
      sendKeys: vi.fn(async () => ({ ok: true as const })),
      createSession: vi.fn(async () => ({ ok: true as const })),
      killSession: vi.fn(async () => ({ ok: true as const })),
      listSessions: vi.fn(async () => []),
      hasSession: vi.fn(async () => true),
      listWindows: vi.fn(async () => []),
      listPanes: vi.fn(async () => []),
      getPaneCommand: vi.fn(async () => "claude"),
    } as unknown as TmuxAdapter);

    const claudeAdapter = new ClaudeCodeAdapter({
      tmux,
      fsOps: mockFs(),
      sleep: async () => {},
      sessionIdFactory: () => "sess-123",
    });

    const launchResult = await claudeAdapter.launchHarness({
      id: "bind-1",
      rigId: rig.id,
      nodeId: node.id,
      logicalId: "analyst",
      runtime: "claude-code",
      sessionName: "dev-analyst@e2e-rig",
      tmuxSession: "e2e-session",
      tmuxPane: "%0",
      cmuxSurface: null,
      updatedAt: "",
      cwd: "/workspace",
      model: dbNode!.model ?? undefined,
      effort: dbNode!.effort ?? undefined,
    }, { name: "analyst" });
    expect(launchResult.ok).toBe(true);
    const lastClaudeCmd = (tmux.sendText as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(lastClaudeCmd).toContain("--effort 'high'");
    expect(lastClaudeCmd).toContain("--model 'claude-3-7-sonnet-20250219'");

    // Register running session and snapshot
    const session = ctx.sessionRegistry.registerSession(node.id, "dev-analyst@e2e-rig");
    ctx.sessionRegistry.updateStatus(session.id, "running");
    ctx.sessionRegistry.updateStartupStatus(session.id, "ready", new Date().toISOString());
    ctx.db.prepare("UPDATE sessions SET resume_type = 'claude_name', resume_token = 'tok-123' WHERE id = ?").run(session.id);

    // 4. Snapshot capture captures node.effort
    const snapshot = ctx.snapshotCapture.captureSnapshot(rig.id, "manual");
    expect(snapshot.data.nodes).toHaveLength(1);
    expect(snapshot.data.nodes[0]!.effort).toBe("high");

    // 5. Restore: verify effort is passed through to ClaudeResumeAdapter
    const mockClaudeResume = {
      canResume: vi.fn(() => true),
      resume: vi.fn(async (...args: unknown[]) => ({ ok: true, code: "resumed" })),
    } as unknown as ClaudeResumeAdapter;

    const mockCodexResume = {
      canResume: vi.fn(() => false),
      resume: vi.fn(),
    } as unknown as CodexResumeAdapter;

    const mockTmux = {
      createSession: vi.fn(async () => ({ ok: true })),
      killSession: vi.fn(async () => ({ ok: true })),
      listSessions: vi.fn(async () => []),
      hasSession: vi.fn(async () => false),
      sendText: vi.fn(async () => ({ ok: true })),
      sendKeys: vi.fn(async () => ({ ok: true })),
      listWindows: vi.fn(async () => []),
      listPanes: vi.fn(async () => []),
      getPaneCommand: vi.fn(async () => "claude"),
    } as any;

    const nodeLauncher = new NodeLauncher({ db: ctx.db, rigRepo: ctx.rigRepo, sessionRegistry: ctx.sessionRegistry, eventBus: ctx.eventBus, tmuxAdapter: mockTmux });
    const restoreOrch = new RestoreOrchestrator({
      db: ctx.db,
      rigRepo: ctx.rigRepo,
      sessionRegistry: ctx.sessionRegistry,
      eventBus: ctx.eventBus,
      snapshotRepo: ctx.snapshotRepo,
      snapshotCapture: ctx.snapshotCapture,
      checkpointStore: ctx.checkpointStore,
      nodeLauncher,
      tmuxAdapter: mockTmux,
      claudeResume: mockClaudeResume,
      codexResume: mockCodexResume,
    });

    const restoreResult = await restoreOrch.restore(snapshot.id);
    expect(restoreResult.ok).toBe(true);

    // Verify claudeResume.resume was called with effort === "high"
    expect(mockClaudeResume.resume).toHaveBeenCalled();
    const resumeCalls = (mockClaudeResume.resume as any).mock.calls;
    expect(resumeCalls).toHaveLength(1);
    // (sessionName, resumeType, resumeToken, cwd, resolvedPosture, model, permissionMode, nodeId, effort)
    const passedEffort = resumeCalls[0]![8];
    expect(passedEffort).toBe("high");

    ctx.db.close();
  });

  it("Codex: resolves effort from profile, persists on node, launches with -c model_reasoning_effort, snapshots, and restores with effort", async () => {
    const ctx = setup();
    const rig = ctx.rigRepo.createRig("e2e-codex-rig");
    const pod = ctx.podRepo.createPod(rig.id, "dev", "Dev", {});

    const member: RigSpecPodMember = {
      id: "coder",
      agentRef: "local:agents/coder",
      profile: "reasoner",
      runtime: "codex",
      cwd: "/workspace",
    };

    const resCtx: ResolutionContext = {
      baseSpec: mockResolvedSpec({ runtime: "codex", model: "o3-mini", effort: "medium" }),
      importedSpecs: [],
      collisions: [],
      profileName: "reasoner",
      member,
      pod: { id: "dev", label: "Dev", members: [member], edges: [] },
      rig: { version: "0.2", name: "e2e-codex-rig", pods: [], edges: [] },
    };
    const configResult = resolveNodeConfig(resCtx);
    expect(configResult.ok).toBe(true);
    if (!configResult.ok) throw new Error("Config resolution failed");
    expect(configResult.config.effort).toBe("medium");

    const node = ctx.rigRepo.addNode(rig.id, "coder", {
      runtime: "codex",
      agentRef: member.agentRef,
      profile: member.profile,
      model: configResult.config.model,
      effort: configResult.config.effort,
      cwd: configResult.config.cwd,
    });

    const dbNode = ctx.rigRepo.getRig(rig.id)!.nodes.find((n) => n.id === node.id);
    expect(dbNode!.effort).toBe("medium");

    // Launch verification: Codex runtime adapter includes -c model_reasoning_effort="medium"
    const codexTmux = mockShellCommand({
      sendText: vi.fn(async () => ({ ok: true as const })),
      sendKeys: vi.fn(async () => ({ ok: true as const })),
      createSession: vi.fn(async () => ({ ok: true as const })),
      killSession: vi.fn(async () => ({ ok: true as const })),
      listSessions: vi.fn(async () => []),
      hasSession: vi.fn(async () => true),
      listWindows: vi.fn(async () => []),
      listPanes: vi.fn(async () => []),
      getPaneCommand: vi.fn(async () => "codex"),
      capturePaneContent: vi.fn(async () => "OpenAI Codex (v0.0.0)\n› Ask Codex to do anything"),
    } as unknown as TmuxAdapter);

    const codexAdapter = new CodexRuntimeAdapter({
      tmux: codexTmux,
      fsOps: mockFs(),
      listProcesses: () => [],
      sleep: async () => {},
    });

    const launchResult = await codexAdapter.launchHarness({
      id: "bind-2",
      rigId: rig.id,
      nodeId: node.id,
      logicalId: "coder",
      runtime: "codex",
      sessionName: "dev-coder@e2e-codex-rig",
      tmuxSession: "e2e-session",
      tmuxPane: "%0",
      cmuxSurface: null,
      updatedAt: "",
      cwd: "/workspace",
      model: dbNode!.model ?? undefined,
      effort: dbNode!.effort ?? undefined,
    }, { name: "coder" });
    expect(launchResult.ok).toBe(true);
    const lastCodexCmd = (codexTmux.sendText as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(lastCodexCmd).toContain('model_reasoning_effort="medium"');
    expect(lastCodexCmd).toContain("-m 'o3-mini'");

    // Register running session and snapshot
    const session = ctx.sessionRegistry.registerSession(node.id, "dev-coder@e2e-codex-rig");
    ctx.sessionRegistry.updateStatus(session.id, "running");
    ctx.sessionRegistry.updateStartupStatus(session.id, "ready", new Date().toISOString());
    ctx.db.prepare("UPDATE sessions SET resume_type = 'codex_id', resume_token = 'sess-codex-1' WHERE id = ?").run(session.id);

    const snapshot = ctx.snapshotCapture.captureSnapshot(rig.id, "manual");
    expect(snapshot.data.nodes[0]!.effort).toBe("medium");

    // Restore verification: verify effort is passed through to CodexResumeAdapter
    const mockClaudeResume = { canResume: vi.fn(() => false), resume: vi.fn() } as unknown as ClaudeResumeAdapter;
    const mockCodexResume = {
      canResume: vi.fn(() => true),
      resume: vi.fn(async (...args: unknown[]) => ({ ok: true, code: "resumed" })),
    } as unknown as CodexResumeAdapter;

    const mockTmux = {
      createSession: vi.fn(async () => ({ ok: true })),
      killSession: vi.fn(async () => ({ ok: true })),
      listSessions: vi.fn(async () => []),
      hasSession: vi.fn(async () => false),
      sendText: vi.fn(async () => ({ ok: true })),
      sendKeys: vi.fn(async () => ({ ok: true })),
      listWindows: vi.fn(async () => []),
      listPanes: vi.fn(async () => []),
      getPaneCommand: vi.fn(async () => "codex"),
    } as any;

    const nodeLauncher = new NodeLauncher({ db: ctx.db, rigRepo: ctx.rigRepo, sessionRegistry: ctx.sessionRegistry, eventBus: ctx.eventBus, tmuxAdapter: mockTmux });
    const restoreOrch = new RestoreOrchestrator({
      db: ctx.db,
      rigRepo: ctx.rigRepo,
      sessionRegistry: ctx.sessionRegistry,
      eventBus: ctx.eventBus,
      snapshotRepo: ctx.snapshotRepo,
      snapshotCapture: ctx.snapshotCapture,
      checkpointStore: ctx.checkpointStore,
      nodeLauncher,
      tmuxAdapter: mockTmux,
      claudeResume: mockClaudeResume,
      codexResume: mockCodexResume,
    });

    const restoreResult = await restoreOrch.restore(snapshot.id);
    expect(restoreResult.ok).toBe(true);

    expect(mockCodexResume.resume).toHaveBeenCalled();
    const resumeCalls = (mockCodexResume.resume as any).mock.calls;
    expect(resumeCalls).toHaveLength(1);
    // (sessionName, resumeType, resumeToken, cwd, codexConfigProfile, resolvedPosture, model, effort)
    const passedEffort = resumeCalls[0]![7];
    expect(passedEffort).toBe("medium");

    ctx.db.close();
  });
});

describe("Effort clear: removing effort from resolved config clears stored node value (#75-clear)", () => {
  it("setNodeEffort then clearNodeEffort produces NULL in the DB", () => {
    const ctx = (() => {
      const db = createFullTestDb();
      const rigRepo = new RigRepository(db);
      return { db, rigRepo };
    })();

    // Set up rig + node with effort = "high"
    const rig = ctx.rigRepo.createRig("clear-test-rig");
    const node = ctx.rigRepo.addNode(rig.id, "worker", {
      runtime: "claude-code",
      agentRef: "agents/worker.yaml",
      profile: "default",
      cwd: "/tmp",
      effort: "high",
    });

    const before = ctx.rigRepo.getRig(rig.id)!.nodes.find((n) => n.id === node.id);
    expect(before!.effort).toBe("high");

    // Now simulate updateNodeResolvedConfig with effort absent — should call clearNodeEffort
    ctx.rigRepo.clearNodeEffort(node.id);

    const after = ctx.rigRepo.getRig(rig.id)!.nodes.find((n) => n.id === node.id);
    expect(after!.effort).toBeNull();

    ctx.db.close();
  });

  it("high → removed → relaunch: clearing effort updates DB and subsequent launch/restore omits effort flag", async () => {
    const ctx = setup();
    const rig = ctx.rigRepo.createRig("relaunch-rig");
    ctx.podRepo.createPod(rig.id, "dev", "Dev", {});

    const member: RigSpecPodMember = {
      id: "analyst",
      agentRef: "local:agents/analyst",
      profile: "reasoner",
      runtime: "claude-code",
      cwd: "/workspace",
    };

    // 1. Initial launch with effort = "high"
    const node = ctx.rigRepo.addNode(rig.id, "analyst", {
      runtime: "claude-code",
      agentRef: member.agentRef,
      profile: member.profile,
      model: "claude-3-7-sonnet-20250219",
      effort: "high",
      cwd: "/workspace",
    });

    const tmux = mockShellCommand({
      sendText: vi.fn(async () => ({ ok: true as const })),
      sendKeys: vi.fn(async () => ({ ok: true as const })),
      createSession: vi.fn(async () => ({ ok: true as const })),
      killSession: vi.fn(async () => ({ ok: true as const })),
      listSessions: vi.fn(async () => []),
      hasSession: vi.fn(async () => true),
      listWindows: vi.fn(async () => []),
      listPanes: vi.fn(async () => []),
      getPaneCommand: vi.fn(async () => "claude"),
    } as unknown as TmuxAdapter);

    const claudeAdapter = new ClaudeCodeAdapter({
      tmux,
      fsOps: mockFs(),
      sleep: async () => {},
      sessionIdFactory: () => "sess-1",
    });

    // Launch with initial high effort
    await claudeAdapter.launchHarness({
      id: "bind-1",
      rigId: rig.id,
      nodeId: node.id,
      logicalId: "analyst",
      runtime: "claude-code",
      sessionName: "dev-analyst@relaunch-rig",
      tmuxSession: "relaunch-session",
      tmuxPane: "%0",
      cmuxSurface: null,
      updatedAt: "",
      cwd: "/workspace",
      model: "claude-3-7-sonnet-20250219",
      effort: "high",
    }, { name: "analyst" });

    expect((tmux.sendText as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toContain("--effort 'high'");

    // 2. Config refresh: effort is removed from the resolved config
    const nodeLauncher = new NodeLauncher({ db: ctx.db, rigRepo: ctx.rigRepo, sessionRegistry: ctx.sessionRegistry, eventBus: ctx.eventBus, tmuxAdapter: tmux });
    const instantiator = new PodRigInstantiator({
      db: ctx.db,
      rigRepo: ctx.rigRepo,
      podRepo: ctx.podRepo,
      sessionRegistry: ctx.sessionRegistry,
      eventBus: ctx.eventBus,
      nodeLauncher,
      startupOrchestrator: {} as any,
      fsOps: mockFs(),
      adapters: { "claude-code": claudeAdapter },
      tmuxAdapter: tmux,
    });

    // Invoke updateNodeResolvedConfig with effort absent (cleared)
    (instantiator as any).updateNodeResolvedConfig(node.id, {
      restorePolicy: "checkpoint_only",
      resolvedSpecName: "worker-agent",
      resolvedSpecVersion: "1.0.0",
      resolvedSpecHash: "sha256:newhash",
      effort: undefined,
    });

    // Verify stored effort is now null in DB
    const refreshedNode = ctx.rigRepo.getRig(rig.id)!.nodes.find((n) => n.id === node.id)!;
    expect(refreshedNode.effort).toBeNull();

    // 3. Relaunch: launch harness again using refreshed node state
    vi.mocked(tmux.sendText).mockClear();
    await claudeAdapter.launchHarness({
      id: "bind-2",
      rigId: rig.id,
      nodeId: node.id,
      logicalId: "analyst",
      runtime: "claude-code",
      sessionName: "dev-analyst@relaunch-rig",
      tmuxSession: "relaunch-session",
      tmuxPane: "%0",
      cmuxSurface: null,
      updatedAt: "",
      cwd: "/workspace",
      model: refreshedNode.model ?? undefined,
      effort: refreshedNode.effort ?? undefined,
    }, { name: "analyst" });

    const relaunchCmd = (tmux.sendText as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string;
    expect(relaunchCmd).not.toContain("--effort");

    // 4. Fresh restore: snapshot and restore should also omit effort
    const session = ctx.sessionRegistry.registerSession(node.id, "dev-analyst@relaunch-rig");
    ctx.sessionRegistry.updateStatus(session.id, "running");
    ctx.sessionRegistry.updateStartupStatus(session.id, "ready", new Date().toISOString());
    ctx.db.prepare("UPDATE sessions SET resume_type = 'claude_name', resume_token = 'tok-456' WHERE id = ?").run(session.id);

    const snapshot = ctx.snapshotCapture.captureSnapshot(rig.id, "manual");
    expect(snapshot.data.nodes[0]!.effort).toBeNull();

    const mockClaudeResume = {
      canResume: vi.fn(() => true),
      resume: vi.fn(async (...args: unknown[]) => ({ ok: true, code: "resumed" })),
    } as unknown as ClaudeResumeAdapter;

    const mockTmux = {
      createSession: vi.fn(async () => ({ ok: true })),
      killSession: vi.fn(async () => ({ ok: true })),
      listSessions: vi.fn(async () => []),
      hasSession: vi.fn(async () => false),
      sendText: vi.fn(async () => ({ ok: true })),
      sendKeys: vi.fn(async () => ({ ok: true })),
      listWindows: vi.fn(async () => []),
      listPanes: vi.fn(async () => []),
      getPaneCommand: vi.fn(async () => "claude"),
    } as any;

    const restoreNodeLauncher = new NodeLauncher({ db: ctx.db, rigRepo: ctx.rigRepo, sessionRegistry: ctx.sessionRegistry, eventBus: ctx.eventBus, tmuxAdapter: mockTmux });
    const restoreOrch = new RestoreOrchestrator({
      db: ctx.db,
      rigRepo: ctx.rigRepo,
      sessionRegistry: ctx.sessionRegistry,
      eventBus: ctx.eventBus,
      snapshotRepo: ctx.snapshotRepo,
      snapshotCapture: ctx.snapshotCapture,
      checkpointStore: ctx.checkpointStore,
      nodeLauncher: restoreNodeLauncher,
      tmuxAdapter: mockTmux,
      claudeResume: mockClaudeResume,
      codexResume: { canResume: vi.fn(() => false), resume: vi.fn() } as unknown as CodexResumeAdapter,
    });

    const restoreResult = await restoreOrch.restore(snapshot.id);
    expect(restoreResult.ok).toBe(true);

    const resumeCalls = (mockClaudeResume.resume as any).mock.calls;
    expect(resumeCalls).toHaveLength(1);
    const passedEffort = resumeCalls[0]![8];
    expect(passedEffort ?? undefined).toBeUndefined();

    ctx.db.close();
  });
});

