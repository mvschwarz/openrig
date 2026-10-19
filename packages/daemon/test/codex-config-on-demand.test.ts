// Run in CI's clean HOME, without provider credentials. Every executable below is a fixture.
// The Codex config.toml is the user's file: a daemon touches it only when it has or launches a Codex seat.
import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

const USER_CONFIG = '# user sentinel\nmodel = "fixture"\n';
const HOOKS_BLOCK = "# BEGIN OPENRIG MANAGED ACTIVITY HOOKS";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-config-on-demand-")); roots.push(root);
  const home = path.join(root, "home"), codexHome = path.join(root, "codex-home"), bin = path.join(root, "bin"), cwd = path.join(root, "project");
  for (const dir of [home, codexHome, bin, cwd]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(bin, "codex"), `#!${process.execPath}\nif(process.argv.includes('--help'))console.log('Usage: codex [OPTIONS]\\n  --no-daemon');else if(process.argv.includes('--version'))console.log('codex-cli 0.155.1');\n`, { mode: 0o700 });
  const config = path.join(codexHome, "config.toml");
  const env = { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, CODEX_HOME: codexHome, OPENRIG_HOME: path.join(root, "instance") };
  return { root, home, codexHome, cwd, config, env };
}

async function startDaemon(f: ReturnType<typeof fixture>, hooksEnabled = true) {
  vi.resetModules();
  vi.spyOn(os, "homedir").mockReturnValue(f.home);
  for (const [k, v] of Object.entries(f.env)) vi.stubEnv(k, v);
  vi.stubEnv("OPENRIG_DB", path.join(f.root, "instance.sqlite")); vi.stubEnv("OPENRIG_NO_KERNEL", "1");
  vi.stubEnv("OPENRIG_RUNTIME_CODEX_HOOKS_ENABLED", String(hooksEnabled)); vi.stubEnv("OPENRIG_URL", undefined); vi.stubEnv("OPENRIG_PORT", undefined);
  const { createDaemon } = await import("../src/startup.js");
  return createDaemon({ dbPath: process.env.OPENRIG_DB!, tmuxExec: async () => "", cmuxFactory: async () => { throw Error("fixture: no cmux"); } });
}

it("a daemon with no Codex seat leaves an existing config.toml byte-identical", async () => {
  const f = fixture(); fs.writeFileSync(f.config, USER_CONFIG);
  const before = fs.statSync(f.config).mtimeMs;
  const daemon = await startDaemon(f);
  try {
    expect(daemon.db.prepare("SELECT count(*) AS n FROM nodes WHERE runtime = 'codex'").get()).toEqual({ n: 0 });
    expect(fs.readFileSync(f.config, "utf8")).toBe(USER_CONFIG);
    expect(fs.statSync(f.config).mtimeMs).toBe(before);
  } finally { daemon.db.close(); }
}, 60000);

it("a daemon with no Codex seat does not create config.toml", async () => {
  const f = fixture();
  const daemon = await startDaemon(f);
  try { expect(fs.existsSync(f.config)).toBe(false); } finally { daemon.db.close(); }
}, 60000);

it("a daemon with no Codex seat and hooks enabled leaves a block an earlier daemon wrote as it was", async () => {
  const f = fixture(); fs.writeFileSync(f.config, USER_CONFIG);
  await launchableAdapter(f, true).ensureManagedConfig();
  const written = fs.readFileSync(f.config);
  expect(written.toString()).toContain(HOOKS_BLOCK);
  const daemon = await startDaemon(f);
  try { expect(fs.readFileSync(f.config)).toEqual(written); } finally { daemon.db.close(); }
}, 60000);

it("a daemon with no Codex seat and hooks disabled strips a stale managed block at boot", async () => {
  const f = fixture(); fs.writeFileSync(f.config, USER_CONFIG);
  await launchableAdapter(f, true).ensureManagedConfig();
  expect(fs.readFileSync(f.config, "utf8")).toContain(HOOKS_BLOCK);
  const daemon = await startDaemon(f, false);
  try {
    expect(daemon.db.prepare("SELECT count(*) AS n FROM nodes WHERE runtime = 'codex'").get()).toEqual({ n: 0 });
    const text = fs.readFileSync(f.config, "utf8");
    expect(text).not.toContain(HOOKS_BLOCK);
    expect(text).toContain(USER_CONFIG);
  } finally { daemon.db.close(); }
}, 60000);

it("a daemon with no Codex seat and hooks disabled leaves a config without the block byte-identical, or absent", async () => {
  const f = fixture(); fs.writeFileSync(f.config, USER_CONFIG);
  const before = fs.statSync(f.config).mtimeMs;
  const daemon = await startDaemon(f, false);
  try {
    expect(fs.readFileSync(f.config, "utf8")).toBe(USER_CONFIG);
    expect(fs.statSync(f.config).mtimeMs).toBe(before);
  } finally { daemon.db.close(); }
  const g = fixture();
  const other = await startDaemon(g, false);
  try { expect(fs.existsSync(g.config)).toBe(false); } finally { other.db.close(); }
}, 60000);

