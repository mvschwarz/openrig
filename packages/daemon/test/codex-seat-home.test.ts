// A Codex seat that declares its own CODEX_HOME: its launch, OpenRig's managed config, thread capture and resume proof
// use that home, and a seat without one keeps the daemon's. Every executable below is a fixture; nothing here signs in.
import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { SeatLaunchEnvironment } from "../src/domain/seat-launch-environment.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { ContextUsageStore } from "../src/domain/context-usage-store.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { provenCodexResume } from "./helpers/codex-resume-proof.js";

const exec = promisify(execFile), roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-seat-home-")); roots.push(root);
  const home = path.join(root, "home"), daemonHome = path.join(root, "daemon codex"), seatHome = path.join(root, "seat's codex");
  const cwd = path.join(root, "project"), bin = path.join(root, "bin");
  for (const dir of [home, daemonHome, seatHome, cwd, bin]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(bin, "codex"), `#!${process.execPath}\nconst r={home:process.env.CODEX_HOME,argv:process.argv.slice(2)};if(process.argv.includes('--help'))console.log('Usage: codex [OPTIONS]');else if(process.argv.includes('--version'))console.log('codex-cli 0.155.1');else console.log(JSON.stringify(r));\n`, { mode: 0o700 });
  const cli = path.join(bin, "rig"); fs.writeFileSync(cli, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const env = { PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, CODEX_HOME: daemonHome, OPENRIG_HOME: path.join(root, "instance") };
  const ids: Record<string, string> = { OPENRIG_NODE_ID: "node", OPENRIG_SESSION_NAME: "seat@rig", OPENRIG_RUNTIME: "codex", OPENRIG_OCCUPANT_GENERATION: "generation" };
  const tmux = {
    getPaneCommand: vi.fn(async () => "bash"),
    getSessionEnv: vi.fn(async (_s: string, k: string) => ids[k]),
    sendShellCommand: vi.fn(async (_s: string, _cmd: string) => ({ ok: true })),
  };
  const fsOps = { homedir: home, readFile: (p: string) => fs.readFileSync(p, "utf8"), writeFile: (p: string, c: string) => fs.writeFileSync(p, c),
    exists: fs.existsSync, mkdirp: (p: string) => { fs.mkdirSync(p, { recursive: true }); } };
  const launchEnv = new (SeatLaunchEnvironment as any)(tmux, env, root, cli, daemonHome) as SeatLaunchEnvironment;
  const run = (cmd: string) => exec("/bin/bash", ["--noprofile", "--norc", "-c", cmd], { cwd, env, timeout: 5000 });
  const seatHomeOf = (nodeId: string) => nodeId === "node" ? seatHome : undefined;
  return { root, home, daemonHome, seatHome, cwd, env, tmux, fsOps, launchEnv, run, seatHomeOf };
}

function seed(root: string, id: string) {
  const logs = new Database(path.join(root, "logs_2.sqlite")); logs.exec("CREATE TABLE logs (process_uuid TEXT,thread_id TEXT,ts INTEGER)");
  logs.prepare("INSERT INTO logs VALUES (?,?,?)").run("pid:42:fixture", id, 2000000000); logs.close();
  const state = new Database(path.join(root, "state_5.sqlite")); state.exec("CREATE TABLE threads (id TEXT,source TEXT,rollout_path TEXT)");
  state.prepare("INSERT INTO threads VALUES (?,?,?)").run(id, "cli", path.join(root, "rollout.jsonl")); state.close();
}

// OpenRig's managed config: without an activity relay it's the hooks feature flag alone.
const MANAGED_FLAG = "codex_hooks = true";

it.each(["fresh", "resume", "fork"])("a seat's own CODEX_HOME wins over the daemon's for a %s launch, and gets OpenRig's managed config", async kind => {
  const f = fixture();
  const adapter = new CodexRuntimeAdapter({ tmux: f.tmux as any, fsOps: f.fsOps, codexHome: f.daemonHome, seatHome: f.seatHomeOf,
    launchPath: f.env.PATH, seatLaunchEnvironment: f.launchEnv, resolveGitAddDirs: async () => [],
    resolveManagedConfigSettings: async () => ({ enabled: true, codexVersion: "0.120.0" }) });
  vi.spyOn(adapter as any, "dismissSkippableCodexUpdatePrompt").mockResolvedValue(undefined);
  vi.spyOn(adapter as any, "captureFreshThreadId").mockResolvedValue("fresh");
  vi.spyOn(adapter as any, "captureVerifiedForkId").mockResolvedValue("fresh");
  const verify = vi.spyOn(adapter as any, "verifyResumeLaunch").mockResolvedValue({ ok: true });
  const result = await adapter.launchHarness({ nodeId: "node", tmuxSession: "seat@rig", cwd: f.cwd } as any,
    { name: "seat", ...(kind === "resume" ? { resumeToken: "old" } : kind === "fork" ? { forkSource: { kind: "native_id" as const, value: "parent" } } : {}) });
  expect(result.ok).toBe(true);
  expect(JSON.parse((await f.run(f.tmux.sendShellCommand.mock.calls.at(-1)![1])).stdout).home).toBe(f.seatHome);
  expect(fs.readFileSync(path.join(f.seatHome, "config.toml"), "utf8")).toContain(MANAGED_FLAG);
  expect(fs.existsSync(path.join(f.daemonHome, "config.toml"))).toBe(false);
  if (kind === "resume") expect(verify).toHaveBeenCalledWith("seat@rig", expect.anything(), expect.objectContaining({ home: f.seatHome }));
});

