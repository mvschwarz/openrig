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
import { PodRepository } from "../src/domain/pod-repository.js";
import { PodRigInstantiator } from "../src/domain/rigspec-instantiator.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { createDesiredClaudeActivityHooksReader, resolveDesiredClaudeActivityHooks } from "../src/domain/desired-claude-activity-hooks.js";
import { resolveAgentRef } from "../src/domain/agent-resolver.js";
import { RestoreCheckService } from "../src/domain/restore-check-service.js";
import { getNodeInventory } from "../src/domain/node-inventory.js";
import type { NodeLaunchRecipe } from "../src/domain/types.js";

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
    extraEntries: Array<{ category: string; effectiveId: string; absolutePath: string; mergeStrategy: string }> = [],
    extraFiles: Array<Record<string, unknown>> = []) {
    const rig = rigs.createRig("restore");
    if (pod) db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("pod", rig.id, "P");
    const node = rigs.addNode(rig.id, pod ? "p.seat" : "seat", { runtime, ...(seedCwd ? { cwd: seedCwd } : {}), ...(pod ? { podId: "pod" } : {}) });
    const session = registry.registerSession(node.id, "seat@restore");
    registry.updateStatus(session.id, "running");
    registry.updateResumeToken(session.id, runtime === "codex" ? "codex_id" : runtime === "pi" ? "pi_session_file" : "claude_id", token);
    const entries = [
      ...(selected ? [activity()] : []),
      { category: "guidance", effectiveId: "do-not-replay", sourceSpec: "saved", sourcePath: root, absolutePath: path.join(root, "missing-guidance.md"), mergeStrategy: "managed_block" },
      ...extraEntries,
    ];
    const files = [{ path: "missing.md", absolutePath: path.join(root, "missing.md"), ownerRoot: root, required: true, appliesOn: ["restore"] }, ...extraFiles];
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
  // must get no hooks write from this recovery. With a resume token, restore
  // tries its resume on an empty plan and names the gap, still with no hooks.
  it("a pod-aware seat with no startup context resumes with an empty plan and the gap named, and gets no claude hooks", async () => {
    const f = seed(true, false, "claude-code", false);
    const project = vi.spyOn(adapter, "project");
    const desired = vi.fn((): { status: "known"; selected: boolean } => ({ status: "known", selected: true }));
    const result = await restore(f, adapter, () => {}, desired);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // It reaches native resume, as a seat with a saved context does here (this fixture gives the joined proof no process).
    expect(adapter.launchHarness).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ resumeToken: token }));
    expect(result.result.nodes[0]).toMatchObject({
      status: "attention_required", error: expect.stringContaining("joined restore proof is incomplete"),
      restoreGaps: ["startup_context: no saved startup context; restore tried the saved conversation without replaying a saved startup plan."],
    });
    expect(result.result.warnings).toContain("Restore: p.seat: no saved startup context, so restore tries its saved conversation without replaying a saved startup plan.");
    expect(desired).not.toHaveBeenCalled();
    const claudeRecovery = project.mock.calls.find(([plan]) => plan.entries.some((e) => e.resourceType === "claude_activity_hooks"));
    expect(claudeRecovery).toBeUndefined();
    expect(owned()).toEqual([]);
    expect(result.result.warnings.some((w) => w.startsWith("Restore activity hooks:"))).toBe(false);
    // Nothing is written for it: it still has no saved startup context.
    expect(db.prepare("SELECT * FROM node_startup_context WHERE node_id=?").get(f.node.id)).toBeUndefined();
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
  async function restoreWithRealSpec(selects: boolean, specExists = true,
    ref: "path" | "local" | "local-unrecorded" | "same-name-import" | "builtin" | "ambiguous" = "path") {
    const { createDesiredClaudeActivityHooksReader } = await import("../src/domain/desired-claude-activity-hooks.js");
    const specDir = path.join(root, "spec");
    // A local: ref resolves at launch against the rig root, which a rig, pod or member startup file records as its owner.
    const rigDir = path.join(root, "rig");
    const culture = { path: "CULTURE.md", absolutePath: path.join(rigDir, "CULTURE.md"), ownerRoot: rigDir, deliveryHint: "guidance_merge",
      required: true, appliesOn: ["fresh_start", "restore"] };
    // A second recorded root that resolves the same ref to another folder holding a spec with the same name.
    const otherRigDir = path.join(root, "other/rig");
    const otherCulture = { ...culture, absolutePath: path.join(otherRigDir, "CULTURE.md"), ownerRoot: otherRigDir };
    if (ref === "ambiguous") {
      fs.mkdirSync(path.join(root, "other/spec"), { recursive: true });
      fs.writeFileSync(path.join(root, "other/spec/agent.yaml"), `name: impl
version: "1.0.0"
profiles:
  default:
    uses:
      runtime_resources: []`);
    }
    // The only saved origin is an import that shares the seat spec's name and selects no hooks.
    const importDir = path.join(root, "imported");
    const fromImport = { category: "skill", effectiveId: "impl-skill", sourceSpec: "impl", sourcePath: importDir, resourcePath: "skills/impl",
      absolutePath: path.join(importDir, "skills/impl"), mergeStrategy: "copy" };
    if (ref === "same-name-import") {
      fs.mkdirSync(importDir, { recursive: true });
      fs.writeFileSync(path.join(importDir, "agent.yaml"), `name: impl
version: "1.0.0"
profiles:
  default:
    uses:
      runtime_resources: []`);
    }
    // Launch records the folder it read the agent from as the owner root of the agent's own startup files.
    const roleOf = (dir: string) => ({ path: "guidance/role.md", absolutePath: path.join(dir, "guidance/role.md"), ownerRoot: dir,
      orientation: "role", deliveryHint: "send_text", required: true, appliesOn: ["fresh_start"] });
    const files = ref === "local" || ref === "builtin" ? [roleOf(specDir), culture]
      : ref === "ambiguous" ? [roleOf(specDir), culture, roleOf(path.join(root, "other/spec")), otherCulture] : [];
    const f = seed(true, false, "claude-code", true, cwd, ref === "same-name-import" ? [fromImport] : [], files);
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
    // A local: ref resolves against the rig spec's folder at launch, which nothing keeps; the node holds only the ref.
    db.prepare("UPDATE nodes SET agent_ref = ?, profile = ?, resolved_spec_name = ? WHERE id = ?")
      .run(ref === "path" ? `path:${specDir}` : ref === "builtin" ? "builtin:terminal" : "local:../spec", "default", "impl", f.node.id);
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

  function recipeForRoot(rigRoot: string, agentRef: string): NodeLaunchRecipe {
    return { version: 1, rigRoot, rigSpec: { version: "0.2", name: "recipe-root", edges: [],
      pods: [{ id: "p", label: "Builders", members: [{ id: "seat", agentRef, profile: "default", runtime: "claude-code", cwd }] }],
    } };
  }

  it("a saved recipe re-anchors a shipped local: agent instead of reading the old packaged selection", () => {
    const agentRef = "local:../../../agents/development/implementer";
    const olderSpecs = path.join(root, "old-prefix/lib/node_modules/@openrig/cli/daemon/specs");
    const olderRoot = path.join(olderSpecs, "rigs/launch/demo");
    const olderAgent = path.join(olderSpecs, "agents/development/implementer");
    fs.mkdirSync(olderRoot, { recursive: true });
    fs.mkdirSync(olderAgent, { recursive: true });
    fs.writeFileSync(path.join(olderRoot, "rig.yaml"), "version: '0.2'\nname: recipe-root\npods: []\n");
    fs.writeFileSync(path.join(olderAgent, "agent.yaml"), "name: implementer\nversion: '1.0'\nprofiles:\n  default:\n    uses:\n      runtime_resources: []\n");
    const recipe = recipeForRoot(olderRoot, agentRef);
    const rig = rigs.createRig("recipe-shipped");
    const node = rigs.addNode(rig.id, "p.seat", { runtime: "claude-code", cwd, launchRecipe: recipe });
    db.prepare("UPDATE nodes SET agent_ref = ?, profile = ?, resolved_spec_name = ? WHERE id = ?")
      .run(agentRef, "default", "implementer", node.id);
    expect(rigs.getNodeLaunchRecipe(node.id)).toEqual(recipe);
    expect(path.isAbsolute(rigs.getNodeLaunchRecipe(node.id)!.rigRoot)).toBe(true);
    expect(db.prepare("SELECT * FROM node_startup_context WHERE node_id=?").get(node.id)).toBeUndefined();
    const readerFs = { exists: fs.existsSync, readFile: (p: string) => fs.readFileSync(p, "utf8") };
    const saved = { resolvedSpecName: "implementer", resolvedStartupFiles: [] };
    expect(resolveDesiredClaudeActivityHooks(`path:${olderAgent}`, "default", readerFs)).toEqual({ status: "known", selected: false });
    const currentAgent = path.resolve(import.meta.dirname, "../specs/agents/development/implementer");
    expect(resolveDesiredClaudeActivityHooks(`path:${currentAgent}`, "default", readerFs)).toEqual({ status: "known", selected: true });
    expect(resolveDesiredClaudeActivityHooks(agentRef, "default", readerFs, saved)).toMatchObject({ status: "unknown" });
    const desired = createDesiredClaudeActivityHooksReader(db, readerFs)(node.id);
    expect(desired).toEqual({ status: "known", selected: true });
    expect(rigs.getNodeLaunchRecipe(node.id)).toEqual(recipe);
    console.info("PR2617_P3_REANCHOR", { desired, oldSelection: false, currentSelection: true, savedRecipeUnchanged: true });
  });

  it.each([
    { rootKind: "absolute", expectedOutcome: "known-selected with hook projection" },
    { rootKind: "relative", expectedOutcome: "unknown/no projection" },
  ])("a valid-shape $rootKind recipe root expects $expectedOutcome", async ({ rootKind }) => {
    const actualRoot = path.join(root, "recipe-agent");
    fs.mkdirSync(path.join(actualRoot, "runtime"), { recursive: true });
    fs.writeFileSync(path.join(actualRoot, "runtime/activity.json"), "{}\n");
    fs.writeFileSync(path.join(actualRoot, "agent.yaml"), `name: impl
version: "1.0.0"
resources:
  runtime_resources:
    - id: activity
      path: runtime/activity.json
      runtime: claude-code
      type: claude_activity_hooks
profiles:
  default:
    uses:
      runtime_resources: [activity]
`);
    const rigRoot = rootKind === "absolute" ? actualRoot : path.relative(process.cwd(), actualRoot);
    expect(path.isAbsolute(rigRoot)).toBe(rootKind === "absolute");
    expect(path.resolve(rigRoot)).toBe(actualRoot);
    const recipe = recipeForRoot(rigRoot, "local:.");
    const f = seed(true, false);
    db.prepare("UPDATE nodes SET agent_ref = ?, profile = ?, resolved_spec_name = ?, launch_recipe_json = ? WHERE id = ?")
      .run("local:.", "default", "impl", JSON.stringify(recipe), f.node.id);
    expect(rigs.getNodeLaunchRecipe(f.node.id)).toEqual(recipe);
    const readerFs = { exists: fs.existsSync, readFile: (p: string) => fs.readFileSync(p, "utf8") };
    expect(resolveDesiredClaudeActivityHooks(`path:${actualRoot}`, "default", readerFs)).toEqual({ status: "known", selected: true });
    // Test the resolver directly: the reader's earlier absolute-root check otherwise hides this guard.
    const direct = resolveDesiredClaudeActivityHooks("local:.", "default", readerFs,
      { resolvedSpecName: "impl", resolvedStartupFiles: [], rigRoot });
    const read = createDesiredClaudeActivityHooksReader(db, readerFs);
    const desired = read(f.node.id);
    if (rootKind === "absolute") {
      expect(direct).toEqual({ status: "known", selected: true });
      expect(desired).toEqual({ status: "known", selected: true });
    } else {
      expect(direct).toMatchObject({ status: "unknown" });
      expect(desired).toMatchObject({ status: "unknown" });
    }
    const project = vi.spyOn(adapter, "project");
    const sentAtRestore = vi.mocked(tmux.sendText).mock.calls.length;
    const result = await restore(f, adapter, () => {}, read);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    if (rootKind === "absolute") expect(owned().length).toBeGreaterThan(0);
    else expect(owned()).toEqual([]);
    expect(result.result.warnings.some(w => w.startsWith("Restore activity hooks:") && w.includes("could not be determined")))
      .toBe(rootKind === "relative");
    const recovery = project.mock.calls.filter(([p]) => p.entries.some(e => e.resourceType === "claude_activity_hooks"));
    expect(recovery).toHaveLength(rootKind === "absolute" ? 1 : 0);
    if (recovery.length) expect(recovery[0]![0].startup).toEqual({ files: [], actions: [] });
    expect(tmux.sendText).toHaveBeenCalledTimes(sentAtRestore);
    expect(db.prepare("SELECT * FROM node_startup_context WHERE node_id=?").get(f.node.id)).toEqual(f.saved);
    expect(settings().hooks.Stop).toContainEqual(userHook);
    expect(settings().env).toEqual(originalSettings.env);
    console.info("PR2617_P3_ROOT", { rootKind, direct, desired, projectedHookCount: owned().length, savedContextUnchanged: true });
  });

  it.each([
    { ref: "path" as const, evidence: "Current agent specification could not be resolved" },
    { ref: "local" as const, evidence: "wasn't found" },
  ])("reports an absent agent file for a $ref reference", async ({ ref, evidence }) => {
    const { f, result } = await restoreWithRealSpec(true, false, ref);
    expect(fs.existsSync(path.join(root, "spec/agent.yaml"))).toBe(false);
    const desired = createDesiredClaudeActivityHooksReader(db, { exists: fs.existsSync, readFile: p => fs.readFileSync(p, "utf8") })(f.node.id);
    expect(desired).toMatchObject({ status: "unknown", evidence: expect.stringContaining(evidence) });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(owned()).toEqual([]);
    expect(result.result.warnings.some((w) => w.includes("could not be determined") && w.includes(evidence)),
      JSON.stringify(result.result.warnings)).toBe(true);
    expect(result.result.nodes[0].restoreGaps).toBeUndefined();
    expect(db.prepare("SELECT * FROM node_startup_context WHERE node_id=?").get(f.node.id)).toEqual(f.saved);
    expect(settings().hooks.Stop).toContainEqual(userHook);
    expect(settings().env).toEqual(originalSettings.env);
  });

  // #1530 follow-up: a local: agent (a shipped-spec seat) resolves as at launch, against the rig root its saved launch
  // recorded, and gets its hooks back like a path: agent.
  it("re-applies the current selection for a local: agent resolved against its recorded rig root", async () => {
    const { f, result } = await restoreWithRealSpec(true, true, "local");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.warnings.some((w) => w.includes("could not be determined")), JSON.stringify(result.result.warnings)).toBe(false);
    expect(owned().length).toBeGreaterThan(0);
    expect(result.result.nodes[0].restoreGaps).toBeUndefined();
    expect(db.prepare("SELECT * FROM node_startup_context WHERE node_id=?").get(f.node.id)).toEqual(f.saved);
  });

  // The control reads unknown because the agent can't be located from the recorded roots, not because the reader failed.
  it("control: a local: agent its saved launch doesn't locate stays unknown, and nothing is projected", async () => {
    const { result } = await restoreWithRealSpec(true, true, "local-unrecorded");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(owned()).toEqual([]);
    expect(result.result.warnings.some((w) => w.includes("could not be determined") && w.includes("against a rig root its last launch recorded")),
      JSON.stringify(result.result.warnings)).toBe(true);
    expect(result.result.nodes[0].restoreGaps).toBeUndefined();
  });

  // A resource origin can't prove the seat's spec, since an import may share its name. With no recorded rig root, the
  // selection stays unknown and restore warns, rather than reading the import's selection as the seat's.
  it("a same-name import as the only saved origin stays unknown and warns", async () => {
    const { result } = await restoreWithRealSpec(true, true, "same-name-import");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(owned()).toEqual([]);
    expect(result.result.warnings.some((w) => w.includes("could not be determined") && w.includes("against a rig root its last launch recorded")),
      JSON.stringify(result.result.warnings)).toBe(true);
    expect(result.result.nodes[0].restoreGaps).toBeUndefined();
  });

  // Two recorded roots resolve the ref to two folders whose specs share the seat's name: ambiguous, so unknown, never a pick.
  it("a local: agent that resolves to two same-name folders stays unknown and warns", async () => {
    const { result } = await restoreWithRealSpec(true, true, "ambiguous");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(owned()).toEqual([]);
    expect(result.result.warnings.some((w) => w.includes("could not be determined") && w.includes("resolved to more than one folder")),
      JSON.stringify(result.result.warnings)).toBe(true);
    expect(result.result.nodes[0].restoreGaps).toBeUndefined();
  });

  // Launch resolves no builtin: agent ref against a folder, so a recorded rig root proves nothing for one: it stays unknown.
  it("a builtin: agent ref stays unknown even with a recorded rig root, and nothing is projected", async () => {
    const { result } = await restoreWithRealSpec(true, true, "builtin");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(owned()).toEqual([]);
    expect(result.result.warnings.some((w) => w.includes("could not be determined") && w.includes("no established absolute source location")),
      JSON.stringify(result.result.warnings)).toBe(true);
    expect(result.result.nodes[0].restoreGaps).toBeUndefined();
  });

  // A rig root stored under an older install's shipped specs is re-anchored first, as the runtime switch reads startup
  // files (#261), so a shipped agent resolves in the running install.
  it("re-anchors a rig root stored under an older install before resolving a shipped local: agent", async () => {
    const { createDesiredClaudeActivityHooksReader } = await import("../src/domain/desired-claude-activity-hooks.js");
    const rig = rigs.createRig("older-install");
    const node = rigs.addNode(rig.id, "impl", { runtime: "claude-code", cwd });
    db.prepare("UPDATE nodes SET agent_ref = ?, profile = ?, resolved_spec_name = ? WHERE id = ?")
      .run("local:../../../agents/development/implementer", "default", "implementer", node.id);
    const olderSpecs = path.join(root, "old-prefix/lib/node_modules/@openrig/cli/daemon/specs");
    const olderRoot = path.join(olderSpecs, "rigs/launch/demo");
    const olderAgent = path.join(olderSpecs, "agents/development/implementer");
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, '[]', ?, '[]', 'claude-code')")
      .run(node.id, JSON.stringify([
        { path: "guidance/role.md", absolutePath: path.join(olderAgent, "guidance/role.md"), ownerRoot: olderAgent, orientation: "role",
          deliveryHint: "send_text", required: true, appliesOn: ["fresh_start"] },
        { path: "CULTURE.md", absolutePath: path.join(olderRoot, "CULTURE.md"), ownerRoot: olderRoot,
          deliveryHint: "guidance_merge", required: true, appliesOn: ["fresh_start", "restore"] }]));
    const read = createDesiredClaudeActivityHooksReader(db, { exists: fs.existsSync, readFile: (p) => fs.readFileSync(p, "utf8") });
    // The running install's implementer selects shared:claude-activity-hooks in its default profile.
    expect(read(node.id)).toEqual({ status: "known", selected: true });
  });

  // Launched from rig/ with local:agents/impl, the saved launch records only the agent's own folder. A same-name spec
  // nested at agents/impl inside it is where the ref lands from that folder, but launch recorded no such folder: unknown.
  it("a same-name spec nested where the ref lands from the agent's own folder stays unknown", async () => {
    const { createDesiredClaudeActivityHooksReader } = await import("../src/domain/desired-claude-activity-hooks.js");
    const agentDir = path.join(root, "rig/agents/impl");
    for (const dir of [agentDir, path.join(agentDir, "agents/impl")]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "agent.yaml"), `name: impl\nversion: "1.0.0"\nprofiles:\n  default:\n    uses:\n      runtime_resources: []`);
    }
    const rig = rigs.createRig("nested");
    const node = rigs.addNode(rig.id, "impl", { runtime: "claude-code", cwd });
    db.prepare("UPDATE nodes SET agent_ref = ?, profile = ?, resolved_spec_name = ? WHERE id = ?")
      .run("local:agents/impl", "default", "impl", node.id);
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, '[]', ?, '[]', 'claude-code')")
      .run(node.id, JSON.stringify([{ path: "guidance/role.md", absolutePath: path.join(agentDir, "guidance/role.md"), ownerRoot: agentDir,
        orientation: "role", deliveryHint: "send_text", required: true, appliesOn: ["fresh_start"] }]));
    const read = createDesiredClaudeActivityHooksReader(db, { exists: fs.existsSync, readFile: (p) => fs.readFileSync(p, "utf8") });
    expect(read(node.id)).toMatchObject({ status: "unknown" });
  });

  it.each([
    ...[false, true].flatMap(selects => [
      { placement: "ordinary", selects, startupFiles: true, recipe: "valid", specExists: true },
      { placement: "ordinary", selects, startupFiles: false, recipe: "valid", specExists: true },
      { placement: "added", selects, startupFiles: true, recipe: "valid", specExists: true },
      { placement: "added", selects, startupFiles: true, recipe: "missing", specExists: true },
      { placement: "added", selects, startupFiles: true, recipe: "malformed", specExists: true },
      { placement: "added", selects, startupFiles: true, recipe: "invalid-root", specExists: true },
    ]),
    { placement: "added", selects: true, startupFiles: true, recipe: "valid", specExists: false },
    { placement: "retained-development", selects: false, startupFiles: true, recipe: "valid", specExists: true },
    { placement: "retained-development-non-dot", selects: false, startupFiles: true, recipe: "valid", specExists: true },
    { placement: "retained-development-reverse", selects: true, startupFiles: true, recipe: "valid", specExists: true },
    { placement: "retained-development-missing-agent", selects: false, startupFiles: true, recipe: "valid", specExists: false },
  ].map(row => ({ ...row,
    agentRef: row.placement === "retained-development-non-dot" ? "local:../../../agents/development/implementer" : "local:.",
    expectedOutcome: row.placement === "retained-development-missing-agent" ? "known-selected after re-anchoring"
      : row.recipe === "valid" && row.specExists ? row.selects ? "known-selected" : "known-unselected" : "unknown/no projection" })))
    ("a $placement $agentRef seat expects $expectedOutcome (recipe=$recipe, selection=$selects, files=$startupFiles, spec=$specExists)",
    async ({ placement, selects, startupFiles, recipe, specExists, agentRef }) => {
    const originalRoot = path.join(root, "original-rig");
    const development = placement.startsWith("retained-development");
    const nonDot = placement === "retained-development-non-dot";
    const reverse = placement === "retained-development-reverse";
    const missingDevelopmentAgent = placement === "retained-development-missing-agent";
    const expectedSelection = missingDevelopmentAgent ? true : selects;
    const specName = development ? "implementer" : "impl";
    const currentProfile = development ? "default" : "current";
    const actualRoot = development ? path.join(root, "checkout/packages/daemon/specs/agents/development/implementer")
      : placement === "ordinary" ? originalRoot : path.join(root, "added-agent");
    const rigRoot = nonDot ? path.join(root, "checkout/packages/daemon/specs/rigs/development/retained") : actualRoot;
    const runningAgent = path.resolve(import.meta.dirname, "../specs/agents/development/implementer");
    const modeledRunningAgent = path.join(root, "modeled-running/implementer");
    const writeAgent = (dir: string, selected: boolean, defaultSelected = selected) => {
      fs.mkdirSync(path.join(dir, "runtime"), { recursive: true });
      fs.writeFileSync(path.join(dir, "runtime/activity.json"), "{}\n");
      fs.writeFileSync(path.join(dir, "agent.yaml"), `name: ${specName}
version: "1.0.0"
resources:
  runtime_resources:
    - id: activity
      path: runtime/activity.json
      runtime: claude-code
      type: claude_activity_hooks
profiles:
  default:
    uses:
      runtime_resources: ${defaultSelected ? "[activity]" : "[]"}
  current:
    uses:
      runtime_resources: ${selected ? "[activity]" : "[]"}
`);
    };
    writeAgent(originalRoot, !selects);
    // Start without hooks. Ordinary/added rows later switch profiles; the retained
    // development row keeps its default profile opposite to the running source.
    writeAgent(actualRoot, false);
    fs.writeFileSync(path.join(originalRoot, "CULTURE.md"), "Original rig culture.\n");
    const nodeLauncher = new NodeLauncher({ db, rigRepo: rigs, sessionRegistry: registry, eventBus: events, tmuxAdapter: tmux });
    const instantiator = new PodRigInstantiator({ db, rigRepo: rigs, podRepo: new PodRepository(db), sessionRegistry: registry,
      eventBus: events, nodeLauncher, tmuxAdapter: tmux,
      startupOrchestrator: new StartupOrchestrator({ db, sessionRegistry: registry, eventBus: events, tmuxAdapter: tmux }),
      fsOps: { exists: fs.existsSync, readFile: p => fs.readFileSync(p, "utf8") },
      adapters: { "claude-code": adapter }, onboardingEnabledResolver: () => false, exec: async () => "" });
    const authoredYaml = `version: "0.2"
name: origin-1530
${startupFiles ? "culture_file: CULTURE.md" : ""}
pods:
  - id: p
    label: Builders
    members:
      - id: ${placement === "ordinary" ? "seat" : "existing"}
        runtime: ${placement === "ordinary" ? "claude-code" : "terminal"}
        agent_ref: ${placement === "ordinary" ? "local:." : "builtin:terminal"}
        profile: ${placement === "ordinary" ? "default" : "none"}
        cwd: ${cwd}
`;
    if (nonDot || missingDevelopmentAgent) {
      fs.mkdirSync(rigRoot, { recursive: true });
      fs.writeFileSync(path.join(rigRoot, "rig.yaml"), authoredYaml);
    }
    const materialized = await instantiator.materialize(authoredYaml, originalRoot);
    expect(materialized.ok, JSON.stringify(materialized)).toBe(true);
    if (!materialized.ok) return;
    const rigId = materialized.result.rigId;
    if (placement === "ordinary") {
      const launched = await instantiator.launchMaterialized(authoredYaml, originalRoot, rigId);
      expect(launched.ok, JSON.stringify(launched)).toBe(true);
      if (!launched.ok) return;
      expect(launched.result.nodes, JSON.stringify(launched)).toEqual([
        expect.objectContaining({ logicalId: "p.seat", status: "launched" }),
      ]);
    }
    if (placement !== "ordinary") {
      const added = await instantiator.addMemberToPod(rigId, "p", {
        id: "seat", runtime: "claude-code", agent_ref: agentRef, profile: "default", cwd,
      }, rigRoot);
      expect(added.ok, JSON.stringify(added)).toBe(true);
      if (!added.ok) return;
      expect(added.result.node.status, JSON.stringify(added)).not.toBe("failed");
    }
    const node = rigs.getRig(rigId)!.nodes.find(n => n.logicalId === "p.seat")!;
    expect(node).toMatchObject({ agentRef, resolvedSpecName: specName });
    const recordedRecipe = rigs.getNodeLaunchRecipe(node.id);
    expect(recordedRecipe).toMatchObject({ version: 1, rigRoot });
    expect(recordedRecipe!.rigSpec.pods[0]!.members.find(member => member.id === "seat")).toMatchObject({ agentRef, profile: "default" });
    expect(path.resolve(rigRoot, agentRef.slice("local:".length))).toBe(actualRoot);
    expect(fs.existsSync(path.join(actualRoot, "agent.yaml"))).toBe(true);
    const persisted = db.prepare("SELECT resolved_files_json FROM node_startup_context WHERE node_id=?").get(node.id);
    expect(persisted).toBeDefined();
    // Explicit legacy empty-files control, after real first-launch persistence; built-in files may have been saved.
    if (!startupFiles) db.prepare("UPDATE node_startup_context SET resolved_files_json = ? WHERE node_id=?").run("[]", node.id);
    const saved = db.prepare("SELECT * FROM node_startup_context WHERE node_id=?").get(node.id) as {
      runtime: string; resolved_files_json: string; projection_entries_json: string; startup_actions_json: string;
    };
    expect(saved).toBeDefined();
    const files = JSON.parse(saved.resolved_files_json) as Array<{ ownerRoot: string; absolutePath: string }>;
    if (startupFiles) {
      expect(files).toContainEqual(expect.objectContaining({ ownerRoot: originalRoot, absolutePath: path.join(originalRoot, "CULTURE.md") }));
    } else expect(files).toEqual([]);
    if (placement !== "ordinary") expect(files.some(file => file.ownerRoot === actualRoot)).toBe(false);
    expect(JSON.parse(saved.projection_entries_json).some((entry: ProjectionEntry) => entry.resourceType === "claude_activity_hooks")).toBe(false);
    expect(owned()).toEqual([]);
    // The saved recipe names the launch profile; the live node's profile and current file decide recovery.
    writeAgent(actualRoot, selects, development ? selects : !selects);
    db.prepare("UPDATE nodes SET profile = ? WHERE id = ?").run(currentProfile, node.id);
    if (recipe !== "valid") {
      const damaged = recipe === "missing" ? null : recipe === "malformed" ? "{unreadable recipe"
        : JSON.stringify({ ...recordedRecipe, rigRoot: 42 });
      db.prepare("UPDATE nodes SET launch_recipe_json = ? WHERE id = ?").run(damaged, node.id);
      expect(rigs.getNodeLaunchRecipe(node.id)).toBeNull();
    }
    const realReaderFs = { exists: fs.existsSync, readFile: (p: string) => fs.readFileSync(p, "utf8") };
    if (missingDevelopmentAgent) {
      expect(fs.existsSync(path.join(rigRoot, "rig.yaml"))).toBe(true);
      expect(resolveDesiredClaudeActivityHooks(`path:${actualRoot}`, currentProfile, realReaderFs)).toEqual({ status: "known", selected: false });
    }
    if (!specExists) fs.rmSync(path.join(actualRoot, "agent.yaml"));
    if (reverse) writeAgent(modeledRunningAgent, false);
    // Only the running alternative's filesystem view is modeled; the saved source,
    // re-anchor helper, resolver, profile checks and restore path remain real.
    const readerPath = (p: string) => reverse && (p === runningAgent || p.startsWith(runningAgent + path.sep))
      ? path.join(modeledRunningAgent, path.relative(runningAgent, p)) : p;
    const readerFs = { exists: (p: string) => fs.existsSync(readerPath(p)), readFile: (p: string) => fs.readFileSync(readerPath(p), "utf8") };
    if (specExists) expect(resolveDesiredClaudeActivityHooks(`path:${actualRoot}`, currentProfile, readerFs)).toEqual({ status: "known", selected: selects });
    if (placement !== "ordinary") expect(resolveDesiredClaudeActivityHooks(`path:${originalRoot}`, currentProfile, readerFs)).toEqual({ status: "known", selected: !selects });
    if (development) {
      expect(fs.existsSync(path.join(actualRoot, "agent.yaml"))).toBe(specExists);
      expect(fs.existsSync(path.join(rigRoot, "rig.yaml"))).toBe(nonDot || missingDevelopmentAgent);
      expect(fs.existsSync(path.join(runningAgent, "agent.yaml"))).toBe(true);
      expect(resolveDesiredClaudeActivityHooks(`path:${runningAgent}`, currentProfile, realReaderFs)).toEqual({ status: "known", selected: true });
      const running = resolveAgentRef(`path:${runningAgent}`, runningAgent, readerFs);
      expect(running.ok).toBe(true);
      if (!running.ok) return;
      expect(running.resolved.spec.name).toBe(specName);
      expect(resolveDesiredClaudeActivityHooks(`path:${runningAgent}`, currentProfile, readerFs)).toEqual({ status: "known", selected: !reverse });
      if (nonDot) {
        expect(agentRef).not.toBe("local:.");
        expect(rigRoot).not.toBe(actualRoot);
        expect(fs.existsSync(path.join(rigRoot, "agent.yaml"))).toBe(false);
      }
    }
    const read = createDesiredClaudeActivityHooksReader(db, readerFs);
    const desired = read(node.id);
    const known = recipe === "valid" && (specExists || missingDevelopmentAgent);
    if (known) expect.soft(desired, "the validated recipe locates this seat's current agent").toEqual({ status: "known", selected: expectedSelection });
    else expect.soft(desired, "unusable source evidence must not borrow the same-name old rig agent").toMatchObject({ status: "unknown" });
    if (recipe !== "valid") expect.soft(desired).toMatchObject({ evidence: expect.stringMatching(/independent.*source|source.*independent/i) });
    const session = registry.getSessionsForRig(rigId).find(s => s.nodeId === node.id)!;
    registry.updateResumeToken(session.id, "claude_id", token);
    const snap = capture.captureSnapshot(rigId, "manual", { intendedNodeIds: [node.id] });
    const check = new RestoreCheckService({ stateDir: path.join(root, "state"),
      listRigs: () => [{ rigId, name: "origin-1530" }], getNodeInventory: id => getNodeInventory(db, id),
      getStartupContext: () => ({ status: "ok", runtime: saved.runtime,
        resolvedStartupFiles: JSON.parse(saved.resolved_files_json), projectionEntries: JSON.parse(saved.projection_entries_json) }),
      hasSnapshot: () => true, getRestoreInputs: () => ({ snapshot: snap, servicesRecord: null }),
      probeDaemonHealth: () => ({ healthy: true, evidence: "isolated fixture" }),
      probeQueueStore: () => ({ available: true, evidence: "isolated SQLite" }),
      exists: readerFs.exists, readFile: readerFs.readFile, getDesiredClaudeActivityHooks: read,
    }).check({});
    const hookCheck = check.checks.find(item => item.check === `seat.${session.sessionName}.hooks`);
    expect.soft(hookCheck, "known-unselected is green; selected hooks absent from saved context are stale, not unknown").toMatchObject({
      status: known && !expectedSelection ? "green" : "yellow",
      evidence: expect.stringContaining(known ? expectedSelection ? "Current desired activity hooks are selected" : "not selected" : "unknown"),
    });
    if (recipe !== "valid") expect.soft(hookCheck).toMatchObject({ evidence: expect.stringMatching(/independent.*source|source.*independent/i) });
    registry.updateStatus(session.id, "exited");
    db.prepare("DELETE FROM bindings WHERE node_id=?").run(node.id);
    const project = vi.spyOn(adapter, "project");
    const sentAtRestore = vi.mocked(tmux.sendText).mock.calls.length;
    const result = await restore({ rig: rigs.getRig(rigId)!.rig, node, snap, saved }, adapter, () => {}, read);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    if (known && expectedSelection) expect.soft(owned().length, "current selected hooks must be recovered").toBeGreaterThan(0);
    else expect.soft(owned(), "unselected or unknown sources must not project current hooks").toEqual([]);
    expect.soft(result.result.warnings.some(w => w.startsWith("Restore activity hooks:") && w.includes("could not be determined")),
      JSON.stringify(result.result.warnings)).toBe(!known);
    if (known) {
      expect.soft(result.result.warnings.some(w => w.startsWith("Restore activity hooks:") && w.includes("current marker was re-applied"))).toBe(expectedSelection);
      expect.soft(result.result.nodes[0].restoreGaps).toBeUndefined();
    } else {
      expect.soft(result.result.warnings.some(w => w.startsWith("Restore activity hooks:") && w.includes("current marker was re-applied"))).toBe(false);
    }
    const recovery = project.mock.calls.filter(([p]) => p.entries.some(e => e.resourceType === "claude_activity_hooks"));
    expect.soft(recovery).toHaveLength(known && expectedSelection ? 1 : 0);
    if (recovery.length) expect.soft(recovery[0]![0].startup).toEqual({ files: [], actions: [] });
    expect(db.prepare("SELECT * FROM node_startup_context WHERE node_id=?").get(node.id)).toEqual(saved);
    if (recipe === "valid") expect(rigs.getNodeLaunchRecipe(node.id)).toEqual(recordedRecipe);
    expect(settings().hooks.Stop).toContainEqual(userHook);
    expect(settings().env).toEqual(originalSettings.env);
    expect(tmux.sendText).toHaveBeenCalledTimes(sentAtRestore);
    console.info("PR2617_RECIPE", { placement, recipe, specExists, startupFiles, legacyEmptyFiles: !startupFiles, actualSelection: selects, oldRootSelection: !selects,
      recordedRigRoot: recordedRecipe?.rigRoot, actualRoot, currentProfile,
      savedOwnerRoots: files.map(file => file.ownerRoot), desired, hookCheck,
      projectedHookCount: owned().length, warnings: result.result.warnings, savedContextUnchanged: true });
    if (nonDot || reverse || missingDevelopmentAgent) console.info("PR2617_INPUT_STATE", JSON.stringify({
      placement, agentRef, rigRoot, actualRoot, currentProfile, expectedSelection,
      targetAgentPresent: fs.existsSync(path.join(actualRoot, "agent.yaml")), rigYamlPresent: fs.existsSync(path.join(rigRoot, "rig.yaml")),
      misleadingRootAgentPresent: fs.existsSync(path.join(rigRoot, "agent.yaml")),
      runningInput: reverse ? "modeled reader-FS view backed by owned fixture files" : "checked-out running source",
      runningSelection: !reverse, retainedSelectionBeforeRemoval: selects, recordedRecipe,
      savedOwnerRoots: files.map(file => file.ownerRoot), desired, hookCheck, projectedHookCount: owned().length,
      recoveryCount: recovery.length, warnings: result.result.warnings, savedContextUnchanged: true,
    }));
  });
});
