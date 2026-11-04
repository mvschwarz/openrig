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
import { MANAGED_BLOCK_START } from "../src/domain/managed-blocks.js";

// Real snapshot/restore/startup/projection and settings files; only terminal and
// native launch/readiness are simulated. No Claude, provider or daemon is started.
describe("contained Claude restore activity resources", () => {
  let db: Database.Database;
  let root: string;
  let cwd: string;
  let settingsPath: string;
  let writes: Array<{ file: string; text: string }>;
  let fsOps: ClaudeAdapterFsOps;
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
    fsOps = {
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
      .map((h: any) => h.command as string).filter(c => c.includes("state/claude-activity-hooks/activity-relay.cjs"));
  }
  function seed(pod: boolean, selected = true, runtime = "claude-code", withStartupContext = true, seedCwd: string | null = cwd,
    extraEntries: Array<{ category: string; effectiveId: string; absolutePath: string; mergeStrategy: string }> = []) {
    const rig = rigs.createRig("restore");
    if (pod) db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("pod", rig.id, "P");
    const node = rigs.addNode(rig.id, pod ? "p.seat" : "seat", { runtime, ...(seedCwd ? { cwd: seedCwd } : {}), ...(pod ? { podId: "pod" } : {}) });
    const session = registry.registerSession(node.id, "seat@restore");
    registry.updateStatus(session.id, "running");
    registry.updateResumeToken(session.id, runtime === "codex" ? "codex_id" : runtime === "pi" ? "pi_session_file" : "claude_id", token);
    const entries = [
      ...(selected ? [activity()] : []),
      { category: "guidance", effectiveId: "do-not-replay", absolutePath: path.join(root, "missing-guidance.md"), mergeStrategy: "managed_block" },
      ...extraEntries,
    ];
    const files = [{ path: "missing.md", absolutePath: path.join(root, "missing.md"), required: true, appliesOn: ["restore"] }];
    const actions = [{ type: "send_text", value: "DO NOT REPLAY", phase: "after_ready", appliesOn: ["restore"], idempotent: true }];
    if (withStartupContext) {
      db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)")
        .run(node.id, JSON.stringify(entries), JSON.stringify(files), JSON.stringify(actions), runtime);
    }
    const saved = db.prepare("SELECT * FROM node_startup_context WHERE node_id=?").get(node.id);
    const snap = capture.captureSnapshot(rig.id, "manual");
    registry.updateStatus(session.id, "exited");
    db.prepare("DELETE FROM bindings WHERE node_id=?").run(node.id);
    return { rig, node, snap, saved };
  }
  function restore(f: ReturnType<typeof seed>, runtimeAdapter: RuntimeAdapter = adapter, beforeResume = () => {}, desired?: (nodeId: string) =>
    | { status: "known"; selected: boolean } | { status: "unknown"; evidence: string },
    adapters?: Record<string, RuntimeAdapter>, claudeResume?: ClaudeResumeAdapter) {
    const claude = claudeResume ?? { canResume: () => true, resume: vi.fn(async () => { beforeResume(); return { ok: true }; }) } as unknown as ClaudeResumeAdapter;
    const nodeLauncher = new NodeLauncher({ db, rigRepo: rigs, sessionRegistry: registry, eventBus: events, tmuxAdapter: tmux });
    const orch = new RestoreOrchestrator({ db, rigRepo: rigs, sessionRegistry: registry, eventBus: events,
      snapshotRepo: snapshots, snapshotCapture: capture, checkpointStore: checkpoints, nodeLauncher, tmuxAdapter: tmux,
      claudeResume: claude, codexResume: { canResume: () => true, resume: async () => ({ ok: true }) } as unknown as CodexResumeAdapter,
      ...(desired ? { getDesiredClaudeActivityHooks: desired } : {}) });
    return orch.restore(f.snap.id, { adapters: adapters ?? { [runtimeAdapter.runtime]: runtimeAdapter }, fsOps: { exists: fs.existsSync } });
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
    // The collector's status line is already in place, so the poll writes nothing and the hooks stay as they are.
    await monitor.pollOnce();
    expect(writes.filter(w => w.file === settingsPath).length).toBe(writeCount);
    expect(owned()).toEqual(beforePoll);
    expect(settings().hooks.Stop).toContainEqual(userHook);
    expect(settings().env).toEqual(originalSettings.env);
    // A poll that does refresh the status line (here a stale collector command) keeps the selected hooks in its write.
    fs.writeFileSync(settingsPath, JSON.stringify({ ...settings(), statusLine: { type: "command", command: "node /old/.openrig/context-collector.cjs /old/ctx /old/prov" } }));
    await monitor.pollOnce(); monitor.stop();
    expect(writes.filter(w => w.file === settingsPath).length).toBe(writeCount + 1);
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

  it.each(["relay", "manifest", "settings"] as const)("warns when restore activity hooks are skipped: %s", async unavailable => {
    const f = seed(true);
    if (unavailable === "settings") fs.writeFileSync(settingsPath, "{invalid settings");
    else {
      const missing = path.join(shipped, unavailable === "relay" ? "scripts/activity-relay.cjs" : "claude.json");
      fsOps.exists = p => p !== missing && fs.existsSync(p);
    }
    const before = fs.readFileSync(settingsPath, "utf8");
    const project = vi.spyOn(adapter, "project");
    const result = await restore(f);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.nodes[0]).toMatchObject({
      status: "attention_required", error: expect.stringContaining("joined restore proof is incomplete"),
    });
    expect(await project.mock.results[0]!.value).toMatchObject({ projected: [], skipped: ["activity"], failed: [] });
    expect(result.result.warnings).toContain("Restore activity hooks: skipped activity; saved hooks could not be reapplied.");
    // Startup may still provision its existing context collector in valid settings.
    if (unavailable === "settings") expect(fs.readFileSync(settingsPath, "utf8")).toBe(before);
    else {
      expect(settings().hooks).toEqual(JSON.parse(before).hooks);
      expect(settings().env).toEqual(JSON.parse(before).env);
    }
    expect(tmux.sendText).not.toHaveBeenCalled();
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

  // #1530: a saved startup context that predates the hooks selection must not
  // leave a resumed seat hookless when the current spec still selects them.
  it("re-applies the current selection when the saved context has no hooks entry", async () => {
    const f = seed(true, false);
    const project = vi.spyOn(adapter, "project");
    const result = await restore(f, adapter, () => {}, () => ({ status: "known", selected: true }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.nodes[0]).toMatchObject({
      status: "attention_required", error: expect.stringContaining("joined restore proof is incomplete"),
    });
    // Marker-only recovery: one reconstructed entry, empty startup payload, no replay.
    const recoveryCall = project.mock.calls.find(([plan]) => plan.entries.some((e) => e.resourceType === "claude_activity_hooks"));
    expect(recoveryCall).toBeDefined();
    expect(recoveryCall![0].entries).toHaveLength(1);
    expect(recoveryCall![0].entries[0]).toMatchObject({
      category: "runtime_resource", resourceType: "claude_activity_hooks", sourceSpec: "current-selection",
    });
    expect(recoveryCall![0].startup).toEqual({ files: [], actions: [] });
    expect(owned().length).toBeGreaterThan(0);
    expect(result.result.warnings.some((w) => w.startsWith("Restore activity hooks:") && w.includes("current"))).toBe(true);
    expect(result.result.nodes[0].restoreGaps).toBeUndefined();
    expect(settings().hooks.Stop).toContainEqual(userHook);
    expect(settings().env).toEqual(originalSettings.env);
    expect(db.prepare("SELECT * FROM node_startup_context WHERE node_id=?").get(f.node.id)).toEqual(f.saved);
    expect(tmux.sendText).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(cwd, "CLAUDE.md"))).toBe(false);
  });

  // Follow-up to #2338 (CodeRabbit Major 4436149570): an older snapshot with
  // NO nodeStartupContext row at all must not leave a known-selected legacy
  // Claude seat hookless with no restore gap. The runtime falls back to the
  // node's saved runtime and absent projection entries count as an empty list.
  // The fallback is scoped to legacy seats whose live runtime still matches
  // the snapshot's: a pod-aware seat, or one whose runtime changed since the
  // snapshot, gets no hooks write from this recovery (see the two tests
  // below). The restore itself is unchanged in both cases.
  it("re-applies the current selection when the saved startup context is absent (legacy seat)", async () => {
    const f = seed(false, false, "claude-code", false);
    const project = vi.spyOn(adapter, "project");
    const result = await restore(f, adapter, () => {}, () => ({ status: "known", selected: true }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const recoveryCall = project.mock.calls.find(([plan]) => plan.entries.some((e) => e.resourceType === "claude_activity_hooks"));
    expect(recoveryCall).toBeDefined();
    expect(recoveryCall![0].entries).toHaveLength(1);
    expect(recoveryCall![0].entries[0]).toMatchObject({
      category: "runtime_resource", resourceType: "claude_activity_hooks", sourceSpec: "current-selection",
    });
    expect(owned().length).toBeGreaterThan(0);
    expect(result.result.warnings.some((w) => w.startsWith("Restore activity hooks:") && w.includes("current"))).toBe(true);
    expect(result.result.nodes[0].restoreGaps).toBeUndefined();
    expect(tmux.sendText).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(cwd, "CLAUDE.md"))).toBe(false);
  });

  it("does not consult current selection or project claude hooks for legacy codex seat with absent startup context", async () => {
    const runtime = "codex";
    const f = seed(false, false, runtime, false);
    const project = vi.fn(CodexRuntimeAdapter.prototype.project);
    const launch = vi.fn(async (_b, opts) => ({ ok: true as const, resumeToken: opts.resumeToken, resumeType: "codex_id" }));
    const other = { runtime, project, listInstalled: async () => [], deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })),
      checkReady: async () => ({ ready: true }), launchHarness: launch } as RuntimeAdapter;
    const claudeProject = vi.spyOn(adapter, "project");
    const desired = vi.fn((): { status: "known"; selected: boolean } => ({ status: "known", selected: true }));
    const result = await restore(f, other, () => {}, desired, { "claude-code": adapter, codex: other });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(desired).not.toHaveBeenCalled();
    const claudeRecovery = claudeProject.mock.calls.find(([plan]) => plan.entries.some((e) => e.resourceType === "claude_activity_hooks"));
    expect(claudeRecovery).toBeUndefined();
    const otherRecovery = project.mock.calls.find(([plan]) => plan.entries.some((e) => e.resourceType === "claude_activity_hooks"));
    expect(otherRecovery).toBeUndefined();
    expect(owned()).toEqual([]);
    expect(writes).toEqual([]);
    expect(result.result.warnings.some((w) => w.startsWith("Restore activity hooks:"))).toBe(false);
    expect(result.result.nodes[0].restoreGaps).toBeUndefined();
  });

  // Maintainer review on #2373: the no-context fallback must not write Claude
  // hooks for a snapshot whose agent runtime changed after the snapshot was
  // taken. With a saved startup context, the compatibility gate stops the
  // mismatch; without one, nothing does, so the fallback must compare the
  // live runtime against the snapshot's before re-applying anything.
  it("does not project claude hooks when the live runtime no longer matches the snapshot runtime (no startup context)", async () => {
    const f = seed(false, false, "claude-code", false);
    db.prepare("UPDATE nodes SET runtime = ? WHERE id = ?").run("codex", f.node.id);
    const project = vi.spyOn(adapter, "project");
    const desired = vi.fn((): { status: "known"; selected: boolean } => ({ status: "known", selected: true }));
    const result = await restore(f, adapter, () => {}, desired);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(desired).not.toHaveBeenCalled();
    const claudeRecovery = project.mock.calls.find(([plan]) => plan.entries.some((e) => e.resourceType === "claude_activity_hooks"));
    expect(claudeRecovery).toBeUndefined();
    expect(owned()).toEqual([]);
    expect(result.result.warnings.some((w) => w.startsWith("Restore activity hooks:"))).toBe(false);
    expect(result.result.nodes[0].restoreGaps).toBeUndefined();
  });

  // Maintainer review on #2373: a pod-aware agent with no startup context
  // must get no hooks write from this recovery — it still ends at the
  // "Harness not started" gate, and the restore itself is unchanged.
  it("does not project claude hooks for a pod-aware seat with no startup context", async () => {
    const f = seed(true, false, "claude-code", false);
    const project = vi.spyOn(adapter, "project");
    const desired = vi.fn((): { status: "known"; selected: boolean } => ({ status: "known", selected: true }));
    const result = await restore(f, adapter, () => {}, desired);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.nodes[0]).toMatchObject({
      status: "attention_required", error: "Harness not started: no startup context for p.seat.",
    });
    expect(desired).not.toHaveBeenCalled();
    const claudeRecovery = project.mock.calls.find(([plan]) => plan.entries.some((e) => e.resourceType === "claude_activity_hooks"));
    expect(claudeRecovery).toBeUndefined();
    expect(owned()).toEqual([]);
    expect(result.result.warnings.some((w) => w.startsWith("Restore activity hooks:"))).toBe(false);
    expect(result.result.nodes[0].restoreGaps).toBeUndefined();
  });

  // CodeRabbit follow-up on #2373: the snapshot node may have no cwd while
  // the live node does. NodeLauncher launches the seat in the live node's
  // directory (opts.cwd ?? live node cwd), so the hook projection must use
  // that resolved directory — not "." (the daemon's working directory), which
  // would write another project's hook settings. The snapshot is captured
  // with no cwd; the live row gains one only after capture.
  function liveProject() {
    const liveCwd = path.join(root, "live-project");
    const liveSettingsPath = path.join(liveCwd, ".claude/settings.local.json");
    fs.mkdirSync(path.dirname(liveSettingsPath), { recursive: true });
    fs.writeFileSync(liveSettingsPath, JSON.stringify(originalSettings));
    return { liveCwd, liveSettingsPath };
  }
  function liveOwned(liveSettingsPath: string): string[] {
    return owned(JSON.parse(fs.readFileSync(liveSettingsPath, "utf8")));
  }

  it("projects the current selection into the live seat directory when the snapshot node has no cwd", async () => {
    const { liveCwd, liveSettingsPath } = liveProject();
    const f = seed(false, false, "claude-code", false, null);
    db.prepare("UPDATE nodes SET cwd = ? WHERE id = ?").run(liveCwd, f.node.id);
    const project = vi.spyOn(adapter, "project");
    const result = await restore(f, adapter, () => {}, () => ({ status: "known", selected: true }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const recoveryCall = project.mock.calls.find(([plan]) => plan.entries.some((e) => e.resourceType === "claude_activity_hooks"));
    expect(recoveryCall).toBeDefined();
    expect(recoveryCall![0].cwd).toBe(liveCwd);
    expect(recoveryCall![1].cwd).toBe(liveCwd);
    expect(liveOwned(liveSettingsPath).length).toBeGreaterThan(0);
    expect(result.result.nodes[0].restoreGaps).toBeUndefined();
    expect(tmux.sendText).not.toHaveBeenCalled();
  });

  it("projects saved hooks entries into the live seat directory when the snapshot node has no cwd", async () => {
    const { liveCwd, liveSettingsPath } = liveProject();
    const f = seed(false, true, "claude-code", true, null);
    db.prepare("UPDATE nodes SET cwd = ? WHERE id = ?").run(liveCwd, f.node.id);
    const project = vi.spyOn(adapter, "project");
    const { StartupOrchestrator } = await import("../src/domain/startup-orchestrator.js");
    const startNode = vi.spyOn(StartupOrchestrator.prototype, "startNode");
    const result = await restore(f, adapter);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const savedCall = project.mock.calls.find(([plan]) => plan.entries.some((e) => e.resourceType === "claude_activity_hooks"));
    expect(savedCall).toBeDefined();
    expect(savedCall![0].cwd).toBe(liveCwd);
    expect(savedCall![1].cwd).toBe(liveCwd);
    expect(liveOwned(liveSettingsPath).length).toBeGreaterThan(0);
    // The same restore's startup replay must use the live seat directory too:
    // with the snapshot cwd absent it previously wrote the collector/status
    // line into the daemon's own working folder ("."), polluting later tests.
    const replayCalls = startNode.mock.calls.filter(([args]) => args.plan && args.binding);
    expect(replayCalls.length).toBeGreaterThan(0);
    for (const [{ plan: replayPlan, binding: replayBinding }] of replayCalls) {
      expect(replayPlan.cwd).toBe(liveCwd);
      expect(replayBinding.cwd).toBe(liveCwd);
    }
    expect(result.result.warnings.some((w) => w.startsWith("Restore activity hooks:"))).toBe(false);
    expect(result.result.nodes[0].restoreGaps).toBeUndefined();
  });

  // CodeRabbit follow-up on #2373: the legacy resume adapter must receive the
  // same resolved launch directory as the hook projection and the startup
  // replay — when the snapshot node has no cwd, the seat was launched in the
  // live node's directory, not "/" (which a managed launch would reject as a
  // directory mismatch for a seat with an explicit permission mode).
  it("resumes the legacy seat in the live seat directory when the snapshot node has no cwd", async () => {
    const { liveCwd, liveSettingsPath } = liveProject();
    const f = seed(false, true, "claude-code", true, null);
    db.prepare("UPDATE nodes SET cwd = ? WHERE id = ?").run(liveCwd, f.node.id);
    const resume = vi.fn(async () => ({ ok: true }));
    const result = await restore(f, adapter, () => {}, undefined, undefined,
      { canResume: () => true, resume } as unknown as ClaudeResumeAdapter);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(resume).toHaveBeenCalled();
    // 4th positional argument: the launch directory handed to the resume adapter.
    expect(resume.mock.calls[0]![3]).toBe(liveCwd);
    expect(liveOwned(liveSettingsPath).length).toBeGreaterThan(0);
    expect(result.result.nodes[0].restoreGaps).toBeUndefined();
  });

  // CodeRabbit follow-up on #2373: the saved-guidance lookups must use the
  // same resolved launch directory as the hook projection and startup replay.
  // When the snapshot node has no cwd, seatGuidance with node.cwd (null)
  // returns null, so the pre-resume repair is skipped and the post-launch
  // check reports nothing — a seat whose guidance blocks are missing in the
  // live directory comes back fully_restored with no warning. The seed's
  // "do-not-replay" guidance entry (source always missing) stays a gap in
  // both tests; only the SOP.md entry distinguishes fixed from unfixed.
  it("puts back saved guidance blocks in the live seat directory when the snapshot node has no cwd", async () => {
    const { liveCwd } = liveProject();
    const sourcePath = path.join(root, "SOP.md");
    fs.writeFileSync(sourcePath, "Current SOP text.");
    const guidanceFile = path.join(liveCwd, "CLAUDE.md");
    fs.writeFileSync(guidanceFile, "# My project notes\n");
    const f = seed(false, false, "claude-code", true, null, [
      { category: "guidance", effectiveId: "SOP.md", absolutePath: sourcePath, mergeStrategy: "managed_block" },
    ]);
    db.prepare("UPDATE nodes SET cwd = ? WHERE id = ?").run(liveCwd, f.node.id);
    const result = await restore(f, adapter);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const content = fs.readFileSync(guidanceFile, "utf-8");
    expect(content).toContain(MANAGED_BLOCK_START("SOP.md"));
    expect(content).toContain("Current SOP text.");
    expect(result.result.nodes[0].guidanceGaps).toEqual(["do-not-replay"]);
  });

  it("discloses a guidance gap in the live seat directory when the snapshot node has no cwd and the source is gone", async () => {
    const { liveCwd } = liveProject();
    const sourcePath = path.join(root, "SOP-gone.md");
    fs.writeFileSync(sourcePath, "Current SOP text.");
    const guidanceFile = path.join(liveCwd, "CLAUDE.md");
    fs.writeFileSync(guidanceFile, "# My project notes\n");
    const f = seed(false, false, "claude-code", true, null, [
      { category: "guidance", effectiveId: "SOP.md", absolutePath: sourcePath, mergeStrategy: "managed_block" },
    ]);
    db.prepare("UPDATE nodes SET cwd = ? WHERE id = ?").run(liveCwd, f.node.id);
    fs.rmSync(sourcePath);
    const result = await restore(f, adapter);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...(result.result.nodes[0].guidanceGaps ?? [])].sort()).toEqual(["SOP.md", "do-not-replay"]);
    expect(result.result.warnings.join("\n")).toContain("SOP.md");
    expect(fs.readFileSync(guidanceFile, "utf-8")).toBe("# My project notes\n");
  });

  // The recovery projection must be awaited: an adapter whose project()
  // suspends (real async work) must not have its warnings/gaps silently
  // dropped because postLaunchRestore continued to the rollup first.
  it("waits for a suspending recovery projection before packaging the restore result", async () => {
    const f = seed(true, false);
    const original = adapter.project.bind(adapter);
    vi.spyOn(adapter, "project").mockImplementation(async (planArg: ProjectionPlan, bindingArg: NodeBinding) => {
      if (planArg.entries.some((e) => e.resourceType === "claude_activity_hooks")) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      return original(planArg, bindingArg);
    });
    const result = await restore(f, adapter, () => {}, () => ({ status: "known", selected: true }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.warnings.some((w) => w.startsWith("Restore activity hooks:") && w.includes("current"))).toBe(true);
    expect(result.result.nodes[0].restoreGaps).toBeUndefined();
  });

  it("does not consult the current selection when a saved hooks entry exists", async () => {
    const f = seed(true);
    const desired = vi.fn((): { status: "known"; selected: boolean } => ({ status: "known", selected: true }));
    const result = await restore(f, adapter, () => {}, desired);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(desired).not.toHaveBeenCalled();
    expect(result.result.warnings.some((w) => w.startsWith("Restore activity hooks:"))).toBe(false);
    expect(result.result.nodes[0].restoreGaps).toBeUndefined();
    expect(owned().length).toBeGreaterThan(0);
  });

  it("does not consult the current selection for saved entries when no Claude adapter was supplied", async () => {
    // Legacy (non-pod) restore proceeds without a runtime adapter, so the
    // guard is reached; with a saved entry present the current selection
    // must stay unread and no gap may be recorded for it.
    const f = seed(false);
    const desired = vi.fn((): { status: "known"; selected: boolean } => ({ status: "known", selected: true }));
    const result = await restore(f, adapter, () => {}, desired, {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(desired).not.toHaveBeenCalled();
    expect(result.result.warnings.some((w) => w.startsWith("Restore activity hooks:"))).toBe(false);
    expect(result.result.nodes[0].restoreGaps).toBeUndefined();
  });

  it("does not project when the current spec does not select hooks", async () => {
    const f = seed(true, false);
    const result = await restore(f, adapter, () => {}, () => ({ status: "known", selected: false }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(owned()).toEqual([]);
    expect(result.result.warnings.some((w) => w.startsWith("Restore activity hooks:"))).toBe(false);
    expect(result.result.nodes[0].restoreGaps).toBeUndefined();
    expect(tmux.sendText).not.toHaveBeenCalled();
  });

  it("warns without projecting when the current selection is unknown", async () => {
    const f = seed(true, false);
    const result = await restore(f, adapter, () => {}, () => ({ status: "unknown", evidence: "no agent file" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(owned()).toEqual([]);
    expect(result.result.warnings.some((w) => w.includes("Restore activity hooks:") && w.includes("could not be determined") && w.includes("p.seat"))).toBe(true);
    expect(result.result.nodes[0].restoreGaps).toBeUndefined();
    expect(tmux.sendText).not.toHaveBeenCalled();
  });

  it("reports a gap when the current selection is known but no Claude adapter was supplied", async () => {
    const f = seed(false, false);
    const result = await restore(f, adapter, () => {}, () => ({ status: "known", selected: true }), {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(owned()).toEqual([]);
    expect(result.result.warnings.some((w) => w.includes("Restore activity hooks:") && w.includes("seat") && w.includes("could not be re-applied"))).toBe(true);
    expect(result.result.nodes[0].restoreGaps).toHaveLength(1);
    expect(result.result.nodes[0].restoreGaps?.[0]).toContain("claude_activity_hooks");
  });

  it("warns without a gap when the selection is unknown and no Claude adapter was supplied", async () => {
    const f = seed(false, false);
    const result = await restore(f, adapter, () => {}, () => ({ status: "unknown", evidence: "no agent file" }), {});
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(owned()).toEqual([]);
    expect(result.result.warnings.some((w) => w.includes("Restore activity hooks:") && w.includes("could not be determined") && w.includes("seat"))).toBe(true);
    expect(result.result.nodes[0].restoreGaps).toBeUndefined();
  });

  it("treats a throwing selection reader as unknown, never as selected", async () => {
    const f = seed(true, false);
    const result = await restore(f, adapter, () => {}, () => { throw new Error("boom"); });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(owned()).toEqual([]);
    expect(result.result.warnings.some((w) => w.includes("Restore activity hooks:"))).toBe(true);
    expect(result.result.nodes[0].restoreGaps).toBeUndefined();
  });

  it("discloses a skipped recovery projection instead of reporting success", async () => {
    const f = seed(true, false);
    const missing = path.join(shipped, "scripts/activity-relay.cjs");
    fsOps.exists = p => p !== missing && fs.existsSync(p);
    const project = vi.spyOn(adapter, "project");
    const result = await restore(f, adapter, () => {}, () => ({ status: "known", selected: true }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const recovery = project.mock.calls.find(([plan]) => plan.entries.some((e) => e.resourceType === "claude_activity_hooks"));
    expect(recovery).toBeDefined();
    const outcomes = await Promise.all(project.mock.results.map((r) => r.value));
    expect(outcomes.find((v) => v.skipped?.includes("claude_activity_hooks")))
      .toMatchObject({ projected: [], skipped: ["claude_activity_hooks"], failed: [] });
    expect(result.result.warnings.some((w) => w.includes("Restore activity hooks:") && w.includes("could not be re-applied"))).toBe(true);
    expect(result.result.nodes[0].restoreGaps).toHaveLength(1);
    expect(settings().hooks).toEqual(originalSettings.hooks);
  });

  it("does not duplicate already-owned hooks when re-applying the current selection", async () => {
    await adapter.project(plan([activity()]), binding());
    const before = owned();
    expect(before.length).toBeGreaterThan(0);
    const f = seed(true, false);
    const result = await restore(f, adapter, () => {}, () => ({ status: "known", selected: true }));
    expect(result.ok).toBe(true);
    expect(owned()).toEqual(before);
  });

  it("rolls a resumed node with a restore gap up to partially_restored", async () => {
    const { rollupRestoreRigResult } = await import("../src/domain/restore-orchestrator.js");
    const resumed = { nodeId: "n", logicalId: "seat", status: "resumed" as const };
    expect(rollupRestoreRigResult([resumed])).toBe("fully_restored");
    expect(rollupRestoreRigResult([{ ...resumed, restoreGaps: ["claude_activity_hooks: test gap"] }])).toBe("partially_restored");
  });

  // Real current-spec resolution: an agent.yaml on disk, read through the
  // shared reader restore-check uses — no stubbed selection.
  async function restoreWithRealSpec(selects: boolean, specExists = true) {
    const { createDesiredClaudeActivityHooksReader } = await import("../src/domain/desired-claude-activity-hooks.js");
    const f = seed(true, false);
    const specDir = path.join(root, "spec");
    if (specExists) {
      fs.mkdirSync(path.join(specDir, "runtime"), { recursive: true });
      fs.writeFileSync(path.join(specDir, "runtime/claude-activity-hooks.json"), "{}\n");
      fs.writeFileSync(path.join(specDir, "agent.yaml"), `name: impl
version: "1.0.0"
resources:
  skills: []
  runtime_resources:
    - id: claude-activity-hooks
      path: runtime/claude-activity-hooks.json
      runtime: claude-code
      type: claude_activity_hooks
profiles:
  default:
    uses:
      skills: []
      runtime_resources: ${selects ? "[claude-activity-hooks]" : "[]"}`);
    }
    db.prepare("UPDATE nodes SET agent_ref = ?, profile = ? WHERE id = ?").run(`path:${specDir}`, "default", f.node.id);
    const reader = createDesiredClaudeActivityHooksReader(db, { exists: fs.existsSync, readFile: (p) => fs.readFileSync(p, "utf8") });
    return { f, result: await restore(f, adapter, () => {}, reader) };
  }

  it("resolves the current selection from the real agent file and re-applies it", async () => {
    const { f, result } = await restoreWithRealSpec(true);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(owned().length).toBeGreaterThan(0);
    expect(result.result.warnings.some((w) => w.startsWith("Restore activity hooks:") && w.includes("current"))).toBe(true);
    expect(result.result.nodes[0].restoreGaps).toBeUndefined();
    expect(db.prepare("SELECT * FROM node_startup_context WHERE node_id=?").get(f.node.id)).toEqual(f.saved);
  });

  it("does not project when the real agent file does not select hooks", async () => {
    const { result } = await restoreWithRealSpec(false);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(owned()).toEqual([]);
    expect(result.result.warnings.some((w) => w.startsWith("Restore activity hooks:"))).toBe(false);
    expect(result.result.nodes[0].restoreGaps).toBeUndefined();
  });

  it("reports unknown when the real agent file is missing", async () => {
    const { result } = await restoreWithRealSpec(true, false);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(owned()).toEqual([]);
    expect(result.result.warnings.some((w) => w.includes("could not be determined"))).toBe(true);
    expect(result.result.nodes[0].restoreGaps).toBeUndefined();
  });
});
