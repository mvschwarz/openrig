import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type Server } from "node:http";
import Database from "better-sqlite3";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SnapshotRepository } from "../src/domain/snapshot-repository.js";
import { CheckpointStore } from "../src/domain/checkpoint-store.js";
import { SnapshotCapture } from "../src/domain/snapshot-capture.js";
import { RigTeardownOrchestrator } from "../src/domain/rig-teardown.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import { PodRigInstantiator } from "../src/domain/rigspec-instantiator.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { RestoreOrchestrator } from "../src/domain/restore-orchestrator.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { SeatHandoverService } from "../src/domain/seat-handover-service.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { ClaudeManagedLaunch as RealManagedLaunch } from "../src/domain/claude-managed-launch.js";
import type { ClaudeManagedLaunch } from "../src/domain/claude-managed-launch.js";
import { SEAT_ENV_KEYS_VAR } from "../src/domain/seat-env.js";
import { SEAT_PROJECT_DIR_ENV } from "../src/domain/claude-core-plugin-env.js";
import {
  persistedPluginPaths, seatCorePluginDir, vendoredCorePluginDir, withCorePlugin,
} from "../src/domain/claude-core-plugin-env.js";
import type { AgentResolverFsOps } from "../src/domain/agent-resolver.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";
import type { RigSpec } from "../src/domain/types.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { createDb } from "../src/db/connection.js";
import type { TmuxAdapter as TmuxAdapterType } from "../src/adapters/tmux.js";

// openrig-core ships hooks (refocus, the compaction-restore pair, the activity relay). Claude loads them
// only from a plugin it was told about, and nothing told it: the plugin sat in OpenRig's state, so a
// seat's PreCompact hook never wrote the restore-pending marker the managed post-compact prompt reads.
// A Claude seat whose resolved plugin selection includes the shipped openrig-core plugin now starts with
// CLAUDE_CODE_PLUGIN_DIRS naming the vendored copy (no launch argument, so the seat's process identity is
// unchanged); a seat that didn't select it starts as before. A seat's own CLAUDE_CODE_PLUGIN_DIRS keeps working and the
// vendored plugin is added to it. The plugin's own activity relay stays quiet for an event only when the seat's
// settings.local.json carries OpenRig's copy of the relay for that event, so each event is reported once either way.

const require = createRequire(import.meta.url);
const PLUGIN_ENV = "CLAUDE_CODE_PLUGIN_DIRS";
const OWN_LIST = "/own/plugins:/more/plugins";

/** A scratch plugins folder with the openrig-core manifest in it, as the daemon's vendoring leaves it. */
function vendoredPlugins(root: string): { pluginsDir: string; vendored: string } {
  const pluginsDir = join(root, "plugins");
  const vendored = join(pluginsDir, "openrig-core");
  mkdirSync(join(vendored, ".claude-plugin"), { recursive: true });
  writeFileSync(join(vendored, ".claude-plugin", "plugin.json"), "{}");
  return { pluginsDir, vendored };
}

function fakeTmux(created: Array<{ name: string; env: Record<string, string> | undefined }>, sessionEnvCalls: string[] = []): TmuxAdapterType {
  return {
    createSession: async (name: string, _c?: string, env?: Record<string, string>) => { created.push({ name, env }); return { ok: true as const }; },
    setSessionEnv: async (_s: string, key: string, value: string) => { sessionEnvCalls.push(`set ${key}=${value}`); },
    unsetSessionEnv: async (_s: string, key: string) => { sessionEnvCalls.push(`unset ${key}`); },
    killSession: async () => ({ ok: true as const }), listPanes: async () => [], listSessions: async () => [], listWindows: async () => [],
    hasSession: async () => false, sendText: async () => ({ ok: true as const }), sendKeys: async () => ({ ok: true as const }),
  } as unknown as TmuxAdapterType;
}