it("a daemon that boots with a Codex seat still writes the hooks block and trust", async () => {
  const f = fixture(); fs.writeFileSync(f.config, USER_CONFIG);
  const first = await startDaemon(f);
  first.db.prepare("INSERT INTO rigs (id, name) VALUES ('rig-1', 'r')").run();
  first.db.prepare("INSERT INTO nodes (id, rig_id, logical_id, runtime) VALUES ('node-1', 'rig-1', 'dev.impl', 'codex')").run();
  first.db.close();
  expect(fs.readFileSync(f.config, "utf8")).toBe(USER_CONFIG);
  const second = await startDaemon(f);
  try {
    const text = fs.readFileSync(f.config, "utf8");
    expect(text).toContain(USER_CONFIG);
    expect(text).toContain(HOOKS_BLOCK);
    expect(text).toContain("trusted_hash");
  } finally { second.db.close(); }
}, 60000);

it("a legacy Codex restore on a daemon with no Codex seat ensures the hooks block and trust before it resumes", async () => {
  const f = fixture(); fs.writeFileSync(f.config, USER_CONFIG);
  const daemon = await startDaemon(f);
  try {
    expect(fs.readFileSync(f.config, "utf8")).toBe(USER_CONFIG);
    const resume = (daemon.deps.restoreOrchestrator as any).codexResume;
    await resume.resume("seat@rig", "codex_id", "thread-1", f.cwd);
    const text = fs.readFileSync(f.config, "utf8");
    expect(text).toContain(USER_CONFIG);
    expect(text).toContain(HOOKS_BLOCK);
    expect(text).toContain("trusted_hash");
  } finally { daemon.db.close(); }
}, 60000);

it("a legacy Codex resume that cannot resume does not touch the config", async () => {
  const f = fixture(); fs.writeFileSync(f.config, USER_CONFIG);
  const daemon = await startDaemon(f);
  try {
    expect((await (daemon.deps.restoreOrchestrator as any).codexResume.resume("seat@rig", "codex_id", null, f.cwd)).code).toBe("no_resume");
    expect(fs.readFileSync(f.config, "utf8")).toBe(USER_CONFIG);
  } finally { daemon.db.close(); }
}, 60000);

function launchableAdapter(f: ReturnType<typeof fixture>, hooksEnabled: boolean) {
  const tmux = { getPaneCommand: vi.fn(async () => "bash"), getSessionEnv: vi.fn(async () => undefined), sendShellCommand: vi.fn(async () => ({ ok: true })) };
  const fsOps = { homedir: f.home, readFile: (p: string) => fs.readFileSync(p, "utf8"), writeFile: (p: string, c: string) => fs.writeFileSync(p, c), exists: fs.existsSync, mkdirp: (p: string) => { fs.mkdirSync(p, { recursive: true }); } };
  const relay = path.join(f.root, "activity-relay.cjs"); fs.writeFileSync(relay, "");
  const adapter = new CodexRuntimeAdapter({
    tmux: tmux as any, fsOps, codexHome: f.codexHome, launchPath: f.env.PATH, activityRelayPath: relay,
    resolveGitAddDirs: async () => [], resolveManagedConfigSettings: async () => ({ enabled: hooksEnabled, codexVersion: "0.155.1" }),
  });
  vi.spyOn(adapter as any, "dismissSkippableCodexUpdatePrompt").mockResolvedValue(undefined);
  vi.spyOn(adapter as any, "captureFreshThreadId").mockResolvedValue("fresh");
  vi.spyOn(adapter as any, "verifyResumeLaunch").mockResolvedValue({ ok: true });
  return adapter;
}

it("a Codex seat launch writes the hooks block and trust before the harness starts", async () => {
  const f = fixture(); fs.writeFileSync(f.config, USER_CONFIG);
  const adapter = launchableAdapter(f, true);
  expect(fs.readFileSync(f.config, "utf8")).toBe(USER_CONFIG);
  expect((await adapter.launchHarness({ nodeId: "node", tmuxSession: "seat@rig", cwd: f.cwd } as any, { name: "seat" })).ok).toBe(true);
  const text = fs.readFileSync(f.config, "utf8");
  expect(text).toContain(USER_CONFIG);
  expect(text).toContain(HOOKS_BLOCK);
  expect(text).toContain("trusted_hash");
});

it("a Codex seat resume ensures the config too", async () => {
  const f = fixture();
  const adapter = launchableAdapter(f, true);
  expect((await adapter.launchHarness({ nodeId: "node", tmuxSession: "seat@rig", cwd: f.cwd } as any, { name: "seat", resumeToken: "old" })).ok).toBe(true);
  expect(fs.readFileSync(f.config, "utf8")).toContain(HOOKS_BLOCK);
});

it("a launch with hooks disabled strips a previously written block", async () => {
  const f = fixture();
  await launchableAdapter(f, true).ensureManagedConfig();
  expect(fs.readFileSync(f.config, "utf8")).toContain(HOOKS_BLOCK);
  const adapter = launchableAdapter(f, false);
  expect((await adapter.launchHarness({ nodeId: "node", tmuxSession: "seat@rig", cwd: f.cwd } as any, { name: "seat" })).ok).toBe(true);
  expect(fs.readFileSync(f.config, "utf8")).not.toContain(HOOKS_BLOCK);
});

it("a config-setup failure warns and does not block the launch", async () => {
  const f = fixture();
  const adapter = launchableAdapter(f, true);
  (adapter as any).resolveManagedConfigSettings = async () => { throw new Error("probe failed"); };
  const warn = vi.spyOn(console, "error").mockImplementation(() => {});
  expect((await adapter.launchHarness({ nodeId: "node", tmuxSession: "seat@rig", cwd: f.cwd } as any, { name: "seat" })).ok).toBe(true);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("probe failed"));
});
