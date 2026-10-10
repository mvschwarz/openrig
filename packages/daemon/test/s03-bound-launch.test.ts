import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, chmodSync, readFileSync, symlinkSync, renameSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { ClaudeManagedLaunch } from "../src/domain/claude-managed-launch.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { seatLifecycleService } from "../src/routes/seat.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

// No provider, tmux or startup. Config-selection cases execute only a private
// fake Claude through the generated shell command; other child calls are mocked.
vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
// Simulate eligibility for inert fixtures; path resolution/stat/replacement use
// private real files. Config-selection cases additionally execute their fake.
vi.mock("node:fs", async importOriginal => {
  const fs = await importOriginal<typeof import("node:fs")>();
  // The private fake executable must be usable on Windows too, where chmod
  // does not create POSIX execute bits.
  return { ...fs, accessSync: (file: string) => { if (!fs.statSync(file).isFile()) throw Error("not executable"); } };
});
const open: Database.Database[] = [];
afterEach(() => { for (const db of open.splice(0)) db.close(); vi.clearAllMocks(); vi.unstubAllEnvs(); });
const fsOps = { readFile: () => { throw Error("forbidden projection"); }, writeFile: () => { throw Error("forbidden projection"); },
  exists: () => false, mkdirp: () => { throw Error("forbidden projection"); }, copyFile: () => { throw Error("forbidden projection"); } };
const help = '--permission-mode <mode> (choices: "acceptEdits", "auto", "default")';

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "s03-bound-")));
  const cwd = path.join(root, "seat's workspace"); mkdirSync(path.join(cwd, "bin"), { recursive: true });
  const executable = path.join(cwd, "bin", "claude"); writeFileSync(executable, "inert fake executable"); chmodSync(executable, 0o700);
  const daemonBin = path.join(root, "daemon-bin"); mkdirSync(daemonBin); writeFileSync(path.join(daemonBin, "claude"), "different daemon executable"); chmodSync(path.join(daemonBin, "claude"), 0o700);
  const db = new Database(":memory:"); open.push(db);
  // Minimal tables, not a migration or a daemon fixture.
  db.exec(`CREATE TABLE nodes(id TEXT, runtime TEXT, cwd TEXT);
    CREATE TABLE bindings(id TEXT, node_id TEXT, tmux_session TEXT, tmux_pane TEXT);
    CREATE TABLE occupant_tenures(node_id TEXT, generation_uuid TEXT, generation_ordinal INTEGER);
    CREATE TABLE node_permission_selections(node_id TEXT PRIMARY KEY, runtime TEXT, mode TEXT, actor TEXT, reason TEXT, updated_at TEXT);
    CREATE TABLE events(payload TEXT);`);
  db.prepare("INSERT INTO nodes VALUES ('node','claude-code',?)").run(cwd);
  db.exec("INSERT INTO bindings VALUES ('binding','node','seat','%1'); INSERT INTO occupant_tenures VALUES ('node','generation-1',1)");
  const env: Record<string,string> = { PATH: "./bin" + path.delimiter + daemonBin, HOME: path.join(root, "home"), CLAUDE_CONFIG_DIR: "./config",
    ANTHROPIC_API_KEY: "synthetic-secret-never-in-command", OPENRIG_HOME: path.join(root, "instance") };
  const renderer = { TERM: "dumb", COLORTERM: "daemon-value", LANG: "C",
    LC_CTYPE: "C", LC_MESSAGES: "C", UNAPPROVED_RENDERER_VALUE: "must-not-forward" };
  const managed = new ClaudeManagedLaunch(db, env, renderer);
  const calls: string[] = [];
  const tmux = { sendShellCommand: vi.fn(async (_target: string, command: string, check: () => void) => { check(); calls.push(command); return { ok: true as const }; }),
    sendText: vi.fn(async (_target: string, command: string) => { calls.push(command); return { ok: true as const }; }),
    sendKeys: vi.fn(async () => ({ ok: true as const })), getPaneCommand: async () => "claude", capturePaneContent: async () => "Claude Code\n>" } as unknown as TmuxAdapter;
  const adapter = new ClaudeCodeAdapter({ tmux, fsOps, claudeManagedLaunch: managed, sessionIdFactory: () => "fresh-id" });
  const binding: NodeBinding = { id: "binding", nodeId: "node", cwd, attachmentType: "tmux", tmuxSession: "seat", tmuxPane: "%1",
    tmuxWindow: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", permissionMode: "auto", model: "model's choice" };
  const eventBus = { db, persistWithinTransaction: (event: unknown) => { db.prepare("INSERT INTO events VALUES (?)").run(JSON.stringify(event)); return event; }, notifySubscribers: vi.fn() };
  const deps: Record<string,unknown> = { rigRepo: { db }, sessionRegistry: { db }, eventBus, tmuxAdapter: tmux, runtimeAdapters: { "claude-code": adapter } };
  // Use the production route constructor and its actual adapter/service wiring.
  const service = seatLifecycleService({ get: key => deps[key] });
  vi.spyOn(service as any, "resolveSeat").mockReturnValue({ nodeId: "node", entry: { runtime: "claude-code", cwd } });
  vi.spyOn(service as any, "describe").mockReturnValue({ nodeId: "node", rigId: "rig", logicalId: "owner", rigName: "rig" });
  vi.mocked(execFile).mockImplementation(((file: string, _args: string[], options: any, done: any) => {
    expect(file).toBe(executable); expect(options.cwd).toBe(cwd); expect(options.env.PATH).toBe(path.join(cwd,"bin") + path.delimiter + daemonBin);
    expect(options.env.ANTHROPIC_API_KEY).toBeUndefined(); done(null, help);
  }) as any);
  return { root, cwd, executable, daemonBin, db, env, renderer, managed, tmux, calls, adapter, binding, service, eventBus };
}
const input = { seatRef: "owner@rig", mode: "auto", actor: "operator", reason: "deliberate choice" };