describe("which Claude seats load the vendored plugin", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "claude-core-plugin-")); });
  afterEach(() => { vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

  it("a real daemon startup vendors the plugin and sets nothing for every Claude seat", async () => {
    // Every home the daemon touches at startup is a scratch one: the real ~/.claude and ~/.codex stay out of it.
    vi.stubEnv("HOME", join(root, "home"));
    vi.stubEnv("OPENRIG_HOME", join(root, "openrig"));
    vi.stubEnv("CODEX_HOME", join(root, "codex"));
    vi.stubEnv("CLAUDE_CONFIG_DIR", join(root, "claude"));
    const { createDaemon } = await import("../src/startup.js");
    const { db, deps } = await createDaemon({ dbPath: ":memory:" });
    try {
      // The plugin is vendored for a seat that selects it to find, and no runtime-wide entry names it.
      expect(vendoredCorePluginDir()).toBe(join(root, "openrig", "plugins", "openrig-core"));
      expect(vendoredCorePluginDir()).not.toContain(":");
      expect(deps.runtimeSessionEnv?.["claude-code"]).toBeUndefined();
      expect(deps.runtimeSessionEnv?.codex).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("is left out when the plugin is not vendored", () => {
    expect(vendoredCorePluginDir(join(root, "plugins"))).toBeUndefined();
    mkdirSync(join(root, "plugins", "openrig-core"), { recursive: true });
    expect(vendoredCorePluginDir(join(root, "plugins"))).toBeUndefined();
    const { pluginsDir, vendored } = vendoredPlugins(root);
    expect(vendoredCorePluginDir(pluginsDir)).toBe(vendored);
  });

  it("adds the plugin after a list the seat declared, once, and leaves a seat that didn't select it alone", () => {
    expect(withCorePlugin({}, "/v")).toEqual({ [PLUGIN_ENV]: "/v" });
    expect(withCorePlugin({ A: "1" }, "/v")).toEqual({ A: "1", [PLUGIN_ENV]: "/v" });
    expect(withCorePlugin({ [PLUGIN_ENV]: OWN_LIST }, "/v")).toEqual({ [PLUGIN_ENV]: `${OWN_LIST}:/v` });
    expect(withCorePlugin({ [PLUGIN_ENV]: "/a:/v" }, "/v")).toEqual({ [PLUGIN_ENV]: "/a:/v" });
    const untouched = { [PLUGIN_ENV]: OWN_LIST };
    expect(withCorePlugin(untouched, undefined)).toBe(untouched);
  });

  it("counts a declared entry as the plugin when it names the same folder another way (trailing slash, symlink)", () => {
    const { vendored } = vendoredPlugins(root);
    const link = join(root, "core-link");
    symlinkSync(vendored, link);
    expect(withCorePlugin({ [PLUGIN_ENV]: `/a:${vendored}/` }, vendored)).toEqual({ [PLUGIN_ENV]: `/a:${vendored}/` });
    expect(withCorePlugin({ [PLUGIN_ENV]: `${link}:/a` }, vendored)).toEqual({ [PLUGIN_ENV]: `${link}:/a` });
    expect(withCorePlugin({ [PLUGIN_ENV]: "/a::/b" }, vendored)).toEqual({ [PLUGIN_ENV]: `/a::/b:${vendored}` });
  });

  it("does not count a relative entry as the plugin, since Claude skips relative entries: it stays as written and the absolute path is added", () => {
    const { vendored } = vendoredPlugins(root);
    const rel = relative(process.cwd(), vendored); // resolves to the vendored folder from here, but Claude would skip it
    expect(isAbsolute(rel)).toBe(false);
    expect(withCorePlugin({ [PLUGIN_ENV]: rel }, vendored)).toEqual({ [PLUGIN_ENV]: `${rel}:${vendored}` });
    expect(withCorePlugin({ [PLUGIN_ENV]: `./x:${rel}:/a` }, vendored)).toEqual({ [PLUGIN_ENV]: `./x:${rel}:/a:${vendored}` });
    expect(withCorePlugin({ [PLUGIN_ENV]: `${rel}:${vendored}` }, vendored)).toEqual({ [PLUGIN_ENV]: `${rel}:${vendored}` });
  });

  it("picks the seat's plugin by where its selection resolved, whichever way it was spelled", () => {
    const { pluginsDir, vendored } = vendoredPlugins(root);
    const db = createFullTestDb();
    try {
      const claude = { id: "n", runtime: "claude-code" };
      expect(seatCorePluginDir(claude, db, [vendored], pluginsDir)).toBe(vendored);
      // A path that spells the same folder differently, and a symlink to it, are the same plugin.
      expect(seatCorePluginDir(claude, db, [`${pluginsDir}/./openrig-core/`], pluginsDir)).toBe(vendored);
      symlinkSync(vendored, join(root, "alias"));
      expect(seatCorePluginDir(claude, db, [join(root, "alias")], pluginsDir)).toBe(vendored);
      // Another plugin, even one called openrig-core somewhere else, is not the shipped one.
      expect(seatCorePluginDir(claude, db, [join(root, "other", "openrig-core")], pluginsDir)).toBeUndefined();
      expect(seatCorePluginDir(claude, db, [], pluginsDir)).toBeUndefined();
      expect(seatCorePluginDir({ id: "n", runtime: "codex" }, db, [vendored], pluginsDir)).toBeUndefined();
      expect(seatCorePluginDir({ id: "n", runtime: null }, db, [vendored], pluginsDir)).toBeUndefined();
      expect(seatCorePluginDir(claude, db, [vendored], join(root, "nowhere"))).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("reads the selection a node saved when a launch isn't given one, and treats nothing readable as not selected", () => {
    const { pluginsDir, vendored } = vendoredPlugins(root);
    const db = createFullTestDb();
    try {
      const rigRepo = new RigRepository(db);
      const rig = rigRepo.createRig("saved");
      const ids = ["selects", "other", "empty", "none", "garbled"].map((l) => rigRepo.addNode(rig.id, l, { runtime: "claude-code" }).id);
      const save = (nodeId: string, json: string) =>
        db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, '[]', '[]', 'claude-code')").run(nodeId, json);
      save(ids[0]!, JSON.stringify([{ category: "skill", absolutePath: "/s" }, { category: "plugin", absolutePath: vendored }]));
      save(ids[1]!, JSON.stringify([{ category: "plugin", absolutePath: "/elsewhere" }, { category: "runtime_resource", absolutePath: vendored }]));
      save(ids[2]!, "[]");
      save(ids[4]!, "{ not json");
      const pick = (id: string) => seatCorePluginDir({ id, runtime: "claude-code" }, db, undefined, pluginsDir);
      expect(pick(ids[0]!)).toBe(vendored);
      expect(pick(ids[1]!)).toBeUndefined();
      expect(pick(ids[2]!)).toBeUndefined();
      expect(pick(ids[3]!)).toBeUndefined(); // no saved context
      expect(pick(ids[4]!)).toBeUndefined(); // unreadable context
      expect(persistedPluginPaths(db, ids[0]!)).toEqual([vendored]);
      expect(persistedPluginPaths(db, ids[3]!)).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe("rig up: only a Claude seat whose resolved plugin selection includes openrig-core loads it", () => {
  const RIG_ROOT = "/project/rigs/my-rig";
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "claude-core-rigup-")); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  const agent = (extra: string, plugins: string, resources: string) => `name: a
version: "1.0.0"
${extra}
resources:
  skills: []
${resources}
profiles:
  default:
    uses:
      skills: []
      plugins: ${plugins}`;

  function mockFs(files: Record<string, string>): AgentResolverFsOps {
    return {
      readFile: (p: string) => { if (p in files) return files[p]!; throw new Error(`Not found: ${p}`); },
      exists: (p: string) => p in files,
    };
  }
  const mockAdapter = (runtime: string): RuntimeAdapter => ({
    runtime, listInstalled: vi.fn(async () => []), project: vi.fn(async () => ({ projected: [], skipped: [], failed: [] })),
    deliverStartup: vi.fn(async () => ({ delivered: 0, failed: [] })), checkReady: vi.fn(async () => ({ ready: true })),
    launchHarness: vi.fn(async () => ({ ok: true })),
  });

  it("covers qualified, unqualified and custom selections, and not a seat that selected nothing or another plugin", async () => {
    const { pluginsDir, vendored } = vendoredPlugins(root);
    const elsewhere = join(root, "elsewhere", "openrig-core");
    const plugin = (id: string, path: string) => `  plugins:\n    - id: ${id}\n      source:\n        kind: local\n        path: ${path}`;
    const files: Record<string, string> = {
      // The shipped shared spec: openrig-core is its plugin.
      [`${RIG_ROOT}/agents/shared/agent.yaml`]: `name: shared\nversion: "1.0"\nresources:\n  skills: []\n${plugin("openrig-core", vendored)}\n`,
      // `shared:openrig-core`, the form the shipped starter agents use.
      [`${RIG_ROOT}/agents/qualified/agent.yaml`]: agent("imports:\n  - ref: local:../shared", "[shared:openrig-core]", ""),
      // The same plugin by its unqualified name, which a single import allows.
      [`${RIG_ROOT}/agents/unqualified/agent.yaml`]: agent("imports:\n  - ref: local:../shared", "[openrig-core]", ""),
      // A resource of another name that points at the vendored copy.
      [`${RIG_ROOT}/agents/custom/agent.yaml`]: agent("", "[team-hooks]", plugin("team-hooks", vendored)),
      // The same name, a different plugin.
      [`${RIG_ROOT}/agents/namesake/agent.yaml`]: agent("", "[openrig-core]", plugin("openrig-core", elsewhere)),
      [`${RIG_ROOT}/agents/other/agent.yaml`]: agent("", "[extras]", plugin("extras", join(root, "extras"))),
      // Imports the shared spec and selects nothing from it.
      [`${RIG_ROOT}/agents/nothing/agent.yaml`]: agent("imports:\n  - ref: local:../shared", "[]", ""),
    };
    const members = ["qualified", "unqualified", "custom", "namesake", "other", "nothing"].map((id) =>
      ({ id, agentRef: `local:agents/${id}`, profile: "default", runtime: "claude-code", cwd: "." }));
    members.push({ id: "codex", agentRef: "local:agents/qualified", profile: "default", runtime: "codex", cwd: "." });
    const spec = { version: "0.2", name: "test-rig", pods: [{ id: "dev", label: "Dev", members, edges: [] }], edges: [] } as RigSpec;

    const db = createFullTestDb();
    try {
      const rigRepo = new RigRepository(db);
      const created: Array<{ name: string; env: Record<string, string> | undefined }> = [];
      const tmux = fakeTmux(created);
      const sessionRegistry = new SessionRegistry(db);
      const eventBus = new EventBus(db);
      const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux, pluginsDir });
      const inst = new PodRigInstantiator({
        db, rigRepo, podRepo: new PodRepository(db), sessionRegistry, eventBus, nodeLauncher,
        startupOrchestrator: new StartupOrchestrator({ db, sessionRegistry, eventBus, tmuxAdapter: tmux }),
        fsOps: mockFs(files),
        adapters: { "claude-code": mockAdapter("claude-code"), codex: mockAdapter("codex"), terminal: mockAdapter("terminal") },
        tmuxAdapter: tmux,
      });
      const result = await inst.instantiate(RigSpecCodec.serialize(spec), RIG_ROOT);
      expect(result.ok, JSON.stringify(result)).toBe(true);
      const envOf = (member: string) => created.find((c) => c.name === `dev-${member}@test-rig`)?.env;
      expect(created).toHaveLength(members.length);
      for (const member of ["qualified", "unqualified", "custom"]) {
        expect(envOf(member)?.[PLUGIN_ENV], member).toBe(vendored);
        expect(envOf(member)?.[SEAT_ENV_KEYS_VAR], member).toBe(PLUGIN_ENV);
      }
      for (const member of ["namesake", "other", "nothing", "codex"]) {
        expect(envOf(member), member).not.toHaveProperty(PLUGIN_ENV);
        expect(envOf(member), member).not.toHaveProperty(SEAT_ENV_KEYS_VAR);
      }
    } finally {
      db.close();
    }
  });
});

describe("a Claude seat's launch env, on the launch paths that don't re-resolve the spec", () => {
  const dbs: ReturnType<typeof createFullTestDb>[] = [];
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "claude-core-launch-")); });
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); rmSync(root, { recursive: true, force: true }); });

  it("fresh launch: a seat that selected the plugin has it, and a Codex seat or one that selected nothing does not", async () => {
    const { pluginsDir, vendored } = vendoredPlugins(root);
    const db = createFullTestDb(); dbs.push(db);
    const rigRepo = new RigRepository(db);
    const rig = rigRepo.createRig("plugin-env");
    for (const id of ["selects", "nothing", "other", "codex"]) rigRepo.addNode(rig.id, id, { runtime: id === "codex" ? "codex" : "claude-code" });
    const created: Array<{ name: string; env: Record<string, string> | undefined }> = [];
    const launcher = new NodeLauncher({ db, rigRepo, sessionRegistry: new SessionRegistry(db), eventBus: new EventBus(db),
      tmuxAdapter: fakeTmux(created), sessionEnv: { OPENRIG_HOME: "/state" }, pluginsDir });
    const sel: Record<string, string[] | undefined> = { selects: [vendored], nothing: [], other: ["/elsewhere"], codex: [vendored] };
    for (const id of Object.keys(sel)) expect((await launcher.launchNode(rig.id, id, { pluginPaths: sel[id] })).ok).toBe(true);
    expect(created[0]!.env).toMatchObject({ [PLUGIN_ENV]: vendored, [SEAT_ENV_KEYS_VAR]: PLUGIN_ENV });
    for (const c of created.slice(1)) expect(c.env).not.toHaveProperty(PLUGIN_ENV);
  });

  it("fresh launch: a seat that loads the plugin is told its launch project, and one that doesn't is not", async () => {
    const { pluginsDir, vendored } = vendoredPlugins(root);
    const db = createFullTestDb(); dbs.push(db);
    const rigRepo = new RigRepository(db);
    const rig = rigRepo.createRig("plugin-project");
    rigRepo.addNode(rig.id, "selects", { runtime: "claude-code", cwd: "/work/seat" });
    rigRepo.addNode(rig.id, "elsewhere", { runtime: "claude-code", cwd: "/work/other" });
    rigRepo.addNode(rig.id, "nothing", { runtime: "claude-code", cwd: "/work/none" });
    const created: Array<{ name: string; env: Record<string, string> | undefined }> = [];
    const launcher = new NodeLauncher({ db, rigRepo, sessionRegistry: new SessionRegistry(db), eventBus: new EventBus(db),
      tmuxAdapter: fakeTmux(created), pluginsDir });
    expect((await launcher.launchNode(rig.id, "selects", { pluginPaths: [vendored] })).ok).toBe(true);
    expect((await launcher.launchNode(rig.id, "elsewhere", { pluginPaths: [vendored], cwd: "/work/moved" })).ok).toBe(true);
    expect((await launcher.launchNode(rig.id, "nothing", { pluginPaths: [] })).ok).toBe(true);
    expect(created[0]!.env![SEAT_PROJECT_DIR_ENV]).toBe("/work/seat");
    expect(created[1]!.env![SEAT_PROJECT_DIR_ENV]).toBe("/work/moved"); // the folder the session actually starts in
    expect(created[2]!.env).not.toHaveProperty(SEAT_PROJECT_DIR_ENV);
  });

  it("fresh launch: nothing is added when the plugin isn't vendored", async () => {
    const db = createFullTestDb(); dbs.push(db);
    const rigRepo = new RigRepository(db);
    const rig = rigRepo.createRig("plugin-env-absent");
    rigRepo.addNode(rig.id, "selects", { runtime: "claude-code" });
    const created: Array<{ name: string; env: Record<string, string> | undefined }> = [];
    const launcher = new NodeLauncher({ db, rigRepo, sessionRegistry: new SessionRegistry(db), eventBus: new EventBus(db),
      tmuxAdapter: fakeTmux(created), pluginsDir: join(root, "plugins") });
    expect((await launcher.launchNode(rig.id, "selects", { pluginPaths: [join(root, "plugins", "openrig-core")] })).ok).toBe(true);
    expect(created[0]!.env).not.toHaveProperty(PLUGIN_ENV);
  });

  it("a relaunch that isn't given a selection reads the one the node saved", async () => {
    const { pluginsDir, vendored } = vendoredPlugins(root);
    const db = createFullTestDb(); dbs.push(db);
    const rigRepo = new RigRepository(db);
    const rig = rigRepo.createRig("plugin-env-saved");
    const selects = rigRepo.addNode(rig.id, "selects", { runtime: "claude-code" });
    rigRepo.addNode(rig.id, "unsaved", { runtime: "claude-code" });
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, '[]', '[]', 'claude-code')")
      .run(selects.id, JSON.stringify([{ category: "plugin", absolutePath: vendored }]));
    const created: Array<{ name: string; env: Record<string, string> | undefined }> = [];
    const launcher = new NodeLauncher({ db, rigRepo, sessionRegistry: new SessionRegistry(db), eventBus: new EventBus(db),
      tmuxAdapter: fakeTmux(created), pluginsDir });
    expect((await launcher.launchNode(rig.id, "selects")).ok).toBe(true);
    expect((await launcher.launchNode(rig.id, "unsaved")).ok).toBe(true);
    expect(created[0]!.env).toMatchObject({ [PLUGIN_ENV]: vendored });
    expect(created[1]!.env).not.toHaveProperty(PLUGIN_ENV);
  });

  it("fresh launch: a seat's own list keeps working and the vendored plugin is added to it", async () => {
    const { pluginsDir, vendored } = vendoredPlugins(root);
    const db = createFullTestDb(); dbs.push(db);
    const rigRepo = new RigRepository(db);
    const rig = rigRepo.createRig("plugin-env-own");
    rigRepo.addNode(rig.id, "own", { runtime: "claude-code", env: { [PLUGIN_ENV]: OWN_LIST } });
    rigRepo.addNode(rig.id, "has-it", { runtime: "claude-code", env: { [PLUGIN_ENV]: `/own/plugins:${vendored}` } });
    rigRepo.addNode(rig.id, "oneoff", { runtime: "claude-code" });
    rigRepo.addNode(rig.id, "own-not-selected", { runtime: "claude-code", env: { [PLUGIN_ENV]: OWN_LIST } });
    const created: Array<{ name: string; env: Record<string, string> | undefined }> = [];
    const sessionEnvCalls: string[] = [];
    const launcher = new NodeLauncher({ db, rigRepo, sessionRegistry: new SessionRegistry(db), eventBus: new EventBus(db),
      tmuxAdapter: fakeTmux(created, sessionEnvCalls), sessionEnv: { OPENRIG_HOME: "/state" }, pluginsDir });
    for (const id of ["own", "has-it"]) expect((await launcher.launchNode(rig.id, id, { pluginPaths: [vendored] })).ok).toBe(true);
    expect(created[0]!.env![PLUGIN_ENV]).toBe(`${OWN_LIST}:${vendored}`);
    expect(created[1]!.env![PLUGIN_ENV]).toBe(`/own/plugins:${vendored}`);
    // A one-off `rig up --env` list is composed too, and once the first pane has it the session goes back to the vendored plugin.
    const oneOff = await launcher.launchNode(rig.id, "oneoff", { pluginPaths: [vendored], env: { [PLUGIN_ENV]: "/one/off" } });
    expect(oneOff.ok, JSON.stringify(oneOff)).toBe(true);
    expect(created[2]!.env![PLUGIN_ENV]).toBe(`/one/off:${vendored}`);
    expect(sessionEnvCalls).toContain(`set ${PLUGIN_ENV}=${vendored}`);
    // A seat that declared its own list but didn't select the plugin keeps exactly its own list.
    expect((await launcher.launchNode(rig.id, "own-not-selected", { pluginPaths: [] })).ok).toBe(true);
    expect(created[3]!.env![PLUGIN_ENV]).toBe(OWN_LIST);
  });

  function restoreHarness(entries: unknown[], memberEnv?: Record<string, string>) {
    const { pluginsDir } = vendoredPlugins(root);
    const db = createFullTestDb(); dbs.push(db);
    const rigRepo = new RigRepository(db);
    const sessionRegistry = new SessionRegistry(db);
    const eventBus = new EventBus(db);
    const snapshotRepo = new SnapshotRepository(db);
    const checkpointStore = new CheckpointStore(db);
    const snapshotCapture = new SnapshotCapture({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, checkpointStore });
    const rig = rigRepo.createRig("restore-test");
    db.prepare("INSERT INTO pods (id, rig_id, label) VALUES (?, ?, ?)").run("restore-pod", rig.id, "Test");
    const node = rigRepo.addNode(rig.id, "test.c", { runtime: "claude-code", podId: "restore-pod", ...(memberEnv ? { env: memberEnv } : {}) });
    const name = "test-c@restore-test";
    const token = "00000000-0000-4000-8000-000000000006";
    const old = sessionRegistry.registerSession(node.id, name);
    sessionRegistry.updateStatus(old.id, "running");
    sessionRegistry.updateResumeToken(old.id, "claude_id", token, "scrape");
    sessionRegistry.updateBinding(node.id, { tmuxSession: name, tmuxPane: "%old" });
    db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, ?, ?, ?)").run(node.id, JSON.stringify(entries), "[]", "[]", "claude-code");
    let live = true;
    const created: Array<Record<string, string> | undefined> = [];
    const tmux = {
      hasSession: vi.fn(async () => live), probeSession: vi.fn(async () => ({ state: live ? "present" : "absent" })),
      killSession: vi.fn(async () => { live = false; return { ok: true }; }),
      createSession: vi.fn(async (_n: string, _c?: string, env?: Record<string, string>) => { live = true; created.push(env); return { ok: true }; }),
      setSessionEnv: vi.fn(async () => {}), unsetSessionEnv: vi.fn(async () => {}),
      listSessions: vi.fn(async () => live ? [{ name }] : []), listWindows: vi.fn(async () => []),
      listPanes: vi.fn(async () => [{ id: "%new", index: 0, cwd: "/", width: 80, height: 24, active: true }]),
      getPanePid: vi.fn(async () => 100), getPaneCommand: vi.fn(async () => "sh"),
      capturePaneContent: vi.fn(async () => "Restored conversation\n❯ \n"),
      sendText: vi.fn(async () => ({ ok: true })), sendShellCommand: vi.fn(async () => ({ ok: true })), sendKeys: vi.fn(async () => ({ ok: true })),
    } as unknown as TmuxAdapterType;
    const listProcesses = async () => [];
    return {
      created,
      async run() {
        const down = await new RigTeardownOrchestrator({ db, rigRepo, sessionRegistry, eventBus, snapshotCapture, tmuxAdapter: tmux }).teardown(rig.id);
        expect(down.errors).toEqual([]);
        // The node's live context changes after the snapshot; restore follows the snapshot.
        db.prepare("DELETE FROM node_startup_context WHERE node_id = ?").run(node.id);
        const adapter = new ClaudeCodeAdapter({ tmux, listProcesses, sleep: async () => {},
          claudeManagedLaunch: { prepare: async () => ({ command: (args: readonly string[]) => `claude ${args.join(" ")}`, assertCurrent: () => {}, configDir: "/fixture", executable: "/opt/claude.exe" }) } as unknown as ClaudeManagedLaunch,
          fsOps: { exists: () => false, readFile: () => "", writeFile: () => {}, mkdirp: () => {}, copyFile: () => {} } });
        const nodeLauncher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: tmux, sessionEnv: { OPENRIG_HOME: "/state" }, pluginsDir });
        const restore = new RestoreOrchestrator({ db, rigRepo, sessionRegistry, eventBus, snapshotRepo, snapshotCapture,
          checkpointStore, nodeLauncher, tmuxAdapter: tmux, claudeResume: new ClaudeResumeAdapter(tmux),
          codexResume: new CodexResumeAdapter(tmux), listProcesses });
        await restore.restore(down.snapshotId!, { adapters: { "claude-code": adapter } });
      },
    };
  }

  it("restore: a seat whose saved selection includes the plugin gets it, with its own list first", async () => {
    const { vendored } = vendoredPlugins(root);
    const plain = restoreHarness([{ category: "plugin", absolutePath: vendored }]);
    await plain.run();
    expect(plain.created).toHaveLength(1);
    expect(plain.created[0]).toMatchObject({ [PLUGIN_ENV]: vendored });
    const own = restoreHarness([{ category: "plugin", absolutePath: vendored }], { [PLUGIN_ENV]: OWN_LIST });
    await own.run();
    expect(own.created[0]).toMatchObject({ [PLUGIN_ENV]: `${OWN_LIST}:${vendored}` });
  });

  it("restore: a seat whose saved selection doesn't include the plugin doesn't get it, and keeps its own list", async () => {
    const none = restoreHarness([{ category: "plugin", absolutePath: "/elsewhere" }]);
    await none.run();
    expect(none.created).toHaveLength(1);
    expect(none.created[0]).not.toHaveProperty(PLUGIN_ENV);
    const own = restoreHarness([], { [PLUGIN_ENV]: OWN_LIST });
    await own.run();
    expect(own.created[0]).toMatchObject({ [PLUGIN_ENV]: OWN_LIST });
  });
});

