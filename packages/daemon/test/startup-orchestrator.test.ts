import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb } from "./helpers/test-app.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { StartupOrchestrator, isRecoverableStartupFailure, type StartupInput, type StartupResult } from "../src/domain/startup-orchestrator.js";
import type { RuntimeAdapter, NodeBinding, ResolvedStartupFile, ProjectionResult, StartupDeliveryResult, ReadinessResult } from "../src/domain/runtime-adapter.js";
import { resolveConcreteHint } from "../src/domain/runtime-adapter.js";
import type { ProjectionPlan } from "../src/domain/projection-planner.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import type { StartupAction } from "../src/domain/types.js";
import { deriveOriented, issueStartupChallenge, verifyStartupProof, STARTUP_PROOF_INSTRUCTION_LINE } from "../src/domain/startup-proof.js";
import { AgentActivityStore } from "../src/domain/agent-activity-store.js";
import { AppliedLaunchObservationStore } from "../src/domain/applied-launch-observation-store.js";
import { observeClaudePermission } from "../src/domain/permission-drift.js";
import type { SettingsStore } from "../src/domain/user-settings/settings-store.js";
import { assessNativeResumeProbe } from "../src/domain/native-resume-probe.js";
import { createHash } from "node:crypto";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { CommunityHarnessRuntimeAdapter } from "../src/adapters/community-harness-runtime-adapter.js";
import { SeatAttentionReconciler } from "../src/domain/seat-attention-reconciler.js";
import { getNodeInventory } from "../src/domain/node-inventory.js";
import { SEAT_SKILLS_BOOTSTRAP_LINE, describeSkillRouterFootprint, seatSkillPaths } from "../src/domain/seat-skill-storage.js";
import { prepareSeatLaunchAdditions, recordConversationPrompt, systemPromptPendingNote } from "../src/domain/seat-launch-additions.js";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { Hono } from "hono";
import { nodesRoutes } from "../src/routes/sessions.js";
import { compactNodeProjection } from "../../cli/src/commands/ps.js";

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
    capturePaneContent: vi.fn(async () => "❯ \n────────────────────\n⏵⏵ accept edits on (shift+tab to cycle)\n"),
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
    // A successful managed Claude resume returns the identity it resumed.
    launchHarness: vi.fn(async (_binding, opts) => ({ ok: true,
      ...(opts.resumeToken ? { resumeToken: opts.resumeToken, resumeType: "claude_id" } : {}) })),
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
    opts?: TmuxAdapter | { tmux?: TmuxAdapter; readFile?: (path: string) => string; readinessSettings?: Pick<SettingsStore, "resolveOne"> },
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
      readinessSettings: normalized.readinessSettings ?? ({
        resolveOne: () => ({ value: 30, source: "default", defaultValue: 30 }),
      } as unknown as Pick<SettingsStore, "resolveOne">),
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

  it.each(["codex-first-login.txt", "codex-first-login-0.162.1.txt"])("persists %s as attention and withholds startup context", async (fixture) => {
    const seed = seedSession();
    db.prepare("UPDATE nodes SET runtime = 'codex' WHERE id = ?").run(seed.nodeId);
    const firstLoginPrompt = nodeFs.readFileSync(new URL(`./fixtures/${fixture}`, import.meta.url), "utf8");
    const nativeTmux = mockTmux({
      getPaneCommand: vi.fn(async () => "codex"),
      getPanePid: vi.fn(async () => null),
      capturePaneContent: vi.fn(async () => firstLoginPrompt),
    });
    const native = new CodexRuntimeAdapter({ tmux: nativeTmux, listProcesses: () => [] });
    const adapter = mockAdapter({ runtime: "codex", checkReady: vi.fn(binding => native.checkReady(binding)) });
    const result = await createOrchestrator({ tmux: nativeTmux }).startNode(makeInput(seed, {
      adapter,
      plan: { ...emptyPlan(), runtime: "codex" },
      readinessTimeoutMs: 1_000,
      resolvedStartupFiles: [{ path: "role.md", absolutePath: "/fixture/role.md", ownerRoot: "/fixture",
        deliveryHint: "send_text", required: true, appliesOn: ["fresh_start"] }],
      startupActions: [makeAction({ type: "send_text", value: "Start the assigned task" })],
    }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected a login gate");
    expect(result.startupStatus).toBe("attention_required");
    expect(result.errors.join("\n")).toMatch(/sign in/i);
    expect(result.errors.join("\n")).not.toContain("Readiness timeout");
    expect(adapter.launchHarness).toHaveBeenCalledTimes(1);
    expect(adapter.checkReady).toHaveBeenCalledTimes(1);
    expect(vi.mocked(adapter.deliverStartup).mock.calls.flatMap(([files]) => files)).toEqual([]);
    expect(nativeTmux.sendText).not.toHaveBeenCalled();
    expect(nativeTmux.sendKeys).not.toHaveBeenCalled();
    expect(sessionRegistry.getSessionsForRig(seed.rigId).find(session => session.id === seed.sessionId)?.startupStatus)
      .toBe("attention_required");
    const inventory = getNodeInventory(db, seed.rigId)[0];
    expect(inventory).toMatchObject({ startupStatus: "attention_required", lifecycleState: "attention_required" });
    expect(inventory?.latestError).toMatch(/sign in/i);
    expect(inventory?.latestError).not.toContain("Readiness timeout");
    const failure = db.prepare("SELECT payload FROM events WHERE node_id = ? AND type = 'node.startup_failed' ORDER BY seq DESC LIMIT 1")
      .get(seed.nodeId) as { payload: string };
    expect(JSON.parse(failure.payload)).toMatchObject({ freshContextPending: true });
    expect(result.errors.join("\n")).toContain("rig seat continue");

    const app = new Hono();
    app.use("*", async (c, next) => {
      c.set("rigRepo" as never, rigRepo);
      c.set("tmuxAdapter" as never, nativeTmux);
      await next();
    });
    app.route("/api/rigs/:rigId/nodes", nodesRoutes);
    const response = await app.request(`/api/rigs/${seed.rigId}/nodes`);
    expect(response.status).toBe(200);
    const served = await response.json();
    expect(served[0]).toMatchObject({ startupStatus: "attention_required", needsAttention: true,
      latestError: expect.stringMatching(/sign in/i) });
    expect(compactNodeProjection(served)[0]).toMatchObject({ needsAttention: true,
      latestError: expect.stringMatching(/sign in/i) });
  });

  // OPR.0.7.0.13 (router, R1.1): a start replaying a saved context delivers the old seat-skills pointer only with the
  // person's recorded yes. The Codex catalog (same logical name, sent as text) and other guidance are unchanged.
  it.each([
    ["the default (never asked)", { value: false, source: "default" }, false, { outcome: "skipped", reason: "answer_unasked" }],
    ["a saved no", { value: false, source: "file" }, false, { outcome: "skipped", reason: "answer_no" }],
    ["the environment's no", { value: false, source: "env" }, false, { outcome: "skipped", reason: "answer_environment_no" }],
    ["a saved yes", { value: true, source: "file" }, true, { outcome: "delivered" }],
  ] as const)("a replayed start delivers the bootstrap line only with a yes, and says why not: %s", async (_label, line, delivered, outcome) => {
    const seed = seedSession();
    const seen: Array<{ path: string; deliveryHint: string }> = [];
    const adapter = mockAdapter({
      deliverStartup: vi.fn(async (files) => { seen.push(...files.map((f) => ({ path: f.path, deliveryHint: f.deliveryHint }))); return { delivered: files.length, failed: [] }; }),
    });
    const file = (path: string, deliveryHint: "guidance_merge" | "send_text") =>
      ({ path, absolutePath: `/fixture/${path}`, ownerRoot: "/fixture", deliveryHint, required: false, appliesOn: ["fresh_start", "restore"] as ("fresh_start" | "restore")[] });
    const readinessSettings = {
      resolveOne: (key: string) => key === "skills.router_line.enabled" ? { ...line, defaultValue: false } : { value: 30, source: "default", defaultValue: 30 },
    } as unknown as Pick<SettingsStore, "resolveOne">;
    const result = await createOrchestrator({ readinessSettings, readFile: () => "text" }).startNode(makeInput(seed, {
      adapter, isRestore: true,
      resolvedStartupFiles: [file("CULTURE.md", "guidance_merge"), file("openrig-seat-skills.md", "guidance_merge"), file("openrig-seat-skills.md", "send_text")],
    }));
    expect(seen).toContainEqual({ path: "CULTURE.md", deliveryHint: "guidance_merge" });
    expect(seen).toContainEqual({ path: "openrig-seat-skills.md", deliveryHint: "send_text" });
    if (delivered) expect(seen).toContainEqual({ path: "openrig-seat-skills.md", deliveryHint: "guidance_merge" });
    else expect(seen).not.toContainEqual({ path: "openrig-seat-skills.md", deliveryHint: "guidance_merge" });
    expect(result).toMatchObject({ ok: true, routerLine: { files: [{ path: expect.stringMatching(/CLAUDE\.md$/), ...outcome }] } });
  });

  // Claude Code answers plan-mode turns with Sonnet when its model setting is exactly the alias `haiku`. The launch is unchanged;
  // its result says so for that pairing.
  it.each([
    ["claude-code", "haiku", "plan", true], ["claude-code", "claude-haiku-4-5", "plan", false],
    ["claude-code", "haiku", undefined, false], ["codex", "haiku", "plan", false],
  ] as const)("a %s launch with model %j and permission mode %j names plan mode's Sonnet answer for the bare alias only", async (runtime, model, permissionMode, named) => {
    const seed = seedSession();
    const binding = { ...makeBinding(), model, ...(permissionMode ? { permissionMode } : {}) };
    const adapter = mockAdapter({ runtime });
    const result = await createOrchestrator().startNode(makeInput(seed, { adapter, binding, sessionName: "dev-impl@test-rig" }));
    expect(result.ok).toBe(true);
    const launched = vi.mocked(adapter.launchHarness).mock.calls[0]![0];
    expect([launched.model, launched.permissionMode]).toEqual([model, permissionMode]);
    expect((result.warnings ?? []).filter((w) => w.includes('alias "haiku"'))).toEqual(named ? ['dev-impl@test-rig: Claude Code answers plan-mode turns '
      + 'with Sonnet when the model is the alias "haiku". To keep Haiku, set a full Haiku model id: rig seat set-model dev-impl@test-rig '
      + '--model <full Haiku id> --reason "<why>".'] : []);
  });

  // R6-F1: the real adapters, not a mock, decide what an unwritable guidance file reports.
  it.skipIf(process.getuid?.() === 0).each(["codex", "claude-code"] as const)("through the real %s adapter: an unwritable guidance file is unwritable with the real error, and the seat still starts", async (runtime) => { // root ignores file modes
    const seed = seedSession();
    const cwd = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "line-unwritable-"));
    nodeFs.chmodSync(cwd, 0o555);
    try {
      const fsOps = {
        readFile: (f: string) => nodeFs.readFileSync(f, "utf8"), writeFile: (f: string, c: string) => nodeFs.writeFileSync(f, c),
        exists: (f: string) => nodeFs.existsSync(f), mkdirp: (d: string) => { nodeFs.mkdirSync(d, { recursive: true }); },
        copyFile: (a: string, b: string) => nodeFs.copyFileSync(a, b), listFiles: (d: string) => nodeFs.readdirSync(d), homedir: cwd,
      };
      const tmuxNever = new Proxy({}, { get() { throw new Error("no tmux calls in delivery"); } }) as never;
      const real = runtime === "codex"
        ? new CodexRuntimeAdapter({ fsOps: fsOps as never, tmux: tmuxNever, listProcesses: () => [] })
        : new ClaudeCodeAdapter({ fsOps: fsOps as never, tmux: tmuxNever } as never);
      const adapter = mockAdapter({ runtime, deliverStartup: real.deliverStartup.bind(real) as RuntimeAdapter["deliverStartup"] });
      const readinessSettings = {
        resolveOne: (key: string) => key === "skills.router_line.enabled" ? { value: true, source: "file", defaultValue: false } : { value: 30, source: "default", defaultValue: 30 },
      } as unknown as Pick<SettingsStore, "resolveOne">;
      const asset = nodePath.join(import.meta.dirname, "../assets/guidance/openrig-seat-skills.md");
      const result = await createOrchestrator({ readinessSettings, readFile: (f) => nodeFs.readFileSync(f, "utf8") }).startNode(makeInput(seed, {
        adapter, isRestore: true, binding: { ...makeBinding(), cwd },
        resolvedStartupFiles: [{ path: "openrig-seat-skills.md", absolutePath: asset, ownerRoot: nodePath.dirname(asset), deliveryHint: "guidance_merge", required: false, appliesOn: ["fresh_start", "restore"] }],
      }));
      expect(result).toMatchObject({ ok: true, routerLine: { answer: { state: "yes", by: "saved" }, files: [{ outcome: "unwritable", error: expect.stringMatching(/EACCES|permission denied/i) }] } });
      expect(result.warnings?.some((w) => w.startsWith("seat_skills_line_unwritable:"))).toBe(true);
    } finally {
      nodeFs.chmodSync(cwd, 0o755);
      nodeFs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  // What setup shows is what a start writes: with a yes, the real adapters add exactly the footprint's bytes, the line between
  // OpenRig's markers, to an existing guidance file, and write exactly that text into a new one.
  it.each([
    ["codex", "an existing"], ["codex", "a new"], ["claude-code", "an existing"], ["claude-code", "a new"],
  ] as const)("through the real %s adapter: a start writes exactly the text setup previews into %s guidance file", async (runtime, kind) => {
    const existing = kind === "an existing" ? "# Personal instructions\nPreserve these exact bytes.\n" : null;
    const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "line-exact-"));
    try {
      const footprint = describeSkillRouterFootprint([]);
      const asset = nodePath.join(import.meta.dirname, "../assets/guidance/openrig-seat-skills.md");
      const readinessSettings = {
        resolveOne: (key: string) => key === "skills.router_line.enabled" ? { value: true, source: "file", defaultValue: false } : { value: 30, source: "default", defaultValue: 30 },
      } as unknown as Pick<SettingsStore, "resolveOne">;
      const seed = seedSession();
      const cwd = nodeFs.mkdtempSync(nodePath.join(root, "project-"));
      const guidance = nodePath.join(cwd, runtime === "codex" ? "AGENTS.md" : "CLAUDE.md");
      if (existing !== null) nodeFs.writeFileSync(guidance, existing);
      const fsOps = {
        readFile: (f: string) => nodeFs.readFileSync(f, "utf8"), writeFile: (f: string, c: string) => nodeFs.writeFileSync(f, c),
        exists: (f: string) => nodeFs.existsSync(f), mkdirp: (d: string) => { nodeFs.mkdirSync(d, { recursive: true }); },
        copyFile: (a: string, b: string) => nodeFs.copyFileSync(a, b), listFiles: (d: string) => nodeFs.readdirSync(d), homedir: root,
      };
      const tmuxNever = new Proxy({}, { get() { throw new Error("no tmux calls in delivery"); } }) as never;
      const real = runtime === "codex"
        ? new CodexRuntimeAdapter({ fsOps: fsOps as never, tmux: tmuxNever, listProcesses: () => [] })
        : new ClaudeCodeAdapter({ fsOps: fsOps as never, tmux: tmuxNever } as never);
      const adapter = mockAdapter({ runtime, deliverStartup: real.deliverStartup.bind(real) as RuntimeAdapter["deliverStartup"] });
      const result = await createOrchestrator({ readinessSettings, readFile: (f) => nodeFs.readFileSync(f, "utf8") }).startNode(makeInput(seed, {
        adapter, isRestore: true, binding: { ...makeBinding(), cwd },
        resolvedStartupFiles: [{ path: "openrig-seat-skills.md", absolutePath: asset, ownerRoot: nodePath.dirname(asset), deliveryHint: "guidance_merge", required: false, appliesOn: ["fresh_start", "restore"] }],
      }));
      expect(result).toMatchObject({ ok: true, routerLine: { files: [{ outcome: "delivered" }] } });
      expect(nodeFs.readFileSync(guidance, "utf8")).toBe(existing === null ? footprint.written : `${existing}${footprint.appended}`);
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
    }
  });

  // A guidance file that is a link (here to a file outside the project) isn't written through: the start reports it linked.
  it.each(["codex", "claude-code"] as const)("through the real %s adapter: a linked guidance file is left unwritten and reported linked, and the seat still starts", async (runtime) => {
    const seed = seedSession();
    const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "line-linked-"));
    try {
      const cwd = nodePath.join(root, "project");
      nodeFs.mkdirSync(cwd);
      const elsewhere = nodePath.join(root, "elsewhere.md");
      const personal = "# Personal instructions\nPreserve these exact bytes.\n";
      nodeFs.writeFileSync(elsewhere, personal);
      nodeFs.symlinkSync(elsewhere, nodePath.join(cwd, runtime === "codex" ? "AGENTS.md" : "CLAUDE.md"));
      const fsOps = {
        readFile: (f: string) => nodeFs.readFileSync(f, "utf8"), writeFile: (f: string, c: string) => nodeFs.writeFileSync(f, c),
        exists: (f: string) => nodeFs.existsSync(f), mkdirp: (d: string) => { nodeFs.mkdirSync(d, { recursive: true }); },
        copyFile: (a: string, b: string) => nodeFs.copyFileSync(a, b), listFiles: (d: string) => nodeFs.readdirSync(d), homedir: root,
      };
      const tmuxNever = new Proxy({}, { get() { throw new Error("no tmux calls in delivery"); } }) as never;
      const real = runtime === "codex"
        ? new CodexRuntimeAdapter({ fsOps: fsOps as never, tmux: tmuxNever, listProcesses: () => [] })
        : new ClaudeCodeAdapter({ fsOps: fsOps as never, tmux: tmuxNever } as never);
      const adapter = mockAdapter({ runtime, deliverStartup: real.deliverStartup.bind(real) as RuntimeAdapter["deliverStartup"] });
      const readinessSettings = {
        resolveOne: (key: string) => key === "skills.router_line.enabled" ? { value: true, source: "file", defaultValue: false } : { value: 30, source: "default", defaultValue: 30 },
      } as unknown as Pick<SettingsStore, "resolveOne">;
      const asset = nodePath.join(import.meta.dirname, "../assets/guidance/openrig-seat-skills.md");
      const result = await createOrchestrator({ readinessSettings, readFile: (f) => nodeFs.readFileSync(f, "utf8") }).startNode(makeInput(seed, {
        adapter, isRestore: true, binding: { ...makeBinding(), cwd },
        resolvedStartupFiles: [{ path: "openrig-seat-skills.md", absolutePath: asset, ownerRoot: nodePath.dirname(asset), deliveryHint: "guidance_merge", required: false, appliesOn: ["fresh_start", "restore"] }],
      }));
      expect(result).toMatchObject({ ok: true, routerLine: { answer: { state: "yes", by: "saved" }, files: [{ outcome: "linked", path: expect.stringMatching(runtime === "codex" ? /AGENTS\.md$/ : /CLAUDE\.md$/) }] } });
      expect(result.warnings?.some((w) => w.startsWith("seat_skills_line_linked:"))).toBe(true);
      expect(nodeFs.readFileSync(elsewhere, "utf8")).toBe(personal);
    } finally {
      nodeFs.rmSync(root, { recursive: true, force: true });
    }
  });

  // An edited seat-skills line is left as it is by a start, as rig down leaves it: a fresh start doesn't replace it.
  it.each(["codex", "claude-code"] as const)("through the real %s adapter: a start leaves an edited seat-skills line as it is and reports it edited", async (runtime) => {
    const seed = seedSession();
    const cwd = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "line-edited-"));
    try {
      const guidance = nodePath.join(cwd, runtime === "codex" ? "AGENTS.md" : "CLAUDE.md");
      const edited = "# Personal instructions\n\n<!-- BEGIN OpenRig MANAGED BLOCK: openrig-seat-skills.md -->\n"
        + `${SEAT_SKILLS_BOOTSTRAP_LINE} PERSON LINE EDIT\n\n<!-- END OpenRig MANAGED BLOCK: openrig-seat-skills.md -->`;
      nodeFs.writeFileSync(guidance, edited);
      const fsOps = {
        readFile: (f: string) => nodeFs.readFileSync(f, "utf8"), writeFile: (f: string, c: string) => nodeFs.writeFileSync(f, c),
        exists: (f: string) => nodeFs.existsSync(f), mkdirp: (d: string) => { nodeFs.mkdirSync(d, { recursive: true }); },
        copyFile: (a: string, b: string) => nodeFs.copyFileSync(a, b), listFiles: (d: string) => nodeFs.readdirSync(d), homedir: cwd,
      };
      const tmuxNever = new Proxy({}, { get() { throw new Error("no tmux calls in delivery"); } }) as never;
      const real = runtime === "codex"
        ? new CodexRuntimeAdapter({ fsOps: fsOps as never, tmux: tmuxNever, listProcesses: () => [] })
        : new ClaudeCodeAdapter({ fsOps: fsOps as never, tmux: tmuxNever } as never);
      const adapter = mockAdapter({ runtime, deliverStartup: real.deliverStartup.bind(real) as RuntimeAdapter["deliverStartup"] });
      const readinessSettings = {
        resolveOne: (key: string) => key === "skills.router_line.enabled" ? { value: true, source: "file", defaultValue: false } : { value: 30, source: "default", defaultValue: 30 },
      } as unknown as Pick<SettingsStore, "resolveOne">;
      const asset = nodePath.join(import.meta.dirname, "../assets/guidance/openrig-seat-skills.md");
      const result = await createOrchestrator({ readinessSettings }).startNode(makeInput(seed, {
        adapter, isRestore: false, binding: { ...makeBinding(), cwd },
        resolvedStartupFiles: [{ path: "openrig-seat-skills.md", absolutePath: asset, ownerRoot: nodePath.dirname(asset), deliveryHint: "guidance_merge", required: false, appliesOn: ["fresh_start", "restore"] }],
      }));
      // The person's bytes first: on a build without the check, the start replaces the edit.
      expect(nodeFs.readFileSync(guidance, "utf8")).toBe(edited);
      expect(result).toMatchObject({ ok: true, routerLine: { answer: { state: "yes", by: "saved" }, files: [{ outcome: "edited" }] } });
      expect(result.warnings?.some((w) => w.startsWith("seat_skills_line_edited:"))).toBe(true);
    } finally {
      nodeFs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  // A link refusing a seat's first plugin manifest or catalog: its skills are refused there and named, never written into
  // the project; a seat that never had storage (no link) keeps the project, as before.
  describe.each(["codex", "claude-code"] as const)("through the real %s adapter, a seat whose storage a link refused", (runtime) => {
    let savedHome: string | undefined;
    let home: string;
    const temps: string[] = [];
    const temp = (name: string) => { const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), name)); temps.push(dir); return dir; };
    beforeEach(() => { savedHome = process.env["OPENRIG_HOME"]; home = temp("seat-refused-home-"); process.env["OPENRIG_HOME"] = home; });
    afterEach(() => {
      if (savedHome === undefined) delete process.env["OPENRIG_HOME"]; else process.env["OPENRIG_HOME"] = savedHome;
      for (const dir of temps.splice(0)) nodeFs.rmSync(dir, { recursive: true, force: true });
    });

    // rig: the rig's folder under the shared anchor is a link. record: only a Codex seat's projection record is a link.
    // marker: only the marker is a link (Claude's .claude-plugin folder; a dangling Codex catalog.md), its skills folder
    // ordinary. unrelated: usable storage, with an unrelated link at skills/team-plugin. none: no storage and no link.
    async function start(layout: "rig" | "record" | "marker" | "unrelated" | "none", withPlugin = false) {
      const rig = rigRepo.createRig("linked-rig");
      const node = rigRepo.addNode(rig.id, "impl", { runtime });
      const session = sessionRegistry.registerSession(node.id, "r01-impl");
      sessionRegistry.updateStatus(session.id, "running");
      const moved = temp("seat-refused-moved-");
      const { logical_id: logicalId } = db.prepare("SELECT logical_id FROM nodes WHERE id = ?").get(node.id) as { logical_id: string };
      const paths = seatSkillPaths({ rigId: rig.id, logicalId, runtime });
      if (layout === "rig") {
        nodeFs.mkdirSync(nodePath.join(home, "state", "seats"), { recursive: true });
        nodeFs.symlinkSync(moved, nodePath.join(home, "state", "seats", rig.id));
      } else if (layout === "record") {
        nodeFs.mkdirSync(paths.root, { recursive: true });
        nodeFs.writeFileSync(nodePath.join(moved, "record.json"), "{}\n");
        nodeFs.symlinkSync(nodePath.join(moved, "record.json"), paths.projectionsPath);
      } else if (layout === "marker") {
        if (runtime === "codex") {
          nodeFs.mkdirSync(paths.root, { recursive: true });
          nodeFs.symlinkSync(nodePath.join(moved, "missing.md"), paths.catalogPath);
        } else {
          nodeFs.mkdirSync(paths.pluginDir, { recursive: true });
          nodeFs.symlinkSync(moved, nodePath.dirname(paths.pluginManifestPath));
        }
      } else if (layout === "unrelated") {
        const marker = runtime === "codex" ? paths.catalogPath : paths.pluginManifestPath;
        nodeFs.mkdirSync(nodePath.dirname(marker), { recursive: true });
        nodeFs.writeFileSync(marker, runtime === "codex" ? "catalog\n" : "{\"name\":\"openrig\"}\n");
        nodeFs.mkdirSync(paths.skillsRoot, { recursive: true });
        nodeFs.symlinkSync(moved, nodePath.join(paths.skillsRoot, "team-plugin"));
      }
      const source = nodePath.join(temp("seat-refused-src-"), "review");
      nodeFs.mkdirSync(source);
      nodeFs.writeFileSync(nodePath.join(source, "SKILL.md"), "---\nname: review\ndescription: d\n---\n");
      const cwd = temp("seat-refused-project-");
      // A selected plugin with a bundled skill, a manifest for each runtime and a hook.
      const plugin = nodePath.join(temp("seat-refused-plugin-"), "team-plugin");
      for (const [file, text] of [[".claude-plugin/plugin.json", "{\"name\":\"team-plugin\"}\n"], [".codex-plugin/plugin.json", "{\"name\":\"team-plugin\"}\n"],
        ["skills/tool/SKILL.md", "---\nname: tool\ndescription: d\n---\n"], ["hooks/hooks.json", "{}\n"]] as const) {
        nodeFs.mkdirSync(nodePath.dirname(nodePath.join(plugin, file)), { recursive: true });
        nodeFs.writeFileSync(nodePath.join(plugin, file), text);
      }
      const files = (d: string): string[] => (nodeFs.readdirSync(d, { recursive: true }) as string[]).filter((f) => nodeFs.statSync(nodePath.join(d, f)).isFile());
      const fsOps = {
        readFile: (f: string) => nodeFs.readFileSync(f, "utf8"), writeFile: (f: string, c: string) => nodeFs.writeFileSync(f, c),
        exists: (f: string) => nodeFs.existsSync(f), mkdirp: (d: string) => { nodeFs.mkdirSync(d, { recursive: true }); },
        copyFile: (a: string, b: string) => nodeFs.copyFileSync(a, b), listFiles: files, homedir: cwd,
      };
      const tmuxNever = new Proxy({}, { get() { throw new Error("no tmux calls in projection"); } }) as never;
      const real = runtime === "codex"
        ? new CodexRuntimeAdapter({ fsOps: fsOps as never, tmux: tmuxNever, listProcesses: () => [] })
        : new ClaudeCodeAdapter({ fsOps: fsOps as never, tmux: tmuxNever } as never);
      const adapter = mockAdapter({ runtime, project: real.project.bind(real) as RuntimeAdapter["project"] });
      const plan = { ...emptyPlan(), runtime, cwd, entries: [{ effectiveId: "review", category: "skill", absolutePath: source, classification: "safe_projection" },
        ...(withPlugin ? [{ effectiveId: "team-plugin", category: "plugin", absolutePath: plugin, classification: "safe_projection" }] : [])] } as unknown as ProjectionPlan;
      const result = await createOrchestrator().startNode(makeInput({ rigId: rig.id, nodeId: node.id, sessionId: session.id }, { adapter, plan, binding: { ...makeBinding(), cwd } }));
      return { result, cwd, moved, paths };
    }

    const projectSkill = (cwd: string) => nodePath.join(cwd, runtime === "codex" ? ".agents" : ".claude", "skills", "review");

    it("refuses the skill there and names it; nothing goes into the project or through the link, and the seat starts", async () => {
      const { result, cwd, moved } = await start("rig");
      expect(result.ok).toBe(true);
      expect(nodeFs.existsSync(projectSkill(cwd))).toBe(false);
      expect(nodeFs.readdirSync(moved)).toEqual([]);
      expect(result.warnings?.some((w) => w.startsWith("review: ") && w.includes("not inside this seat's storage"))).toBe(true);
    });

    it("names a selected plugin's bundled skills as not delivered; its other files are copied as before", async () => {
      const { result, cwd } = await start("rig", true);
      expect(result.ok).toBe(true);
      const pluginCopy = nodePath.join(cwd, runtime === "codex" ? ".codex" : ".claude", "plugins", "team-plugin");
      expect(nodeFs.existsSync(nodePath.join(pluginCopy, "hooks", "hooks.json"))).toBe(true);
      expect(nodeFs.existsSync(nodePath.join(pluginCopy, "skills"))).toBe(false);
      expect(result.warnings?.some((w) => w.startsWith("team-plugin: plugin_skills_not_delivered: its bundled skills (1 file(s))"))).toBe(true);
    });

    it.skipIf(runtime !== "codex")("a linked projection record alone: the skill is refused there and named, not written into the project", async () => {
      const { result, cwd, paths } = await start("record");
      expect(result.ok).toBe(true);
      expect(nodeFs.existsSync(projectSkill(cwd))).toBe(false);
      expect(nodeFs.existsSync(nodePath.join(paths.skillsRoot, "review"))).toBe(false);
      expect(result.warnings?.some((w) => w.startsWith("review: ") && w.includes("not inside this seat's storage"))).toBe(true);
    });

    it("only the marker linked: the skill isn't written where nothing reads it, and the plugin's bundled skills are named", async () => {
      const { result, cwd, paths } = await start("marker", true);
      expect(result.ok).toBe(true);
      expect(nodeFs.existsSync(projectSkill(cwd))).toBe(false);
      expect(nodeFs.existsSync(nodePath.join(paths.skillsRoot, "review"))).toBe(false);
      expect(result.warnings?.some((w) => w.startsWith("review: ") && w.includes("not inside this seat's storage"))).toBe(true);
      expect(result.warnings?.some((w) => w.startsWith("team-plugin: plugin_skills_not_delivered:"))).toBe(true);
    });

    it("usable storage with an unrelated link at skills/<plugin id>: no plugin-skills note", async () => {
      const { result, paths } = await start("unrelated", true);
      expect(result.ok).toBe(true);
      expect(nodeFs.existsSync(nodePath.join(paths.skillsRoot, "review", "SKILL.md"))).toBe(true);
      expect((result.warnings ?? []).some((w) => w.includes("plugin_skills_not_delivered"))).toBe(false);
    });

    it("with no link and no storage yet, keeps the project, as before", async () => {
      const { result, cwd } = await start("none");
      expect(result.ok).toBe(true);
      expect(nodeFs.existsSync(nodePath.join(projectSkill(cwd), "SKILL.md"))).toBe(true);
    });
  });

  // OPR.0.7.0.9: a seat's own launch additions, prepared in its seat storage, reach its launch binding; a peer gets
  // none. The prompt a conversation starts with is recorded, and a resume after it changed reports it pending.
  describe("a seat's launch additions at start", () => {
    let savedHome: string | undefined;
    const temps: string[] = [];
    const temp = (name: string) => { const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), name)); temps.push(dir); return dir; };
    beforeEach(() => { savedHome = process.env["OPENRIG_HOME"]; process.env["OPENRIG_HOME"] = temp("seat-additions-start-home-"); });
    afterEach(() => {
      if (savedHome === undefined) delete process.env["OPENRIG_HOME"]; else process.env["OPENRIG_HOME"] = savedHome;
      for (const dir of temps.splice(0)) nodeFs.rmSync(dir, { recursive: true, force: true });
    });

    function seat(logicalId: string, withAdditions: boolean) {
      const rig = rigRepo.createRig(`additions-${logicalId}`);
      const node = rigRepo.addNode(rig.id, logicalId, { runtime: "claude-code" });
      const session = sessionRegistry.registerSession(node.id, `r01-${logicalId}`);
      sessionRegistry.updateStatus(session.id, "running");
      const paths = seatSkillPaths({ rigId: rig.id, logicalId, runtime: "claude-code" });
      const src = temp("seat-additions-start-src-");
      const prompt = nodePath.join(src, "prompt.md");
      nodeFs.writeFileSync(prompt, "First instructions.\n");
      if (withAdditions && !prepareSeatLaunchAdditions(paths, { appendSystemPromptFile: prompt }).ok) throw new Error("prepare");
      return { seed: { rigId: rig.id, nodeId: node.id, sessionId: session.id }, paths, prompt };
    }

    function launching(token: string) {
      const seen: NodeBinding[] = [];
      const adapter = mockAdapter({ launchHarness: vi.fn(async (binding: NodeBinding) => { seen.push(binding); return { ok: true as const, resumeToken: token, resumeType: "claude_id" }; }) });
      return { adapter, seen };
    }

    it("binds the seat's additions, and none for a peer", async () => {
      const own = seat("impl", true);
      const peer = seat("peer", false);
      for (const [s, expected] of [[own, true], [peer, false]] as const) {
        const { adapter, seen } = launching("conv-1");
        expect((await createOrchestrator().startNode(makeInput(s.seed, { adapter }))).ok).toBe(true);
        if (expected) expect(seen[0]!.launchAdditions?.appendSystemPromptFile).toBe(nodePath.join(s.paths.root, "additions", "system-prompt.md"));
        else expect(seen[0]!.launchAdditions).toBeUndefined();
      }
    });

    it("a seat root with ordinary spaces: the prompt file and the agent are both passed", async () => {
      process.env["OPENRIG_HOME"] = nodePath.join(temp("seat-additions-start-spaced-"), "Application Support", "openrig");
      const own = seat("impl", false);
      const src = temp("seat-additions-start-agent-");
      nodeFs.writeFileSync(nodePath.join(src, "reviewer.md"), "---\nname: reviewer\ndescription: d\n---\n");
      expect(prepareSeatLaunchAdditions(own.paths, { appendSystemPromptFile: own.prompt, agentFile: nodePath.join(src, "reviewer.md") }).ok).toBe(true);
      const { adapter, seen } = launching("conv-1");
      const result = await createOrchestrator().startNode(makeInput(own.seed, { adapter }));
      expect(seen[0]!.launchAdditions?.appendSystemPromptFile).toContain("Application Support");
      expect(seen[0]!.launchAdditions?.agent).toBe("openrig:reviewer");
      expect((result.warnings ?? []).some((w) => w.includes("seat_launch_addition"))).toBe(false);
    });

    it("a fork takes its parent's recorded start, not today's prompt", async () => {
      const own = seat("impl", true);
      recordConversationPrompt(own.paths, "parent-1");
      nodeFs.writeFileSync(own.prompt, "Changed before the fork.\n");
      expect(prepareSeatLaunchAdditions(own.paths, { appendSystemPromptFile: own.prompt }).ok).toBe(true);
      const forked = launching("fork-1");
      expect((await createOrchestrator().startNode(makeInput(own.seed, { adapter: forked.adapter, forkSource: { kind: "native_id", value: "parent-1" } }))).ok).toBe(true);
      expect(systemPromptPendingNote(own.paths, "fork-1")).toMatch(/^system_prompt_pending: /);
    });

    it("a resume after the prompt changed says it's pending; a missing copy is left off the launch and named", async () => {
      const own = seat("impl", true);
      const fresh = launching("conv-1");
      expect((await createOrchestrator().startNode(makeInput(own.seed, { adapter: fresh.adapter }))).ok).toBe(true);
      nodeFs.writeFileSync(own.prompt, "Changed instructions.\n");
      expect(prepareSeatLaunchAdditions(own.paths, { appendSystemPromptFile: own.prompt }).ok).toBe(true);
      const resumed = launching("conv-1");
      const result = await createOrchestrator().startNode(makeInput(own.seed, { adapter: resumed.adapter, resumeToken: "conv-1", resumeType: "claude_id" }));
      expect(result.warnings?.some((w) => w.includes("system_prompt_pending: "))).toBe(true);

      nodeFs.rmSync(nodePath.join(own.paths.root, "additions", "system-prompt.md"));
      const again = launching("conv-2");
      const missing = await createOrchestrator().startNode(makeInput(own.seed, { adapter: again.adapter }));
      expect(again.seen[0]!.launchAdditions?.appendSystemPromptFile).toBeUndefined();
      expect(missing.warnings?.some((w) => w.includes("seat_launch_addition_missing: ") && w.includes("system-prompt.md"))).toBe(true);
    });
  });

  it("a line that can't be written is the start's named result; the seat still starts", async () => {
    const seed = seedSession();
    const adapter = mockAdapter({
      deliverStartup: vi.fn(async (files) => files.some((f) => f.path === "openrig-seat-skills.md")
        ? { delivered: 0, failed: [{ path: "openrig-seat-skills.md", error: "EACCES: permission denied" }] }
        : { delivered: files.length, failed: [] }),
    });
    const readinessSettings = {
      resolveOne: (key: string) => key === "skills.router_line.enabled" ? { value: true, source: "file", defaultValue: false } : { value: 30, source: "default", defaultValue: 30 },
    } as unknown as Pick<SettingsStore, "resolveOne">;
    const result = await createOrchestrator({ readinessSettings, readFile: () => "text" }).startNode(makeInput(seed, {
      adapter, isRestore: true,
      resolvedStartupFiles: [{ path: "openrig-seat-skills.md", absolutePath: "/fixture/line.md", ownerRoot: "/fixture", deliveryHint: "guidance_merge", required: false, appliesOn: ["fresh_start", "restore"] }],
    }));
    expect(result).toMatchObject({ ok: true, routerLine: { answer: { state: "yes", by: "saved" }, files: [{ outcome: "unwritable", error: "EACCES: permission denied" }] } });
    expect(result.warnings?.some((w) => w.startsWith("seat_skills_line_unwritable:"))).toBe(true);
  });

  it.each([false, true])("returns projection and delivery warnings on launch outcomes (fails=%s)", async fails => {
    const seed = seedSession();
    const adapter = mockAdapter({
      project: vi.fn(async () => ({ projected: ["core"], skipped: [], failed: [], warnings: ["AGENTS.md is untracked"] })),
      deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [], warnings: ["plugin exclude skipped"] })),
      launchHarness: vi.fn(async () => fails ? { ok: false, error: "controlled launch failure" } : { ok: true }),
    });
    const result = await createOrchestrator().startNode(makeInput(seed, { adapter }));
    expect(result.ok).toBe(!fails);
    expect(result.warnings).toEqual(["AGENTS.md is untracked", "plugin exclude skipped"]);
  });

  it("keeps a challenge-only transport failure best-effort", async () => {
    const seed = seedSession();
    const tmux = mockTmux({ sendText: vi.fn(async () => ({ ok: false as const, message: "fixture transport failure" })) });
    const result = await createOrchestrator(tmux).startNode(makeInput(seed, {
      startupActions: [makeAction({ type: "startup_proof", value: "authenticated" })],
    }));
    expect(result).toMatchObject({ ok: true, startupStatus: "ready" });
    expect(tmux.sendKeys).not.toHaveBeenCalled();
  });

  it("deliberate fresh replacement appends the named durable obligation read without an extra message", async () => {
    const seed = seedSession();
    await createOrchestrator().startNode(makeInput(seed, { startupActions: [makeIdentityAction()], includeDurableObligations: true }));
    expect(tmux.sendText).toHaveBeenCalledTimes(1);
    expect(tmux.sendText).toHaveBeenCalledWith("r01-impl", expect.stringContaining("rig queue list --destination r01-impl --state pending,in-progress,blocked"));
    expect(tmux.sendText).toHaveBeenCalledWith("r01-impl", expect.stringContaining(makeIdentityAction().value));
    expect(vi.mocked(tmux.sendText).mock.calls[0]?.[1]).not.toContain("readiness for an assignment");
  });

  it("persists the authored context before a native gate and exposes only the matching continuation", async () => {
    const seed = seedSession(); const orch = createOrchestrator();
    const action = makeAction({ type: "send_text", value: "configured role and durable queue instructions" });
    const adapter = mockAdapter({ launchHarness: vi.fn(async () => ({ ok: false, recovery: "attention_required", error: "Hook review" })) });
    const result = await orch.startNode(makeInput(seed, { adapter, startupActions: [action] }));
    expect(result.startupStatus).toBe("attention_required");
    expect(JSON.parse((db.prepare("SELECT startup_actions_json FROM node_startup_context WHERE node_id=?").get(seed.nodeId) as {startup_actions_json:string}).startup_actions_json)).toEqual([action]);
    expect(orch.canContinueStartup(seed.nodeId, seed.sessionId)).toBe(true);
    expect(orch.canContinueStartup(seed.nodeId, "other-occupant")).toBe(false);
    eventBus.emit({ type: "node.startup_pending", rigId: seed.rigId, nodeId: seed.nodeId });
    expect(orch.canContinueStartup(seed.nodeId, seed.sessionId)).toBe(false);
  });

  it("records a role binding before launch succeeds and preserves it on exact resume", async () => {
    const seed = seedSession();
    const orch = createOrchestrator();
    const role: ResolvedStartupFile = { path: "role.md", absolutePath: "/fixture/role.md", ownerRoot: "/fixture", orientation: "role", deliveryHint: "send_text", required: true, appliesOn: ["fresh_start"] };
    const read = () => db.prepare("SELECT * FROM node_startup_context WHERE node_id=?").get(seed.nodeId) as { resolved_files_json: string; created_at: string };
    const adapter = mockAdapter({ launchHarness: vi.fn(async () => {
      expect(JSON.parse(read().resolved_files_json)).toEqual([role]);
      return { ok: false, recovery: "attention_required", error: "Native gate" };
    }) });
    expect((await orch.startNode(makeInput(seed, { adapter, resolvedStartupFiles: [role] }))).ok).toBe(false);
    const before = read();
    expect(before.created_at).toBeTruthy();
    await orch.startNode(makeInput(seed, { isRestore: true, resumeToken: "original", preserveStartupContext: true }));
    expect(read()).toEqual(before);
  });

  it("exact resume retains configured fresh context while sending no replay", async () => {
    const seed = seedSession(); const orch = createOrchestrator();
    const action = makeAction({ type: "send_text", value: "configured context" });
    await orch.startNode(makeInput(seed, { startupActions: [action] }));
    const before = db.prepare("SELECT * FROM node_startup_context WHERE node_id=?").get(seed.nodeId);
    const adapter = mockAdapter();
    const result = await orch.startNode(makeInput(seed, { adapter, isRestore: true, resumeToken: "native-original", preserveStartupContext: true }));
    expect(result.ok).toBe(true);
    expect(db.prepare("SELECT * FROM node_startup_context WHERE node_id=?").get(seed.nodeId)).toEqual(before);
    expect(adapter.deliverStartup).toHaveBeenCalledWith([], expect.anything());
  });

  it.each([
    { preserve: true, populated: false, calls: 0 },
    { preserve: true, populated: true, calls: 1 },
    { preserve: false, populated: false, calls: 1 },
  ])("projects resources only outside an empty preserved Claude plan: %j", async ({ preserve, populated, calls }) => {
    const adapter = mockAdapter();
    const plan = emptyPlan();
    if (populated) plan.entries.push({
      category: "runtime_resource", resourceType: "claude_activity_hooks", effectiveId: "activity",
      sourceSpec: "saved", sourcePath: "/fixture", resourcePath: "activity", absolutePath: "/fixture/activity",
      classification: "safe_projection",
    });
    const result = await createOrchestrator().startNode(makeInput(seedSession(), {
      adapter, plan, preserveStartupContext: preserve, isRestore: true, resumeToken: "native-original",
    }));
    expect(result.ok).toBe(true);
    expect(adapter.project).toHaveBeenCalledTimes(calls);
    if (calls) expect(adapter.project).toHaveBeenCalledWith(plan, expect.anything());
    expect(tmux.sendText).not.toHaveBeenCalled();
  });

  it.each([undefined, "claude_id", "claude_name", "codex_id"])("managed Claude resume agrees with the requested type: %s", async (resumeType) => {
    const seed = seedSession();
    const adapter = mockAdapter();
    const orch = createOrchestrator();
    const result = await orch.startNode(makeInput(seed, {
      adapter, isRestore: true, resumeToken: "requested-native", resumeType,
    }));
    const compatible = resumeType !== "codex_id";
    expect(result).toMatchObject(compatible
      ? { ok: true, startupStatus: "ready", continuityOutcome: "resumed" }
      : { ok: false, startupStatus: "attention_required" });
    expect(db.prepare("SELECT status, startup_status, resume_type, resume_token, resume_provenance FROM sessions WHERE id = ?").get(seed.sessionId))
      .toEqual({ status: "running", startup_status: compatible ? "ready" : "attention_required",
        resume_type: "claude_id", resume_token: "requested-native", resume_provenance: "scrape" });
    expect(adapter.launchHarness).toHaveBeenCalledOnce();
    expect(tmux.killSession).not.toHaveBeenCalled();
    expect(tmux.sendText).not.toHaveBeenCalled();
    if (!compatible) expect(orch.canContinueStartup(seed.nodeId, seed.sessionId)).toBe(false);
  });

  it.each(["missing", "late-hook"])("managed Claude resume checks final row agreement: %s", async (mode) => {
    const seed = seedSession();
    const token = "requested-native";
    const adapter = mockAdapter(mode === "missing"
      ? { launchHarness: vi.fn(async () => ({ ok: true })) } : {});
    const t = mockTmux({ sendText: vi.fn(async () => {
      sessionRegistry.updateResumeToken(seed.sessionId, "claude_id", "other-native", "hook");
      return { ok: true as const };
    }) });
    const orch = createOrchestrator({ tmux: t });
    const result = await orch.startNode(makeInput(seed, {
      adapter, resumeToken: token, isRestore: true,
      startupActions: mode === "late-hook" ? [makeAction()] : [],
    }));
    expect(result).toMatchObject({ ok: false, startupStatus: "attention_required" });
    expect(db.prepare("SELECT status, startup_status, resume_token, resume_provenance FROM sessions WHERE id = ?").get(seed.sessionId))
      .toEqual({ status: "running", startup_status: "attention_required",
        resume_token: mode === "late-hook" ? "other-native" : null, resume_provenance: mode === "late-hook" ? "hook" : null });
    expect(orch.canContinueStartup(seed.nodeId, seed.sessionId)).toBe(false);
    expect(adapter.launchHarness).toHaveBeenCalledOnce();
    expect(t.killSession).not.toHaveBeenCalled();
    expect(db.prepare("SELECT type FROM events WHERE node_id = ? AND type = 'node.startup_ready'").all(seed.nodeId)).toEqual([]);
  });

  it.each(["launch", "readiness"])("pod-aware exact resume cannot continue fresh context after a %s gate", async (gate) => {
    const seed = seedSession(); const orch = createOrchestrator();
    await orch.startNode(makeInput(seed, { startupActions: [makeIdentityAction()], includeDurableObligations: true }));
    const before = db.prepare("SELECT * FROM node_startup_context WHERE node_id=?").get(seed.nodeId);
    vi.mocked(tmux.sendText).mockClear();
    const adapter = mockAdapter(gate === "launch"
      ? { launchHarness: vi.fn(async () => ({ ok: false, recovery: "attention_required", error: "Hook review" })) }
      : { checkReady: vi.fn(async () => ({ ready: false, code: "hook_trust_gate", reason: "Hook review" })) });
    // RestoreOrchestrator's pod-aware exact-resume path contains replay via
    // empty files/actions, but uses isRestore:false to launch the native harness.
    const input = makeInput(seed, { adapter, isRestore: false, resumeToken: "native-original",
      resumeType: "claude_id", preserveStartupContext: true, allowFreshFallback: false });
    expect((await orch.startNode(input)).startupStatus).toBe("attention_required");
    expect(orch.canContinueStartup(seed.nodeId, seed.sessionId)).toBe(false);
    expect(createOrchestrator().canContinueStartup(seed.nodeId, seed.sessionId)).toBe(false);
    expect(db.prepare("SELECT * FROM node_startup_context WHERE node_id=?").get(seed.nodeId)).toEqual(before);
    expect(tmux.sendText).not.toHaveBeenCalled();
    const retry = await createOrchestrator().startNode({ ...input, adapter: mockAdapter() });
    expect(retry).toMatchObject({ ok: true, continuityOutcome: "resumed" });
    expect(tmux.sendText).not.toHaveBeenCalled();
  });

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
  it.each(["codex_client_incompatible", "hook_trust_gate"])("does not mark ready when context delivery exposes %s", async (code) => {
    const seed = seedSession();
    let delivered = false;
    const adapter = mockAdapter({
      runtime: "codex",
      deliverStartup: vi.fn(async (files) => { if (files.some((file) => file.deliveryHint === "send_text")) delivered = true; return { delivered: files.length, failed: [] }; }),
      checkReady: vi.fn(async () => delivered
        ? { ready: false, code, reason: "The native runtime requires attention" }
        : { ready: true }),
    });
    const result = await createOrchestrator().startNode(makeInput(seed, { adapter,
      resolvedStartupFiles: [{ path: "role.md", absolutePath: "/tmp/role.md", ownerRoot: "/tmp",
        deliveryHint: "send_text", required: true, appliesOn: ["fresh_start"] }] }));
    expect(result).toMatchObject({ ok: false, startupStatus: "attention_required" });
    expect(db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(seed.sessionId)).toEqual({ startup_status: "attention_required" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM node_startup_context WHERE node_id = ?").get(seed.nodeId)).toEqual({ n: 1 });
  });

  it.each(["initial_identity", "restore_preload", "after_ready"])("reports a trust dialog after %s instead of startup ready", async (source) => {
    const seed = seedSession();
    let delivered = false;
    // Claude 2.1.220's observed trust panel, with the project path replaced.
    const trust = "Accessing workspace:\n/fixture/project\nQuick safety check: Is this a project you created or one you trust?\n❯ 1. Yes, I trust this folder\n  2. No, exit\nEnter to confirm · Esc to cancel";
    const t = mockTmux({ sendText: vi.fn(async () => { delivered = true; return { ok: true as const }; }),
      capturePaneContent: vi.fn(async () => trust) });
    const adapter = mockAdapter({ checkReady: vi.fn(async () => {
      const probe = assessNativeResumeProbe({ runtime: "claude-code", paneCommand: "claude",
        paneContent: delivered ? trust : "Claude Code v2.1.220\n❯ \n? for shortcuts" });
      return { ready: probe.status === "resumed", code: probe.code, reason: probe.detail };
    }) });
    const result = await createOrchestrator({ tmux: t, readFile: () => "Read the project instructions." }).startNode(makeInput(seed, {
      adapter, isRestore: source === "restore_preload",
      ...(source === "restore_preload" ? { resumeToken: "native-original", resumeType: "claude_id" } : {}),
      resolvedStartupFiles: source === "after_ready" ? [] : [{ path: "role.md", absolutePath: "/fixture/role.md",
        ownerRoot: "/fixture", deliveryHint: "send_text", required: true, appliesOn: ["fresh_start", "restore"] }],
      startupActions: [source === "initial_identity" ? makeIdentityAction() : makeAction({ type: "send_text", value: "Read the project instructions." })],
    }));
    // A fresh start's refused turn wasn't read, so its context stays pending for `rig seat continue`; a restore's doesn't.
    expect(result).toMatchObject({ ok: false, startupStatus: "attention_required",
      errors: source === "restore_preload" ? [expect.stringContaining("workspace trust approval")] : [
        expect.stringContaining("workspace trust approval"), expect.stringContaining("hasn't read its startup context"),
        expect.stringContaining("rig seat continue")] });
    expect(adapter.checkReady).toHaveBeenCalledTimes(2);
    expect(t.sendText).toHaveBeenCalledTimes(1);
    expect(t.sendKeys).toHaveBeenCalledTimes(1); // no extra Enter into the trust menu
    expect(t.killSession).not.toHaveBeenCalled();
    expect(db.prepare("SELECT startup_status FROM sessions WHERE id = ?").get(seed.sessionId)).toEqual({ startup_status: "attention_required" });
    expect(db.prepare("SELECT type FROM events WHERE node_id = ? AND type = 'node.startup_ready'").all(seed.nodeId)).toEqual([]);
  });

  it.each(["bundled", "file"])("keeps an unavailable post-%s observation unverified without failing startup", async (delivery) => {
    const seed = seedSession();
    const adapter = mockAdapter({ checkReady: vi.fn().mockResolvedValueOnce({ ready: true })
      .mockRejectedValueOnce(new Error("fixture capture unavailable")) });
    const result = await createOrchestrator({ readFile: () => "Read the project instructions." }).startNode(makeInput(seed, {
      adapter, resolvedStartupFiles: [{ path: "role.md", absolutePath: "/fixture/role.md", ownerRoot: "/fixture",
        deliveryHint: "send_text", required: true, appliesOn: ["fresh_start"] }],
      startupActions: delivery === "bundled" ? [makeIdentityAction()] : [],
    }));
    expect(result).toMatchObject({ ok: true, startupStatus: "ready", submission: { status: "unverified",
      reasons: ["Post-delivery runtime state is unverified: fixture capture unavailable"] } });
    expect(adapter.checkReady).toHaveBeenCalledTimes(2);
    const event = db.prepare("SELECT payload FROM events WHERE node_id = ? AND type = 'node.startup_ready'").get(seed.nodeId) as { payload: string };
    expect(JSON.parse(event.payload).submission).toMatchObject({ status: "unverified" });
    expect(tmux.killSession).not.toHaveBeenCalled();
  });

  describe("a startup turn the runtime refuses (an expired login)", () => {
    const files: ResolvedStartupFile[] = ["role.md", "a.md", "b.md"].map((path) => ({
      path, absolutePath: `/fixture/${path}`, ownerRoot: "/fixture", deliveryHint: "send_text" as const, required: true,
      appliesOn: ["fresh_start" as const, "restore" as const],
    }));
    const LOGIN: ReadinessResult = { ready: false, code: "login_required", reason: "Claude refused the request: Login expired · Please run /login" };
    const CONTINUE = "The seat hasn't read its startup context. Continuing delivers the whole startup again, the refused turn included.";
    const read = (path: string) => {
      if (path.endsWith("unreadable.md")) throw new Error("EACCES: permission denied");
      return `Contents of ${nodePath.basename(path)}`;
    };
    const sent = (typed: string[]) => typed.map((text) => text.match(/Contents of (\S+)/)?.[1] ?? text);
    // The adapter's own loop: read each file, send it through the orchestrator's checked send, and collect a required
    // file's error and go on (claude-code-adapter deliverStartup).
    const deliverStartup: RuntimeAdapter["deliverStartup"] = async (pending, _binding, send) => {
      const failed: Array<{ path: string; error: string }> = [];
      for (const file of pending) {
        try { await send?.(read(file.absolutePath)); } catch (err) { if (file.required) failed.push({ path: file.path, error: (err as Error).message }); }
      }
      return { delivered: pending.length - failed.length, failed };
    };
    function harness(readiness: (typed: string[]) => ReadinessResult, enterFails: (typed: string[]) => boolean = () => false) {
      const typed: string[] = [];
      const attempted: string[] = [];
      const t = mockTmux({ sendText: vi.fn(async (_session: string, text: string) => { typed.push(text); return { ok: true as const }; }),
        sendKeys: vi.fn(async () => {
          // A request's refusal follows its Enter attempt, not the earlier bracketed paste.
          attempted.push(typed.at(-1)!);
          return enterFails(typed) ? { ok: false as const, code: "unknown", message: "tmux: Enter failed" } : { ok: true as const };
        }) });
      const adapter = mockAdapter({ deliverStartup: vi.fn(deliverStartup), checkReady: vi.fn(async () => readiness(attempted)) });
      return { typed, orchestrator: createOrchestrator({ tmux: t, readFile: read }), adapter };
    }
    const errorsOf = (result: StartupResult) => result.ok ? [] : result.errors;
    const readyEvents = (nodeId: string) => db.prepare("SELECT count(*) AS n FROM events WHERE node_id = ? AND type = 'node.startup_ready'").get(nodeId);

    // Ordered no-model discriminator: real Claude readiness/classification and file delivery, fake terminal I/O.
    // The response rows/footer match the retained Claude 2.1.309 expired-login frame; no credential is involved.
    it.each([
      ["before_check", "fresh"], ["after_check", "fresh"], ["after_paste", "fresh"],
      ["healthy", "fresh"], ["stale", "fresh"], ["unavailable", "fresh"],
      ["after_paste", "resumed"], ["after_paste", "forked"],
    ] as const)(
      "a login refusal at %s on a %s start stops later submissions without replaying a staged input", async (arrival, continuity) => {
        const seed = seedSession();
        const typed: string[] = [];
        const submitted: string[] = [];
        const trace: string[] = [];
        let refusal = false;
        let injected = false;
        let composer = "";
        const frame = () => arrival === "unavailable" && submitted.length > 0 ? null
          : `${submitted.length ? "❯ First startup turn\n" : ""}${refusal || arrival === "stale"
            ? "● Login expired · Please run /login\n\n✻ Worked for 0s · done 7:22 PM\n" : ""}${arrival === "stale"
              ? "❯ A newer request\n● Ready to work.\n" : ""}────────────────────\n❯ ${composer}\n────────────────────\n⏵⏵ accept edits on (shift+tab to cycle)\n`;
        const t = mockTmux({
          getPaneCommand: vi.fn(async () => "claude"),
          capturePaneContent: vi.fn(async () => { trace.push(`capture:${refusal ? "refused" : "healthy"}:${composer ? "staged" : "clear"}`); return frame(); }),
          sendText: vi.fn(async (_session, text) => {
            typed.push(text); composer = text; trace.push(`paste:${typed.length}`);
            if (typed.length === 2 && arrival === "after_paste") { refusal = true; trace.push("refusal"); }
            return { ok: true as const };
          }),
          sendKeys: vi.fn(async () => {
            submitted.push(composer); composer = ""; trace.push(`enter:${submitted.length}`);
            if (submitted.length === 1 && arrival === "before_check") { refusal = true; trace.push("refusal"); }
            return { ok: true as const };
          }),
        });
        const real = new ClaudeCodeAdapter({ tmux: t, sleep: async () => {}, fsOps: {
          readFile: read, writeFile: () => {}, exists: () => false, mkdirp: () => {}, copyFile: () => {}, listFiles: () => [],
        } });
        const adapter = mockAdapter({
          deliverStartup: real.deliverStartup.bind(real),
          checkReady: vi.fn(async (binding) => {
            const result = await real.checkReady(binding); trace.push(`ready:${result.code ?? result.ready}`);
            if (submitted.length === 1 && !composer && !injected && arrival === "after_check") {
              injected = true; refusal = true; trace.push("refusal");
            }
            return result;
          }),
        });
        const orchestrator = createOrchestrator({ tmux: t, readFile: read });
        const result = await orchestrator.startNode(makeInput(seed, { adapter, resolvedStartupFiles: files, startupActions: [makeIdentityAction()],
          ...(continuity === "resumed" ? { isRestore: true, resumeToken: "existing-token" }
            : continuity === "forked" ? { forkSource: { kind: "native_id" as const, value: "parent-token" } } : {}),
        }));
        const blocked = ["before_check", "after_check", "after_paste"].includes(arrival);
        expect(sent(submitted), trace.join(" → ")).toEqual(blocked ? ["role.md"] : ["role.md", "a.md", "b.md"]);
        if (!blocked) { expect(result).toMatchObject({ ok: true, startupStatus: "ready" }); return; }
        expect(result).toMatchObject({ ok: false, startupStatus: "attention_required" });
        expect(readyEvents(seed.nodeId)).toEqual({ n: 0 });
        if (arrival === "before_check") {
          expect(sent(typed)).toEqual(["role.md"]);
          expect(errorsOf(result).join(" ")).toContain("2 later startup inputs weren't sent");
          expect(orchestrator.pendingStartupContext(seed.nodeId, seed.sessionId)).toMatchObject({ mode: "fresh" });
        } else {
          expect(sent(typed)).toEqual(["role.md", "a.md"]);
          expect(composer).toBe("Contents of a.md");
          expect(errorsOf(result).join(" ")).toContain("1 later startup input wasn't sent");
          const guidance = errorsOf(result).join(" ");
          expect(guidance).toContain("OpenRig pasted the next startup input in r01-impl but didn't press Enter");
          if (continuity === "fresh") {
            expect(guidance).toContain("rig seat launch 'r01-impl' --fresh --stop --reason");
            expect(guidance).not.toContain("this start was a restore");
          } else {
            expect(guidance).toContain("The seat's conversation is kept");
            expect(guidance).toContain("clear it or send it after signing in");
            expect(guidance).not.toContain("--fresh");
          }
          expect(errorsOf(result).join(" ")).not.toContain("Continuing delivers the whole startup again");
          expect(orchestrator.pendingStartupContext(seed.nodeId, seed.sessionId)).toBeNull();
          expect(isRecoverableStartupFailure(db, seed.nodeId, seed.sessionId)).toBe(false);
        }
      });

    it("sends nothing more, holds the rest as owed, and a continuation delivers the whole startup in order after sign-in", async () => {
      const seed = seedSession();
      let loggedIn = false;
      const { typed, orchestrator, adapter } = harness((t) => t.length > 0 && !loggedIn ? LOGIN : { ready: true });
      const failed = await orchestrator.startNode(makeInput(seed, { adapter, resolvedStartupFiles: files, startupActions: [makeIdentityAction()] }));

      expect(sent(typed)).toEqual(["role.md"]); // only the refused first turn (identity + role.md)
      expect(failed).toMatchObject({ ok: false, startupStatus: "attention_required" });
      expect(errorsOf(failed)).toEqual([LOGIN.reason, `2 later startup inputs weren't sent. ${CONTINUE}`,
        "After resolving it in r01-impl, run: rig seat continue 'r01-impl'"]);
      expect(orchestrator.pendingStartupContext(seed.nodeId, seed.sessionId)).toMatchObject({ mode: "fresh" });
      expect(readyEvents(seed.nodeId)).toEqual({ n: 0 });

      loggedIn = true;
      typed.length = 0;
      const continued = await orchestrator.startNode(makeInput(seed, { adapter, resolvedStartupFiles: files,
        startupActions: [makeIdentityAction()], skipHarnessLaunch: true, continueFreshStartup: true }));
      expect(continued).toMatchObject({ ok: true, startupStatus: "ready" });
      expect(sent(typed)).toEqual(["role.md", "a.md", "b.md"]);
    });

    it("doesn't offer continuing once a one-shot action ran, names the fresh launch, and is never marked ready later", async () => {
      const seed = seedSession();
      const { typed, orchestrator, adapter } = harness((t) => t.includes("/setup-once") ? LOGIN : { ready: true });
      const result = await orchestrator.startNode(makeInput(seed, { adapter, resolvedStartupFiles: files, startupActions: [
        makeIdentityAction(),
        makeAction({ value: "/setup-once", idempotent: false, phase: "after_files", appliesOn: ["fresh_start"] }),
        makeAction({ value: "/later", phase: "after_ready", appliesOn: ["fresh_start"] }),
      ] }));

      expect(sent(typed)).toEqual(["role.md", "a.md", "b.md", "/setup-once"]);
      expect(result).toMatchObject({ ok: false, startupStatus: "attention_required" });
      expect(errorsOf(result)).toEqual([LOGIN.reason, "1 later startup input wasn't sent. The seat hasn't read all of its startup context, "
        + "and continuing isn't offered: a one-shot startup action already ran and must not run twice. "
        + "To deliver it, launch the seat fresh: rig seat launch 'r01-impl' --fresh --stop --reason \"<why>\"."]);
      expect(orchestrator.pendingStartupContext(seed.nodeId, seed.sessionId)).toBeNull();
      expect(isRecoverableStartupFailure(db, seed.nodeId, seed.sessionId)).toBe(false); // a later reconcile can't mark it ready
      expect(readyEvents(seed.nodeId)).toEqual({ n: 0 });
    });

    it("counts a one-shot whose text was typed but whose Enter failed, so continuing isn't offered", async () => {
      const seed = seedSession();
      const lastIsSetup = (t: string[]) => t.at(-1) === "/setup-once";
      const { typed, orchestrator, adapter } = harness((t) => t.includes("/setup-once") ? LOGIN : { ready: true }, lastIsSetup);
      const result = await orchestrator.startNode(makeInput(seed, { adapter, resolvedStartupFiles: files, startupActions: [
        makeIdentityAction(),
        makeAction({ value: "/setup-once", idempotent: false, phase: "after_files", appliesOn: ["fresh_start"] }),
        makeAction({ value: "/later", phase: "after_files", appliesOn: ["fresh_start"] }),
      ] }));

      expect(sent(typed)).toEqual(["role.md", "a.md", "b.md", "/setup-once"]);
      expect(result).toMatchObject({ ok: false, startupStatus: "attention_required" });
      expect(errorsOf(result)).toEqual([LOGIN.reason, "Action failed (slash_command): tmux: Enter failed",
        expect.stringMatching(/^1 later startup input wasn't sent\. .*a one-shot startup action already ran and must not run twice/)]);
      expect(orchestrator.pendingStartupContext(seed.nodeId, seed.sessionId)).toBeNull();
      expect(isRecoverableStartupFailure(db, seed.nodeId, seed.sessionId)).toBe(false);
    });

    it("keeps a resumed conversation and never tells it to relaunch blank", async () => {
      const seed = seedSession();
      const { typed, orchestrator, adapter } = harness((t) => t.length > 0 ? LOGIN : { ready: true });
      const result = await orchestrator.startNode(makeInput(seed, { adapter, isRestore: true, resumeToken: "existing-token",
        resolvedStartupFiles: files.slice(0, 2) }));

      expect(sent(typed)).toEqual(["role.md"]);
      expect(result).toMatchObject({ ok: false, startupStatus: "attention_required" });
      expect(errorsOf(result)).toEqual([LOGIN.reason,
        "1 later startup input wasn't sent. The seat's conversation is kept, but it hasn't read that input; continuing isn't offered for a resumed start."]);
      expect(errorsOf(result).join("\n")).not.toContain("--fresh");
      expect(orchestrator.pendingStartupContext(seed.nodeId, seed.sessionId)).toBeNull();
      expect(isRecoverableStartupFailure(db, seed.nodeId, seed.sessionId)).toBe(false);
    });

    it("keeps the hold when a later file can't be read, listing that error beside it", async () => {
      const seed = seedSession();
      const withUnreadable = [files[0]!, files[1]!, { ...files[2]!, path: "unreadable.md", absolutePath: "/fixture/unreadable.md" }];
      const { typed, orchestrator, adapter } = harness((t) => t.length > 0 ? LOGIN : { ready: true });
      const result = await orchestrator.startNode(makeInput(seed, { adapter, resolvedStartupFiles: withUnreadable, startupActions: [makeIdentityAction()] }));

      expect(sent(typed)).toEqual(["role.md"]);
      expect(result).toMatchObject({ ok: false, startupStatus: "attention_required" });
      expect(errorsOf(result)).toEqual([LOGIN.reason, "Post-launch file delivery failed: unreadable.md: EACCES: permission denied",
        `1 later startup input wasn't sent. ${CONTINUE}`, "After resolving it in r01-impl, run: rig seat continue 'r01-impl'"]);
      expect(orchestrator.pendingStartupContext(seed.nodeId, seed.sessionId)).toMatchObject({ mode: "fresh" });
    });

    it("holds a refused only turn too, and continuing delivers it after sign-in", async () => {
      const seed = seedSession();
      let loggedIn = false;
      const { typed, orchestrator, adapter } = harness((t) => t.length > 0 && !loggedIn ? LOGIN : { ready: true });
      const failed = await orchestrator.startNode(makeInput(seed, { adapter, startupActions: [makeIdentityAction()] }));

      expect(typed).toHaveLength(1);
      expect(failed).toMatchObject({ ok: false, startupStatus: "attention_required" });
      expect(errorsOf(failed)).toEqual([LOGIN.reason, CONTINUE, "After resolving it in r01-impl, run: rig seat continue 'r01-impl'"]);
      expect(orchestrator.pendingStartupContext(seed.nodeId, seed.sessionId)).toMatchObject({ mode: "fresh" });

      loggedIn = true;
      typed.length = 0;
      const continued = await orchestrator.startNode(makeInput(seed, { adapter, startupActions: [makeIdentityAction()],
        skipHarnessLaunch: true, continueFreshStartup: true }));
      expect(continued).toMatchObject({ ok: true, startupStatus: "ready" });
      expect(typed).toHaveLength(1);
      expect(typed[0]).toContain("OpenRig session identity:");
    });

    it.each([
      ["ready", (): ReadinessResult => ({ ready: true })],
      ["not ready with no attention code", (): ReadinessResult => ({ ready: false, code: "awaiting_runtime", reason: "still drawing" })],
      ["unreadable", (): ReadinessResult => { throw new Error("capture failed"); }],
    ])("sends everything as before when the read between sends is %s", async (_label, between) => {
      const seed = seedSession();
      const { typed, orchestrator, adapter } = harness((t) => t.length > 0 ? between() : { ready: true });
      const result = await orchestrator.startNode(makeInput(seed, { adapter, resolvedStartupFiles: files, startupActions: [makeIdentityAction()] }));
      expect(result).toMatchObject({ ok: true, startupStatus: "ready" });
      expect(sent(typed)).toEqual(["role.md", "a.md", "b.md"]);
      expect(orchestrator.pendingStartupContext(seed.nodeId, seed.sessionId)).toBeNull();
    });
  });

  it("records the exact adapter-returned launch effect only after successful managed launch", async () => {
    const seed = seedSession();
    const appliedLaunch = observeClaudePermission("--permission-mode acceptEdits");
    const adapter = mockAdapter({ launchHarness: vi.fn(async () => ({ ok: true, appliedLaunch })) });
    const result = await createOrchestrator().startNode(makeInput(seed, { adapter }));
    expect(result.ok).toBe(true);
    expect(new AppliedLaunchObservationStore(db).readCurrent(seed.nodeId)).toMatchObject(appliedLaunch);
  });

  it("binds a delayed launch observation to the generation that actually launched", async () => {
    const seed = seedSession();
    const launchedGeneration = sessionRegistry.currentOccupantTenure(seed.nodeId)!.generationUuid;
    let releaseLaunch!: () => void;
    const launchGate = new Promise<void>((resolve) => { releaseLaunch = resolve; });
    const adapter = mockAdapter({
      launchHarness: vi.fn(async () => {
        await launchGate;
        return { ok: true as const, appliedLaunch: observeClaudePermission("--permission-mode acceptEdits") };
      }),
    });

    const pending = createOrchestrator().startNode(makeInput(seed, { adapter }));
    await vi.waitFor(() => expect(adapter.launchHarness).toHaveBeenCalledTimes(1));
    sessionRegistry.mintOccupantTenure(seed.nodeId, "handover");
    releaseLaunch();
    expect((await pending).ok).toBe(true);

    expect(new AppliedLaunchObservationStore(db).readCurrent(seed.nodeId)).toBeNull();
    expect(db.prepare("SELECT generation_uuid FROM applied_launch_observations").get()).toEqual({
      generation_uuid: launchedGeneration,
    });
  });

  it("never resurrects an invalidated generation when delayed readiness completes", async () => {
    const seed = seedSession();
    const generation = sessionRegistry.currentOccupantTenure(seed.nodeId)!.generationUuid;
    let releaseReady!: () => void;
    const readyGate = new Promise<void>((resolve) => { releaseReady = resolve; });
    const adapter = mockAdapter({
      launchHarness: vi.fn(async () => ({ ok: true as const, appliedLaunch: observeClaudePermission("--permission-mode acceptEdits") })),
      checkReady: vi.fn(async () => {
        await readyGate;
        return { ready: true as const };
      }),
    });

    const pending = createOrchestrator().startNode(makeInput(seed, { adapter }));
    await vi.waitFor(() => expect(adapter.checkReady).toHaveBeenCalledTimes(1));
    expect(new AppliedLaunchObservationStore(db).invalidateGeneration(generation)).toBe(true);
    releaseReady();
    expect((await pending).ok).toBe(true);

    expect(new AppliedLaunchObservationStore(db).readCurrent(seed.nodeId)).toBeNull();
    expect(db.prepare("SELECT COUNT(*) AS n FROM applied_launch_observations WHERE generation_uuid = ?").get(generation)).toEqual({ n: 0 });
  });

  it("does not record an attempted effect when the managed launch fails", async () => {
    const seed = seedSession();
    const adapter = mockAdapter({ launchHarness: vi.fn(async () => ({ ok: false, error: "provider refused" })) });
    const result = await createOrchestrator().startNode(makeInput(seed, { adapter }));
    expect(result.ok).toBe(false);
    expect(new AppliedLaunchObservationStore(db).readCurrent(seed.nodeId)).toBeNull();
  });

  it("keeps a successful provider launch successful when observation persistence is unavailable", async () => {
    const seed = seedSession();
    db.exec("DROP TABLE applied_launch_observations");
    const adapter = mockAdapter({
      launchHarness: vi.fn(async () => ({ ok: true, appliedLaunch: observeClaudePermission("--permission-mode acceptEdits") })),
    });
    const result = await createOrchestrator().startNode(makeInput(seed, { adapter }));
    expect(result.ok).toBe(true);
    expect(result.startupStatus).toBe("ready");
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

  // Slice 51-01 stub-runtime — TEST-ONLY RED (undisputed mechanical FACT 3): the REAL StubRuntimeAdapter,
  // driven through the REAL StartupOrchestrator, must ride the ordered sequence project → pre-launch
  // deliver → launchHarness → checkReady → post-launch deliver and reach `ready`. Dynamic import keeps
  // this file's other tests green; RED now because the adapter module is absent. Fully executable after
  // the import: a BARE `StubRuntimeAdapter` export fails (methods absent/wrong ⇒ startNode never reaches
  // ready and deliver is not invoked twice). A send_text-hinted file forces the post-launch phase.
  // Requires the stub's hermetic testability (a determinism/hermetic design property of the shape).
  // Encodes NO disputed hook/usage_limit/compaction/packaging surface. Construction deps are
  // provisional-to-design, finalized when the adapter ships (post fresh Guard CLEAR).
  it("FACT3: real stub adapter rides ordered project→pre-deliver→launch→ready→post-deliver to ready", async () => {
    const { StubRuntimeAdapter } = await import("../src/adapters/stub-runtime-adapter.js") as { StubRuntimeAdapter: new (deps: unknown) => RuntimeAdapter }; // RED now: module absent
    const seed = seedSession();
    const t = mockTmux();
    const adapter = new StubRuntimeAdapter({ tmux: t, runtime: "stub" });
    const projectSpy = vi.spyOn(adapter, "project");
    const deliverSpy = vi.spyOn(adapter, "deliverStartup");
    const launchSpy = vi.spyOn(adapter, "launchHarness");
    const readySpy = vi.spyOn(adapter, "checkReady");
    const files = [
      { path: "priming.txt", absolutePath: "/tmp/priming.txt", ownerRoot: "/tmp", deliveryHint: "send_text" as const, required: false, appliesOn: ["fresh_start" as const] },
    ];
    const result = await createOrchestrator({ tmux: t }).startNode(makeInput(seed, { adapter, resolvedStartupFiles: files }));
    expect(result.startupStatus, "the real stub must reach ready through the real orchestrator").toBe("ready");
    expect(deliverSpy, "deliverStartup must run on BOTH sides of launch").toHaveBeenCalledTimes(2);
    const pIdx = projectSpy.mock.invocationCallOrder[0]!;
    const preDeliver = deliverSpy.mock.invocationCallOrder[0]!;
    const lIdx = launchSpy.mock.invocationCallOrder[0]!;
    const rIdx = readySpy.mock.invocationCallOrder[0]!;
    const postDeliver = deliverSpy.mock.invocationCallOrder[1]!;
    expect(pIdx).toBeLessThan(preDeliver);
    expect(preDeliver).toBeLessThan(lIdx);
    expect(lIdx).toBeLessThan(rIdx);
    expect(rIdx).toBeLessThan(postDeliver);
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
    // Neither an inapplicable action nor an unselected proof is sent.
    const calls = (tmux.sendText as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1]);
    expect(calls).toEqual([]);
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
    expect(tmux.sendKeys).toHaveBeenCalledWith("r01-impl", ["Enter"]);
  });

  it("does not persist passed-at-launch after a confirmed pre-input failure", async () => {
    const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "first-input-stage-"));
    try {
      nodeFs.writeFileSync(nodePath.join(dir, "synth.yaml"),
        `format: 1\nname: synth\nmaintainer: Example\nfirst_input: true\ncommand: /bin/true ${"x".repeat(600)}\n`);
      const exec = vi.fn(async () => "");
      const transport = new TmuxAdapter(exec, { tmpName: () => "/fixture/stage.txt", bufferName: () => "fixture",
        writeFile: async () => { throw Object.assign(new Error("fixture write denied"), { code: "EACCES" }); }, unlink: async () => {} });
      const adapter = new CommunityHarnessRuntimeAdapter("synth", { tmux: transport, presetsDir: () => dir,
        launchResultRoot: () => nodePath.join(dir, "state", "launch-results") });
      const seed = seedSession();
      const result = await createOrchestrator().startNode(makeInput(seed, { adapter, startupActions: [makeIdentityAction()] }));
      expect(result.ok).toBe(false);
      expect(exec).not.toHaveBeenCalled();
      expect(db.prepare("SELECT payload FROM events WHERE node_id=? AND type='node.startup_first_input_passed'").all(seed.nodeId)).toHaveLength(0);
      expect(JSON.stringify(result)).not.toContain("passed at launch");
    } finally { nodeFs.rmSync(dir, { recursive: true, force: true }); }
  });

  it.each([[false, false, false], [true, false, false], [true, true, false], [true, false, true]])("passes the composed first input at launch (%s), assistance (%s), uncertain launch (%s)", async (firstInput, assisted, uncertain) => {
    const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "first-input-"));
    try {
      nodeFs.writeFileSync(nodePath.join(dir, "synth.yaml"),
        `format: 1\nname: synth\ncommand: synth\nmaintainer: Example\nnames_conversation: true\n${firstInput ? "first_input: true\n" : ""}startup_assisted: ${assisted}\n`);
      const seed = seedSession();
      db.prepare("UPDATE nodes SET runtime='synth' WHERE id=?").run(seed.nodeId);
      let path: string | undefined;
      let content: string | undefined;
      const shell = vi.fn(async (_session: string, command: string, beforeInput?: () => void) => {
        beforeInput?.();
        path = /OPENRIG_FIRST_INPUT='([^']+)'/.exec(command)?.[1];
        if (path) {
          content = nodeFs.readFileSync(path, "utf8");
          expect(nodeFs.statSync(path).mode & 0o777).toBe(0o600);
          expect(command).not.toContain("first role");
        }
        if (uncertain) throw new Error("fixture uncertain launch");
        return { ok: true as const };
      });
      const adapter = new CommunityHarnessRuntimeAdapter("synth", { presetsDir: () => dir,
        launchResultRoot: () => nodePath.join(dir, "state", "launch-results"),
        tmux: { hasSession: async () => true, getPaneCommand: async () => "node", sendShellCommand: shell } });
      const delivery = vi.spyOn(adapter, "deliverStartup");
      const files: ResolvedStartupFile[] = ["first", "second"].map(name => ({ path: `${name}.md`, absolutePath: `/${name}.md`,
        ownerRoot: "/", deliveryHint: "send_text", required: true, appliesOn: ["fresh_start"] }));
      const orchestrator = createOrchestrator({ readFile: path => path === "/first.md" ? "first role\n'quoted' $literal\n" : "second role" });
      const result = await orchestrator.startNode(makeInput(seed, { adapter, includeDurableObligations: true, resolvedStartupFiles: files,
          startupActions: [makeAction({ type: "startup_proof", value: "authenticated" }), makeIdentityAction(), makeAction({ value: "later action" })] }));
      expect(result.ok).toBe(!assisted && !uncertain);
      if (firstInput && (assisted || uncertain)) expect(orchestrator.canContinueStartup(seed.nodeId, seed.sessionId)).toBe(false);
      const typed = vi.mocked(tmux.sendText).mock.calls.map(call => call[1]);
      const first = firstInput ? content : typed[0];
      expect(first).toContain("OpenRig-generated identity context");
      expect(first).toContain("first role\n'quoted' $literal\n");
      expect(first).toContain("read durable obligations with rig queue list");
      expect(first).toContain("startup orientation challenge");
      expect(typed).toHaveLength(uncertain ? 0 : firstInput ? 1 : 2);
      if (!uncertain) {
        expect(typed.at(-1)).toBe("later action");
        expect(delivery.mock.calls.flatMap(([files]) => files.map(file => file.path))).toEqual(["second.md"]);
      }
      const records = db.prepare("SELECT payload FROM events WHERE node_id=? AND type='node.startup_first_input_passed'").all(seed.nodeId) as { payload: string }[];
      expect(records).toHaveLength(firstInput ? 1 : 0);
      if (firstInput) expect(JSON.parse(records[0]!.payload)).toMatchObject({ path, submission: "unconfirmed" });
      else expect(path).toBeUndefined();
    } finally { nodeFs.rmSync(dir, { recursive: true, force: true }); }
  });

  it.each([
    [true, true, "attention_required", false],
    [false, true, "ready", false],
    [true, false, "ready", false],
    [true, true, "attention_required", true],
  ] as const)("reports declared startup assistance (%s), after sending context (%s), status (%s), full restore (%s)", async (assisted, sendContext, status, fullRestore) => {
    const dir = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "assisted-startup-"));
    try {
      nodeFs.writeFileSync(nodePath.join(dir, "synth.yaml"),
        `format: 1\nname: synth\ncommand: synth\nmaintainer: Example\nstartup_assisted: ${assisted}\n`);
      const seed = seedSession();
      db.prepare("UPDATE nodes SET runtime='synth' WHERE id=?").run(seed.nodeId);
      const started = fullRestore ? eventBus.emit({ type: "restore.started", rigId: seed.rigId, snapshotId: "snapshot" }) : null;
      if (fullRestore) vi.mocked(tmux.sendText).mockImplementation(async () => {
        nodeFs.unlinkSync(nodePath.join(dir, "synth.yaml")); // A mid-start preset edit doesn't change this launch's declaration.
        return { ok: true };
      });
      const adapter = new CommunityHarnessRuntimeAdapter("synth", { presetsDir: () => dir,
        tmux: { hasSession: async () => true, getPaneCommand: async () => "node", sendShellCommand: vi.fn() } });
      const input = makeInput(seed, { adapter, skipHarnessLaunch: true,
        startupActions: sendContext ? [makeIdentityAction()] : [] });
      const orch = createOrchestrator();
      const result = await orch.startNode(input);
      expect(result.startupStatus).toBe(status);
      expect(db.prepare("SELECT status, startup_status FROM sessions WHERE id=?").get(seed.sessionId))
        .toEqual({ status: "running", startup_status: status });
      expect(tmux.killSession).not.toHaveBeenCalled();
      expect(tmux.sendText).toHaveBeenCalledTimes(sendContext ? 1 : 0);
      expect(tmux.sendKeys).toHaveBeenCalledTimes(sendContext ? 1 : 0);
      if (sendContext) expect(tmux.sendKeys).toHaveBeenCalledWith("r01-impl", ["Enter"]);
      if (status === "attention_required") {
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.errors.join(" ")).toContain("Startup assisted");
        expect(orch.canContinueStartup(seed.nodeId, seed.sessionId)).toBe(false); // Don't paste uncertain context again.
        expect(db.prepare("SELECT seq FROM events WHERE node_id=? AND type='node.startup_ready'").all(seed.nodeId)).toEqual([]);
      }
      if (fullRestore) {
        eventBus.emit({ type: "restore.completed", rigId: seed.rigId, snapshotId: "snapshot", result: {
          snapshotId: "snapshot", preRestoreSnapshotId: null, rigResult: "partially_restored",
          nodes: [{ nodeId: seed.nodeId, logicalId: "impl", status: "attention_required" }], warnings: [],
        } });
        const completed = db.prepare("SELECT payload FROM events WHERE type='restore.completed'").get();
        const strict = vi.fn(async () => ({ ok: false as const, code: "runtime_unsupported", detail: "Native lineage proof isn't supported for synth." }));
        const reconciler = new SeatAttentionReconciler({ db, sessionRegistry, eventBus,
          agentActivityStore: new AgentActivityStore({ db, eventBus }), reconcileRestoreOutcome: strict });
        expect(await reconciler.clearAttention("r01-impl")).toMatchObject({ ok: false });
        expect(strict).toHaveBeenCalledTimes(1);
        strict.mockClear();
        expect(await reconciler.clearAttention("r01-impl", { reason: "Checked startup; seat responded" }))
          .toMatchObject({ ok: true, clearedBy: "operator_attestation", clearedClasses: ["startup_status", "restore_outcome"] });
        expect(strict).not.toHaveBeenCalled();
        expect(getNodeInventory(db, seed.rigId)[0]).toMatchObject({ startupStatus: "ready", restoreOutcome: "operator_recovered" });
        const event = db.prepare("SELECT payload FROM events WHERE type='restore.outcome_reconciled'").get() as { payload: string };
        expect(JSON.parse(event.payload)).toMatchObject({ attemptId: started!.seq, evidence: { source: "operator_attestation", runtimeCwdVerified: false } });
        expect(db.prepare("SELECT payload FROM events WHERE type='restore.completed'").get()).toEqual(completed);
        expect(tmux.sendText).toHaveBeenCalledTimes(1);
      }
    } finally { nodeFs.rmSync(dir, { recursive: true, force: true }); }
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

  it("Claude's resume chooser or picker becomes attention_required without waiting out the timeout or typing", async () => {
    const seed = seedSession();
    const adapter = mockAdapter({
      checkReady: vi.fn(async () => ({
        ready: false,
        code: "claude_resume_selection_prompt",
        reason: "Claude is at a resume-selection prompt; an operator must choose the conversation to continue.",
      })),
    });
    const orch = createOrchestrator();
    const result = await orch.startNode(makeInput(seed, { adapter, readinessTimeoutMs: 1500 }));

    expect(result.ok).toBe(false);
    expect(result.startupStatus).toBe("attention_required");
    expect(adapter.checkReady).toHaveBeenCalledTimes(1);
    expect(tmux.sendText).not.toHaveBeenCalled();
  });

  it("Claude MCP approval blockers become attention_required", async () => {
    const seed = seedSession();
    const adapter = mockAdapter({
      checkReady: vi.fn(async () => ({
        ready: false,
        code: "mcp_gate",
        reason: "Claude is waiting for project MCP server approval before the session can become interactive.",
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
    expect(firstPrompt).toContain("OpenRig-generated identity context (not a project task):");
    expect(firstPrompt).not.toContain("readiness for an assignment");
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

  // OPR.0.4.7.17 restore-order-correction (qitem-e99624f7). On a real automatic
  // Codex restore the daemon delivered the work-triggering guidance/role.md FIRST
  // (its turn ran skill-metadata checks + `rig whoami`), and the after_ready
  // "BEFORE you do anything else" preload action landed only afterwards — so
  // non-skill work preceded the action, breaking the locked action-before-work
  // contract. The fix must be CAUSAL (sequence the preload ahead of the
  // role-triggered turn), not a larger send delay. This pin asserts the contract
  // shape-agnostically: across the ordered provider inputs (send_text sends AND
  // post-launch send_text file deliveries), the preload text is delivered no
  // later than the role.md work-trigger content, and when bundled into one input
  // the preload text precedes the role content.
  it("restore: the after_ready preload action is sequenced before the role.md work-trigger", async () => {
    const seed = seedSession();
    const ROLE = "# Role: QA\nload your named skills: using-superpowers, test-driven-development";
    const PRELOAD = "A task is coming. BEFORE you do anything else, load and invoke your process skills NOW: using-superpowers, test-driven-development. Load them first, then begin the work.";

    // Unified ordered list of provider inputs (what actually reaches the pane).
    const inputs: string[] = [];
    const deliverStartup = vi.fn(async (files: ResolvedStartupFile[]) => {
      for (const f of files) {
        if (f.deliveryHint === "send_text") inputs.push(f.absolutePath === "/tmp/role.md" ? ROLE : "");
      }
      return { delivered: 0, failed: [] };
    });
    const adapter = mockAdapter({ deliverStartup });
    const sendText = vi.fn(async (_session: string, text: string) => { inputs.push(text); return { ok: true as const }; });
    const tmuxOverride = mockTmux({ sendText });
    const orch = createOrchestrator({
      tmux: tmuxOverride,
      readFile: (path) => path === "/tmp/role.md" ? ROLE : "",
    });

    const result = await orch.startNode(makeInput(seed, {
      adapter,
      resolvedStartupFiles: [{
        path: "guidance/role.md",
        absolutePath: "/tmp/role.md",
        ownerRoot: "/tmp",
        deliveryHint: "send_text",
        required: true,
        appliesOn: ["fresh_start", "restore"],
      }],
      startupActions: [
        makeAction({ type: "send_text", value: PRELOAD, phase: "after_ready", appliesOn: ["fresh_start", "restore"], idempotent: true }),
      ],
      isRestore: true,
      resumeToken: "codex-session-abc",
    }));

    expect(result.ok).toBe(true);

    const preloadIdx = inputs.findIndex((t) => t.includes("BEFORE you do anything else"));
    const roleIdx = inputs.findIndex((t) => t.includes("# Role: QA"));
    expect(preloadIdx).toBeGreaterThanOrEqual(0); // the preload action reached the provider
    expect(roleIdx).toBeGreaterThanOrEqual(0);    // the role.md work-trigger reached the provider

    // CONTRACT: the preload must not land after the role.md work-trigger.
    expect(preloadIdx).toBeLessThanOrEqual(roleIdx);
    // If bundled into a single input, the preload text must precede the role content.
    if (preloadIdx === roleIdx) {
      const payload = inputs[preloadIdx]!;
      expect(payload.indexOf("BEFORE you do anything else")).toBeLessThan(payload.indexOf("# Role: QA"));
    }
    // And the preload must not be re-sent as a duplicate separate turn.
    const preloadDeliveries = inputs.filter((t) => t.includes("BEFORE you do anything else")).length;
    expect(preloadDeliveries).toBe(1);
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
    expect(sendText.mock.calls[0]?.[1]).not.toContain("readiness for an assignment");
    expect(sendText).toHaveBeenNthCalledWith(2, "r01-impl", "/rename impl");
  });

  it("issues a selected startup challenge (oriented=missing, challenge in prompt)", async () => {
    const seed = seedSession();
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const orch = createOrchestrator({ tmux: mockTmux({ sendText }) });

    await orch.startNode(makeInput(seed, {
      resolvedStartupFiles: [{ path: "role.md", absolutePath: "/tmp/role.md", ownerRoot: "/tmp", deliveryHint: "guidance_merge", required: true, appliesOn: ["fresh_start"] }],
      startupActions: [makeAction({ type: "startup_proof", value: "authenticated" }), makeIdentityAction()],
    }));

    const challenged = db.prepare("SELECT COUNT(*) AS n FROM events WHERE node_id = ? AND type = 'node.startup_challenged'").get(seed.nodeId) as { n: number };
    expect(challenged.n).toBe(1);
    expect(deriveOriented(db, seed.nodeId)).toBe("missing");
    // The challenge instruction is embedded in the first delivered prompt.
    expect(sendText.mock.calls[0]?.[1]).toContain("startup orientation challenge");
    expect(sendText.mock.calls[0]?.[1]).not.toContain("readiness for an assignment");
  });

  // Claude shows the long startup paste as pasted content and won't act on an instruction found only
  // there; one short line in the person's turn asks it to run the challenge's own command.
  describe("the Claude startup-proof line", () => {
    const challengeAndIdentity = () => [makeAction({ type: "startup_proof", value: "authenticated" }), makeIdentityAction()];

    it("follows a Claude seat's challenged prompt with the short line, as its own submission", async () => {
      const seed = seedSession();
      const sendText = vi.fn(async (_session: string, _text: string) => ({ ok: true as const }));
      const result = await createOrchestrator({ tmux: mockTmux({ sendText }) }).startNode(makeInput(seed, { startupActions: challengeAndIdentity() }));
      expect(result).toMatchObject({ ok: true, startupStatus: "ready" });
      expect(sendText.mock.calls.map((c) => c[1])).toHaveLength(2);
      expect(sendText.mock.calls[0]![1]).toContain("startup orientation challenge");
      expect(sendText.mock.calls[1]![1]).toBe(STARTUP_PROOF_INSTRUCTION_LINE);
      expect(deriveOriented(db, seed.nodeId)).toBe("missing");
    });

    it("sends no line to a Codex seat, which already acts on the pasted challenge", async () => {
      const seed = seedSession();
      const sendText = vi.fn(async (_session: string, _text: string) => ({ ok: true as const }));
      await createOrchestrator({ tmux: mockTmux({ sendText }) }).startNode(makeInput(seed, {
        adapter: mockAdapter({ runtime: "codex" }), startupActions: challengeAndIdentity(),
      }));
      expect(sendText.mock.calls.map((c) => c[1])).not.toContain(STARTUP_PROOF_INSTRUCTION_LINE);
    });

    it("sends no line when no challenge was issued", async () => {
      const seed = seedSession();
      const sendText = vi.fn(async (_session: string, _text: string) => ({ ok: true as const }));
      await createOrchestrator({ tmux: mockTmux({ sendText }) }).startNode(makeInput(seed, { startupActions: [makeIdentityAction()] }));
      expect(sendText.mock.calls.map((c) => c[1])).not.toContain(STARTUP_PROOF_INSTRUCTION_LINE);
    });

    it("a line that fails to send is a submission warning; the seat is still ready", async () => {
      const seed = seedSession();
      const sendText = vi.fn(async (_session: string, text: string) => text === STARTUP_PROOF_INSTRUCTION_LINE
        ? { ok: false as const, message: "fixture send failure" }
        : { ok: true as const });
      const result = await createOrchestrator({ tmux: mockTmux({ sendText } as unknown as Partial<TmuxAdapter>) }).startNode(makeInput(seed, { startupActions: challengeAndIdentity() }));
      expect(result).toMatchObject({ ok: true, startupStatus: "ready" });
      expect(result.ok && result.submission?.reasons).toContain("Startup proof instruction was not delivered: fixture send failure");
    });
  });

  // OPR.0.4.3.06 — a resumed restore is NOT re-challenged (oriented stays n-a).
  it("runs a terminal startup command without sending agent-orientation prose to its shell", async () => {
    const seed = seedSession();
    const sendText = vi.fn(async () => ({ ok: true as const }));
    const orch = createOrchestrator({ tmux: mockTmux({ sendText }) });
    await orch.startNode(makeInput(seed, {
      adapter: mockAdapter({ runtime: "terminal" }),
      startupActions: [makeAction({ type: "startup_proof", value: "authenticated" }), makeAction({ type: "send_text", value: "rig tui" })],
    }));
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith("r01-impl", "rig tui");
    expect(deriveOriented(db, seed.nodeId)).toBe("n-a");
  });

  it("does NOT challenge a resumed restore (oriented=n-a)", async () => {
    const seed = seedSession();
    const orch = createOrchestrator();
    await orch.startNode(makeInput(seed, {
      startupActions: [makeAction({ type: "startup_proof", value: "authenticated" }), makeIdentityAction()],
      isRestore: true,
      resumeToken: "claude-session-123",
    }));
    const challenged = db.prepare("SELECT COUNT(*) AS n FROM events WHERE node_id = ? AND type = 'node.startup_challenged'").get(seed.nodeId) as { n: number };
    expect(challenged.n).toBe(0);
    expect(deriveOriented(db, seed.nodeId)).toBe("n-a");
  });

  it.each([false, true])("identity-only startup asks for readiness with guidance files=%s and adds no proof exercise", async (withFiles) => {
    const seed = seedSession();
    const adapter = mockAdapter();
    const result = await createOrchestrator().startNode(makeInput(seed, {
      adapter,
      startupActions: [makeIdentityAction()],
      resolvedStartupFiles: withFiles ? [{ path: "role.md", absolutePath: "/tmp/role.md", ownerRoot: "/tmp", deliveryHint: "guidance_merge", required: true, appliesOn: ["fresh_start"] }] : [],
    }));
    expect(result).toMatchObject({ ok: true, startupStatus: "ready" });
    expect(adapter.project).toHaveBeenCalledOnce();
    expect(adapter.checkReady).toHaveBeenCalledTimes(2);
    expect(tmux.sendText).toHaveBeenCalledExactlyOnceWith("r01-impl", expect.stringContaining(makeIdentityAction().value));
    const prompt = vi.mocked(tmux.sendText).mock.calls[0]?.[1];
    expect(prompt).toContain("OpenRig-generated identity context (not a project task):");
    expect(prompt).toContain("run rig whoami --json and reply with your identity and readiness for an assignment");
    expect(deriveOriented(db, seed.nodeId)).toBe("n-a");
    const row = db.prepare("SELECT payload FROM events WHERE type='node.startup_pending'").get() as { payload: string };
    expect(JSON.parse(row.payload).startupProof).toEqual({ mode: "none", source: "default" });
  });

  function seedVerifiedProof() {
    const seed = seedSession();
    const store = new AgentActivityStore({ db, eventBus });
    const challenge = issueStartupChallenge(eventBus, { ...seed, contractSource: "prior occupant" });
    const submit = () => verifyStartupProof({ store, eventBus }, {
      nodeId: seed.nodeId, challengeId: challenge.challengeId, answer: challenge.expectedAnswer,
    });
    expect(submit().ok).toBe(true);
    expect(deriveOriented(db, seed.nodeId)).toBe("verified");
    return { seed, submit };
  }

  describe.each(["fresh", "fresh-fallback"] as const)("%s lean proof boundary", (mode) => {
    const launchInput = mode === "fresh-fallback"
      ? { isRestore: true, resumeToken: "stale-token", allowFreshFallback: true }
      : {};
    function launchAdapter() {
      const launch = vi.fn<RuntimeAdapter["launchHarness"]>().mockResolvedValue({ ok: true });
      if (mode === "fresh-fallback") {
        launch.mockResolvedValueOnce({ ok: false, recovery: "retry_fresh", error: "stale resume" });
      }
      return launch;
    }

    it.each(["ready", "attention", "timeout", "throws"] as const)("retires verified proof before readiness %s", async (readiness) => {
      const { seed, submit } = seedVerifiedProof();
      const observedAtReadiness: string[] = [];
      const adapter = mockAdapter({
        launchHarness: launchAdapter(),
        checkReady: vi.fn(async () => {
          observedAtReadiness.push(deriveOriented(db, seed.nodeId));
          if (readiness === "throws") throw new Error("fixture readiness error");
          if (readiness === "attention") return { ready: false, code: "login_required", reason: "fixture login" };
          return { ready: readiness === "ready", reason: "fixture timeout" };
        }),
      });
      const result = await createOrchestrator().startNode(makeInput(seed, {
        ...launchInput, adapter, readinessTimeoutMs: 0,
        startupActions: [makeAction({ type: "startup_proof", value: "none" })],
      }));
      expect(result.startupStatus).toBe(readiness === "ready" ? "ready" : readiness === "attention" ? "attention_required" : "failed");
      expect(adapter.launchHarness).toHaveBeenCalledTimes(mode === "fresh-fallback" ? 2 : 1);
      expect(observedAtReadiness.length).toBeGreaterThan(0);
      expect(observedAtReadiness.every(value => value === "n-a")).toBe(true);
      expect(deriveOriented(db, seed.nodeId)).toBe("n-a");
      expect(submit()).toMatchObject({ ok: false, code: "challenge_stale" });
      expect(db.prepare("SELECT count(*) AS n FROM events WHERE type='node.startup_proof_skipped'").get()).toEqual({ n: 1 });
      expect(db.prepare("SELECT count(*) AS n FROM events WHERE type='node.startup_proof_verified'").get()).toEqual({ n: 1 });
    });

    it.each(["failed", "throws"] as const)("preserves verified proof when replacement launch %s", async (failure) => {
      const { seed, submit } = seedVerifiedProof();
      const launch = launchAdapter();
      if (failure === "throws") launch.mockRejectedValue(new Error("fixture launch error"));
      else launch.mockResolvedValue({ ok: false, error: "fixture launch failed" });
      const adapter = mockAdapter({ launchHarness: launch });
      const result = await createOrchestrator().startNode(makeInput(seed, { ...launchInput, adapter }));
      expect(result.startupStatus).toBe("failed");
      expect(launch).toHaveBeenCalledTimes(mode === "fresh-fallback" ? 2 : 1);
      expect(adapter.checkReady).not.toHaveBeenCalled();
      expect(deriveOriented(db, seed.nodeId)).toBe("verified");
      expect(submit().ok).toBe(true);
      expect(db.prepare("SELECT count(*) AS n FROM events WHERE type='node.startup_proof_skipped'").get()).toEqual({ n: 0 });
    });
  });

  it.each(["resume", "adopt"] as const)("preserves verified proof when %s needs readiness attention", async (mode) => {
    const { seed, submit } = seedVerifiedProof();
    const adapter = mockAdapter({ checkReady: vi.fn(async () => ({ ready: false, code: "login_required" })) });
    const result = await createOrchestrator().startNode(makeInput(seed, {
      adapter, isRestore: true,
      ...(mode === "resume" ? { resumeToken: "existing-token" } : { skipHarnessLaunch: true }),
      startupActions: [makeAction({ type: "startup_proof", value: "none" })],
    }));
    expect(result.startupStatus).toBe("attention_required");
    expect(deriveOriented(db, seed.nodeId)).toBe("verified");
    expect(submit().ok).toBe(true);
    expect(db.prepare("SELECT count(*) AS n FROM events WHERE type='node.startup_proof_skipped'").get()).toEqual({ n: 0 });
  });

  it("rejects unknown persisted proof selection before projection or launch", async () => {
    const seed = seedSession();
    const adapter = mockAdapter();
    const result = await createOrchestrator().startNode(makeInput(seed, {
      adapter, startupActions: [makeAction({ type: "startup_proof", value: "quiz" })],
    }));
    expect(result).toMatchObject({ ok: false, startupStatus: "failed" });
    expect(adapter.project).not.toHaveBeenCalled();
    expect(adapter.launchHarness).not.toHaveBeenCalled();
    expect(tmux.sendText).not.toHaveBeenCalled();
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
    // Ready on both attempts. Readiness is also read between startup sends (a refused turn holds the rest).
    const failAdapter = mockAdapter({ checkReady: vi.fn(async () => ({ ready: true })) });
    // OPR.0.4.3.06 — text-aware mock (robust to the extra orientation-challenge
    // send on fresh continuity): everything succeeds except the FIRST /configure
    // (attempt 1's second action), which fails as before.
    let configureSeen = 0;
    const failTmux = mockTmux({
      sendText: vi.fn(async (_target: string, text: string) => {
        if (text === "/configure") {
          configureSeen++;
          if (configureSeen === 1) return { ok: false as const, message: "second action fails" };
        }
        return { ok: true as const };
      }),
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

  it.each(["available", "error", "timeout"] as const)("persists the real Claude launch probe on startup_failed with geometry=%s (#1480)", async geometry => {
    const missingGeometry = geometry !== "available";
    const seed = seedSession();
    const content = "❯ fixture-private-startup-prompt\n● Login expired · Please run /login\n\n❯";
    const tmux = mockTmux({
      getPaneCommand: vi.fn(async () => "claude"),
      capturePaneContent: vi.fn(async () => content),
      listPanes: vi.fn(async () => {
        if (geometry === "timeout") return new Promise<never>(() => {});
        if (geometry === "error") throw new Error("fixture-private-geometry-error");
        return [{ id: "%1", index: 0, cwd: "/project", width: 100, height: 30, active: true }];
      }),
    });
    const adapter = new ClaudeCodeAdapter({ tmux, sleep: async () => {}, fsOps: {
      readFile: () => { throw new Error("fixture file missing"); },
      writeFile: () => {}, exists: () => false, mkdirp: () => {}, copyFile: () => {}, listFiles: () => [],
    } });
    const result = await createOrchestrator(tmux).startNode(makeInput(seed, {
      adapter, binding: { ...makeBinding(), cwd: "/project" },
      isRestore: true, resumeToken: "saved-conversation", resumeType: "claude_id", allowFreshFallback: false,
    }));
    const probe = {
      status: "failed", code: "login_required", loginRefusal: { message: "Login expired · Please run /login", row: "response" },
      capture: { lines: 4, bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex"), columns: missingGeometry ? null : 100, rows: missingGeometry ? null : 30 },
    };
    expect(result).toMatchObject({ ok: false, startupStatus: "failed",
      errors: ["Harness launch failed: Claude resume failed: timed out waiting for Claude to become active"], probe });
    expect(sessionRegistry.getSessionsForRig(seed.rigId).find(s => s.id === seed.sessionId)?.startupStatus).toBe("failed");
    const events = db.prepare("SELECT payload FROM events WHERE type = 'node.startup_failed'").all() as { payload: string }[];
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.payload)).toMatchObject({ rigId: seed.rigId, nodeId: seed.nodeId, sessionId: seed.sessionId,
      requestedResumeToken: "saved-conversation", stage: "harness_launch", probe });
    expect(JSON.parse(events[0]!.payload).probe).toEqual(probe);
    expect(events[0]!.payload).not.toContain("fixture-private");
    expect(JSON.stringify(result)).not.toContain("fixture-private-startup-prompt");
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
      resumeType: "codex_id",
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
      resumeType: "codex_id",
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

  // Pod-aware Codex auth-refusal: when launchHarness reports
  // recovery: "attention_required" with evidence, the orchestrator must
  // surface startup_status: "attention_required" with the evidence preserved
  // (NOT fall back to fresh launch — that would lose continuity for a state
  // the operator can resolve by re-running `codex login`).
  it("propagates attention_required recovery without falling back to fresh", async () => {
    const seed = seedSession();
    const refusalEvidence = [
      "$ codex resume stale-token",
      "Error: Your access token could not be refreshed because you have since",
      "logged out or signed in to another account. Please sign in again.",
    ].join("\n");
    const launchHarness = vi.fn().mockResolvedValueOnce({
      ok: false as const,
      error: "Codex auth-refusal: please sign in again",
      recovery: "attention_required",
      evidence: refusalEvidence,
    });
    const adapter = mockAdapter({ runtime: "codex", launchHarness });
    const orch = createOrchestrator();

    const result = await orch.startNode(makeInput(seed, {
      adapter,
      isRestore: true,
      resumeToken: "stale-token",
      resumeType: "codex_id",
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.startupStatus).toBe("attention_required");
      // Evidence is preserved on the StartupResult so restore-orchestrator
      // can populate attentionEvidence on RestoreNodeResult.
      expect(result.evidence).toBe(refusalEvidence);
      expect(result.errors.some((e) => e.includes("requires attention"))).toBe(true);
    }
    // Critical: launchHarness called ONCE — no fresh-fallback retry.
    // Auth-refusal is operator-recoverable, not a stale-token signal.
    expect(launchHarness).toHaveBeenCalledTimes(1);

    const sessions = sessionRegistry.getSessionsForRig(seed.rigId);
    const session = sessions.find((s) => s.id === seed.sessionId);
    expect(session!.startupStatus).toBe("attention_required");
    expect(session!.resumeType).toBe("codex_id");
    expect(session!.resumeToken).toBe("stale-token");
    expect(session!.resumeProvenance).toBeNull();
    expect(session!.resumeLastVerified).toBeNull();
    expect(session!.resumeLastProbeStatus).toBeNull();
  });

  it.each([
    "runner exited (code 1)",
    "readiness timed out before the runtime became interactive",
  ])("preserves attempted lineage without certifying attention outcome: %s", async (error) => {
    const seed = seedSession();
    const adapter = mockAdapter({
      runtime: "pi",
      launchHarness: vi.fn(async () => ({
        ok: false as const,
        error,
        recovery: "attention_required" as const,
      })),
    });

    const result = await createOrchestrator().startNode(makeInput(seed, {
      adapter,
      isRestore: true,
      resumeToken: "attempted-pi-token",
      resumeType: "pi_session_file",
    }));

    expect(result.ok).toBe(false);
    expect(result.startupStatus).toBe("attention_required");
    const session = sessionRegistry.getSessionsForRig(seed.rigId).find((s) => s.id === seed.sessionId)!;
    expect(session.resumeType).toBe("pi_session_file");
    expect(session.resumeToken).toBe("attempted-pi-token");
    expect(session.resumeProvenance).toBeNull();
    expect(session.resumeLastVerified).toBeNull();
    expect(session.resumeLastProbeStatus).toBeNull();
  });

  // NS-T05: readiness retry loop
  describe("readiness deadline", () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it("uses the configured launch window when the caller has no override", async () => {
      const seed = seedSession();
      const started = Date.now();
      const adapter = mockAdapter({ checkReady: vi.fn(async () => ({ ready: Date.now() - started >= 40_000 })) });
      const readinessSettings = {
        resolveOne: () => ({ value: 45, source: "file", defaultValue: 30 }),
      } as unknown as Pick<SettingsStore, "resolveOne">;
      const pending = createOrchestrator({ readinessSettings }).startNode(makeInput(seed, { adapter }));

      await vi.advanceTimersByTimeAsync(45_000);
      expect(await pending).toMatchObject({ ok: true, startupStatus: "ready" });
    });

    it("falls back to the 30-second window with a warning when the settings read throws", async () => {
      const seed = seedSession();
      const started = Date.now();
      const adapter = mockAdapter({ checkReady: vi.fn(async () => ({ ready: Date.now() - started >= 20_000 })) });
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const readinessSettings = {
        resolveOne: () => { throw new Error("config.json is not valid JSON"); },
      } as unknown as Pick<SettingsStore, "resolveOne">;

      try {
        const pending = createOrchestrator({ readinessSettings }).startNode(makeInput(seed, { adapter }));
        await vi.advanceTimersByTimeAsync(30_000);

        expect(await pending).toMatchObject({ ok: true, startupStatus: "ready" });
        expect(stderr).toHaveBeenCalledWith(expect.stringContaining("falling back to 30s default"));
      } finally {
        stderr.mockRestore();
      }
    });

    it.each([20_000, 30_000])("accepts readiness at %i ms within the 30-second budget", async (readyAfterMs) => {
      const seed = seedSession();
      const started = Date.now();
      const adapter = mockAdapter({
        checkReady: vi.fn(async () => ({ ready: Date.now() - started >= readyAfterMs })),
      });
      let settled = false;
      const pending = createOrchestrator().startNode(makeInput(seed, { adapter }))
        .then((result) => { settled = true; return result; });

      await vi.advanceTimersByTimeAsync(15_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(14_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(await pending).toMatchObject({ ok: true, startupStatus: "ready" });
      expect(sessionRegistry.getSessionsForRig(seed.rigId).find((s) => s.id === seed.sessionId)?.startupStatus).toBe("ready");
    });

    it.each([500, 30_000])("does not time out before the %i ms budget expires", async (timeoutMs) => {
      const seed = seedSession();
      const started = Date.now();
      const adapter = mockAdapter({
        checkReady: vi.fn(async () => ({ ready: false, reason: `not ready at ${Date.now() - started}ms` })),
      });
      let settled = false;
      const pending = createOrchestrator().startNode(makeInput(seed, { adapter, readinessTimeoutMs: timeoutMs }))
        .then((result) => { settled = true; return result; });

      await vi.advanceTimersByTimeAsync(timeoutMs - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(await pending).toMatchObject({
        ok: false,
        startupStatus: "failed",
        errors: [expect.stringContaining(`not ready at ${timeoutMs}ms`)],
      });
      expect(vi.getTimerCount()).toBe(0);
    });

    it("preserves an attention blocker observed at the deadline", async () => {
      const seed = seedSession();
      const started = Date.now();
      const adapter = mockAdapter({
        checkReady: vi.fn(async () => Date.now() - started >= 30_000
          ? { ready: false, code: "trust_gate", reason: "workspace trust required" }
          : { ready: false, reason: "starting" }),
      });
      const pending = createOrchestrator().startNode(makeInput(seed, { adapter }));
      await vi.advanceTimersByTimeAsync(30_000);

      expect(await pending).toMatchObject({
        ok: false,
        startupStatus: "attention_required",
        errors: ["Startup requires attention: workspace trust required", expect.stringContaining("rig seat continue")],
      });
    });
  });

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
      expect(result.errors).toEqual([expect.stringContaining("after 0.1s")]);
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
