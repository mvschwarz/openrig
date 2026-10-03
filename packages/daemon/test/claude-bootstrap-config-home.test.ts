// Maintainer-owned file/launch fixtures only: no native Claude, daemon, tmux,
// provider or real user configuration. The fake reads the selected state; this
// proves OpenRig's routing, not Claude ingestion or successful login.
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { ClaudeManagedLaunch } from "../src/domain/claude-managed-launch.js";
import { StartupOrchestrator } from "../src/domain/startup-orchestrator.js";
import type { SessionRegistry } from "../src/domain/session-registry.js";
import type { EventBus } from "../src/domain/event-bus.js";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const selections = ["unset", "default-looking", "alternate", "relative", "empty"] as const;
type Selection = typeof selections[number];
const sentinel = { syntheticAccount: { value: "fixture-only-preserve-me" }, theme: "chosen", arbitrary: [1, 2],
  projects: { elsewhere: { untouched: true } } };

function fixture(selection: Selection, separateHomes: boolean, populated: boolean) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "claude-bootstrap-")));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "seat's project");
  const home = path.join(root, "managed-home");
  const daemonHome = separateHomes ? path.join(root, "daemon-home") : home;
  const bin = path.join(root, "bin");
  for (const dir of [cwd, home, daemonHome, bin]) fs.mkdirSync(dir, { recursive: true });
  const env: Record<string, string> = { PATH: bin, HOME: home };
  if (selection !== "unset") env.CLAUDE_CONFIG_DIR = selection === "default-looking" ? path.join(home, ".claude")
    : selection === "alternate" ? path.join(root, "selected-config") : selection === "empty" ? "" : "./relative-config";
  const configDir = path.resolve(cwd, env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"));
  const statePath = env.CLAUDE_CONFIG_DIR === undefined ? path.join(home, ".claude.json") : path.join(configDir, ".claude.json");
  const untouched = new Map<string, string>();
  for (const file of new Set([path.join(daemonHome, ".claude.json"), path.join(home, ".claude.json"), path.join(home, ".claude", ".claude.json")])) {
    if (file === statePath) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const text = JSON.stringify({ ...sentinel, location: file });
    fs.writeFileSync(file, text); untouched.set(file, text);
  }
  if (populated) { fs.mkdirSync(path.dirname(statePath), { recursive: true }); fs.writeFileSync(statePath, JSON.stringify(sentinel)); }
  const executable = path.join(bin, "claude");
  fs.writeFileSync(executable, `#!${process.execPath}\nconst fs = require('node:fs'), path = require('node:path');
if (process.argv.includes('--help')) { console.log('--permission-mode <mode> (choices: "acceptEdits", "default")'); process.exit(0); }
const dir = process.env.CLAUDE_CONFIG_DIR;
const statePath = dir === undefined ? path.join(process.env.HOME, '.claude.json') : path.join(dir, '.claude.json');
if (process.argv.includes('--fork-session')) {
  const sessions = path.join(dir ?? path.join(process.env.HOME, '.claude'), 'sessions'); fs.mkdirSync(sessions, {recursive:true});
  fs.writeFileSync(path.join(sessions, 'fixture.json'), JSON.stringify({name:'seat',sessionId:'fixture-fork'}));
}
console.log(JSON.stringify({env:{HOME:process.env.HOME,CLAUDE_CONFIG_DIR:dir}, statePath,
  state:fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath,'utf8')):null,args:process.argv.slice(2)}));\n`);
  fs.chmodSync(executable, 0o700);
  const db = new Database(":memory:"); cleanup.push(() => db.close());
  db.exec(`CREATE TABLE nodes(id TEXT, runtime TEXT, cwd TEXT);
    CREATE TABLE bindings(id TEXT, node_id TEXT, tmux_session TEXT, tmux_pane TEXT);
    CREATE TABLE occupant_tenures(node_id TEXT, generation_uuid TEXT, generation_ordinal INTEGER);`);
  db.prepare("INSERT INTO nodes VALUES ('node','claude-code',?)").run(cwd);
  db.exec("INSERT INTO bindings VALUES ('binding','node','seat','%1'); INSERT INTO occupant_tenures VALUES ('node','generation',1)");
  const managed = new ClaudeManagedLaunch(db, env, {});
  const reads: string[] = [], writes: string[] = [], launches: any[] = [];
  const fsOps: ClaudeAdapterFsOps = {
    homedir: daemonHome, exists: fs.existsSync, mkdirp: p => { fs.mkdirSync(p, { recursive: true }); },
    readFile: p => { reads.push(p); return fs.readFileSync(p, "utf8"); },
    writeFile: (p, text) => { writes.push(p); fs.writeFileSync(p, text); },
    copyFile: fs.copyFileSync, readdir: p => fs.readdirSync(p),
  };
  const tmux = { sendShellCommand: async (_target: string, command: string, check: () => void) => {
    check(); launches.push(JSON.parse(execFileSync("/bin/sh", ["-c", command], { encoding: "utf8", env: { HOME: daemonHome, PATH: "/usr/bin:/bin" } })));
    return { ok: true as const };
  }, getPaneCommand: async () => "claude", capturePaneContent: async () => "Claude Code\n>" } as unknown as TmuxAdapter;
  const adapter = new ClaudeCodeAdapter({ tmux, fsOps, claudeManagedLaunch: managed, sessionIdFactory: () => "fixture-fresh", sleep: async () => {} });
  const binding = { id: "binding", nodeId: "node", cwd, tmuxSession: "seat", tmuxPane: "%1", permissionMode: "acceptEdits" } as NodeBinding;
  return { root, cwd, env, statePath, untouched, reads, writes, launches, adapter, binding, fsOps, tmux, db };
}