// A handover successor is a respawned pane in the seat's tmux session. This runs the real SeatHandoverService on an
// isolated tmux server (a per-run -L socket, torn down by session name, never kill-server) and reads what each
// successor pane's shell has in its environment.
describe("handover successor, on a real tmux server", () => {
  const pexec = promisify(execFile);
  const SOCK = `openrig-coreplug-${process.pid}`;
  const cleanEnv: NodeJS.ProcessEnv = { ...process.env };
  delete cleanEnv.TMUX;
  // A test run from inside a seat that loads the plugin must not hand its own plugin variables to the tmux server under test.
  delete cleanEnv.CLAUDE_CODE_PLUGIN_DIRS;
  delete cleanEnv.OPENRIG_SEAT_PROJECT_DIR;
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const exec = async (cmd: string): Promise<string> => {
    const safe = cmd.startsWith("tmux ") ? `tmux -L ${SOCK} ${cmd.slice(5)}` : cmd;
    return (await pexec("sh", ["-c", safe], { env: cleanEnv })).stdout;
  };
  const tmux = (a: string) => exec(`tmux ${a}`);
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const available = (() => { try { execFileSync("sh", ["-c", "command -v tmux"], { env: cleanEnv, stdio: "ignore" }); return true; } catch { return false; } })();
  const scratch = mkdtempSync(join(tmpdir(), "coreplug-handover-"));
  const seats: string[] = [];
  afterAll(async () => {
    for (const seat of seats) await tmux(`kill-session -t ${q(seat)}`).catch(() => {});
    rmSync(scratch, { recursive: true, force: true });
  });

  async function paneEnviron(seat: string, tag: string): Promise<Record<string, string>> {
    const file = join(scratch, `${tag}.env`);
    const pane = (await tmux(`list-panes -t ${q(seat)} -F '#{pane_id}'`)).trim();
    await tmux(`send-keys -t ${q(pane)} -l -- ${q(`env > ${q(file)}.part && mv ${q(file)}.part ${q(file)}`)}`);
    await tmux(`send-keys -t ${q(pane)} Enter`);
    for (let i = 0; i < 50 && !existsSync(file); i++) await sleep(100);
    const out: Record<string, string> = {};
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const eq = line.indexOf("=");
      if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return out;
  }

  async function successorEnviron(rigName: string, saved: unknown[]): Promise<Record<string, string>> {
    const { pluginsDir, vendored } = vendoredPlugins(scratch);
    const seat = `dev-impl@${rigName}`;
    seats.push(seat);
    const db = createDb(); db.pragma("foreign_keys = ON"); migrate(db, ALL_MIGRATIONS);
    try {
      const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db);
      const discoveryRepo = new DiscoveryRepository(db), eventBus = new EventBus(db);
      const rig = rigRepo.createRig(rigName);
      const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", cwd: scratch });
      db.prepare("INSERT INTO node_startup_context (node_id, projection_entries_json, resolved_files_json, startup_actions_json, runtime) VALUES (?, ?, '[]', '[]', 'claude-code')")
        .run(node.id, JSON.stringify(saved.map((p) => p === "vendored" ? { category: "plugin", absolutePath: vendored } : p)));
      const adapter = new TmuxAdapter(exec);
      const launcher = new NodeLauncher({ db, rigRepo, sessionRegistry, eventBus, tmuxAdapter: adapter, pluginsDir });
      const launched = await launcher.launchNode(rig.id, "dev.impl", { sessionName: seat, cwd: scratch });
      expect(launched.ok).toBe(true);
      await sleep(300);
      const pane = (await tmux(`list-panes -t ${q(seat)} -F '#{pane_id}'`)).trim();
      await tmux(`send-keys -t ${q(pane)} -l -- ${q("trap 'exit 0' TERM")}`);
      await tmux(`send-keys -t ${q(pane)} Enter`);
      await sleep(200);
      sessionRegistry.updateStartupStatus(sessionRegistry.getSessionsForRig(rig.id)[0]!.id, "ready", new Date("2026-08-07T09:00:00Z").toISOString());
      const runtime = {
        runtime: "claude-code",
        async launchHarness() { return { ok: true, resumeToken: "tok", resumeType: "claude_id" }; },
        async checkReady() { return { ready: true }; },
      };
      const service = new SeatHandoverService({
        db, rigRepo, sessionRegistry, discoveryRepo, eventBus,
        tmuxAdapter: adapter, runtimeAdapters: { "claude-code": runtime as never }, pluginsDir,
        predecessorRecapResolver: () => ({ recap: [], recordPath: join(scratch, "none.jsonl") }),
        readinessTimeoutMs: 3000, sleep,
      });
      const result = await service.handover({ seatRef: seat, reason: "context ~85%", source: "fresh", operator: "orch@seat" });
      expect(result.ok).toBe(true);
      await sleep(300);
      return await paneEnviron(seat, rigName);
    } finally {
      db.close();
    }
  }

  it.runIf(available)("has the vendored plugin when the seat selected it and nothing when it didn't", async () => {
    const { vendored } = vendoredPlugins(scratch);
    const selecting = await successorEnviron("coreplug-yes", ["vendored"]);
    expect(selecting[PLUGIN_ENV]).toBe(vendored);
    expect(selecting[SEAT_PROJECT_DIR_ENV]).toBe(scratch); // the seat's launch project, for the plugin's hooks
    const other = await successorEnviron("coreplug-no", [{ category: "plugin", absolutePath: "/elsewhere" }]);
    expect(other).not.toHaveProperty(PLUGIN_ENV);
    expect(other).not.toHaveProperty(SEAT_PROJECT_DIR_ENV);
  }, 90_000);
});