describe("S03 production managed capability selection", () => {
  it.skipIf(process.platform === "win32").each([
    { USER: "fixture-user", LOGNAME: "fixture-login" },
    { USER: "fixture-user" }, { LOGNAME: "fixture-login" }, {},
  ])("forwards only supplied daemon user names through the actual startup channel: %j", async names => {
    const f = fixture();
    // Execute the actual initializer, without starting a daemon or reading its env.
    const source = readFileSync(new URL("../src/startup.ts", import.meta.url), "utf8");
    const start = source.indexOf("const launchSessionEnv:");
    expect(start).toBeGreaterThan(-1);
    const expression = source.slice(source.indexOf("{", start), source.indexOf("\n  };", start) + 4);
    const sessionEnv = runInNewContext(`(${expression})`, {
      process: { env: { PATH: f.env.PATH, ...names, UNRELATED_VALUE: "not-forwarded" } },
      OPENRIG_HOME: f.env.OPENRIG_HOME, openRigPort: "1", openRigHost: "127.0.0.1",
      resolvedActivityHookUrl: "http://127.0.0.1:1", resolvedActivityHookToken: "synthetic-only",
      providerAuthEnv: {}, daemonHome: f.env.HOME, codexHome: path.join(f.root, "codex"),
    });
    for (const key of Object.keys(f.env)) delete f.env[key];
    Object.assign(f.env, sessionEnv);
    writeFileSync(f.executable, `#!${process.execPath}\nif (process.argv.includes('--help')) console.log(${JSON.stringify(help)}); else console.log(JSON.stringify(Object.fromEntries(['USER','LOGNAME','UNRELATED_VALUE'].filter(k => process.env[k] !== undefined).map(k => [k,process.env[k]]))));\n`);
    const native = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    vi.mocked(execFile).mockImplementation(native.execFile);
    const prepared = await f.managed.prepare({ nodeId: "node", session: "seat", pane: "%1" }, "auto");
    const child = native.execFileSync("/bin/sh", ["-c", prepared.command(["--permission-mode", "auto"])], {
      encoding: "utf8", timeout: 3000,
      env: { ...sessionEnv, UNRELATED_VALUE: "not-forwarded" },
    });
    expect(JSON.parse(child)).toEqual(names);
  });
  it.each([
    ["unset", undefined, "present"], ["relative", "./config", "present"],
    ["absolute", "/inert/explicit-config", "present"], ["empty", "", "present"],
    ["absent terminal", undefined, "absent"], ["empty terminal", undefined, "empty"],
  ])("preserves %s config selection in help and the executed launch", async (_label, selected, terminal) => {
    const f = fixture();
    if (selected === undefined) delete f.env.CLAUDE_CONFIG_DIR;
    else f.env.CLAUDE_CONFIG_DIR = selected;
    const helpReceipt = path.join(f.cwd, "help-env.json");
    // Observe the actual child environment, using only synthetic credentials.
    writeFileSync(f.executable, `#!${process.execPath}\n
const fs = require('node:fs');
    const keys = ['CLAUDE_CONFIG_DIR', 'HOME', 'TERM', 'COLORTERM', 'LANG', 'LC_CTYPE', 'LC_MESSAGES',
      'UNAPPROVED_RENDERER_VALUE', 'ANTHROPIC_API_KEY', 'OPENRIG_HOME',
  'OPENRIG_NODE_ID', 'OPENRIG_RUNTIME', 'OPENRIG_SESSION_NAME', 'OPENRIG_OCCUPANT_GENERATION'];
const env = Object.fromEntries(keys.filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]));
if (process.argv.includes('--help')) {
  fs.writeFileSync(${JSON.stringify(helpReceipt)}, JSON.stringify(env));
  console.log(${JSON.stringify(help)});
} else console.log(JSON.stringify({ env, args: process.argv.slice(2), cwd: process.cwd() }));
`);
    const native = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    vi.mocked(execFile).mockImplementation(native.execFile);
    const prepared = await f.managed.prepare({ nodeId: "node", session: "seat", pane: "%1" }, "auto");
    const configDir = path.resolve(f.cwd, selected ?? path.join(f.env.HOME!, ".claude"));
    expect(prepared.configDir).toBe(configDir);
    const args = ["--permission-mode", "auto", "--name", "seat's literal name"];
    const command = prepared.command(args);
    expect(command).not.toContain(f.env.ANTHROPIC_API_KEY);
    const paneEnv: Record<string, string> = { ...f.env, UNAPPROVED_RENDERER_VALUE: "must-not-forward",
      CLAUDE_CONFIG_DIR: "/inert/not-the-managed-selection", OPENRIG_NODE_ID: "not-the-target" };
    if (terminal !== "absent") Object.assign(paneEnv, Object.fromEntries(Object.entries({
      TERM: "tmux-256color", COLORTERM: "truecolor", LANG: "en_US.UTF-8",
      LC_CTYPE: "en_US.UTF-8", LC_MESSAGES: "en_US.UTF-8",
    }).map(([key, value]) => [key, terminal === "empty" ? "" : value])));
    // Some shells initialize TERM; model absent pane variables before expansion.
    const paneCommand = terminal === "absent"
      ? `unset TERM COLORTERM LANG LC_CTYPE LC_MESSAGES; ${command}`
      : command;
    const stdout = await new Promise<string>((resolve, reject) => {
      native.execFile("/bin/sh", ["-c", paneCommand], { encoding: "utf8", timeout: 3000,
        env: paneEnv },
      (error, out) => error ? reject(error) : resolve(out));
    });
    const launched = JSON.parse(stdout);
    const queried = JSON.parse(readFileSync(helpReceipt, "utf8"));
    for (const env of [queried, launched.env]) {
      if (selected === undefined) expect.soft(env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
      else expect(env.CLAUDE_CONFIG_DIR).toBe(configDir);
    }
    if (selected === undefined) expect.soft(command).not.toContain("CLAUDE_CONFIG_DIR=");
    expect(queried).not.toHaveProperty("ANTHROPIC_API_KEY");
    if (terminal === "present") expect(launched.env).toMatchObject({ TERM: "tmux-256color", COLORTERM: "truecolor", LANG: "en_US.UTF-8",
      LC_CTYPE: "en_US.UTF-8", LC_MESSAGES: "en_US.UTF-8" });
    else for (const key of ["TERM", "COLORTERM", "LANG", "LC_CTYPE", "LC_MESSAGES"]) expect(launched.env).not.toHaveProperty(key);
    for (const key of ["TERM", "COLORTERM", "LANG", "LC_CTYPE", "LC_MESSAGES"]) expect(queried).not.toHaveProperty(key);
    expect(launched.env).not.toHaveProperty("UNAPPROVED_RENDERER_VALUE");
    expect(launched).toMatchObject({ cwd: f.cwd, args, env: {
      HOME: f.env.HOME, ANTHROPIC_API_KEY: f.env.ANTHROPIC_API_KEY, OPENRIG_HOME: f.env.OPENRIG_HOME,
      OPENRIG_NODE_ID: "node", OPENRIG_RUNTIME: "claude-code", OPENRIG_SESSION_NAME: "seat",
      OPENRIG_OCCUPANT_GENERATION: "generation-1",
    } });
  });
  it("forwards only terminal and locale variables into the isolated Claude environment", async () => {
    const f = fixture();
    const prepared = await f.managed.prepare({ nodeId: "node", session: "seat", pane: "%1" }, "auto");
    const command = prepared.command([]);
    for (const key of ["TERM", "COLORTERM", "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES",
      "LC_COLLATE", "LC_NUMERIC", "LC_TIME", "LC_MONETARY"]) {
      expect(command).toContain(`\${${key}:+"${key}=$${key}"}`);
    }
    expect(command).not.toContain("UNAPPROVED_RENDERER_VALUE");
  });
  it("detects unset config becoming explicit even when the storage directory stays the same", async () => {
    const f = fixture(); delete f.env.CLAUDE_CONFIG_DIR;
    const prepared = await f.managed.prepare({ nodeId: "node", session: "seat" }, "auto");
    f.env.CLAUDE_CONFIG_DIR = path.join(f.env.HOME!, ".claude");
    expect(() => prepared.command([])).toThrow(/context changed/);
  });
  it("selects and audits through the production service/adapter seam, without launch or secret copies", async () => {
    const f = fixture(); vi.stubEnv("PATH", f.daemonBin);
    expect(await f.service.setPermissions(input)).toEqual(expect.objectContaining({ ok: true, changed: true, to: { runtime: "claude-code", mode: "auto" } }));
    expect(f.db.prepare("SELECT mode FROM node_permission_selections").get()).toEqual({ mode: "auto" });
    expect(f.db.prepare("SELECT COUNT(*) n FROM events").get()).toEqual({ n: 1 }); expect(f.calls).toEqual([]);
    expect(JSON.stringify(f.db.prepare("SELECT * FROM events").all())).not.toContain(f.env.ANTHROPIC_API_KEY);
  });
  it("does not try a daemon executable just because its vocabulary is newer", async () => {
    const f = fixture(); vi.stubEnv("PATH", f.daemonBin);
    vi.mocked(execFile).mockImplementation(((file: string, _args: string[], _options: any, done: any) => {
      done(null, file === f.executable ? '--permission-mode <mode> (choices: "acceptEdits")' : help);
    }) as any);
    expect(await f.service.setPermissions(input)).toMatchObject({ ok: false });
    expect(execFile).toHaveBeenCalledOnce(); expect(f.db.prepare("SELECT * FROM node_permission_selections").all()).toEqual([]);
  });
  it.each(["generation", "binding", "cwd", "environment", "binary", "symlink"])("refuses %s replacement during help without selection/audit effects", async kind => {
    const f = fixture();
    vi.mocked(execFile).mockImplementation(((_file: string, _args: string[], _opts: any, done: any) => {
      if (kind === "generation") f.db.exec("INSERT INTO occupant_tenures VALUES ('node','generation-2',2)");
      if (kind === "binding") f.db.exec("UPDATE bindings SET tmux_pane='%2'");
      if (kind === "cwd") f.db.prepare("UPDATE nodes SET cwd=?").run(f.root);
      if (kind === "environment") f.env.CLAUDE_CONFIG_DIR = "./elsewhere";
      if (kind === "binary") writeFileSync(f.executable, "changed executable bytes");
      if (kind === "symlink") { renameSync(f.executable, f.executable + ".retained"); symlinkSync(path.join(f.daemonBin, "claude"), f.executable); }
      done(null, help);
    }) as any);
    expect(await f.service.setPermissions(input)).toMatchObject({ ok: false });
    expect(execFile).toHaveBeenCalledOnce();
    expect(f.db.prepare("SELECT * FROM node_permission_selections").all()).toEqual([]); expect(f.db.prepare("SELECT * FROM events").all()).toEqual([]);
  });
  it.each(["timeout", "malformed", "missing"])("refuses %s support without fallback", async kind => {
    const f = fixture();
    if (kind === "missing") f.env.PATH = "/intentionally/missing";
    else vi.mocked(execFile).mockImplementation(((_f: string, _a: string[], _o: any, done: any) => done(kind === "timeout" ? Error("timeout") : null, "no vocabulary")) as any);
    expect(await f.service.setPermissions(input)).toMatchObject({ ok: false }); expect(f.db.prepare("SELECT * FROM events").all()).toEqual([]);
  });
  it("retains floor/full_bypass/inherit and does not probe", async () => {
    const f = fixture(); for (const mode of ["floor", "full_bypass", "inherit"]) expect(await f.service.setPermissions({ ...input, mode })).toMatchObject({ ok: true });
    expect(execFile).not.toHaveBeenCalled(); expect(f.calls).toEqual([]);
  });
  it("freezes selection intent while help is pending", async () => {
    const f = fixture(); const request = { ...input };
    vi.mocked(execFile).mockImplementation(((_f: string, _a: string[], _o: any, done: any) => { request.mode = "full_bypass"; request.actor = "changed"; done(null, help); }) as any);
    expect(await f.service.setPermissions(request)).toMatchObject({ ok: true, to: { mode: "auto" } });
    expect(f.db.prepare("SELECT mode,actor FROM node_permission_selections").get()).toEqual({ mode: "auto", actor: "operator" });
  });
});

describe("S03 bound launch across existing paths", () => {
  it.each(["fresh", "resume", "fork", "legacy"])("uses the same context and quotes every argument on %s", async kind => {
    const f = fixture(); vi.spyOn(f.adapter as any, "pollForResumeToken").mockResolvedValue("fork-id");
    vi.spyOn(f.adapter as any, "verifyResumeLaunch").mockResolvedValue({ ok: true });
    const resume = new ClaudeResumeAdapter(f.tmux, { claudeManagedLaunch: f.managed });
    vi.spyOn(resume as any, "verifyResume").mockResolvedValue({ ok: true });
    const token = "history's id; literal";
    const result = kind === "legacy" ? await resume.resume("seat", "claude_id", token, f.cwd, "floor", f.binding.model, "auto", "node")
      : await f.adapter.launchHarness(f.binding, { name: "seat; literal", ...(kind === "resume" ? { resumeToken: token } : {}),
        ...(kind === "fork" ? { forkSource: { kind: "native_id" as const, value: token } } : {}) });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, appliedLaunch: { reason: "emitted_launch_arguments" } });
    expect(f.calls).toHaveLength(1); const cmd = f.calls[0]!;
    expect(cmd).toContain("/usr/bin/env -i"); expect(cmd).toContain("'--permission-mode' 'auto'");
    expect(cmd).toContain("'OPENRIG_OCCUPANT_GENERATION=generation-1'"); expect(cmd).toContain("'model'\"'\"'s choice'");
    expect(cmd).toContain('"ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY-}"'); expect(cmd).not.toContain(f.env.ANTHROPIC_API_KEY);
    expect(cmd).toContain("'" + f.executable.replaceAll("'", "'\"'\"'") + "'");
    if (kind !== "fresh") expect(cmd).toContain("'history'\"'\"'s id; literal'");
    expect(f.tmux.sendText).not.toHaveBeenCalled(); expect(f.tmux.sendKeys).not.toHaveBeenCalled(); expect(execFile).toHaveBeenCalledOnce();
  });
  it("rechecks later-generation support rather than reusing successful selection evidence", async () => {
    const f = fixture(); expect(await f.service.setPermissions(input)).toMatchObject({ ok: true });
    f.db.exec("INSERT INTO occupant_tenures VALUES ('node','generation-2',2)");
    vi.mocked(execFile).mockImplementation(((_f: string, _a: string[], _o: any, done: any) => done(null, '--permission-mode <mode> (choices: "acceptEdits")')) as any);
    expect(await f.adapter.launchHarness(f.binding, { name: "seat" })).toMatchObject({ ok: false });
    expect(execFile).toHaveBeenCalledTimes(2); expect(f.calls).toEqual([]);
    expect(f.db.prepare("SELECT mode FROM node_permission_selections").get()).toEqual({ mode: "auto" });
  });
  it("binds the successor's reserved generation while guarding the uncommitted current tenure", async () => {
    const f = fixture(); await f.adapter.launchHarness({ ...f.binding, launchGeneration: "reserved-next" }, { name: "seat" });
    expect(f.calls[0]).toContain("'OPENRIG_OCCUPANT_GENERATION=reserved-next'");
    expect(f.db.prepare("SELECT generation_uuid FROM occupant_tenures").get()).toEqual({ generation_uuid: "generation-1" });
  });
  it.each(["unset", "explicit"])("captures the fork token from the %s config root and preserves call-entry arguments", async selection => {
    const f = fixture(); const reads: string[] = [];
    if (selection === "unset") delete f.env.CLAUDE_CONFIG_DIR;
    const configDir = selection === "unset" ? path.join(f.env.HOME!, ".claude") : path.join(f.cwd, "config");
    const adapter = new ClaudeCodeAdapter({ tmux: f.tmux, claudeManagedLaunch: f.managed, fsOps: { ...fsOps,
      homedir: "/different/daemon/home", exists: p => p === path.join(configDir,"sessions"), readdir: () => ["token.json"],
      readFile: p => { reads.push(p); return JSON.stringify({ name: "original", sessionId: "new-fork-token" }); } } });
    const opts = { name: "original", forkSource: { kind: "native_id" as const, value: "original-parent" } };
    vi.mocked(execFile).mockImplementation(((_f: string, _a: string[], _o: any, done: any) => {
      f.binding.tmuxSession = "other-seat"; f.binding.model = "other-model"; f.binding.permissionMode = "bypassPermissions";
      opts.name = "changed"; opts.forkSource.value = "other-history"; done(null, help);
    }) as any);
    expect(await adapter.launchHarness(f.binding, opts)).toMatchObject({ ok: true, resumeToken: "new-fork-token" });
    expect(reads).toEqual([path.join(configDir,"sessions","token.json")]);
    expect(f.calls[0]).toContain("'--resume' 'original-parent'"); expect(f.calls[0]).toContain("'--name' 'original'");
    expect(f.calls[0]).not.toContain("other-history"); expect(f.calls[0]).not.toContain("other-model");
  });
  it.each(["pane", "generation"])("refuses a missing %s before help or input", async missing => {
    const f = fixture(); f.db.exec(missing === "pane" ? "UPDATE bindings SET tmux_pane=NULL" : "DELETE FROM occupant_tenures");
    expect(await f.adapter.launchHarness(f.binding, { name: "seat" })).toMatchObject({ ok: false });
    expect(execFile).not.toHaveBeenCalled(); expect(f.calls).toEqual([]);
  });
  it.each(["payload-generation", "buffer-generation", "payload-binary", "buffer-environment"])("revalidates at actual TmuxAdapter %s await before paste or Enter", async condition => {
    const f = fixture(); const commands: string[] = []; let writes = 0;
    const [phase, kind] = condition.split("-");
    const change = () => { if (kind === "binary") writeFileSync(f.executable, "replacement bytes");
      else if (kind === "environment") f.env.HOME = "/different/managed/home";
      else f.db.exec("UPDATE occupant_tenures SET generation_uuid='changed'"); };
    const t = new TmuxAdapter(async cmd => { commands.push(cmd); if (phase === "buffer" && cmd.includes("load-buffer")) change(); return ""; }, {
      tmpName: () => path.join(f.root, `script-${writes}`), bufferName: () => "private",
      writeFile: async () => { writes++; if (phase === "payload" && writes === 2) change(); }, unlink: async () => {} });
    const adapter = new ClaudeCodeAdapter({ tmux: t, fsOps, claudeManagedLaunch: f.managed });
    expect(await adapter.launchHarness(f.binding, { name: "seat" })).toMatchObject({ ok: false });
    expect(commands.some(cmd => cmd.includes("paste-buffer") || cmd.includes("send-keys"))).toBe(false);
  });
  it("production startup supplies one helper to both adapters without calling startup", () => {
    const startup = readFileSync(new URL("../src/startup.ts", import.meta.url), "utf8");
    expect(startup).toContain("new ClaudeManagedLaunch(db, { ...launchSessionEnv, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR },");
    expect(startup).toContain("new ClaudeResumeAdapter(tmuxAdapter, { claudeManagedLaunch, seatLaunchEnvironment })");
    expect(startup).toContain("new ClaudeCodeAdapter({ tmux: tmuxAdapter, seatLaunchEnvironment, claudeManagedLaunch,");
  });
  it.skipIf(process.platform === "win32")("does not submit after a context change following a valid paste; preserves partial-input semantics", async () => {
    const f = fixture(); const commands: string[] = [];
    const t = new TmuxAdapter(async cmd => { commands.push(cmd); if (cmd.includes("paste-buffer")) f.env.CLAUDE_CONFIG_DIR = "./changed"; return ""; }, {
      tmpName: () => path.join(f.root,"inert-script"), bufferName: () => "private", writeFile: async () => {}, unlink: async () => {} });
    const result = await new ClaudeCodeAdapter({ tmux: t, fsOps, claudeManagedLaunch: f.managed }).launchHarness(f.binding, { name: "seat" });
    expect(result).toMatchObject({ ok: false }); expect(commands.some(c => c.includes("paste-buffer"))).toBe(true);
    expect(commands.some(c => c.includes("send-keys") && c.includes("Enter"))).toBe(false);
  });
});
