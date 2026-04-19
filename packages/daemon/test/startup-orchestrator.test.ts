import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { StartupOrchestrator, type StartupInput } from "../src/domain/startup-orchestrator.js";
import type { RuntimeAdapter, NodeBinding, ResolvedStartupFile, ProjectionResult, StartupDeliveryResult, ReadinessResult } from "../src/domain/runtime-adapter.js";
import { resolveConcreteHint } from "../src/domain/runtime-adapter.js";
import type { ProjectionPlan } from "../src/domain/projection-planner.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { StartupAction } from "../src/domain/types.js";

// -- Mocks --

function mockTmux(overrides?: Partial<TmuxAdapter>): TmuxAdapter {
  return {
    sendText: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    ...overrides,
  } as unknown as TmuxAdapter;
}

function mockAdapter(overrides?: Partial<RuntimeAdapter>): RuntimeAdapter {
  return {
    runtime: "claude-code",
    listInstalled: vi.fn(async () => []),
    project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
    deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
    checkReady: vi.fn(async () => ({ ready: true })),
    launchHarness: vi.fn(async () => ({ ok: true })),
    ...overrides,
  };
}

function emptyPlan(): ProjectionPlan {
  return { runtime: "claude-code", cwd: ".", entries: [], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] };
}

function makeBinding(): NodeBinding {
  return { id: "b1", nodeId: "n1", tmuxSession: "r01-impl", tmuxWindow: null, tmuxPane: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: "." };
}

function makeAction(overrides?: Partial<StartupAction>): StartupAction {
  return { type: "slash_command", value: "/test", phase: "after_ready", appliesOn: ["fresh_start", "restore"], idempotent: true, ...overrides };
}

function makeIdentityAction(overrides?: Partial<StartupAction>): StartupAction {
  return {
    type: "send_text",
    value: [
      "dev-impl@test-rig",
      "OpenRig session identity:",
      "- rig: test-rig",
      "- pod: dev",
      "- member: impl",
      "- logical_id: dev.impl",
      "- session: dev-impl@test-rig",
    ].join("\n"),
    phase: "after_ready",
    appliesOn: ["fresh_start", "restore"],
    idempotent: true,
    builtin: "session_identity",
    ...overrides,
  };
}