it("a seat without its own home keeps the daemon's CODEX_HOME and config", async () => {
  const f = fixture();
  const adapter = new CodexRuntimeAdapter({ tmux: f.tmux as any, fsOps: f.fsOps, codexHome: f.daemonHome, seatHome: f.seatHomeOf,
    launchPath: f.env.PATH, seatLaunchEnvironment: f.launchEnv, resolveGitAddDirs: async () => [],
    resolveManagedConfigSettings: async () => ({ enabled: true, codexVersion: "0.120.0" }) });
  vi.spyOn(adapter as any, "dismissSkippableCodexUpdatePrompt").mockResolvedValue(undefined);
  vi.spyOn(adapter as any, "captureFreshThreadId").mockResolvedValue("fresh");
  expect((await adapter.launchHarness({ nodeId: "other", tmuxSession: "seat@rig", cwd: f.cwd } as any, { name: "seat" })).ok).toBe(true);
  expect(JSON.parse((await f.run(f.tmux.sendShellCommand.mock.calls.at(-1)![1])).stdout).home).toBe(f.daemonHome);
  expect(fs.readFileSync(path.join(f.daemonHome, "config.toml"), "utf8")).toContain(MANAGED_FLAG);
  expect(fs.readdirSync(f.seatHome)).toEqual([]);
});

it("thread capture reads the seat's own home, and the daemon's for a seat without one", async () => {
  const f = fixture(); seed(f.daemonHome, "daemon-thread"); seed(f.seatHome, "seat-thread");
  const adapter = new CodexRuntimeAdapter({ tmux: f.tmux as any, fsOps: f.fsOps, codexHome: f.daemonHome, seatHome: f.seatHomeOf,
    resolveHomeDirByPid: () => f.home });
  expect(await (adapter as any).readThreadIdByPid(42, undefined, f.seatHome)).toBe("seat-thread");
  expect(await (adapter as any).readThreadIdByPid(42, undefined, undefined)).toBe("daemon-thread");

  const reads: Array<[number, string | undefined, string | undefined]> = [];
  const capturing = new CodexRuntimeAdapter({ tmux: { ...f.tmux, getPanePid: async () => 900 } as any, fsOps: f.fsOps,
    codexHome: f.daemonHome, seatHome: f.seatHomeOf, sleep: async () => {},
    readThreadIdByPid: async (pid, identity, home) => { reads.push([pid, identity, home]); return home === f.seatHome ? "seat-thread" : undefined; } });
  vi.spyOn(capturing as any, "findCodexDescendantPids").mockResolvedValue([901]);
  expect(await (capturing as any).captureFreshThreadId({ nodeId: "node", tmuxSession: "seat@rig" }, { handled: false })).toBe("seat-thread");
  expect(reads).toEqual([[901, undefined, f.seatHome]]);
});

it("the in-place restart's resume proof reads the seat's own home", async () => {
  const f = fixture();
  const proof = provenCodexResume("conversation-1");
  const homes: Array<string | undefined> = [];
  const adapter = new CodexRuntimeAdapter({ tmux: { ...f.tmux, getPanePid: proof.getPanePid } as any, fsOps: f.fsOps,
    codexHome: f.daemonHome, seatHome: f.seatHomeOf, sleep: async () => {}, listProcesses: proof.listProcesses as never });
  const verify = vi.spyOn(adapter as any, "verifyResumeLaunch").mockImplementation(async (...args: unknown[]) => {
    homes.push((args[2] as { home?: string }).home); return { ok: true };
  });
  vi.spyOn(adapter as any, "dismissSkippableCodexUpdatePrompt").mockResolvedValue(undefined);
  expect((await adapter.verifyResumeInPane("seat@rig", "conversation-1", "node")).ok).toBe(true);
  expect((await adapter.sendResumeCommand("seat@rig", "codex resume conversation-1", "conversation-1", "node")).ok).toBe(true);
  expect((await adapter.verifyResumeInPane("seat@rig", "conversation-1")).ok).toBe(true);
  expect(verify).toHaveBeenCalledTimes(3);
  // Without a seat, the proof is asked exactly as before: no home, so its reader keeps the daemon's.
  expect(homes).toEqual([f.seatHome, f.seatHome, undefined]);
});