// A Claude seat with a permission mode starts through ClaudeManagedLaunch, whose command is `/usr/bin/env -i`: it keeps only
// the keys it lists and forwards the names a seat declared from the pane shell. A seat that selected the plugin has the
// variable in its pane and on that list (the launch puts it there with the seat's declared env), so it reaches Claude
// through the managed launch with no change to that command. These run the command in a real shell and read back what a
// fake claude process was left with.
describe.skipIf(process.platform === "win32")("the managed (env -i) Claude launch", () => {
  const exec = promisify(execFile);
  const cleanup: Array<() => void> = [];
  afterEach(() => { for (const f of cleanup.splice(0)) f(); });

  function fixture(opts: { memberEnv?: object; sessionKeys?: string; saved?: unknown[] }) {
    const root = mkdtempSync(join(tmpdir(), "managed-plugin-dirs-"));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const bin = join(root, "bin"), home = join(root, "home"), cwd = join(root, "work");
    for (const dir of [bin, home, cwd]) mkdirSync(dir);
    writeFileSync(join(bin, "claude"), `#!/bin/sh
if [ "$1" = --help ]; then printf '%s\\n' '--permission-mode <mode> (choices: "auto", "default")'; exit 0; fi
printf '{"PLUGIN_DIRS":"%s","LEAKED":"%s","PROJECT":"%s"}' "\${CLAUDE_CODE_PLUGIN_DIRS-absent}" "\${LEAKED-absent}" "\${OPENRIG_SEAT_PROJECT_DIR-absent}"
`);
    chmodSync(join(bin, "claude"), 0o700);
    const db = new Database(":memory:"); cleanup.push(() => { db.close(); });
    db.exec(`CREATE TABLE rigs(id TEXT, env_json TEXT);
      CREATE TABLE nodes(id TEXT, rig_id TEXT, runtime TEXT, cwd TEXT, env_json TEXT);
      CREATE TABLE bindings(id TEXT, node_id TEXT, tmux_session TEXT, tmux_pane TEXT);
      CREATE TABLE occupant_tenures(node_id TEXT, generation_uuid TEXT, generation_ordinal INTEGER);
      CREATE TABLE node_startup_context(node_id TEXT, projection_entries_json TEXT);`);
    const { pluginsDir, vendored } = vendoredPlugins(root);
    if (opts.saved) db.prepare("INSERT INTO node_startup_context VALUES ('node', ?)").run(JSON.stringify(opts.saved.map((p) => p === "vendored" ? { category: "plugin", absolutePath: vendored } : p)));
    db.prepare("INSERT INTO rigs VALUES ('rig', NULL)").run();
    db.prepare("INSERT INTO nodes VALUES ('node', 'rig', 'claude-code', ?, ?)").run(cwd, opts.memberEnv ? JSON.stringify(opts.memberEnv) : null);
    db.exec("INSERT INTO bindings VALUES ('b', 'node', 'seat@rig', '%1'); INSERT INTO occupant_tenures VALUES ('node', 'gen', 1)");
    // The tmux session variable the launch records: the names the seat's declared environment holds.
    const managed = new RealManagedLaunch(db, { PATH: `${bin}:/usr/bin:/bin`, HOME: home }, {},
      async (_session, key) => key === SEAT_ENV_KEYS_VAR ? opts.sessionKeys : undefined, pluginsDir);
    const run = async (command: string, paneEnv: Record<string, string>) => {
      const { stdout } = await exec("/bin/sh", ["-c", command], { env: { PATH: "/usr/bin:/bin", ...paneEnv }, timeout: 5000 });
      return JSON.parse(stdout) as Record<string, string>;
    };
    return { managed, run, vendored };
  }
  const target = { nodeId: "node", session: "seat@rig", pane: "%1" };
  const launch = async (f: ReturnType<typeof fixture>) => (await f.managed.prepare(target, "auto")).command(["--permission-mode", "auto"]);

  it("gives a seat that selected the plugin the vendored plugin from its pane, and nothing else the pane holds", async () => {
    const vendored = "/v/plugins/openrig-core";
    // What NodeLauncher hands such a seat: the variable and the list naming it.
    const vars = withCorePlugin({}, vendored);
    const f = fixture({ sessionKeys: PLUGIN_ENV });
    const seen = await f.run(await launch(f), { ...vars, LEAKED: "should-not-pass" });
    expect(seen).toEqual({ PLUGIN_DIRS: vendored, LEAKED: "absent", PROJECT: "absent" });
  });

  it("gives a seat that declared its own list the composed list, once", async () => {
    const f = fixture({ memberEnv: { [PLUGIN_ENV]: OWN_LIST }, sessionKeys: PLUGIN_ENV });
    const seen = await f.run(await launch(f), { [PLUGIN_ENV]: `${OWN_LIST}:/v/openrig-core` });
    expect(seen.PLUGIN_DIRS).toBe(`${OWN_LIST}:/v/openrig-core`);
  });

  it("gives a handover successor the plugin even when its tmux session's name list predates the plugin variable", async () => {
    // The session was created before the daemon was upgraded: its OPENRIG_SEAT_ENV_KEYS lacks the name (or is absent), while the
    // respawned pane's shell has the variable. The seat's saved plugin selection is what says to forward it.
    for (const sessionKeys of [undefined, "FOO"]) {
      const f = fixture({ sessionKeys, saved: ["vendored"] });
      const seen = await f.run(await launch(f), { [PLUGIN_ENV]: f.vendored, [SEAT_PROJECT_DIR_ENV]: "/seat/project", LEAKED: "should-not-pass" });
      expect(seen, String(sessionKeys)).toEqual({ PLUGIN_DIRS: f.vendored, LEAKED: "absent", PROJECT: "/seat/project" });
    }
  });

  it("does not forward the variable for a seat whose saved selection lacks the plugin, even from an old session list", async () => {
    const f = fixture({ sessionKeys: undefined, saved: [{ category: "plugin", absolutePath: "/elsewhere" }] });
    expect((await f.run(await launch(f), { [PLUGIN_ENV]: "/from/the/shell" })).PLUGIN_DIRS).toBe("absent");
  });

  it("changes nothing for a seat that didn't select the plugin, whatever its pane shell happens to hold", async () => {
    const f = fixture({});
    const command = await launch(f);
    expect(command).not.toContain(PLUGIN_ENV);
    const seen = await f.run(command, { [PLUGIN_ENV]: "/from/the/shell", [SEAT_PROJECT_DIR_ENV]: "/from/the/shell" });
    expect(seen.PLUGIN_DIRS).toBe("absent");
    expect(seen.PROJECT).toBe("absent");
  });
});

