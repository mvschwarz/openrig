import { it, expect, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { RestoreCheckService } from "../src/domain/restore-check-service.js";
import { getNodeInventory } from "../src/domain/node-inventory.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { resolveAgentRef } from "../src/domain/agent-resolver.js";
import { resolveNodeConfig } from "../src/domain/profile-resolver.js";
import { deriveRelayEvents, claudeActivityRelayPath } from "../src/domain/claude-activity-hooks.js";

const cases = [
  { plugin: false, wantsHooks: true, savedResource: false },
  { plugin: true, wantsHooks: true, savedResource: false },
  { plugin: false, wantsHooks: false, savedResource: false },
  { plugin: true, wantsHooks: false, savedResource: false },
  { plugin: false, wantsHooks: true, savedResource: true },
  { plugin: true, wantsHooks: true, savedResource: true },
];
const token = "74398f0a-6dbd-41b6-897e-e3ed4d36787f";

async function invokeRelay(script: string, args: string[], env: Record<string, string>) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env, stdio: ["pipe", "ignore", "pipe"] });
    let error = "";
    child.stderr.on("data", b => { error += b; });
    const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("owned relay fixture exceeded 5 seconds")); }, 5000);
    child.on("error", e => { clearTimeout(timer); reject(e); });
    child.on("close", code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error(`relay exit ${code}: ${error}`)); });
    child.stdin.end(JSON.stringify({ hook_event_name: "Stop", cwd: env.CLAUDE_PROJECT_DIR }));
  });
}