describe("StartupOrchestrator", () => {
  let db: Database.Database;
  let sessionRegistry: SessionRegistry;
  let eventBus: EventBus;
  let rigRepo: RigRepository;
  let tmux: TmuxAdapter;

  beforeEach(() => {
    db = createFullTestDb();
    sessionRegistry = new SessionRegistry(db);
    eventBus = new EventBus(db);
    rigRepo = new RigRepository(db);
    tmux = mockTmux();
  });

  afterEach(() => { db.close(); });

  function createOrchestrator(
    opts?: TmuxAdapter | { tmux?: TmuxAdapter; readFile?: (path: string) => string },
  ): StartupOrchestrator {
    const normalized = opts && "sendText" in opts
      ? { tmux: opts as TmuxAdapter }
      : (opts ?? {});
    return new StartupOrchestrator({
      db,
      sessionRegistry,
      eventBus,
      tmuxAdapter: normalized.tmux ?? tmux,
      readFile: normalized.readFile,
      sleep: async () => {},
    });
  }

  function seedSession(): { rigId: string; nodeId: string; sessionId: string } {
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, "impl", { runtime: "claude-code" });
    const session = sessionRegistry.registerSession(node.id, "r01-impl");
    sessionRegistry.updateStatus(session.id, "running");
    return { rigId: rig.id, nodeId: node.id, sessionId: session.id };
  }

  function makeInput(seed: { rigId: string; nodeId: string; sessionId: string }, overrides?: Partial<StartupInput>): StartupInput {
    return {
      rigId: seed.rigId,
      nodeId: seed.nodeId,
      sessionId: seed.sessionId,
      binding: makeBinding(),
      adapter: mockAdapter(),
      plan: emptyPlan(),
      resolvedStartupFiles: [],
      startupActions: [],
      isRestore: false,
      ...overrides,
    };
  }

  // T1: fresh launch enters pending before startup delivery
  it("marks pending before delivery", async () => {
    const seed = seedSession();
    const adapter = mockAdapter();
    let statusDuringProject = "";
    (adapter.project as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      const row = db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(seed.sessionId) as { startup_status: string };
      statusDuringProject = row.startup_status;
      return { projected: [], skipped: [], failed: [] };
    });

    const orch = createOrchestrator();
    await orch.startNode(makeInput(seed, { adapter }));
    expect(statusDuringProject).toBe("pending");
  });

  // T2: successful startup transitions to ready
  it("successful startup transitions to ready", async () => {
    const seed = seedSession();
    const orch = createOrchestrator();
    const result = await orch.startNode(makeInput(seed));
    expect(result.ok).toBe(true);
    expect(result.startupStatus).toBe("ready");

    const row = db.prepare("SELECT startup_status, startup_completed_at FROM sessions WHERE id = ?").get(seed.sessionId) as { startup_status: string; startup_completed_at: string | null };
    expect(row.startup_status).toBe("ready");
    expect(row.startup_completed_at).not.toBeNull();
  });

  // T3: delivery failure transitions to failed
  it("delivery failure transitions to failed", async () => {
    const seed = seedSession();
    const adapter = mockAdapter({
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [{ path: "startup.md", error: "disk full" }] })),
    });
    const orch = createOrchestrator();
    const result = await orch.startNode(makeInput(seed, {
      adapter,
      resolvedStartupFiles: [{ path: "startup.md", absolutePath: "/tmp/startup.md", ownerRoot: "/tmp", deliveryHint: "guidance_merge", required: true, appliesOn: ["fresh_start", "restore"] }],
    }));
    expect(result.ok).toBe(false);
    expect(result.startupStatus).toBe("failed");

    const row = db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(seed.sessionId) as { startup_status: string };
    expect(row.startup_status).toBe("failed");
  });

  // T4: action failure transitions to failed
  it("action failure transitions to failed", async () => {
    const seed = seedSession();
    const failTmux = mockTmux({ sendText: vi.fn(async () => ({ ok: false as const, message: "session gone" })) });
    const orch = createOrchestrator({ tmux: failTmux });
    const actions: StartupAction[] = [makeAction({ phase: "after_ready" })];
    const result = await orch.startNode(makeInput(seed, { startupActions: actions }));
    expect(result.ok).toBe(false);
    expect(result.startupStatus).toBe("failed");
  });

  // T5: new startup sequence: project → pre-launch deliver → launchHarness → checkReady → post-launch deliver → after_files → after_ready
  it("startup sequence: pre-launch deliver before launchHarness; after_files after post-launch; after_ready last", async () => {
    const seed = seedSession();
    const callOrder: string[] = [];

    const adapter = mockAdapter({
      project: vi.fn(async () => { callOrder.push("project"); return { projected: [], skipped: [], failed: [] }; }),
      deliverStartup: vi.fn(async () => { callOrder.push("deliver"); return { delivered: 1, failed: [] }; }),
      launchHarness: vi.fn(async () => { callOrder.push("launchHarness"); return { ok: true }; }),
      checkReady: vi.fn(async () => { callOrder.push("checkReady"); return { ready: true }; }),
    });

    const t = mockTmux({
      sendText: vi.fn(async (target: string, text: string) => {
        callOrder.push(`action:${text}`);
        return { ok: true as const };
      }),
    });

    const orch = createOrchestrator({ tmux: t });
    const actions: StartupAction[] = [
      makeAction({ phase: "after_files", value: "/after-files-cmd" }),
      makeAction({ phase: "after_ready", value: "/after-ready-cmd" }),
    ];
    const files = [
      { path: "culture.md", absolutePath: "/tmp/culture.md", ownerRoot: "/tmp", deliveryHint: "guidance_merge" as const, required: true, appliesOn: ["fresh_start" as const, "restore" as const] },
      { path: "priming.txt", absolutePath: "/tmp/priming.txt", ownerRoot: "/tmp", deliveryHint: "send_text" as const, required: false, appliesOn: ["fresh_start" as const] },
    ];
    await orch.startNode(makeInput(seed, { adapter, startupActions: actions, resolvedStartupFiles: files }));

    const projectIdx = callOrder.indexOf("project");
    const launchIdx = callOrder.indexOf("launchHarness");
    const checkReadyIdx = callOrder.indexOf("checkReady");
    const afterFilesIdx = callOrder.indexOf("action:/after-files-cmd");
    const afterReadyIdx = callOrder.indexOf("action:/after-ready-cmd");

    // deliver is called twice (pre-launch + post-launch), but we verify order via launchHarness position
    expect(launchIdx).toBeGreaterThan(projectIdx);
    expect(checkReadyIdx).toBeGreaterThan(launchIdx);
    expect(afterFilesIdx).toBeGreaterThan(checkReadyIdx);
    expect(afterReadyIdx).toBeGreaterThan(afterFilesIdx);
  });

  // T6: non-idempotent restore action is skipped
  it("non-idempotent action skipped on restore", async () => {
    const seed = seedSession();
    const orch = createOrchestrator();
    const actions: StartupAction[] = [
      makeAction({ value: "/setup-once", idempotent: false, appliesOn: ["fresh_start"] }),
    ];
    const result = await orch.startNode(makeInput(seed, { startupActions: actions, isRestore: true }));
    expect(result.ok).toBe(true);
    expect(tmux.sendText).not.toHaveBeenCalled();
  });

  // T7: idempotent restore action replays safely
  it("idempotent action replays on restore", async () => {
    const seed = seedSession();
    const orch = createOrchestrator();
    const actions: StartupAction[] = [
      makeAction({ value: "/rename impl", idempotent: true, appliesOn: ["fresh_start", "restore"] }),
    ];
    const result = await orch.startNode(makeInput(seed, { startupActions: actions, isRestore: true }));
    expect(result.ok).toBe(true);
    expect(tmux.sendText).toHaveBeenCalledWith("r01-impl", "/rename impl");
  });

  it("submits startup actions after sending text", async () => {
    const seed = seedSession();
    const orch = createOrchestrator();
    const actions: StartupAction[] = [makeAction({ value: "/rename impl" })];

    const result = await orch.startNode(makeInput(seed, { startupActions: actions }));

    expect(result.ok).toBe(true);
    expect(tmux.sendText).toHaveBeenCalledWith("r01-impl", "/rename impl");
    expect(tmux.sendKeys).toHaveBeenCalledWith("r01-impl", ["C-m"]);
  });

  // T8: operator debug append executes after resolved startup
  it("operator debug actions execute in startup sequence", async () => {
    const seed = seedSession();
    const orch = createOrchestrator();
    // Operator debug actions are just regular actions added last by the startup resolver
    const actions: StartupAction[] = [
      makeAction({ value: "/debug-overlay", phase: "after_ready" }),
    ];
    const result = await orch.startNode(makeInput(seed, { startupActions: actions }));
    expect(result.ok).toBe(true);
    expect(tmux.sendText).toHaveBeenCalledWith("r01-impl", "/debug-overlay");
  });

  // T9: reconciler reports failed startup state
  it("failed startup visible in session query", async () => {
    const seed = seedSession();
    const adapter = mockAdapter({
      checkReady: vi.fn(async () => ({ ready: false, reason: "not responding" })),
    });
    const orch = createOrchestrator();
    await orch.startNode(makeInput(seed, { adapter, readinessTimeoutMs: 100 }));

    // Session should show failed startup
    const sessions = sessionRegistry.getSessionsForRig(seed.rigId);
    const session = sessions.find((s) => s.id === seed.sessionId);
    expect(session).toBeDefined();
    expect(session!.startupStatus).toBe("failed");
  });

  it("recoverable interactive startup blockers become attention_required", async () => {
    const seed = seedSession();
    const adapter = mockAdapter({
      checkReady: vi.fn(async () => ({
        ready: false,
        code: "trust_gate",
        reason: "Claude is waiting for workspace trust approval before the session can become interactive.",
      })),
    });
    const orch = createOrchestrator();
    const result = await orch.startNode(makeInput(seed, { adapter }));

    expect(result.ok).toBe(false);
    expect(result.startupStatus).toBe("attention_required");

    const row = db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(seed.sessionId) as { startup_status: string };
    expect(row.startup_status).toBe("attention_required");
  });

  it("injects the session identity into the first fresh send_text prompt", async () => {
    const seed = seedSession();
    const deliverStartup = vi.fn(async (_files: ResolvedStartupFile[]) => ({ delivered: 0, failed: [] }));
    const adapter = mockAdapter({
      deliverStartup,
    });
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const tmuxOverride = mockTmux({ sendText });
    const orch = createOrchestrator({
      tmux: tmuxOverride,
      readFile: (path) => path === "/tmp/role.md" ? "Role instructions go here." : "",
    });

    const result = await orch.startNode(makeInput(seed, {
      adapter,
      resolvedStartupFiles: [{
        path: "guidance/role.md",
        absolutePath: "/tmp/role.md",
        ownerRoot: "/tmp",
        deliveryHint: "send_text",
        required: true,
        appliesOn: ["fresh_start"],
      }],
      startupActions: [
        makeIdentityAction(),
        makeAction({ value: "/rename impl" }),
      ],
    }));

    expect(result).toEqual({
      ok: true,
      startupStatus: "ready",
      continuityOutcome: "fresh",
    });
    expect(sendText).toHaveBeenNthCalledWith(1, "r01-impl", expect.any(String));
    const firstPrompt = sendText.mock.calls[0]?.[1];
    expect(firstPrompt).toContain("dev-impl@test-rig");
    expect(firstPrompt).toContain("OpenRig session identity:");
    expect(firstPrompt).toContain("Role instructions go here.");
    expect(sendText).toHaveBeenNthCalledWith(2, "r01-impl", "/rename impl");
    expect(deliverStartup).toHaveBeenCalledTimes(1);
  });

  it("does not replay the session identity on a resumed restore", async () => {
    const seed = seedSession();
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const tmuxOverride = mockTmux({ sendText });
    const orch = createOrchestrator({ tmux: tmuxOverride });

    const result = await orch.startNode(makeInput(seed, {
      startupActions: [
        makeIdentityAction(),
        makeAction({ value: "/rename impl" }),
      ],
      isRestore: true,
      resumeToken: "claude-session-123",
    }));

    expect(result).toEqual({
      ok: true,
      startupStatus: "ready",
      continuityOutcome: "resumed",
    });
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith("r01-impl", "/rename impl");
  });

  it("sends the identity prompt first when restore falls back to a fresh launch", async () => {
    const seed = seedSession();
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const tmuxOverride = mockTmux({ sendText });
    const adapter = mockAdapter({
      runtime: "codex",
      launchHarness: vi.fn()
        .mockResolvedValueOnce({ ok: false as const, error: "saved session missing", recovery: "retry_fresh" })
        .mockResolvedValueOnce({ ok: true as const, resumeToken: "fresh-token", resumeType: "codex_id" }),
    });
    const orch = createOrchestrator({ tmux: tmuxOverride });

    const result = await orch.startNode(makeInput(seed, {
      adapter,
      isRestore: true,
      resumeToken: "stale-token",
      startupActions: [
        makeIdentityAction(),
        makeAction({ value: "/rename impl" }),
      ],
    }));

    expect(result).toEqual({
      ok: true,
      startupStatus: "ready",
      continuityOutcome: "fresh",
    });
    expect(sendText).toHaveBeenNthCalledWith(
      1,
      "r01-impl",
      expect.stringContaining("dev-impl@test-rig"),
    );
    expect(sendText).toHaveBeenNthCalledWith(2, "r01-impl", "/rename impl");
  });

  // T10: launcher does not mark ready before actions complete
  it("startup_status stays pending until orchestrator completes", async () => {
    const seed = seedSession();
    // After NodeLauncher creates session, startupStatus is pending (default from AS-T00)
    const row = db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(seed.sessionId) as { startup_status: string };
    expect(row.startup_status).toBe("pending"); // launcher left it as default

    // Only after orchestrator.startNode completes does it become ready
    const orch = createOrchestrator();
    await orch.startNode(makeInput(seed));
    const afterRow = db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(seed.sessionId) as { startup_status: string };
    expect(afterRow.startup_status).toBe("ready");
  });

  // T11: retrying failed startup does not duplicate irreversible work
  it("retry-as-restore skips non-idempotent fresh_start actions", async () => {
    const seed = seedSession();

    // First attempt: fails during action (non-idempotent action executes then something else fails)
    const failAdapter = mockAdapter({
      checkReady: vi.fn()
        .mockResolvedValueOnce({ ready: true }) // first attempt: ready
        .mockResolvedValueOnce({ ready: true }), // retry: ready
    });
    const failTmux = mockTmux({
      sendText: vi.fn()
        .mockResolvedValueOnce({ ok: true }) // first attempt: action succeeds
        .mockResolvedValueOnce({ ok: false, message: "second action fails" }) // first attempt: second action fails
        .mockResolvedValueOnce({ ok: true }), // retry: idempotent action succeeds
    });

    const orch = createOrchestrator(failTmux);
    const actions: StartupAction[] = [
      makeAction({ value: "/setup-once", idempotent: false, phase: "after_ready", appliesOn: ["fresh_start"] }),
      makeAction({ value: "/configure", idempotent: true, phase: "after_ready", appliesOn: ["fresh_start", "restore"] }),
    ];

    // First attempt fails on second action
    const r1 = await orch.startNode(makeInput(seed, { adapter: failAdapter, startupActions: actions, isRestore: false }));
    expect(r1.ok).toBe(false);

    // Retry as restore — non-idempotent /setup-once should be skipped
    const r2 = await orch.startNode(makeInput(seed, { adapter: failAdapter, startupActions: actions, isRestore: true }));
    expect(r2.ok).toBe(true);

    // /setup-once was called once (first attempt only), /configure called in retry
    const calls = (failTmux.sendText as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1]);
    expect(calls.filter((c: string) => c === "/setup-once")).toHaveLength(1);
  });

  // T12a: fresh-start-only startup files skipped on restore
  it("fresh-start-only startup files skipped on restore", async () => {
    const seed = seedSession();
    const adapter = mockAdapter();
    const files: ResolvedStartupFile[] = [
      { path: "fresh.md", absolutePath: "/rig/fresh.md", ownerRoot: "/rig", deliveryHint: "auto", required: true, appliesOn: ["fresh_start"] },
      { path: "always.md", absolutePath: "/rig/always.md", ownerRoot: "/rig", deliveryHint: "auto", required: true, appliesOn: ["fresh_start", "restore"] },
    ];
    const orch = createOrchestrator();
    await orch.startNode(makeInput(seed, { adapter, resolvedStartupFiles: files, isRestore: true }));

    // Only "always.md" should be delivered, not "fresh.md"
    const deliverCalls = (adapter.deliverStartup as ReturnType<typeof vi.fn>).mock.calls;
    expect(deliverCalls).toHaveLength(1);
    const deliveredFiles = deliverCalls[0][0] as ResolvedStartupFile[];
    expect(deliveredFiles).toHaveLength(1);
    expect(deliveredFiles[0]!.path).toBe("always.md");
  });

  // T12b: emits correct lifecycle events
  it("emits startup_pending and startup_ready events", async () => {
    const seed = seedSession();
    const events: string[] = [];
    eventBus.subscribe((e) => events.push(e.type));

    const orch = createOrchestrator();
    await orch.startNode(makeInput(seed));

    expect(events).toContain("node.startup_pending");
    expect(events).toContain("node.startup_ready");
    expect(events.indexOf("node.startup_pending")).toBeLessThan(events.indexOf("node.startup_ready"));
  });

  // NS-T04: resolveConcreteHint shared resolver
  it("resolveConcreteHint: SKILL.md path → skill_install", () => {
    expect(resolveConcreteHint("skills/my-skill/SKILL.md", "some content")).toBe("skill_install");
  });

  it("resolveConcreteHint: content starting with # SKILL → skill_install", () => {
    expect(resolveConcreteHint("custom.txt", "# SKILL Some tool")).toBe("skill_install");
  });

  it("resolveConcreteHint: .md file → guidance_merge", () => {
    expect(resolveConcreteHint("role.md", "You are a developer")).toBe("guidance_merge");
  });

  it("resolveConcreteHint: non-.md file → send_text", () => {
    expect(resolveConcreteHint("config.yaml", "key: value")).toBe("send_text");
  });

  // NS-T04: skipHarnessLaunch
  it("skipHarnessLaunch: true skips launchHarness entirely", async () => {
    const seed = seedSession();
    const launchSpy = vi.fn(async () => ({ ok: true as const }));
    const adapter = mockAdapter({ launchHarness: launchSpy });
    const orch = createOrchestrator();
    const result = await orch.startNode(makeInput(seed, { adapter, skipHarnessLaunch: true }));
    expect(result.ok).toBe(true);
    expect(launchSpy).not.toHaveBeenCalled();
  });

  // NS-T04: launchHarness failure → startup_failed
  it("launchHarness failure transitions to startup_failed", async () => {
    const seed = seedSession();
    const adapter = mockAdapter({
      launchHarness: vi.fn(async () => ({ ok: false as const, error: "harness crash" })),
    });
    const orch = createOrchestrator();
    const result = await orch.startNode(makeInput(seed, { adapter }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("harness crash"))).toBe(true);
    }
  });

  // NS-T04: launchHarness persists resume token
  it("launchHarness resume token persisted to session", async () => {
    const seed = seedSession();
    const adapter = mockAdapter({
      launchHarness: vi.fn(async () => ({ ok: true as const, resumeToken: "sess-xyz", resumeType: "claude_id" })),
    });
    const orch = createOrchestrator();
    await orch.startNode(makeInput(seed, { adapter }));

    const sessions = sessionRegistry.getSessionsForRig(seed.rigId);
    const session = sessions.find((s) => s.id === seed.sessionId);
    expect(session!.resumeToken).toBe("sess-xyz");
    expect(session!.resumeType).toBe("claude_id");
  });

  it("launchHarness does not persist empty resume token as restoreable state", async () => {
    const seed = seedSession();
    const adapter = mockAdapter({
      launchHarness: vi.fn(async () => ({ ok: true as const, resumeToken: "", resumeType: "claude_id" })),
    });
    const orch = createOrchestrator();
    await orch.startNode(makeInput(seed, { adapter }));

    const sessions = sessionRegistry.getSessionsForRig(seed.rigId);
    const session = sessions.find((s) => s.id === seed.sessionId);
    expect(session!.resumeToken).toBeNull();
    expect(session!.resumeType).toBeNull();
  });

  it("retries restore once as fresh when launchHarness reports resume recovery can safely fall back", async () => {
    const seed = seedSession();
    const launchHarness = vi.fn()
      .mockResolvedValueOnce({ ok: false as const, error: "saved session missing", recovery: "retry_fresh" })
      .mockResolvedValueOnce({ ok: true as const, resumeToken: "fresh-token", resumeType: "codex_id" });
    const adapter = mockAdapter({
      runtime: "codex",
      launchHarness,
    });
    const orch = createOrchestrator();

    const result = await orch.startNode(makeInput(seed, {
      adapter,
      isRestore: true,
      resumeToken: "stale-token",
    }));

    expect(result).toEqual({
      ok: true,
      startupStatus: "ready",
      continuityOutcome: "fresh",
    });
    expect(launchHarness).toHaveBeenCalledTimes(2);
    expect(launchHarness.mock.calls[0]![1]).toEqual({
      name: "r01-impl",
      resumeToken: "stale-token",
    });
    expect(launchHarness.mock.calls[1]![1]).toEqual({
      name: "r01-impl",
      resumeToken: undefined,
    });

    const sessions = sessionRegistry.getSessionsForRig(seed.rigId);
    const session = sessions.find((s) => s.id === seed.sessionId);
    expect(session!.resumeToken).toBe("fresh-token");
    expect(session!.resumeType).toBe("codex_id");
    expect(session!.startupStatus).toBe("ready");
  });

  // NS-T05: readiness retry loop
  it("readiness retries until ready", async () => {
    const seed = seedSession();
    let callCount = 0;
    const adapter = mockAdapter({
      checkReady: vi.fn(async () => {
        callCount++;
        // Ready on 3rd attempt
        return callCount >= 3 ? { ready: true } : { ready: false, reason: "not yet" };
      }),
    });
    const orch = createOrchestrator();
    const result = await orch.startNode(makeInput(seed, { adapter, readinessTimeoutMs: 10_000 }));
    expect(result.ok).toBe(true);
    expect(callCount).toBeGreaterThanOrEqual(3);
  });

  it("readiness timeout → startup_failed with timeout message", async () => {
    const seed = seedSession();
    const adapter = mockAdapter({
      checkReady: vi.fn(async () => ({ ready: false, reason: "harness not interactive" })),
    });
    const orch = createOrchestrator();
    const result = await orch.startNode(makeInput(seed, { adapter, readinessTimeoutMs: 100 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => e.includes("timeout") || e.includes("Readiness timeout"))).toBe(true);
    }
  });

  it("readiness blocker fails immediately with the blocker reason instead of a timeout", async () => {
    const seed = seedSession();
    const adapter = mockAdapter({
      checkReady: vi.fn(async () => ({
        ready: false,
        reason: "Codex is waiting for workspace trust approval before the session can become interactive.",
        code: "trust_gate",
      })),
    });
    const orch = createOrchestrator();
    const result = await orch.startNode(makeInput(seed, { adapter, readinessTimeoutMs: 10_000 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.startupStatus).toBe("attention_required");
      expect(result.errors.some((e) => e.includes("Startup requires attention"))).toBe(true);
      expect(result.errors.some((e) => e.includes("timeout"))).toBe(false);
    }
  });

  it("delivers openrig-start.md overlay alongside agent role guidance (append, not replace)", async () => {
    const seed = seedSession();
    const deliveredFiles: string[] = [];
    const adapter = mockAdapter({
      deliverStartup: vi.fn(async (files) => {
        for (const f of files) deliveredFiles.push(f.path);
        return { delivered: files.length, failed: [] };
      }),
    });
    const roleFile: ResolvedStartupFile = {
      path: "guidance/role.md",
      absolutePath: "/agents/impl/guidance/role.md",
      ownerRoot: "/agents/impl",
      deliveryHint: "guidance_merge",
      required: true,
      appliesOn: ["fresh_start", "restore"],
    };
    const onboardingFile: ResolvedStartupFile = {
      path: "openrig-start.md",
      absolutePath: "/assets/guidance/openrig-start.md",
      ownerRoot: "/assets",
      deliveryHint: "guidance_merge",
      required: false,
      appliesOn: ["fresh_start", "restore"],
    };

    const orch = createOrchestrator();
    const result = await orch.startNode(makeInput(seed, {
      adapter,
      resolvedStartupFiles: [roleFile, onboardingFile],
    }));

    expect(result.ok).toBe(true);
    // Both files were delivered — overlay appended, not replacing role guidance
    expect(deliveredFiles).toContain("guidance/role.md");
    expect(deliveredFiles).toContain("openrig-start.md");
  });
});