describe("the plugin's activity relay", () => {
  const relayPath = require.resolve("../assets/plugins/openrig-core/hooks/scripts/activity-relay.cjs");
  let server: Server;
  let posts: Array<{ url: string; body: string }>;
  let port: number;
  let project: string;
  let settingsRelay: string; // the copy of the relay OpenRig puts in a seat's state, as settings.local.json names it

  beforeEach(async () => {
    posts = [];
    project = mkdtempSync(join(tmpdir(), "claude-core-relay-"));
    mkdirSync(join(project, ".claude"), { recursive: true });
    settingsRelay = join(project, "state", "claude-activity-hooks", "activity-relay.cjs");
    mkdirSync(join(settingsRelay, ".."), { recursive: true });
    copyFileSync(relayPath, settingsRelay);
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => { posts.push({ url: req.url ?? "", body }); res.end("{}"); });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    port = (server.address() as { port: number }).port;
  });
  afterEach(async () => { await new Promise<void>((ok) => server.close(() => ok())); rmSync(project, { recursive: true, force: true }); });

  const settingsWithRelay = (events: string[]) => JSON.stringify({
    hooks: Object.fromEntries(events.map((e) => [e, [{ hooks: [{ type: "command", command: `node '${settingsRelay}'` }] }]])),
  });

  function run(payload: Record<string, unknown>, args: string[] = [], extraEnv: Record<string, string> = {}): Promise<void> {
    return new Promise((done, fail) => {
      const child = spawn(process.execPath, [relayPath, ...args], {
        env: { PATH: process.env.PATH ?? "", OPENRIG_SESSION_NAME: "dev-claude@rig", OPENRIG_NODE_ID: "node-1", OPENRIG_RUNTIME: "claude-code",
          OPENRIG_URL: `http://127.0.0.1:${port}`, OPENRIG_ACTIVITY_HOOK_TOKEN: "tok", CLAUDE_PROJECT_DIR: project, ...extraEnv },
        stdio: ["pipe", "ignore", "ignore"],
      });
      child.on("error", fail);
      child.on("close", () => done());
      child.stdin.end(JSON.stringify(payload));
    });
  }

  it("reports as the plugin's copy when the seat has no settings relay (the resource is optional)", async () => {
    await run({ hook_event_name: "UserPromptSubmit", session_id: "s-1" }, ["--from-plugin"]);
    expect(posts.map((p) => p.url)).toEqual(["/api/activity/hooks"]);
    writeFileSync(join(project, ".claude", "settings.local.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] } }));
    await run({ hook_event_name: "UserPromptSubmit", session_id: "s-1" }, ["--from-plugin"]);
    expect(posts).toHaveLength(2);
  });

  it("reports a session start and its identity as the plugin's copy when nothing registers the settings relay", async () => {
    await run({ hook_event_name: "SessionStart", session_id: "s-1", source: "startup" }, ["--from-plugin"]);
    expect(posts.map((p) => p.url)).toEqual(["/api/activity/hooks", "/api/activity/hooks"]);
  });

  it("stays quiet as the plugin's copy for exactly the events the settings relay is registered for", async () => {
    writeFileSync(join(project, ".claude", "settings.local.json"), settingsWithRelay(["SessionStart", "UserPromptSubmit"]));
    await run({ hook_event_name: "SessionStart", session_id: "s-1", source: "startup" }, ["--from-plugin"]);
    await run({ hook_event_name: "UserPromptSubmit", session_id: "s-1" }, ["--from-plugin"]);
    expect(posts).toEqual([]);
    await run({ hook_event_name: "Stop", session_id: "s-1" }, ["--from-plugin"]);
    expect(posts.map((p) => p.url)).toEqual(["/api/activity/hooks"]);
  });

  it("reports when the settings relay's group has a matcher, since that group may not run for this event", async () => {
    const withMatcher = (matcher: string) => JSON.stringify({ hooks: { SessionStart: [{ matcher, hooks: [{ type: "command", command: `node '${settingsRelay}'` }] }] } });
    writeFileSync(join(project, ".claude", "settings.local.json"), withMatcher("resume"));
    await run({ hook_event_name: "SessionStart", session_id: "s-1", source: "startup" }, ["--from-plugin"]);
    expect(posts.length).toBeGreaterThan(0);
    posts = [];
    for (const unrestricted of ["", "*"]) {
      writeFileSync(join(project, ".claude", "settings.local.json"), withMatcher(unrestricted));
      await run({ hook_event_name: "SessionStart", session_id: "s-1", source: "startup" }, ["--from-plugin"]);
    }
    expect(posts).toEqual([]);
  });

  it("reports when a settings command only mentions the relay path, since it may not be OpenRig's relay", async () => {
    for (const command of [`node wrapper.cjs '${settingsRelay}'`, `node 'x' '${settingsRelay}'`, `bash -c 'node ${settingsRelay}'`]) {
      writeFileSync(join(project, ".claude", "settings.local.json"),
        JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command }] }] } }));
      await run({ hook_event_name: "UserPromptSubmit", session_id: "s-1" }, ["--from-plugin"]);
    }
    expect(posts).toHaveLength(3);
  });

  it("reports when the settings entry names a relay script that isn't there or isn't the relay", async () => {
    writeFileSync(join(project, ".claude", "settings.local.json"), settingsWithRelay(["UserPromptSubmit"]));
    // As OpenRig wrote it, the entry silences the plugin's run.
    await run({ hook_event_name: "UserPromptSubmit", session_id: "s-1" }, ["--from-plugin"]);
    expect(posts).toEqual([]);
    // The script is gone: that entry reports nothing, so the plugin must.
    rmSync(settingsRelay);
    await run({ hook_event_name: "UserPromptSubmit", session_id: "s-1" }, ["--from-plugin"]);
    expect(posts).toHaveLength(1);
    // A no-op at the path, and an older copy of the relay, are not this script either.
    for (const content of ["// does nothing\n", readFileSync(relayPath, "utf8") + "\n// an older copy\n"]) {
      writeFileSync(settingsRelay, content);
      await run({ hook_event_name: "UserPromptSubmit", session_id: "s-1" }, ["--from-plugin"]);
    }
    expect(posts).toHaveLength(3);
  });

  it("reports when the settings file can't be read, so an unreadable file never leaves a seat silent", async () => {
    writeFileSync(join(project, ".claude", "settings.local.json"), "{ not json");
    await run({ hook_event_name: "UserPromptSubmit", session_id: "s-1" }, ["--from-plugin"]);
    expect(posts).toHaveLength(1);
  });

  it("always reports as the settings copy, the same script started without --from-plugin", async () => {
    writeFileSync(join(project, ".claude", "settings.local.json"), settingsWithRelay(["UserPromptSubmit"]));
    await run({ hook_event_name: "UserPromptSubmit", session_id: "s-1" });
    expect(posts.map((p) => p.url)).toEqual(["/api/activity/hooks"]);
  });

  it("is started with --from-plugin by every Claude manifest entry and by no Codex one", () => {
    const hookRoot = join(relayPath, "..", "..");
    const commands = (file: string): string[] => {
      const hooks = JSON.parse(readFileSync(join(hookRoot, file), "utf8")).hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
      return Object.values(hooks).flatMap((groups) => groups.flatMap((g) => g.hooks.map((h) => h.command))).filter((c) => c.includes("activity-relay.cjs"));
    };
    expect(commands("claude.json").length).toBeGreaterThan(0);
    expect(commands("claude.json").every((c) => c.endsWith(" --from-plugin"))).toBe(true);
    expect(commands("codex.json").some((c) => c.includes("--from-plugin"))).toBe(false);
  });
});