it.each(cases)("contained resume matrix %j", async scenario => {
  const db = createFullTestDb();
  const root = fs.mkdtempSync(path.join(tmpdir(), "i1530-"));
  const cwd = path.join(root, "project"), stateDir = path.join(root, "state");
  const pluginsDir = path.join(stateDir, "plugins"), vendored = path.join(pluginsDir, "openrig-core");
  const settingsPath = path.join(cwd, ".claude", "settings.local.json");
  const shipped = path.resolve(import.meta.dirname, "../assets/plugins/openrig-core");
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.mkdirSync(path.join(vendored, ".claude-plugin"), { recursive: true });
  fs.copyFileSync(path.join(shipped, ".claude-plugin/plugin.json"), path.join(vendored, ".claude-plugin/plugin.json"));
  fs.cpSync(path.join(shipped, "hooks"), path.join(vendored, "hooks"), { recursive: true });
  const originalSettings = { env: { USER_SETTING: "keep" }, hooks: { Stop: [{ matcher: "user-only", hooks: [{ type: "command", command: "echo user-hook" }] }] } };
  fs.writeFileSync(settingsPath, JSON.stringify(originalSettings));
  const posts: any[] = [];
  const server = createServer((req, res) => {
    let text = ""; req.on("data", b => { text += b; }); req.on("end", () => { posts.push({ url: req.url, payload: JSON.parse(text) }); res.writeHead(200); res.end("{}"); });
  });
  await new Promise<void>(resolve => { server.listen(0, "127.0.0.1", resolve); });
  try {
    const addr = server.address() as { port: number };
    const rigs = new RigRepository(db), registry = new SessionRegistry(db), events = new EventBus(db);
    const snapshots = new SnapshotRepository(db), checkpoints = new CheckpointStore(db);
    const capture = new SnapshotCapture({ db, rigRepo: rigs, sessionRegistry: registry, eventBus: events, snapshotRepo: snapshots, checkpointStore: checkpoints });
    const rig = rigs.createRig("i1530");
    db.prepare("INSERT INTO pods (id,rig_id,label) VALUES ('p',?,'Fixture')").run(rig.id);
    const specDir = path.join(root, "agent"); fs.mkdirSync(specDir);
    const profile = scenario.wantsHooks ? "with-hooks" : "hookless";
    const node = rigs.addNode(rig.id, "p.seat", { runtime: "claude-code", cwd, podId: "p", agentRef: `path:${specDir}`, profile });
    const old = registry.registerSession(node.id, "p-seat@i1530");
    registry.updateStatus(old.id, "running"); registry.updateResumeToken(old.id, "claude_id", token);
    const marker = { category: "runtime_resource", resourceType: "claude_activity_hooks", effectiveId: "activity", sourceSpec: "saved", sourcePath: "/old/specs", resourcePath: "activity", absolutePath: "/old/specs/activity", classification: "safe_projection" };
    const entries = [ ...(scenario.plugin ? [{ category: "plugin", absolutePath: vendored, effectiveId: "saved-core", sourceSpec: "saved" }] : []), ...(scenario.savedResource ? [marker] : []) ];
    const actions = [{ type: "send_text", value: "DO NOT REPLAY", phase: "after_ready", appliesOn: ["restore"], idempotent: true }];
    db.prepare("INSERT INTO node_startup_context (node_id,projection_entries_json,resolved_files_json,startup_actions_json,runtime) VALUES (?,?,'[]',?,'claude-code')").run(node.id, JSON.stringify(entries), JSON.stringify(actions));
    const saved = db.prepare("SELECT * FROM node_startup_context WHERE node_id=?").get(node.id);
    const snap = capture.captureSnapshot(rig.id, "manual");
    registry.updateStatus(old.id, "exited"); db.prepare("DELETE FROM bindings WHERE node_id=?").run(node.id);

    // Today's profile is separately resolved, never projected or substituted for the saved context.
    fs.writeFileSync(path.join(specDir, "agent.yaml"), `name: fixture-agent\nversion: "1.0.0"\nresources:\n  runtime_resources:\n    - id: claude-activity-hooks\n      path: hooks.json\n      runtime: claude-code\n      type: claude_activity_hooks\nprofiles:\n  with-hooks:\n    uses:\n      runtime_resources: [claude-activity-hooks]\n  hookless:\n    uses:\n      runtime_resources: []\n`);
    const resolved = resolveAgentRef(`path:${specDir}`, root, { exists: fs.existsSync, readFile: f => fs.readFileSync(f, "utf8") });
    expect(resolved.ok).toBe(true); if (!resolved.ok) throw new Error(JSON.stringify(resolved));
    const member = { id: "seat", agentRef: `path:${specDir}`, profile, runtime: "claude-code", cwd };
    const pod = { id: "p", label: "Fixture", members: [member], edges: [] };
    const current = resolveNodeConfig({ baseSpec: resolved.resolved, importedSpecs: resolved.imports, collisions: resolved.collisions, profileName: profile, member, pod, rig: { version: "0.2", name: "i1530", pods: [pod], edges: [] } });
    expect(current.ok).toBe(true); if (!current.ok) throw new Error(JSON.stringify(current));
    expect(current.config.selectedResources.runtimeResources).toHaveLength(scenario.wantsHooks ? 1 : 0);

    const launchEnvs: Array<Record<string,string>> = [];
    const tmux = { createSession: vi.fn(async (_s, _c, env) => { launchEnvs.push(env); return { ok: true }; }), killSession: vi.fn(async () => ({ ok: true })), hasSession: async () => false,
      sendText: vi.fn(async () => ({ ok: true })), sendKeys: vi.fn(async () => ({ ok: true })),
      getPaneCommand: async () => "claude", capturePaneContent: async () => "", listSessions: async () => [], listWindows: async () => [], listPanes: async () => [] } as any;
    const collector = path.join(root, "collector.cjs"); fs.writeFileSync(collector, "// inert fixture\n");
    const adapter = new ClaudeCodeAdapter({ tmux, listProcesses: async () => [], stateDir, collectorAssetPath: collector, activityRelayPath: path.join(shipped,"hooks/scripts/activity-relay.cjs"), claudeHooksManifestPath: path.join(shipped,"hooks/claude.json"), fsOps: {
      exists: fs.existsSync, readFile: f => fs.readFileSync(f,"utf8"), writeFile: (f,s) => fs.writeFileSync(f,s), mkdirp: f => { fs.mkdirSync(f,{recursive:true}); }, copyFile: fs.copyFileSync, statMode: f => fs.statSync(f).mode, chmod: fs.chmodSync, homedir: path.join(root,"home"),
    } });
    vi.spyOn(adapter, "checkReady").mockResolvedValue({ ready: true });
    const launch = vi.spyOn(adapter, "launchHarness").mockImplementation(async (_b, opts) => ({ ok: true, resumeToken: opts.resumeToken, resumeType: "claude_id" }));
    const launcher = new NodeLauncher({ db, rigRepo: rigs, sessionRegistry: registry, eventBus: events, tmuxAdapter: tmux, pluginsDir, sessionEnv: { OPENRIG_HOME: root, OPENRIG_URL: `http://127.0.0.1:${addr.port}`, OPENRIG_ACTIVITY_HOOK_TOKEN: "dummy-fixture-only" } });
    const orchestrator = new RestoreOrchestrator({ db, rigRepo: rigs, sessionRegistry: registry, eventBus: events, snapshotRepo: snapshots, snapshotCapture: capture, checkpointStore: checkpoints, nodeLauncher: launcher, tmuxAdapter: tmux, listProcesses: async () => [] });
    const result = await orchestrator.restore(snap.id, { adapters: { "claude-code": adapter }, fsOps: { exists: fs.existsSync } });
    expect(result.ok).toBe(true); if (!result.ok) throw new Error(JSON.stringify(result));
    expect(launchEnvs).toHaveLength(1);
    expect(launch).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ resumeToken: token }));
    expect(tmux.sendText).not.toHaveBeenCalled();
    expect(db.prepare("SELECT * FROM node_startup_context WHERE node_id=?").get(node.id)).toEqual(saved);
    const settings = JSON.parse(fs.readFileSync(settingsPath,"utf8"));
    expect(settings.env).toEqual(originalSettings.env); expect(settings.hooks.Stop).toContainEqual(originalSettings.hooks.Stop[0]);
    const settingsRelay = claudeActivityRelayPath(stateDir);
    const hasSettingsRelay = JSON.stringify(settings.hooks).includes(settingsRelay);
    expect(hasSettingsRelay).toBe(scenario.savedResource);
    expect(launchEnvs[0].CLAUDE_CODE_PLUGIN_DIRS).toBe(scenario.plugin ? vendored : undefined);

    const stateBeforeCheck = db.prepare("SELECT * FROM node_startup_context WHERE node_id=?").get(node.id);
    const settingsBeforeCheck = fs.readFileSync(settingsPath,"utf8");
    const checker = new RestoreCheckService({ listRigs: () => [{ rigId: rig.id, name: "i1530" }], getNodeInventory: id => getNodeInventory(db,id) as any,
      getStartupContext: id => { const row=db.prepare("SELECT * FROM node_startup_context WHERE node_id=?").get(id) as any; return { status: "ok", runtime: row.runtime, resolvedStartupFiles: JSON.parse(row.resolved_files_json), projectionEntries: JSON.parse(row.projection_entries_json) }; },
      getDesiredClaudeActivityHooks: () => ({ status: "known", selected: current.config.selectedResources.runtimeResources.length > 0 }),
      hasSnapshot: () => true, getRestoreInputs: () => ({ snapshot: snap, servicesRecord: null }), getLatestSnapshot: () => null,
      probeDaemonHealth: () => ({ healthy: true, evidence: "Daemon running fixture" }), exists: fs.existsSync, readFile: f => fs.readFileSync(f,"utf8"), stateDir,
      probeQueueStore: () => ({ available: true, evidence: "fixture SQLite" }), getClaudeActivityHookEvents: () => deriveRelayEvents({ exists: fs.existsSync, readFile: f => fs.readFileSync(f,"utf8") }, path.join(shipped,"hooks/claude.json")).map(e => e.event),
    });
    const check = checker.check({ noQueue: true });
    const hooksCheck = check.checks.find(c => c.check.endsWith(".hooks")); expect(hooksCheck).toBeDefined(); expect(hooksCheck!.status).toBe(!scenario.savedResource && !scenario.plugin && scenario.wantsHooks ? "yellow" : "green");
    expect(hooksCheck!.evidence).toContain(scenario.savedResource ? "hook execution is not verified" : scenario.plugin ? "native plugin loading and hook execution are unverified" : scenario.wantsHooks ? "stale selection" : "not selected");
    expect(checker.check({ noQueue: true, compact: true, includeReady: true }).checks.find(c => c.check.endsWith(".hooks"))).toEqual(hooksCheck);
    expect(db.prepare("SELECT * FROM node_startup_context WHERE node_id=?").get(node.id)).toEqual(stateBeforeCheck);
    expect(fs.readFileSync(settingsPath,"utf8")).toBe(settingsBeforeCheck);

    // Controlled consumer, NOT Claude: invoke only the relay selected by the measured env/manifest/settings.
    const env = { ...launchEnvs[0], HOME: path.join(root,"home"), CLAUDE_PROJECT_DIR: cwd, CLAUDE_PLUGIN_ROOT: vendored };
    let invoked = 0;
    if (launchEnvs[0].CLAUDE_CODE_PLUGIN_DIRS) {
      const manifest = JSON.parse(fs.readFileSync(path.join(vendored,"hooks/claude.json"),"utf8"));
      expect(manifest.hooks.Stop.some(g => g.hooks.some(h => h.command.includes("activity-relay.cjs")))).toBe(true);
      invoked++; await invokeRelay(path.join(vendored,"hooks/scripts/activity-relay.cjs"), ["--from-plugin"], env);
    }
    if (hasSettingsRelay) { invoked++; await invokeRelay(settingsRelay, [], env); }
    expect(posts).toHaveLength(scenario.plugin || scenario.savedResource ? 1 : 0);
    for (const post of posts) { expect(post.url).toBe("/api/activity/hooks"); expect(post.payload).toMatchObject({ nodeId: node.id, runtime: "claude-code", hookEvent: "Stop" }); }
    console.log("I1530_CASE", JSON.stringify({ scenario, currentProfile: profile, currentSelectedHookCount: current.config.selectedResources.runtimeResources.length,
      launchPluginDirsPresent: Boolean(launchEnvs[0].CLAUDE_CODE_PLUGIN_DIRS), settingsRelayPresent: hasSettingsRelay, controlledRelayInvocations: invoked, receivedActivityPosts: posts.length,
      hooksCheck, nodeOutcome: result.result.nodes[0]?.status, preservedSavedContext: true, sameTokenRequested: true, startupReplayCalls: tmux.sendText.mock.calls.length,
      native: "NOT RUN; fake terminal and harness, controlled relay consumer; no provider" }));
  } finally {
    vi.restoreAllMocks(); server.closeAllConnections(); await new Promise<void>(resolve => { server.close(() => resolve()); }); db.close(); fs.rmSync(root,{recursive:true,force:true});
  }
}, 20000);