it("a home the caller read from the running Codex wins over the seat's declared one and the daemon's", async () => {
  const f = fixture();
  const homes: Array<string | undefined> = [];
  const adapter = new CodexRuntimeAdapter({ tmux: f.tmux as any, fsOps: f.fsOps, codexHome: f.daemonHome, seatHome: f.seatHomeOf,
    sleep: async () => {} });
  vi.spyOn(adapter as any, "verifyResumeLaunch").mockImplementation(async (...args: unknown[]) => {
    homes.push((args[2] as { home?: string }).home); return { ok: true };
  });
  vi.spyOn(adapter as any, "dismissSkippableCodexUpdatePrompt").mockResolvedValue(undefined);
  await adapter.verifyResumeInPane("seat@rig", "conversation-1", "node", "/running/codex-home");
  await adapter.verifyResumeInPane("seat@rig", "conversation-1", undefined, "/running/codex-home");
  await adapter.sendResumeCommand("seat@rig", "codex resume conversation-1", "conversation-1", "node", "/running/codex-home");
  expect(homes).toEqual(["/running/codex-home", "/running/codex-home", "/running/codex-home"]);
});

it("the resume proof itself reads evidence from the home it's given", async () => {
  const f = fixture();
  const proof = provenCodexResume("conversation-1");
  const evidence = vi.fn(async (_pid: number, _identity: string, home?: string) =>
    home === f.seatHome ? { threadId: "conversation-1" } : { reason: "no_log_row" });
  const adapter = new CodexRuntimeAdapter({ tmux: { ...f.tmux, getPanePid: proof.getPanePid } as any, fsOps: f.fsOps,
    codexHome: f.daemonHome, seatHome: f.seatHomeOf, sleep: async () => {}, listProcesses: proof.listProcesses as never,
    readResumeEvidence: evidence as never });
  const proved = await (adapter as any).proveResumedProcess("seat@rig", "conversation-1", Date.now() + 5000, f.seatHome);
  expect(evidence).toHaveBeenCalledWith(901, expect.any(String), f.seatHome);
  expect(proved).toMatchObject({ kind: "match" });
});

it("the legacy Codex resume launches in the seat's own home when one is passed, and in the daemon's otherwise", async () => {
  const f = fixture();
  const ensured: Array<string | undefined> = [];
  const adapter = new CodexResumeAdapter(f.tmux as any, { codexHome: f.daemonHome, seatLaunchEnvironment: f.launchEnv, launchPath: f.env.PATH,
    ensureManagedConfig: async (home?: string) => { ensured.push(home); } } as any);
  vi.spyOn(adapter as any, "verifyResume").mockResolvedValue({ ok: true });
  const homeOf = async () => JSON.parse((await f.run(f.tmux.sendShellCommand.mock.calls.at(-1)![1])).stdout).home;
  expect((await adapter.resume("seat@rig", "codex_id", "old", f.cwd, undefined, undefined, undefined, undefined, undefined, undefined, undefined, f.seatHome)).ok).toBe(true);
  expect(await homeOf()).toBe(f.seatHome);
  expect((await adapter.resume("seat@rig", "codex_id", "old", f.cwd)).ok).toBe(true);
  expect(await homeOf()).toBe(f.daemonHome);
  expect(ensured).toEqual([f.seatHome, undefined]);
});

it("context usage finds a thread's state in a declared seat home", () => {
  const f = fixture(); seed(f.seatHome, "seat-thread");
  const db = new Database(":memory:");
  try {
    db.exec("CREATE TABLE rigs(id TEXT, env_json TEXT); CREATE TABLE nodes(id TEXT, rig_id TEXT, env_json TEXT);");
    db.prepare("INSERT INTO rigs VALUES ('rig', NULL)").run();
    db.prepare("INSERT INTO nodes VALUES ('node', 'rig', ?)").run(JSON.stringify({ CODEX_HOME: f.seatHome }));
    const store = new ContextUsageStore(db, { stateDir: f.root, codexHomeDir: f.home, codexHome: f.daemonHome } as any);
    expect((store as any).resolveCodexStateDbPaths()).toContain(path.join(f.seatHome, "state_5.sqlite"));
  } finally { db.close(); }
});
