import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import type Database from "better-sqlite3";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { PiRuntimeAdapter } from "../src/adapters/pi-runtime-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import type { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { ContextMonitor } from "../src/domain/context-monitor.js";
import { ContextUsageStore } from "../src/domain/context-usage-store.js";
import type { ProjectionEntry, ProjectionPlan } from "../src/domain/projection-planner.js";
import type { NodeBinding, RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import { createFullTestDb } from "./helpers/test-app.js";

// Real snapshot/restore/startup/projection and settings files; only terminal and
// native launch/readiness are simulated. No Claude, provider or daemon is started.
describe("contained Claude restore activity resources", () => {
  let db: Database.Database;
  let root: string;
  let cwd: string;
  let settingsPath: string;
  let writes: Array<{ file: string; text: string }>;
  let adapter: ClaudeCodeAdapter;
  let tmux: TmuxAdapter;
  let rigs: RigRepository;
  let registry: SessionRegistry;
  let events: EventBus;
  let snapshots: SnapshotRepository;
  let checkpoints: CheckpointStore;
  let capture: SnapshotCapture;
  const token = "74398f0a-6dbd-41b6-897e-e3ed4d36787f";
  const userHook = { matcher: "user-only", hooks: [{ type: "command", command: "echo user-hook" }] };
  const originalSettings = { env: { USER_SETTING: "keep" }, hooks: { Stop: [userHook] } };
  const shipped = path.resolve(import.meta.dirname, "../assets/plugins/openrig-core/hooks");

  beforeEach(() => {
    db = createFullTestDb();
    root = fs.mkdtempSync(path.join(tmpdir(), "restore-activity-"));
    cwd = path.join(root, "project");
    settingsPath = path.join(cwd, ".claude/settings.local.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(originalSettings));
    writes = [];
    const fsOps: ClaudeAdapterFsOps = {
      exists: fs.existsSync, readFile: p => fs.readFileSync(p, "utf8"),
      writeFile: (p, text) => { writes.push({ file: p, text }); fs.writeFileSync(p, text); },
      mkdirp: p => { fs.mkdirSync(p, { recursive: true }); },
      copyFile: fs.copyFileSync, statMode: p => fs.statSync(p).mode, chmod: fs.chmodSync,
      homedir: path.join(root, "home"),
    };
    tmux = {
      createSession: vi.fn(async () => ({ ok: true })), killSession: vi.fn(async () => ({ ok: true })),
      sendText: vi.fn(async () => ({ ok: true })), sendKeys: vi.fn(async () => ({ ok: true })),
      getPaneCommand: vi.fn(async () => "claude"), capturePaneContent: vi.fn(async () => ""),
      listSessions: async () => [], listWindows: async () => [], listPanes: async () => [],
      hasSession: async () => false,
    } as unknown as TmuxAdapter;
    const collector = path.join(root, "collector.cjs");
    fs.writeFileSync(collector, "// inert collector fixture\n");
    adapter = new ClaudeCodeAdapter({ tmux, fsOps, stateDir: path.join(root, "state"), collectorAssetPath: collector,
      activityRelayPath: path.join(shipped, "scripts/activity-relay.cjs"), claudeHooksManifestPath: path.join(shipped, "claude.json") });
    vi.spyOn(adapter, "checkReady").mockResolvedValue({ ready: true });
    vi.spyOn(adapter, "launchHarness").mockImplementation(async (_binding, opts) => ({ ok: true,
      ...(opts.resumeToken ? { resumeToken: opts.resumeToken, resumeType: "claude_id" } : {}) }));
    rigs = new RigRepository(db); registry = new SessionRegistry(db); events = new EventBus(db);
    snapshots = new SnapshotRepository(db); checkpoints = new CheckpointStore(db);
    capture = new SnapshotCapture({ db, rigRepo: rigs, sessionRegistry: registry, eventBus: events,
      snapshotRepo: snapshots, checkpointStore: checkpoints });
  });

  afterEach(() => { vi.restoreAllMocks(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });

  function activity(): ProjectionEntry {
    return { category: "runtime_resource", resourceType: "claude_activity_hooks", effectiveId: "activity",
      sourceSpec: "saved", sourcePath: "/old-install/specs", resourcePath: "activity", absolutePath: "/old-install/specs/activity",
      classification: "safe_projection" };
  }
  function plan(entries: ProjectionEntry[]): ProjectionPlan {
    return { runtime: "claude-code", cwd, entries, startup: { files: [], actions: [] }, conflicts: [], diagnostics: [], noOps: [] };
  }
  function binding(): NodeBinding {
    return { id: "b", nodeId: "n", tmuxSession: "seat@restore", tmuxWindow: null, tmuxPane: null,
      cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd };
  }
  function settings() { return JSON.parse(fs.readFileSync(settingsPath, "utf8")); }
  function owned(s = settings()): string[] {
    return Object.values(s.hooks ?? {}).flatMap((groups: any) => groups.flatMap((g: any) => g.hooks ?? []))
      .map((h: any) => h.command as string).filter(c => c.includes(".openrig/hooks/scripts/activity-relay.cjs"));
  }
  function seed(pod: boolean, selected = true, runtime = "claude-code") {
    const rig = rigs.createRig("restore");
    if (pod) db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("pod", rig.id, "P");
    const node = rigs.addNode(rig.id, pod ? "p.seat" : "seat", { runtime, cwd, ...(pod ? { podId: "pod" } : {}) });
    const session = registry.registerSession(node.id, "seat@restore");
    registry.updateStatus(session.id, "running");
    registry.updateResumeToken(session.id, runtime === "codex" ? "codex_id" : runtime === "pi" ? "pi_session_file" : "claude_id", token);
    const entries = [
      ...(selected ? [activity()] : []),
      { category: "guidance", effectiveId: "do-not-replay", absolutePath: path.join(root, "missing-guidance.md"), mergeStrategy: "managed_block" },
    ];
    const files = [{ path: "missing.md", absolutePath: path.join(root, "missing.md"), required: true, appliesOn: ["restore"] }];
    const actions = [{ type: "send_text", value: "DO NOT REPLAY", phase: "after_ready", appliesOn: ["restore"], idempotent: true }];
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)")
      .run(node.id, JSON.stringify(entries), JSON.stringify(files), JSON.stringify(actions), runtime);
    const saved = db.prepare("SELECT * FROM node_startup_context WHERE node_id=?").get(node.id);
    const snap = capture.captureSnapshot(rig.id, "manual");
    registry.updateStatus(session.id, "exited");
    db.prepare("DELETE FROM bindings WHERE node_id=?").run(node.id);
    return { rig, node, snap, saved };
  }
  function restore(f: ReturnType<typeof seed>, runtimeAdapter: RuntimeAdapter = adapter, beforeResume = () => {}) {
    const claude = { canResume: () => true, resume: vi.fn(async () => { beforeResume(); return { ok: true }; }) } as unknown as ClaudeResumeAdapter;
    const nodeLauncher = new NodeLauncher({ db, rigRepo: rigs, sessionRegistry: registry, eventBus: events, tmuxAdapter: tmux });
    const orch = new RestoreOrchestrator({ db, rigRepo: rigs, sessionRegistry: registry, eventBus: events,
      snapshotRepo: snapshots, snapshotCapture: capture, checkpointStore: checkpoints, nodeLauncher, tmuxAdapter: tmux,
      claudeResume: claude, codexResume: { canResume: () => true, resume: async () => ({ ok: true }) } as unknown as CodexResumeAdapter });
    return orch.restore(f.snap.id, { adapters: { [runtimeAdapter.runtime]: runtimeAdapter }, fsOps: { exists: fs.existsSync } });
  }

  it.each([false, true])("preserves selected hooks, including at native launch (pod=%s)", async pod => {
    await adapter.project(plan([activity()]), binding());
    const enabled = owned(); expect(enabled.length).toBeGreaterThan(0);
    const f = seed(pod);
    const atLaunch = () => expect(owned()).toEqual(enabled);
    vi.mocked(adapter.launchHarness).mockImplementation(async (_b, opts) => { atLaunch(); return { ok: true, resumeToken: opts.resumeToken, resumeType: "claude_id" }; });
    const result = await restore(f, adapter, atLaunch);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result.nodes[0]).toMatchObject({
      // Native launch is simulated; no process identity is supplied to the final
      // joined proof. Keep that honest attention outcome separate from projection.
      status: "attention_required", error: expect.stringContaining("joined restore proof is incomplete"),
    });
    expect(owned()).toEqual(enabled);
    expect(settings().hooks.Stop).toContainEqual(userHook);
    expect(settings().env).toEqual(originalSettings.env);
    expect(db.prepare("SELECT * FROM node_startup_context WHERE node_id=?").get(f.node.id)).toEqual(f.saved);
    expect(tmux.sendText).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(cwd, "CLAUDE.md"))).toBe(false);
    if (pod) expect(adapter.launchHarness).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ resumeToken: token }));
    const beforePoll = owned(); const writeCount = writes.filter(w => w.file === settingsPath).length;
    const monitor = new ContextMonitor(db, new ContextUsageStore(db, { stateDir: path.join(root, "state"), codexHome: path.join(root, "codex") }), adapter);
    await monitor.pollOnce(); monitor.stop();
    expect(writes.filter(w => w.file === settingsPath).length).toBeGreaterThan(writeCount);
    expect(owned()).toEqual(beforePoll);
    expect(writes.filter(w => w.file === settingsPath).every(w => owned(JSON.parse(w.text)).length > 0)).toBe(true);
  });

  it("#729: keeps startup warnings when the final joined restore proof needs attention", async () => {
    const f = seed(true);
    const { StartupOrchestrator } = await import("../src/domain/startup-orchestrator.js");
    const warning = "Startup submission unverified: capture unavailable";
    vi.spyOn(StartupOrchestrator.prototype, "startNode").mockResolvedValue({
      ok: true, startupStatus: "ready", continuityOutcome: "resumed", warnings: [warning],
    });
    const result = await restore(f);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.nodes[0]).toMatchObject({ status: "attention_required" });
    expect(result.result.warnings).toContain(warning);
  });

  it.each([false, true])("heals already stripped settings before native resume (pod=%s)", async pod => {
    const f = seed(pod);
    const atLaunch = () => expect(owned().length).toBeGreaterThan(0);
    vi.mocked(adapter.launchHarness).mockImplementation(async (_b, opts) => { atLaunch(); return { ok: true, resumeToken: opts.resumeToken, resumeType: "claude_id" }; });
    const result = await restore(f, adapter, atLaunch);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.result.nodes[0]).toMatchObject({
      // Native launch is simulated; no process identity is supplied to the final
      // joined proof. Keep that honest attention outcome separate from projection.
      status: "attention_required", error: expect.stringContaining("joined restore proof is incomplete"),
    });
    expect(owned().length).toBeGreaterThan(0);
    expect(settings().hooks.Stop).toContainEqual(userHook);
    expect(settings().env).toEqual(originalSettings.env);
    const healed = settings(); await adapter.project(plan([activity()]), binding());
    expect(settings()).toEqual(healed);
    expect(tmux.sendText).not.toHaveBeenCalled();
  });

  it.each([false, true])("does not reconcile absent saved selection (existing owned hooks=%s)", async existing => {
    if (existing) await adapter.project(plan([activity()]), binding());
    const before = settings().hooks;
    const result = await restore(seed(true, false));
    expect(result.ok).toBe(true);
    expect(settings().hooks).toEqual(before);
  });

  it("retains real fresh projection and deliberate resource removal", async () => {
    await adapter.project(plan([activity()]), binding()); expect(owned().length).toBeGreaterThan(0);
    await adapter.project(plan([]), binding()); expect(owned()).toEqual([]);
    expect(settings()).toEqual(originalSettings);
  });

  it.each(["codex", "pi"])("keeps %s contained projection empty and launch token unchanged", async runtime => {
    const f = seed(true, false, runtime);
    const project = vi.fn(runtime === "codex" ? CodexRuntimeAdapter.prototype.project : PiRuntimeAdapter.prototype.project);
    const launch = vi.fn(async (_b, opts) => ({ ok: true as const, resumeToken: opts.resumeToken, resumeType: runtime === "codex" ? "codex_id" : "pi_session_file" }));
    const other = { runtime, project, listInstalled: async () => [], deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: async () => ({ ready: true }), launchHarness: launch } as RuntimeAdapter;
    const result = await restore(f, other);
    expect(result.ok).toBe(true);
    expect(project).toHaveBeenCalledTimes(1);
    expect(project.mock.calls[0]![0].entries).toEqual([]);
    expect(launch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ resumeToken: token }));
    expect(other.deliverStartup).toHaveBeenCalledWith([], expect.anything());
    expect(writes).toEqual([]);
  });
});
