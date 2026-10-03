// Run in CI's clean HOME, without provider credentials. Every executable below is a fixture.
import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { SeatLaunchEnvironment } from "../src/domain/seat-launch-environment.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { CodexThreadIdResolver } from "../src/domain/codex-thread-id.js";
import { ContextUsageStore } from "../src/domain/context-usage-store.js";
import { codexDaemonSupportProbe } from "../src/domain/codex-daemon-support.js";
import { shellQuote } from "../src/adapters/shell-quote.js";

const exec = promisify(execFile), roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-selected-home-")); roots.push(root);
  const home = path.join(root, "home"), selected = path.join(root, "selected home's"), cwd = path.join(root, "project-two"), bin = path.join(root, "bin");
  for (const dir of [home, selected, cwd, bin, path.join(home, ".codex"), path.join(root, "project-one")]) fs.mkdirSync(dir, { recursive: true });
  const firstConfig = path.join(home, ".codex/config.toml"); fs.writeFileSync(firstConfig, '# first-home sentinel\nmodel = "fixture"\n');
  fs.writeFileSync(path.join(home, '.codex/history.jsonl'), '{"fixture":"first-home"}\n');
  fs.writeFileSync(path.join(root, 'project-one/AGENTS.md'), 'first-project sentinel\n');
  fs.writeFileSync(path.join(bin, "codex"), `#!${process.execPath}\nconst fs=require('node:fs');const r={home:process.env.CODEX_HOME,cwd:process.cwd(),argv:process.argv.slice(2)};if(process.env.PROBE_RECORD)fs.appendFileSync(process.env.PROBE_RECORD,JSON.stringify(r)+'\\n');if(process.argv.includes('--help'))console.log('Usage: codex [OPTIONS]\\n  --no-daemon');else if(process.argv.includes('--version'))console.log('codex-cli 0.155.1');else console.log(JSON.stringify(r));\n`, { mode: 0o700 });
  const cli = path.join(bin, "rig"); fs.writeFileSync(cli, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const env = { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, CODEX_HOME: selected, OPENRIG_HOME: path.join(root, "instance") };
  const ids: Record<string, string> = { OPENRIG_NODE_ID: "node", OPENRIG_SESSION_NAME: "seat@rig", OPENRIG_RUNTIME: "codex", OPENRIG_OCCUPANT_GENERATION: "generation" };
  const tmux = { getPaneCommand: vi.fn(async () => "bash"), getSessionEnv: vi.fn(async (_s: string, k: string) => ids[k]), sendShellCommand: vi.fn(async (_s: string, _cmd: string) => ({ ok: true })) };
  const fsOps = { homedir: home, readFile: (p: string) => fs.readFileSync(p, "utf8"), writeFile: (p: string, c: string) => fs.writeFileSync(p, c), exists: fs.existsSync, mkdirp: (p: string) => { fs.mkdirSync(p, { recursive: true }); } };
  const launch = (explicit: boolean) => new (SeatLaunchEnvironment as any)(tmux, env, root, cli, explicit ? selected : undefined) as SeatLaunchEnvironment;
  const rc = path.join(root, 'pane.rc'); fs.writeFileSync(rc, `export CODEX_HOME=${shellQuote(path.join(home, '.codex'))}\n`);
  const run = (cmd: string) => exec('/bin/bash', ['--noprofile', '--norc', '-c', `. ${shellQuote(rc)}; ${cmd}`], { cwd, env, timeout: 5000 });
  return { root, home, selected, cwd, bin, env, tmux, fsOps, launch, run, firstConfig };
}

