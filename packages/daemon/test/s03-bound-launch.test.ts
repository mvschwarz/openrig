import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, chmodSync, readFileSync, symlinkSync, renameSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { ClaudeManagedLaunch } from "../src/domain/claude-managed-launch.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { seatLifecycleService } from "../src/routes/seat.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import { NO_SESSION_BUS } from "../src/domain/seat-runtime-dir.js";
import { SEAT_ENV_KEYS_VAR } from "../src/domain/seat-env.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SeatLifecycleService } from "../src/domain/seat-lifecycle-service.js";

// No provider, tmux or startup. Config-selection cases execute only a private
// fake Claude through the generated shell command; other child calls are mocked.
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(), execFile: vi.fn(),
}));
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
  vi.spyOn(service as any, "resolveSeat").mockReturnValue({ nodeId: "node", entry: { rigId: "rig", runtime: "claude-code", cwd } });
  vi.spyOn(service as any, "describe").mockReturnValue({ nodeId: "node", rigId: "rig", logicalId: "owner", rigName: "rig" });
  vi.mocked(execFile).mockImplementation(((file: string, _args: string[], options: any, done: any) => {
    expect(file).toBe(executable); expect(options.cwd).toBe(cwd); expect(options.env.PATH).toBe(path.join(cwd,"bin") + path.delimiter + daemonBin);
    expect(options.env.ANTHROPIC_API_KEY).toBeUndefined(); done(null, help);
  }) as any);
  return { root, cwd, executable, daemonBin, db, env, renderer, managed, tmux, calls, adapter, binding, service, eventBus };
}
// Exercise the actual initial-shell reset without starting a tmux server or native Claude.
async function scopedPaneLaunch(env: Record<string, string>, command: string, runtimeDir?: string): Promise<string[]> {
  const tmux = new TmuxAdapter(async () => { throw Error("argv fixture only"); }, undefined, async args => {
    if (args.at(-1) === "default-shell") return "/bin/sh";
    if (args.at(-1) === "update-environment") return "WAYLAND_DISPLAY TERM_PROGRAM TERM_PROGRAM_VERSION";
    throw Error(`Unexpected option query: ${args.at(-1)}`);
  });
  tmux.launchEnvironment = () => ({ inheritTmuxEnvironment: false,
    env: { ...env, TERM_PROGRAM: "daemon-editor", TERM_PROGRAM_VERSION: "daemon-version" }, runtimeDir });
  const launch = await (tmux as unknown as { scopedLaunchCommand(env: Record<string, string>, command: string): Promise<string[] | null> })
    .scopedLaunchCommand({ OPENRIG_NODE_ID: "node" }, command);
  expect(launch).not.toBeNull();
  return launch!;
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
      providerAuthEnv: {}, daemonHome: f.env.HOME, codexHome: path.join(f.root, "codex"), seatDbPath: path.join(f.root, "instance.sqlite"),
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
    for (const key of ["TERM", "COLORTERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES",
      "LC_COLLATE", "LC_NUMERIC", "LC_TIME", "LC_MONETARY"]) {
      expect(command).toContain(`if [ -n "\${${key}-}" ]; then export ${key}; else unset ${key}; fi`);
    }
    expect(command).not.toContain("UNAPPROVED_RENDERER_VALUE");
    expect(command).not.toMatch(/TMUX/);
  });
  for (const scoped of [false, true]) it.each([
    ["present", { TERM_PROGRAM: "tmux", TERM_PROGRAM_VERSION: "3.7c" }],
    ["absent", {}],
    ["empty", { TERM_PROGRAM: "", TERM_PROGRAM_VERSION: "" }],
  ])(`hands Claude the pane's TERM_PROGRAM when it is %s (scoped=${scoped}), so Claude asks tmux for extended keys`, async (label, programEnv) => {
    const f = fixture();
    // Claude requests extended keys (Shift+Enter) only when it can tell it runs inside tmux.
    writeFileSync(f.executable, `#!${process.execPath}\n
if (process.argv.includes('--help')) console.log(${JSON.stringify(help)});
else console.log(JSON.stringify(Object.fromEntries(['TMUX', 'TERM_PROGRAM', 'TERM_PROGRAM_VERSION', 'TMUX_PANE']
  .filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]))));
`);
    const native = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    vi.mocked(execFile).mockImplementation(native.execFile);
    const prepared = await f.managed.prepare({ nodeId: "node", session: "seat", pane: "%1" }, "auto");
    const command = prepared.command(["--permission-mode", "auto"]);
    // TMUX is set in every case: it must never reach Claude, because a bare tmux follows it ahead of TMUX_TMPDIR.
    const paneEnv: Record<string, string> = { ...f.env, TMUX: "/tmp/tmux-1000/default,123,0", TMUX_PANE: "%1", ...programEnv };
    // Some shells set these themselves; model the absent case before the command expands them.
    const paneCommand = label === "absent" ? `unset TMUX TERM_PROGRAM TERM_PROGRAM_VERSION; ${command}` : command;
    const launch = scoped ? await scopedPaneLaunch(f.env, paneCommand) : ["/bin/sh", "-c", paneCommand];
    const stdout = await new Promise<string>((resolve, reject) => {
      native.execFile(launch[0]!, launch.slice(1), { encoding: "utf8", timeout: 3000, env: paneEnv },
        (error, out) => error ? reject(error) : resolve(out));
    });
    // An empty or absent variable stays absent; TMUX and TMUX_PANE never arrive.
    expect(JSON.parse(stdout)).toEqual(label === "present" ? programEnv : {});
  });
  // The names Claude needs for its external-editor action (Ctrl+G) and for image paste, which shells out to
  // `xclip || wl-paste`. The pane supplies the values, so a person's editor and display session reach the seat
  // without a per-spec value. WAYLAND_DISPLAY is resolved to an absolute path instead of forwarding XDG_RUNTIME_DIR.
  const sessionNames = ["EDITOR", "VISUAL", "DISPLAY", "XAUTHORITY"];
  // Present in the pane on purpose: they must stay out. XDG_RUNTIME_DIR is where sd-bus, GDBus and libdbus look for the
  // session bus when DBUS_SESSION_BUS_ADDRESS is unset, so the pane's own pair stays out; only OpenRig's pair, with the
  // bus address that can't connect, is forwarded (#2030, below). The desktop names reach services (notifications,
  // xdg-open) that nothing in the editor or paste path uses; SSH_AUTH_SOCK is a credential channel.
  const withheldNames = ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP", "SSH_AUTH_SOCK", "TMUX", "TMUX_PANE"];
  const paneNames = [...sessionNames, "WAYLAND_DISPLAY", ...withheldNames];
  // A managed launch runs as a staged script under /bin/sh, which is dash on Debian and Ubuntu. Run the cases under dash too
  // when the host has it (OPENRIG_TEST_DASH names one).
  const dash = [process.env.OPENRIG_TEST_DASH, "/usr/bin/dash", "/bin/dash"].find(file => file && existsSync(file));
  const shells = ["/bin/sh", ...(dash ? [dash] : [])];
  async function runPane(f: ReturnType<typeof fixture>, pane: Record<string, string>, unset: string[] = [], shell = "/bin/sh", scopedRuntimeDir?: string): Promise<Record<string, string>> {
    writeFileSync(f.executable, `#!${process.execPath}\n
if (process.argv.includes('--help')) console.log(${JSON.stringify(help)});
else console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(paneNames)}
  .filter(k => process.env[k] !== undefined).map(k => [k, process.env[k]]))));
`);
    const native = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    vi.mocked(execFile).mockImplementation(native.execFile);
    const prepared = await f.managed.prepare({ nodeId: "node", session: "seat", pane: "%1" }, "auto");
    const command = prepared.command(["--permission-mode", "auto"]);
    // Some shells set these themselves; model the absent case before the command expands them.
    const paneCommand = unset.length ? `unset ${unset.join(" ")}; ${command}` : command;
    const launch = scopedRuntimeDir ? await scopedPaneLaunch(f.env, paneCommand, scopedRuntimeDir) : [shell, "-c", paneCommand];
    const stdout = await new Promise<string>((resolve, reject) => {
      native.execFile(launch[0]!, launch.slice(1), { encoding: "utf8", timeout: 3000, env: { ...f.env, ...pane } },
        (error, out) => error ? reject(error) : resolve(out));
    });
    return JSON.parse(stdout);
  }
  const withheldInPane = Object.fromEntries(withheldNames.map(key => [key, `/pane/${key}`]));
  it.each([
    ["present", Object.fromEntries(sessionNames.map(key => [key, `/pane/${key}`])), []],
    ["absent", {}, sessionNames],
    ["empty", Object.fromEntries(sessionNames.map(key => [key, ""])), []],
  ])("hands Claude the pane's editor and X11 variables when they are %s, and never the withheld names", async (_label, sessionEnv, unset) => {
    const f = fixture();
    // An empty or absent variable stays absent; the withheld names (XDG_RUNTIME_DIR among them) never arrive.
    expect(await runPane(f, { ...withheldInPane, ...sessionEnv }, [...unset, "WAYLAND_DISPLAY"]))
      .toEqual(Object.fromEntries(Object.entries(sessionEnv).filter(([, value]) => value !== "")));
  });
  const waylandCases: [string, Record<string, string>, string | undefined][] = [
    ["absolute", { WAYLAND_DISPLAY: "/run/user/1000/wayland-1", XDG_RUNTIME_DIR: "/run/user/1000" }, "/run/user/1000/wayland-1"],
    ["absolute with no XDG_RUNTIME_DIR", { WAYLAND_DISPLAY: "/run/user/1000/wayland-1" }, "/run/user/1000/wayland-1"],
    ["absolute outside the runtime dir", { WAYLAND_DISPLAY: "/elsewhere/sock", XDG_RUNTIME_DIR: "/run/user/1000" }, "/elsewhere/sock"],
    ["relative", { WAYLAND_DISPLAY: "wayland-1", XDG_RUNTIME_DIR: "/run/user/1000" }, "/run/user/1000/wayland-1"],
    ["absolute with a space", { WAYLAND_DISPLAY: "/run/user/1000/way land", XDG_RUNTIME_DIR: "/run/user/1000" }, "/run/user/1000/way land"],
    ["relative with a space", { WAYLAND_DISPLAY: "way land", XDG_RUNTIME_DIR: "/run/user/1000" }, "/run/user/1000/way land"],
    ["relative in a runtime dir with a space", { WAYLAND_DISPLAY: "wayland-1", XDG_RUNTIME_DIR: "/run/my user/1000" }, "/run/my user/1000/wayland-1"],
    ["absolute with a glob character", { WAYLAND_DISPLAY: "/run/user/1000/way*", XDG_RUNTIME_DIR: "/run/user/1000" }, "/run/user/1000/way*"],
    ["relative with a glob character", { WAYLAND_DISPLAY: "wayland-*", XDG_RUNTIME_DIR: "/run/user/1000" }, "/run/user/1000/wayland-*"],
    ["relative with an empty XDG_RUNTIME_DIR", { WAYLAND_DISPLAY: "wayland-1", XDG_RUNTIME_DIR: "" }, undefined],
    ["relative with no XDG_RUNTIME_DIR", { WAYLAND_DISPLAY: "wayland-1" }, undefined],
    ["empty", { WAYLAND_DISPLAY: "", XDG_RUNTIME_DIR: "/run/user/1000" }, undefined],
    ["absent", { XDG_RUNTIME_DIR: "/run/user/1000" }, undefined],
  ];
  it.each(shells.flatMap(shell => waylandCases.map(([label, pane, expected]) => [label, shell, pane, expected] as const)))(
    "hands Claude an absolute WAYLAND_DISPLAY when the pane's is %s under %s, without XDG_RUNTIME_DIR", async (_label, shell, pane, expected) => {
    const f = fixture();
    const unset = ["WAYLAND_DISPLAY", "XDG_RUNTIME_DIR"].filter(key => !(key in pane));
    expect(await runPane(f, { ...withheldInPane, ...pane }, unset, shell)).toEqual(expected === undefined ? {} : { WAYLAND_DISPLAY: expected });
  });
  it("resolves a relative Wayland display through the scoped reset and managed launch", async () => {
    vi.stubEnv("WAYLAND_DISPLAY", "wayland-1");
    const f = fixture();
    expect(await runPane(f, {}, [], "/bin/sh", "/run/test user")).toEqual({
      WAYLAND_DISPLAY: "/run/test user/wayland-1", XDG_RUNTIME_DIR: "/run/test user", DBUS_SESSION_BUS_ADDRESS: "disabled:",
    });
  });
  it("uses balanced case patterns and no unquoted substitution for WAYLAND_DISPLAY", async () => {
    const f = fixture();
    const cmd = (await f.managed.prepare({ nodeId: "node", session: "seat", pane: "%1" }, "auto")).command([]);
    // An unbalanced `)` inside `$(…)` does not parse in bash before 4.0 or in macOS's /bin/sh; a bare `$(` word would be split.
    expect(cmd).toContain("(/*) printf %s");
    expect(cmd).toContain("(?*) if [");
    expect(cmd).not.toMatch(/(^|\s)\$\(/);
    expect(cmd).toContain('export WAYLAND_DISPLAY="$__openrig_wayland_display"');
  });
  it.each(["fresh", "resume", "fork", "legacy"])("names the editor and display session variables on a %s launch", async kind => {
    const f = fixture();
    vi.spyOn(f.adapter as any, "verifyResumeLaunch").mockResolvedValue({ ok: true });
    const resume = new ClaudeResumeAdapter(f.tmux, { claudeManagedLaunch: f.managed });
    vi.spyOn(resume as any, "verifyResume").mockResolvedValue({ ok: true });
    const token = "history's id";
    const result = kind === "legacy" ? await resume.resume("seat", "claude_id", token, f.cwd, "floor", f.binding.model, "auto", "node")
      : await f.adapter.launchHarness(f.binding, { name: "seat", ...(kind === "resume" ? { resumeToken: token } : {}),
        ...(kind === "fork" ? { forkSource: { kind: "native_id" as const, value: token } } : {}) });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    const cmd = f.calls[0]!;
    for (const key of sessionNames) expect(cmd).toContain(`if [ -n "\${${key}-}" ]; then export ${key}; else unset ${key}; fi`);
    expect(cmd).toContain('export WAYLAND_DISPLAY="$__openrig_wayland_display"');
    // XDG_RUNTIME_DIR resolves WAYLAND_DISPLAY, and it and the bus address are forwarded only as OpenRig's pair.
    expect(cmd).not.toMatch(/XDG_RUNTIME_DIR=\$|"XDG_RUNTIME_DIR=/);
    expect(cmd).toContain(`if [ "\${DBUS_SESSION_BUS_ADDRESS-}" = ${shellQuote(NO_SESSION_BUS)} ]; then export DBUS_SESSION_BUS_ADDRESS; else unset DBUS_SESSION_BUS_ADDRESS; fi`);
    for (const key of withheldNames.filter(key => !["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"].includes(key))) expect(cmd).not.toContain(key);
  });
  // #2030: a pane with OpenRig's runtime-dir pair hands it to Claude; a pane's own runtime directory or bus address, from a
  // shell profile or tmux's update-environment, stays out as before.
  const openRigPair = { XDG_RUNTIME_DIR: "/run/user/1000", DBUS_SESSION_BUS_ADDRESS: NO_SESSION_BUS };
  const runtimeDirCases: [string, Record<string, string>, Record<string, string>][] = [
    ["OpenRig's pair", openRigPair, openRigPair],
    ["OpenRig's bus address with no runtime directory", { DBUS_SESSION_BUS_ADDRESS: NO_SESSION_BUS }, { DBUS_SESSION_BUS_ADDRESS: NO_SESSION_BUS }],
    ["a runtime directory alone", { XDG_RUNTIME_DIR: "/run/user/1000" }, {}],
    ["a runtime directory with the pane's own bus address", { XDG_RUNTIME_DIR: "/run/user/1000", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" }, {}],
  ];
  it.each(shells.flatMap(shell => runtimeDirCases.map(([label, pane, expected]) => [label, shell, pane, expected] as const)))(
    "hands Claude the runtime directory only with OpenRig's bus address: %s under %s", async (_label, shell, pane, expected) => {
    const unset = ["WAYLAND_DISPLAY", ...["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"].filter(key => !(key in pane))];
    expect(await runPane(fixture(), { ...withheldInPane, ...pane }, unset, shell)).toEqual(expected);
  });
  it.each([
    ["own bus address", "DBUS_SESSION_BUS_ADDRESS", { XDG_RUNTIME_DIR: "/run/user/1000", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" },
      { XDG_RUNTIME_DIR: "/run/user/1000", DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" }],
    ["own runtime directory", "XDG_RUNTIME_DIR", { XDG_RUNTIME_DIR: "/run/user/1000" }, { XDG_RUNTIME_DIR: "/run/user/1000" }],
  ])("forwards a seat's %s as declared, with the runtime directory beside a declared bus address", async (_label, declared, pane, expected) => {
    const f = fixture();
    // A one-off launch name, read from the session, is a declared name like an env: entry.
    const managed = new ClaudeManagedLaunch(f.db, f.env, f.renderer, async (_session, key) => key === SEAT_ENV_KEYS_VAR ? declared : undefined);
    const unset = ["WAYLAND_DISPLAY", ...["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"].filter(key => !(key in pane))];
    expect(await runPane({ ...f, managed }, { ...withheldInPane, ...pane }, unset)).toEqual(expected);
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
  it("keeps node-ID permission saves bound to the real Claude generation check during help", async () => {
    const f = fixture();
    const db = createFullTestDb(); open.push(db);
    const rigRepo = new RigRepository(db), registry = new SessionRegistry(db), eventBus = new EventBus(db);
    const rig = rigRepo.createRig("node-rig");
    const node = rigRepo.addNode(rig.id, "worker", { runtime: "claude-code", cwd: f.cwd });
    registry.registerSession(node.id, "worker@node-rig");
    registry.updateBinding(node.id, { attachmentType: "tmux", tmuxSession: "worker@node-rig", tmuxPane: "%1" });
    const managed = new ClaudeManagedLaunch(db, f.env, f.renderer);
    const service = new SeatLifecycleService({ db, rigRepo, sessionRegistry: registry, eventBus, tmuxAdapter: f.tmux,
      runtimeAdapters: { "claude-code": { claudeManagedLaunch: managed } as never } });
    const choice = { nodeId: node.id, mode: "auto", actor: "operator", reason: "reviewed native choice" };
    let replaceDuringHelp = true;
    vi.mocked(execFile).mockImplementation(((file: string, _args: string[], options: any, done: any) => {
      expect(file).toBe(f.executable);
      expect(options.cwd).toBe(f.cwd);
      if (replaceDuringHelp) {
        replaceDuringHelp = false;
        registry.registerSession(node.id, "worker-next@node-rig", "handover");
      }
      done(null, help);
    }) as any);

    expect(await service.setPermissions(choice)).toMatchObject({ ok: false, code: "permission_selection_refused" });
    expect(db.prepare("SELECT * FROM node_permission_selections WHERE node_id=?").all(node.id)).toEqual([]);
    expect(db.prepare("SELECT * FROM events WHERE type='node.permissions_changed'").all()).toEqual([]);

    // A fresh request prepares against the current generation and can save the choice.
    expect(await service.setPermissions(choice)).toMatchObject({ ok: true, changed: true, seat: { nodeId: node.id, rigId: rig.id } });
    expect(db.prepare("SELECT mode, actor FROM node_permission_selections WHERE node_id=?").get(node.id)).toEqual({ mode: "auto", actor: "operator" });
    expect(db.prepare("SELECT COUNT(*) n FROM events WHERE type='node.permissions_changed'").get()).toEqual({ n: 1 });
    expect(f.calls).toEqual([]);
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
  it.skipIf(process.platform === "win32").each(["managed", "classic"].flatMap(mode => ["fresh", "resume", "fork", "legacy"].map(kind => ({ mode, kind }))))("executes the seat's literal Advisor argument on $mode $kind and omits it for a peer", async ({ mode, kind }) => {
    const f = fixture();
    const native = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    writeFileSync(f.executable, `#!${process.execPath}\nconsole.log(process.argv.includes('--help') ? ${JSON.stringify(help)} : JSON.stringify(process.argv.slice(2)));\n`);
    vi.mocked(execFile).mockImplementation(native.execFile);
    vi.spyOn(f.adapter as any, "verifyResumeLaunch").mockResolvedValue({ ok: true });
    const resume = new ClaudeResumeAdapter(f.tmux, { claudeManagedLaunch: f.managed });
    vi.spyOn(resume as any, "verifyResume").mockResolvedValue({ ok: true });
    const advisor = "opus'; $(exit 99)";
    const binding = { ...f.binding, advisor: ` ${advisor} `, effort: "medium", permissionMode: mode === "managed" ? "auto" : undefined };
    const result = kind === "legacy"
      ? await resume.resume("seat", "claude_id", "prior-id", f.cwd, "floor", binding.model, binding.permissionMode, "node", "medium", undefined, undefined, undefined, binding.advisor)
      : await f.adapter.launchHarness(binding, { name: "seat", ...(kind === "resume" ? { resumeToken: "prior-id" } : {}),
        ...(kind === "fork" ? { forkSource: { kind: "native_id" as const, value: "prior-id" } } : {}) });
    expect(result).toMatchObject({ ok: true });
    const argv = JSON.parse(native.execFileSync("/bin/sh", ["-c", f.calls[0]!], { cwd: f.cwd, env: f.env, encoding: "utf8", timeout: 3000 })) as string[];
    expect(argv.slice(argv.indexOf("--advisor"), argv.indexOf("--advisor") + 2)).toEqual(["--advisor", advisor]);
    expect(argv.slice(argv.indexOf("--model"), argv.indexOf("--model") + 2)).toEqual(["--model", binding.model]);
    expect(argv.slice(argv.indexOf("--effort"), argv.indexOf("--effort") + 2)).toEqual(["--effort", "medium"]);
    if (kind === "fresh") expect(argv).toContain("--session-id");
    else expect(argv.slice(argv.indexOf("--resume"), argv.indexOf("--resume") + 2)).toEqual(["--resume", "prior-id"]);
    expect(argv.includes("--fork-session")).toBe(kind === "fork");
    await f.adapter.launchHarness({ ...f.binding, permissionMode: binding.permissionMode }, { name: "peer" });
    const peer = JSON.parse(native.execFileSync("/bin/sh", ["-c", f.calls[1]!], { cwd: f.cwd, env: f.env, encoding: "utf8", timeout: 3000 })) as string[];
    expect(peer).not.toContain("--advisor");
  });

  it.each(["fresh", "resume", "fork", "legacy"])("uses the same context and quotes every argument on %s", async kind => {
    const f = fixture();
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
    expect(cmd).toContain('export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY-}"'); expect(cmd).not.toContain(f.env.ANTHROPIC_API_KEY);
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
  it.each(["unset", "explicit"])("names the fork's own id with the %s config root, reads no session file, and preserves call-entry arguments", async selection => {
    const f = fixture(); const reads: string[] = [];
    if (selection === "unset") delete f.env.CLAUDE_CONFIG_DIR;
    const configDir = selection === "unset" ? path.join(f.env.HOME!, ".claude") : path.join(f.cwd, "config");
    const adapter = new ClaudeCodeAdapter({ tmux: f.tmux, claudeManagedLaunch: f.managed, fsOps: { ...fsOps,
      homedir: "/different/daemon/home", exists: p => p === path.join(configDir,"sessions"), readdir: () => ["token.json"],
      readFile: p => { reads.push(p); return JSON.stringify({ name: "original", sessionId: "stale-same-name-token" }); } }, sessionIdFactory: () => "fork-id" });
    const opts = { name: "original", forkSource: { kind: "native_id" as const, value: "original-parent" } };
    vi.mocked(execFile).mockImplementation(((_f: string, _a: string[], _o: any, done: any) => {
      f.binding.tmuxSession = "other-seat"; f.binding.model = "other-model"; f.binding.permissionMode = "bypassPermissions";
      opts.name = "changed"; opts.forkSource.value = "other-history"; done(null, help);
    }) as any);
    expect(await adapter.launchHarness(f.binding, opts)).toMatchObject({ ok: true, resumeToken: "fork-id" });
    expect(reads).toEqual([]);
    expect(f.calls[0]).toContain("'--resume' 'original-parent' '--fork-session' '--session-id' 'fork-id'"); expect(f.calls[0]).toContain("'--name' 'original'");
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
    expect(startup).toContain("new ClaudeResumeAdapter(tmuxAdapter, { claudeManagedLaunch, seatLaunchEnvironment, openrigHome: OPENRIG_HOME, restoreReadPolicy })");
    expect(startup).toContain("new ClaudeCodeAdapter({ tmux: tmuxAdapter, seatLaunchEnvironment, claudeManagedLaunch,");
  });
  it("does not submit after a context change following a valid paste; preserves partial-input semantics", async () => {
    const f = fixture(); const commands: string[] = [];
    const t = new TmuxAdapter(async cmd => { commands.push(cmd); if (cmd.includes("paste-buffer")) f.env.CLAUDE_CONFIG_DIR = "./changed"; return ""; }, {
      tmpName: () => path.join(f.root,"inert-script"), bufferName: () => "private", writeFile: async () => {}, unlink: async () => {} });
    const result = await new ClaudeCodeAdapter({ tmux: t, fsOps, claudeManagedLaunch: f.managed }).launchHarness(f.binding, { name: "seat" });
    expect(result).toMatchObject({ ok: false }); expect(commands.some(c => c.includes("paste-buffer"))).toBe(true);
    expect(commands.some(c => c.includes("send-keys") && c.includes("Enter"))).toBe(false);
  });
});