describe.skipIf(process.platform === "win32")("Claude managed bootstrap selects the launch config home", () => {
  it.each(["fresh", "resume"])("classic %s keeps bootstrap in its inherited default home", async mode => {
    const f = fixture("alternate", false, true);
    const alternateBefore = fs.readFileSync(f.statePath, "utf8");
    let pending = "";
    f.tmux.sendText = async (_target, text) => { pending = text; return { ok: true }; };
    f.tmux.sendKeys = async () => {
      f.launches.push(JSON.parse(execFileSync("/bin/sh", ["-c", pending], {
        encoding: "utf8", cwd: f.cwd, env: { HOME: f.env.HOME, PATH: f.env.PATH + ":/usr/bin:/bin" },
      })));
      return { ok: true };
    };
    const binding = { ...f.binding, permissionMode: undefined };
    await f.adapter.deliverStartup([], binding);
    expect(await f.adapter.launchHarness(binding, { name: "seat", ...(mode === "resume" ? { resumeToken: "fixture-original" } : {}) })).toMatchObject({ ok: true });
    const observed = f.launches[0];
    expect(observed.env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
    expect(observed.statePath).toBe(path.join(f.env.HOME, ".claude.json"));
    expect(observed.state).toMatchObject({ ...sentinel, hasCompletedOnboarding: true, projects: { ...sentinel.projects, [f.cwd]: { hasTrustDialogAccepted: true } } });
    expect(new Set(f.writes)).toEqual(new Set([observed.statePath]));
    expect(fs.readFileSync(f.statePath, "utf8")).toBe(alternateBefore);
  });
  it.each(["{broken", "[]", "null", '{"projects":[]}', "invalid project"])("classic bootstrap preserves unmergeable state (%s)", async value => {
    const f = fixture("alternate", false, true);
    const file = path.join(f.env.HOME, ".claude.json");
    const before = value === "invalid project" ? JSON.stringify({ projects: { [f.cwd]: [] } }) : value;
    fs.writeFileSync(file, before);
    await f.adapter.deliverStartup([], { ...f.binding, permissionMode: undefined });
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(f.writes).toEqual([]);
  });
  it.each(["relative", "unset"] as const)("startup with missing binding cwd bootstraps the stored node's %s selection", async selection => {
    const f = fixture(selection, true, true);
    f.db.exec(`CREATE TABLE node_permission_selections(node_id TEXT, runtime TEXT, mode TEXT);
      CREATE TABLE node_startup_context(node_id TEXT PRIMARY KEY, projection_entries_json TEXT, resolved_files_json TEXT, startup_actions_json TEXT, runtime TEXT);`);
    const statuses: string[] = [];
    // Persistence/readiness boundaries are synthetic; orchestration, projection,
    // bootstrap, prepare and the emitted child command are the production path.
    const registry = { db: f.db, currentOccupantTenure: () => null,
      updateStartupStatus: (_id: string, state: string) => statuses.push(state),
      updateResumeToken: () => {} } as unknown as SessionRegistry;
    const eventBus = { db: f.db, emit: () => {} } as unknown as EventBus;
    f.adapter.checkReady = async () => ({ ready: true });
    const orchestrator = new StartupOrchestrator({ db: f.db, sessionRegistry: registry, eventBus, tmuxAdapter: f.tmux });
    const binding = { ...f.binding };
    delete (binding as Partial<NodeBinding>).cwd;
    const result = await orchestrator.startNode({ rigId: "rig", nodeId: "node", sessionId: "session",
      binding, adapter: f.adapter,
      plan: { runtime: "claude-code", cwd: f.cwd, entries: [], startup: { files: [], actions: [] }, conflicts: [], noOps: [], diagnostics: [] },
      resolvedStartupFiles: [], startupActions: [], isRestore: false });
    expect(result).toMatchObject({ ok: true });
    expect(statuses).toEqual(["pending", "ready"]);
    expect(f.launches[0].statePath).toBe(f.statePath);
    expect(f.launches[0].state).toMatchObject({ ...sentinel, hasCompletedOnboarding: true,
      projects: { ...sentinel.projects, [f.cwd]: { hasTrustDialogAccepted: true } } });
    expect(new Set(f.writes)).toEqual(new Set([f.statePath]));
    for (const [file, before] of f.untouched) expect(fs.readFileSync(file, "utf8")).toBe(before);
  });
  it("classic bootstrap without cwd preserves known-home onboarding", () => {
    const f = fixture("alternate", false, true);
    f.adapter.ensureManagedBootstrap({ ...f.binding, cwd: undefined, permissionMode: undefined });
    expect(JSON.parse(fs.readFileSync(path.join(f.env.HOME, ".claude.json"), "utf8")))
      .toMatchObject({ ...sentinel, hasCompletedOnboarding: true });
  });
  it.each(["projects", "project entry"])("preserves an unmergeable %s field", async field => {
    const f = fixture("alternate", true, true);
    const state = { ...sentinel, projects: field === "projects" ? [] : { [f.cwd]: [] } };
    const before = JSON.stringify(state);
    fs.writeFileSync(f.statePath, before);
    expect(await f.adapter.deliverStartup([], f.binding)).toEqual({ delivered: 0, failed: [] });
    expect(fs.readFileSync(f.statePath, "utf8")).toBe(before);
    expect(f.writes).toEqual([]);
  });
  it.each(["{broken", "[]", "null"])("preserves unmergeable selected state (%s), without falling back", async text => {
    const f = fixture("alternate", true, true);
    fs.writeFileSync(f.statePath, text);
    expect(await f.adapter.deliverStartup([], f.binding)).toEqual({ delivered: 0, failed: [] });
    expect(fs.readFileSync(f.statePath, "utf8")).toBe(text);
    expect(f.writes).toEqual([]);
    for (const [file, before] of f.untouched) expect(fs.readFileSync(file, "utf8")).toBe(before);
  });
  it("preserves unreadable selected state without writing another home", async () => {
    const f = fixture("alternate", true, true);
    f.fsOps.readFile = () => { throw Error("synthetic read refusal"); };
    expect(await f.adapter.deliverStartup([], f.binding)).toEqual({ delivered: 0, failed: [] });
    expect(JSON.parse(fs.readFileSync(f.statePath, "utf8"))).toEqual(sentinel);
    expect(f.writes).toEqual([]);
  });
  for (const selection of selections) for (const separateHomes of [false, true]) for (const populated of [false, true]) {
    it(`${selection}; ${separateHomes ? "two homes" : "same home"}; ${populated ? "populated" : "fresh"}`, async () => {
      const f = fixture(selection, separateHomes, populated);
      // The ordinary prelaunch delivery + launch seams, with no rigbundle involved.
      expect(await f.adapter.deliverStartup([], f.binding)).toEqual({ delivered: 0, failed: [] });
      expect(await f.adapter.launchHarness(f.binding, { name: "seat" })).toMatchObject({ ok: true });
      const observed = f.launches[0];
      if (process.env.BOOTSTRAP_FIXTURE_RECEIPTS) fs.appendFileSync(process.env.BOOTSTRAP_FIXTURE_RECEIPTS, JSON.stringify({
        selection, separateHomes, populated, expected: f.statePath, reads: f.reads, writes: f.writes,
        launchSelection: observed.env, selectedStatePresent: observed.state !== null,
        onboarding: observed.state?.hasCompletedOnboarding, trust: observed.state?.projects?.[f.cwd]?.hasTrustDialogAccepted,
      }) + "\n");
      expect.soft(observed.state).toMatchObject({ hasCompletedOnboarding: true, projects: { [f.cwd]: { hasTrustDialogAccepted: true } } });
      expect.soft(new Set(f.writes)).toEqual(new Set([f.statePath]));
      expect.soft(f.reads.filter(p => p.endsWith(".claude.json")).every(p => p === f.statePath)).toBe(true);
      for (const [file, text] of f.untouched) expect.soft(fs.readFileSync(file, "utf8")).toBe(text);
      if (populated) expect.soft(observed.state).toMatchObject(sentinel);
      expect(observed.env.HOME).toBe(f.env.HOME);
      if (selection === "unset") expect(observed.env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
      else expect(observed.env.CLAUDE_CONFIG_DIR).toBe(path.dirname(f.statePath));
      expect(observed.args.slice(0, 2)).toEqual(["--permission-mode", "acceptEdits"]);
    });
  }
  it.each(["resume", "fork"])("%s uses the same selected bootstrap path", async mode => {
    const f = fixture("relative", true, true);
    await f.adapter.deliverStartup([], f.binding);
    const result = await f.adapter.launchHarness(f.binding, mode === "resume"
      ? { name: "seat", resumeToken: "fixture-original" }
      : { name: "seat", forkSource: { kind: "native_id", value: "fixture-original" } });
    expect(result).toMatchObject({ ok: true });
    expect(f.launches[0].state).toMatchObject({ ...sentinel, hasCompletedOnboarding: true, projects: { ...sentinel.projects, [f.cwd]: { hasTrustDialogAccepted: true } } });
    expect(new Set(f.writes)).toEqual(new Set([f.statePath]));
    for (const [file, text] of f.untouched) expect(fs.readFileSync(file, "utf8")).toBe(text);
  });
});