it.each(["fresh", "resume", "fork", "legacy"])("explicit home wins over pane rc for %s; executable PATH is retained", async kind => {
  const f = fixture(), launch = f.launch(true);
  if (kind === "legacy") {
    const adapter = new CodexResumeAdapter(f.tmux as any, { seatLaunchEnvironment: launch, launchPath: f.env.PATH });
    vi.spyOn(adapter as any, 'verifyResume').mockResolvedValue({ ok: true });
    expect((await adapter.resume('seat@rig', 'codex_id', 'old', f.cwd)).ok).toBe(true);
  } else {
    const adapter = new CodexRuntimeAdapter({ tmux: f.tmux as any, fsOps: f.fsOps, codexHome: f.selected, launchPath: f.env.PATH, seatLaunchEnvironment: launch, resolveGitAddDirs: async () => [] });
    vi.spyOn(adapter as any, 'dismissSkippableCodexUpdatePrompt').mockResolvedValue(undefined);
    vi.spyOn(adapter as any, 'captureFreshThreadId').mockResolvedValue('fresh');
    vi.spyOn(adapter as any, 'verifyResumeLaunch').mockResolvedValue({ ok: true });
    expect((await adapter.launchHarness({ nodeId: 'node', tmuxSession: 'seat@rig', cwd: f.cwd } as any,
      { name: 'seat', ...(kind === 'resume' ? { resumeToken: 'old' } : kind === 'fork' ? { forkSource: { kind: 'native_id' as const, value: 'parent' } } : {}) })).ok).toBe(true);
  }
  expect(JSON.parse((await f.run(f.tmux.sendShellCommand.mock.calls.at(-1)![1])).stdout).home).toBe(f.selected);
});
it("unset selection keeps the pane home, including when startup supplies its default session home", async () => {
  const f = fixture();
  const cmd = await f.launch(false).command('seat@rig', 'codex --versionless', { codexCwd: f.cwd });
  expect(JSON.parse((await f.run(cmd)).stdout).home).toBe(path.join(f.home, '.codex'));
});
it("explicit home survives the existing metadata-unavailable fallback", async () => {
  const f = fixture(); f.tmux.getSessionEnv.mockRejectedValue(Error('unavailable'));
  const cmd = await f.launch(true).command('seat@rig', 'codex --versionless', { codexCwd: f.cwd });
  expect(JSON.parse((await f.run(cmd)).stdout).home).toBe(f.selected);
});
it.each(['managed', 'legacy', 'capability'])("%s probe uses the explicit home and launch PATH/cwd", async kind => {
  const f = fixture(), record = path.join(f.root, 'probe.jsonl');
  vi.stubEnv('CODEX_HOME', path.join(f.home, '.codex')); vi.stubEnv('PATH', f.env.PATH); vi.stubEnv('PROBE_RECORD', record);
  if (kind === 'capability') {
    expect(await (codexDaemonSupportProbe as any)(f.env.PATH, 5000, f.selected)(f.cwd)).toEqual({ kind: 'supported' });
  } else if (kind === 'legacy') {
    const a = new CodexResumeAdapter(f.tmux as any, { codexHome: f.selected, launchPath: f.env.PATH } as any);
    vi.spyOn(a as any, 'verifyResume').mockResolvedValue({ ok: true });
    expect((await a.resume('seat@rig', 'codex_id', 'old', f.cwd, 'fixture')).ok).toBe(true);
  } else {
    const a = new CodexRuntimeAdapter({ tmux: f.tmux as any, fsOps: f.fsOps, codexHome: f.selected, launchPath: f.env.PATH, resolveGitAddDirs: async () => [] });
    vi.spyOn(a as any, 'dismissSkippableCodexUpdatePrompt').mockResolvedValue(undefined); vi.spyOn(a as any, 'captureFreshThreadId').mockResolvedValue('fresh');
    expect((await a.launchHarness({ nodeId: 'node', tmuxSession: 'seat@rig', cwd: f.cwd, codexConfigProfile: 'fixture' } as any, { name: 'seat' })).ok).toBe(true);
  }
  const rows = fs.readFileSync(record, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  expect(rows.length).toBeGreaterThan(0); for (const r of rows) { expect(r.home).toBe(f.selected); expect(r.cwd).toBe(f.cwd); }
  if (kind !== 'capability') expect(JSON.parse((await f.run(f.tmux.sendShellCommand.mock.calls.at(-1)![1])).stdout).home).toBe(f.selected);
});
function seed(root: string, id: string) {
  const logs = new Database(path.join(root, 'logs_2.sqlite')); logs.exec('CREATE TABLE logs (process_uuid TEXT,thread_id TEXT,ts INTEGER)');
  logs.prepare('INSERT INTO logs VALUES (?,?,?)').run('pid:42:fixture', id, 2000000000); logs.close();
  const state = new Database(path.join(root, 'state_5.sqlite')); state.exec('CREATE TABLE threads (id TEXT,source TEXT,rollout_path TEXT)');
  state.prepare('INSERT INTO threads VALUES (?,?,?)').run(id, 'cli', path.join(root, 'rollout.jsonl')); state.close();
}
it("selected state root wins without querying PID HOME or falling through to another home", async () => {
  const f = fixture(); seed(path.join(f.home, '.codex'), 'first'); seed(f.selected, 'second');
  const pidHome = vi.fn(() => f.home);
  const resolver = new CodexThreadIdResolver({ defaultHome: f.home, codexHome: f.selected, resolveHomeDirByPid: pidHome } as any);
  expect(await resolver.resolve(42, 'Sat Oct  3 00:00:00 2026')).toBe('second'); expect(pidHome).not.toHaveBeenCalled();
  expect(await resolver.resolve(42, 'Sat Oct  3 00:00:00 2037')).toBeUndefined();
  fs.unlinkSync(path.join(f.selected, 'logs_2.sqlite'));
  expect(await resolver.resolve(42, 'Sat Oct  3 00:00:00 2026')).toBeUndefined(); expect(pidHome).not.toHaveBeenCalled();
});
it("adapter capture and context usage read the selected root", async () => {
  const f = fixture(); seed(path.join(f.home, '.codex'), 'first'); seed(f.selected, 'second');
  const a = new CodexRuntimeAdapter({ tmux: f.tmux as any, fsOps: f.fsOps, codexHome: f.selected, resolveHomeDirByPid: () => f.home });
  expect(await (a as any).readThreadIdFromLogs(42)).toBe('second');
  const db = new Database(':memory:');
  try { const s = new ContextUsageStore(db, { stateDir: f.root, codexHomeDir: f.home, codexHome: f.selected } as any); expect((s as any).resolveCodexStateDbPaths()).toEqual([path.join(f.selected, 'state_5.sqlite')]); }
  finally { db.close(); }
});
it("seatless startup, disable and projection preserve the other home's bytes; startup readers share the selection", async () => {
  const f = fixture(), before = fs.readFileSync(f.firstConfig);
  vi.spyOn(os, 'homedir').mockReturnValue(f.home);
  for (const [k, v] of Object.entries(f.env)) vi.stubEnv(k, v);
  vi.stubEnv('OPENRIG_DB', path.join(f.root, 'instance.sqlite')); vi.stubEnv('OPENRIG_NO_KERNEL', '1');
  vi.stubEnv('OPENRIG_RUNTIME_CODEX_HOOKS_ENABLED', 'true'); vi.stubEnv('OPENRIG_URL', undefined); vi.stubEnv('OPENRIG_PORT', undefined);
  const { createDaemon } = await import('../src/startup.js');
  const start = () => createDaemon({ dbPath: process.env.OPENRIG_DB!, tmuxExec: async () => '', cmuxFactory: async () => { throw Error('fixture: no cmux'); } });
  const first = await start();
  try {
    expect(first.db.prepare('SELECT count(*) AS n FROM nodes').get()).toEqual({ n: 0 });
    const config = path.join(f.selected, 'config.toml'); const text = fs.readFileSync(config, 'utf8');
    expect(text).toContain('trusted_hash'); expect(text).toContain('hooks');
    const a = first.deps.runtimeAdapters!.codex as CodexRuntimeAdapter;
    a.ensureCodexFeatureFlag(true, { codexVersion: '0.120.0' });
    expect(fs.readFileSync(config, 'utf8')).toContain('codex_hooks = true');
    a.ensureManagedBootstrap({ cwd: f.cwd });
    const fragment = path.join(f.cwd, 'fragment.toml'); fs.writeFileSync(fragment, '[sandbox_workspace_write]\nnetwork_access = false\n');
    const result = await a.project({ entries: [{ category: 'runtime_resource', effectiveId: 'fixture', classification: 'safe_projection', resourceType: 'codex_config_fragment', absolutePath: fragment }] } as any, { cwd: f.cwd } as any);
    expect(result.failed).toEqual([]); expect(fs.readFileSync(config, 'utf8')).toContain('network_access = false');
    expect(fs.readFileSync(config, 'utf8')).toContain(f.cwd);
    expect((first.deps.pluginDiscoveryService as any).opts.codexCacheDir).toBe(path.join(f.selected, 'plugins/cache'));
    seed(f.selected, 'second');
    expect((first.deps.contextUsageStore as any).resolveCodexStateDbPaths()).toEqual([path.join(f.selected, 'state_5.sqlite')]);
    expect(await (first.deps.resumeMetadataRefresher as any).readCodexThreadIdByPid(42, 'Sat Oct  3 00:00:00 2026')).toBe('second');
    expect(fs.readFileSync(f.firstConfig)).toEqual(before);
  } finally { first.db.close(); }
  vi.stubEnv('OPENRIG_RUNTIME_CODEX_HOOKS_ENABLED', 'false');
  const second = await start();
  try {
    expect(fs.readFileSync(path.join(f.selected, 'config.toml'), 'utf8')).not.toContain('# BEGIN OPENRIG MANAGED ACTIVITY HOOKS');
    expect(fs.readFileSync(f.firstConfig)).toEqual(before);
    expect(fs.readdirSync(path.join(f.home, '.codex')).sort()).toEqual(['config.toml', 'history.jsonl']);
    expect(fs.readFileSync(path.join(f.home, '.codex/history.jsonl'), 'utf8')).toBe('{"fixture":"first-home"}\n');
    expect(fs.readFileSync(path.join(f.root, 'project-one/AGENTS.md'), 'utf8')).toBe('first-project sentinel\n');
  }
  finally { second.db.close(); }
}, 60000);

it.each([
  { name: 'unset', selection: undefined },
  { name: 'empty', selection: '' },
])('$name home selection keeps seatless startup writes in the default home', async ({ selection }) => {
  const f = fixture(), originalCwd = process.cwd();
  vi.resetModules();
  vi.spyOn(os, 'homedir').mockReturnValue(f.home);
  for (const [k, v] of Object.entries(f.env)) vi.stubEnv(k, v);
  vi.stubEnv('CODEX_HOME', selection);
  vi.stubEnv('OPENRIG_DB', path.join(f.root, 'instance.sqlite'));
  vi.stubEnv('OPENRIG_NO_KERNEL', '1');
  vi.stubEnv('OPENRIG_RUNTIME_CODEX_HOOKS_ENABLED', 'true');
  vi.stubEnv('OPENRIG_URL', undefined); vi.stubEnv('OPENRIG_PORT', undefined);
  process.chdir(f.cwd);
  try {
    const { createDaemon } = await import('../src/startup.js');
    const daemon = await createDaemon({ dbPath: process.env.OPENRIG_DB!, tmuxExec: async () => '', cmuxFactory: async () => { throw Error('fixture: no cmux'); } });
    try {
      expect(daemon.db.prepare('SELECT count(*) AS n FROM nodes').get()).toEqual({ n: 0 });
      expect(fs.existsSync(path.join(f.cwd, 'config.toml'))).toBe(false);
      expect(fs.readFileSync(f.firstConfig, 'utf8')).toContain('trusted_hash');
      expect(fs.readFileSync(f.firstConfig, 'utf8')).toContain('# BEGIN OPENRIG MANAGED ACTIVITY HOOKS');
      expect(daemon.deps.sessionEnv!.CODEX_HOME).toBe(path.join(f.home, '.codex'));
      expect((daemon.deps.pluginDiscoveryService as any).opts.codexCacheDir).toBe(path.join(f.home, '.codex/plugins/cache'));
      expect(fs.readdirSync(f.selected)).toEqual([]);
    } finally { daemon.db.close(); }
  } finally { process.chdir(originalCwd); }
}, 60000);

it.each(['   ', 'relative-codex-home'])('keeps the startup refusal for non-absolute home %j', async selection => {
  const f = fixture();
  vi.stubEnv('CODEX_HOME', selection);
  const { createDaemon } = await import('../src/startup.js');
  await expect(createDaemon({ dbPath: path.join(f.root, 'must-not-exist.sqlite') }))
    .rejects.toThrow('CODEX_HOME must be an absolute path');
  expect(fs.existsSync(path.join(f.root, 'must-not-exist.sqlite'))).toBe(false);
});