// A Claude started from inside a seat (its shell, its Bash tool) inherits the seat's environment and so loads the plugin.
// The plugin's seat effects act only when Claude's fixed CLAUDE_PROJECT_DIR is the seat's launch project
// (OPENRIG_SEAT_PROJECT_DIR); the hook's moving cwd is never compared. These run each hook script as Claude would.
describe("the plugin's seat effects stay inside the seat's project", () => {
  const scripts = join(import.meta.dirname, "../assets/plugins/openrig-core");
  const roots: string[] = [];
  afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

  function world() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "seat-boundary-")));
    roots.push(root);
    const seat = join(root, "seat"), nested = join(root, "nested"), sub = join(seat, "sub");
    for (const d of [seat, nested, sub]) mkdirSync(d, { recursive: true });
    symlinkSync(seat, join(root, "seat-link"));
    // The CLAUDE_PROJECT_DIR / OPENRIG_SEAT_PROJECT_DIR pairs, and whether the seat's effects should run.
    const cases: Array<{ label: string; claude: string | undefined; launch: string | undefined; acts: boolean }> = [
      { label: "the same folder", claude: seat, launch: seat, acts: true },
      { label: "a trailing slash", claude: `${seat}/`, launch: seat, acts: true },
      { label: "a symlink to the folder", claude: join(root, "seat-link"), launch: seat, acts: true },
      { label: "a path with a dot segment", claude: `${seat}/./`, launch: seat, acts: true },
      { label: "a nested Claude in another project", claude: nested, launch: seat, acts: false },
      { label: "a nested Claude in a folder under the seat's", claude: sub, launch: seat, acts: false },
      { label: "no launch project (an older or manual launch)", claude: nested, launch: undefined, acts: true },
      { label: "no CLAUDE_PROJECT_DIR", claude: undefined, launch: seat, acts: true },
    ];
    return { root, seat, nested, sub, cases };
  }
  const envFor = (c: { claude?: string; launch?: string }, base: Record<string, string>) => {
    const env: Record<string, string> = { PATH: process.env.PATH ?? "", ...base };
    if (c.claude !== undefined) env.CLAUDE_PROJECT_DIR = c.claude;
    if (c.launch !== undefined) env.OPENRIG_SEAT_PROJECT_DIR = c.launch;
    return env;
  };

  it("the activity relay posts and records the first-launch marker only inside the seat's project, whatever the hook's cwd", async () => {
    const w = world();
    const posts: string[] = [];
    const server = createServer((req, res) => { req.on("data", () => {}); req.on("end", () => { posts.push(req.url ?? ""); res.end("{}"); }); });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const port = (server.address() as { port: number }).port;
    try {
      for (const c of w.cases) {
        posts.length = 0;
        const tmp = join(w.root, `tmp-${c.label.replace(/\W+/g, "-")}`);
        mkdirSync(tmp);
        const out = await new Promise<void>((done, fail) => {
          const child = spawn(process.execPath, [join(scripts, "hooks/scripts/activity-relay.cjs")], {
            env: envFor(c, { TMPDIR: tmp, OPENRIG_SESSION_NAME: "dev-claude@rig", OPENRIG_NODE_ID: "n1", OPENRIG_RUNTIME: "claude-code",
              OPENRIG_OCCUPANT_GENERATION: "gen-1", OPENRIG_RESUME_LAUNCH: "resume-1",
              OPENRIG_URL: `http://127.0.0.1:${port}`, OPENRIG_ACTIVITY_HOOK_TOKEN: "tok" }),
            stdio: ["pipe", "ignore", "ignore"],
          });
          child.on("error", fail); child.on("close", () => done());
          // The hook's cwd has moved into a subfolder; that must not matter either way.
          child.stdin.end(JSON.stringify({ hook_event_name: "SessionStart", session_id: "s-1", source: "startup", cwd: w.sub }));
        });
        void out;
        const markers = readdirSync(tmp).filter((n) => n.startsWith("openrig-resume-launch-"));
        expect(posts.length > 0, c.label).toBe(c.acts);
        expect(markers.length > 0, `${c.label}: marker`).toBe(c.acts);
      }
    } finally {
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  });

  it("the compaction hooks (PreCompact, the restore bridge) and refocus write nothing outside the seat's project", () => {
    const w = world();
    for (const c of w.cases) {
      const home = join(w.root, `home-${c.label.replace(/\W+/g, "-")}`);
      const out = join(home, "out");
      mkdirSync(out, { recursive: true });
      const transcript = join(home, "transcript.jsonl");
      writeFileSync(transcript, `${JSON.stringify({ sessionId: "s-1", cwd: w.seat, message: { role: "user", content: "x" } })}\n`);
      const base = { OPENRIG_HOME: home, HOME: home, OPENRIG_SESSION_NAME: "seat@rig", OPENRIG_COMPACTION_OUT_ROOT: out, OPENRIG_REFOCUS_ENABLED: "1" };
      const markers = join(home, "compaction", "restore-pending");

      // PreCompact writes the restore-pending marker.
      spawnSync(process.execPath, [join(scripts, "skills/claude-compaction-restore/scripts/precompact-hook.mjs")], {
        input: JSON.stringify({ hook_event_name: "PreCompact", session_id: "s-1", cwd: w.sub, transcript_path: transcript }),
        encoding: "utf8", env: envFor(c, base), timeout: 20_000,
      });
      expect(existsSync(join(markers, "seat@rig.json")), `${c.label}: PreCompact marker`).toBe(c.acts);

      // The bridge delivers a marker once. Give it one to deliver.
      mkdirSync(markers, { recursive: true });
      const markerFile = join(markers, "seat@rig.json");
      const planted = { sessionName: "seat@rig", outputDir: "/packet" };
      writeFileSync(markerFile, JSON.stringify(planted));
      const bridge = spawnSync(process.execPath, [join(scripts, "hooks/scripts/compaction-restore-bridge.cjs")], {
        input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s-1", cwd: w.sub }),
        encoding: "utf8", env: envFor(c, base), timeout: 10_000,
      });
      expect(bridge.stdout.includes("/packet"), `${c.label}: bridge delivery`).toBe(c.acts);
      expect(JSON.parse(readFileSync(markerFile, "utf8")).deliveryCount !== undefined, `${c.label}: bridge marker`).toBe(c.acts);

      // Refocus keeps due-state per seat and session.
      spawnSync(process.execPath, [join(scripts, "hooks/scripts/refocus.cjs"), "--runtime", "claude"], {
        input: JSON.stringify({ hook_event_name: "PostCompact", session_id: "s-1", cwd: w.sub, transcript_path: transcript }),
        encoding: "utf8", env: envFor(c, base), timeout: 10_000,
      });
      expect(existsSync(join(home, "refocus")), `${c.label}: refocus state`).toBe(c.acts);
    }
  });

  it("keeps one copy of the boundary check in the four scripts that have it", () => {
    const files = ["hooks/scripts/activity-relay.cjs", "hooks/scripts/compaction-restore-bridge.cjs", "hooks/scripts/refocus.cjs",
      "skills/claude-compaction-restore/scripts/precompact-hook.mjs"];
    const block = (file: string) => {
      const text = readFileSync(join(scripts, file), "utf8");
      const start = text.indexOf("// --- seat project boundary");
      const end = text.indexOf("// --- end seat project boundary ---");
      expect(start, file).toBeGreaterThanOrEqual(0);
      expect(end, file).toBeGreaterThan(start);
      return text.slice(start, end);
    };
    const first = block(files[0]!);
    for (const file of files.slice(1)) expect(block(file), file).toBe(first);
    // The disk's own letter case, not the case a path was typed in (see the macOS test below).
    expect(first).toContain("fs.realpathSync.native(");
    expect(first).not.toMatch(/fs\.realpathSync\(/);
  });

  // macOS volumes are case-insensitive by default, and Claude's CLAUDE_PROJECT_DIR carries the case the disk has while a
  // seat's folder may be written in another case. fs.realpathSync keeps the typed case; fs.realpathSync.native gives the
  // disk's. Runs only where that is true (a case-insensitive volume on darwin); skipped everywhere else.
  it.skipIf(process.platform !== "darwin")("treats a case-variant spelling of the seat's folder as the same project (macOS)", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "seat-case-")));
    roots.push(root);
    const seat = join(root, "Seat-Project");
    mkdirSync(seat);
    const variant = join(root, "seat-project");
    if (!existsSync(variant)) return; // a case-sensitive volume: the two names are different folders, nothing to prove
    const posts: string[] = [];
    const server = createServer((req, res) => { req.on("data", () => {}); req.on("end", () => { posts.push(req.url ?? ""); res.end("{}"); }); });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const port = (server.address() as { port: number }).port;
    const post = (launch: string, claude: string) => new Promise<void>((done, fail) => {
      const child = spawn(process.execPath, [join(scripts, "hooks/scripts/activity-relay.cjs")], {
        env: { PATH: process.env.PATH ?? "", OPENRIG_SESSION_NAME: "dev-claude@rig", OPENRIG_NODE_ID: "n1", OPENRIG_RUNTIME: "claude-code",
          OPENRIG_URL: `http://127.0.0.1:${port}`, OPENRIG_ACTIVITY_HOOK_TOKEN: "tok", OPENRIG_SEAT_PROJECT_DIR: launch, CLAUDE_PROJECT_DIR: claude },
        stdio: ["pipe", "ignore", "ignore"],
      });
      child.on("error", fail); child.on("close", () => done());
      child.stdin.end(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "s-1" }));
    });
    try {
      await post(seat, variant); // the launch folder as typed, Claude's value in the disk's (here: the other) case
      await post(variant, seat);
      expect(posts).toHaveLength(2);
    } finally {
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  });
});
