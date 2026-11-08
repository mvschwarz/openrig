// #2710: on Linux with a systemd user manager, the seats' tmux server runs in a transient
// `systemd-run --user --scope` of its own, so seat processes leave the daemon's cgroup (a daemon unit
// stop or restart no longer takes every seat with it). Without a user manager, or when systemd-run
// fails, the server starts exactly as before, with a log line that gives the reason.
//
// The daemon is composed by createDaemon with an injected string exec, so every command (tmux,
// systemd-run, systemctl) reaches the fake below and nothing touches the host's systemd or tmux. A
// systemd-run/systemctl on PATH that only records a marker catches a command that bypasses that exec.
// The systemd and tmux answers are read from a capture on a real host (fixtures/systemd-user-scope);
// the one answer that is not captured is noted where it is used.
//
// Contract this test relies on: the daemon detects a usable user manager only through the injected exec
// and the environment (XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS, INVOCATION_ID, MANAGERPID, whichever it
// reads). A probe of the host's filesystem (/run/systemd/system, /proc/1/comm) would make the result depend
// on the machine running the test (the macOS CI job, a container), so it is out of contract here.
//
// The fake parses each command as a POSIX shell would split it (`;`, `&&`, `||`, `|`, `&`, newlines,
// quotes): only a tmux that is the program systemd-run runs, directly or inside its `/bin/sh -c '…'`,
// counts as started in the scope, and a `tmux -D` that would hold child_process.exec open (foreground,
// or in the background with stdout/stderr still on exec's pipes) is recorded as blocking.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecFn, TmuxAdapter as TmuxAdapterClass } from "../src/adapters/tmux.js";
import type { CmuxTransportFactory } from "../src/adapters/cmux.js";

type CreateDaemon = typeof import("../src/startup.js").createDaemon;
type Daemon = Awaited<ReturnType<CreateDaemon>>;

const cmuxFactory: CmuxTransportFactory = async () => { throw Object.assign(new Error(""), { code: "ENOENT" }); };

// ---- the real host capture -------------------------------------------------------------------------------
const capture = fs.readFileSync(new URL("./fixtures/systemd-user-scope/linux-systemd-255-tmux-3.8-2026-11-08.txt", import.meta.url), "utf8");
function section(header: string): string[] {
  const lines = capture.split("\n");
  const start = lines.findIndex(line => line.startsWith(`## ${header}`));
  if (start < 0) throw new Error(`capture section missing: ${header}`);
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) { if (line.startsWith("## ")) break; body.push(line); }
  return body.filter(line => line.length > 0);
}
interface Answer { stdout: string; stderr: string; exit: number }
function answer(header: string, stream: "stdout" | "stderr"): Answer {
  const body = section(header);
  const exit = Number(/^exit=(\d+)$/.exec(body.at(-1) ?? "")?.[1]);
  if (!Number.isInteger(exit)) throw new Error(`capture section without exit=: ${header}`);
  const text = body.slice(0, -1).join("\n") + "\n";
  return { stdout: stream === "stdout" ? text : "", stderr: stream === "stderr" ? text : "", exit };
}
const REAL = {
  // The user manager is up and usable, yet reports `degraded` with exit 1 (one failed unit is enough).
  isSystemRunningUp: answer("systemctl --user is-system-running, user manager up", "stdout"),
  noManager: answer("systemd-run --user --scope, XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS unset", "stderr"),
  // A bus address that is set but refuses the connection, as a seat's shell has it.
  busRefused: answer("systemctl --user, with the bus address a seat's shell gets", "stderr"),
  systemdRunMissing: answer("systemd-run missing from PATH, run by /bin/sh -c", "stderr"),
  // What the daemon's tmux server runs as today (TmuxAdapter.startServer).
  serverCmdline: /cmdline: (.*)$/.exec(section("the tmux server the daemon started today")[0] ?? "")?.[1]?.trim() ?? "",
};
// Not captured: asking the system manager for a scope without --user. Capturing it would create (or try to
// create) a system scope on the host, so this one answer is systemd's documented text, used only to refuse it.
const SYSTEM_MANAGER_REFUSED: Answer = { stdout: "", stderr: "Failed to start transient scope unit: Interactive authentication required.\n", exit: 1 };
// The command origin/main runs to start the empty server, byte for byte; the fallback keeps it.
const TODAY_START = "tmux -D </dev/null >/dev/null 2>&1 &";

// ---- a small POSIX shell reader ---------------------------------------------------------------------------
interface Segment { text: string; end: "" | ";" | "&&" | "||" | "|" | "&" | "\n" }
/** Split a command line into simple commands at unquoted `;`, `&&`, `||`, `|`, `&` and newlines. */
function splitCommands(line: string): Segment[] {
  const out: Segment[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  const push = (end: Segment["end"]) => { if (cur.trim()) out.push({ text: cur.trim(), end }); cur = ""; };
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      else if (quote === '"' && c === "\\" && i + 1 < line.length) cur += line[++i];
      continue;
    }
    if (c === "'" || c === '"') { quote = c; cur += c; continue; }
    if (c === "\\" && i + 1 < line.length) { cur += c + line[++i]; continue; }
    const two = line.slice(i, i + 2);
    if (two === "&&" || two === "||") { push(two); i++; continue; }
    if (c === "&") {
      // `2>&1`, `<&0` and bash's `&>` are redirections, not the background operator.
      if (/[<>]$/.test(cur) || line[i + 1] === ">") { cur += c; continue; }
      push("&");
      continue;
    }
    if (c === ";" || c === "|" || c === "\n") { push(c); continue; }
    cur += c;
  }
  push("");
  return out;
}
/** The words of one simple command, quotes removed. */
function words(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (quote === '"' && c === "\\" && /["\\$`]/.test(text[i + 1] ?? "")) cur += text[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; has = true; continue; }
    if (c === "\\" && i + 1 < text.length) { cur += text[++i]; has = true; continue; }
    if (/\s/.test(c)) { if (has) out.push(cur); cur = ""; has = false; continue; }
    cur += c;
    has = true;
  }
  if (has) out.push(cur);
  return out;
}
const REDIRECT = /^(\d*|&)(>>?|<)(&?)(.*)$/;
/** argv without its redirections, and whether stdout and stderr leave exec's pipes. */
function parseSimple(text: string): { argv: string[]; stdoutAway: boolean; stderrAway: boolean } {
  const all = words(text);
  const argv: string[] = [];
  let stdoutAway = false;
  let stderrAway = false;
  for (let i = 0; i < all.length; i++) {
    const m = REDIRECT.exec(all[i]!);
    if (!m) { argv.push(all[i]!); continue; }
    const [, fd, op] = m;
    if (!m[4] && !m[3]) i++; // `> file`: the target is the next word
    if (op === "<") continue;
    if (fd === "&") { stdoutAway = stderrAway = true; continue; }
    if (fd === "" || fd === "1") stdoutAway = true;
    if (fd === "2") stderrAway = true;
  }
  return { argv, stdoutAway, stderrAway };
}
/** The program a simple command runs, past assignments and exec/env/nice/nohup/setsid wrappers. */
function program(argv: string[]): { name: string; args: string[] } {
  let i = 0;
  for (;;) {
    while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i]!)) i++;
    const word = argv[i] ?? "";
    const base = path.posix.basename(word);
    if (base === "exec" || base === "nohup" || base === "setsid") { i++; continue; }
    if (base === "command" && !/^-[vV]$/.test(argv[i + 1] ?? "")) { i++; continue; }
    if (base === "env") { i++; while (i < argv.length && argv[i]!.startsWith("-")) { if (argv[i] === "-u") i++; i++; } continue; }
    if (base === "nice") { i++; if (argv[i] === "-n") i += 2; else if (/^-\d+$/.test(argv[i] ?? "")) i++; continue; }
    return { name: base, args: argv.slice(i + 1) };
  }
}
/** systemd-run options that take a separate value word. */
const SYSTEMD_RUN_VALUE_OPTIONS = new Set(["-p", "--property", "-u", "--unit", "--description", "--slice", "-E", "--setenv",
  "--uid", "--gid", "--nice", "--working-directory", "-M", "--machine", "-H", "--host", "--service-type", "--on-active",
  "--on-boot", "--on-startup", "--on-unit-active", "--on-unit-inactive", "--on-calendar", "--path-property",
  "--socket-property", "--timer-property"]);
const isShell = (name: string) => ["sh", "bash", "dash", "zsh"].includes(name);
/** A tmux client that starts a server when none runs: `tmux -D`, `start-server` or `new-session`. */
function startsServer(args: string[]): boolean {
  return args.includes("-D") || args.includes("start-server") || args.includes("new-session");
}

// ---- the fake host behind the injected exec ---------------------------------------------------------------
type Mode = "manager" | "no-manager" | "bus-refused" | "systemd-run-missing";

function execError(cmd: string, result: Answer): Error {
  // child_process.exec's shape, as execTmuxCommand rethrows it (message with the output, execStderr apart).
  const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
  return Object.assign(new Error(`Command failed: ${cmd}\n${output}`), {
    code: result.exit, stdout: result.stdout, stderr: result.stderr, execStderr: result.stderr,
  });
}

interface ServerStart { wrapped: boolean; user: boolean; scope: boolean; blocking: boolean; command: string }

class FakeHost {
  serverUp = false;
  readonly calls: string[] = [];
  readonly starts: ServerStart[] = [];
  /** Every tmux -D outside systemd-run, whether or not a server already runs. */
  readonly looseStartAttempts: string[] = [];
  /** Every tmux argv run as systemd-run's scoped command (directly or inside its sh -c). */
  readonly scopedTmux: string[][] = [];
  constructor(public mode: Mode, private readonly socket: string) {}

  readonly exec: ExecFn = async (cmd: string) => {
    this.calls.push(cmd);
    let output = "";
    let failure: Error | undefined;
    let skip = false;
    for (const segment of splitCommands(cmd)) {
      if (!skip) {
        try { output = this.simple(cmd, segment); failure = undefined; } catch (error) { output = ""; failure = error as Error; }
        if (segment.end === "&") { output = ""; failure = undefined; }
      }
      skip = segment.end === "&&" ? failure !== undefined : segment.end === "||" ? failure === undefined : false;
    }
    if (failure) throw failure;
    return output;
  };

  private simple(cmd: string, segment: Segment): string {
    const parsed = parseSimple(segment.text);
    const { name, args } = program(parsed.argv);
    const background = segment.end === "&";
    if (name === "systemd-run") return this.systemdRun(cmd, args, background && parsed.stdoutAway && parsed.stderrAway);
    if (name === "systemctl") {
      if (this.mode === "no-manager") throw execError(cmd, REAL.noManager);
      if (this.mode === "bus-refused") throw execError(cmd, REAL.busRefused);
      if (args.includes("is-system-running")) throw execError(cmd, REAL.isSystemRunningUp);
      return "";
    }
    if ((name === "command" && /^-[vV]$/.test(args[0] ?? "")) || name === "which" || name === "type") {
      // A PATH lookup: POSIX `command -v` prints the path, or nothing with exit 1.
      const target = args.find(arg => !arg.startsWith("-")) ?? "";
      if (target === "systemd-run" && this.mode === "systemd-run-missing") throw execError(cmd, { stdout: "", stderr: "", exit: 1 });
      return /^(systemd-run|systemctl|tmux)$/.test(target) ? `/usr/bin/${target}\n` : "";
    }
    if (name === "tmux") return this.tmux(cmd, args, { wrapped: false, user: false, scope: false },
      background && parsed.stdoutAway && parsed.stderrAway);
    return "";
  }

  private systemdRun(cmd: string, args: string[], detached: boolean): string {
    if (this.mode === "no-manager") throw execError(cmd, REAL.noManager);
    if (this.mode === "bus-refused") throw execError(cmd, REAL.busRefused);
    if (this.mode === "systemd-run-missing") throw execError(cmd, REAL.systemdRunMissing);
    const options: string[] = [];
    let i = 0;
    for (; i < args.length; i++) {
      const word = args[i]!;
      if (word === "--") { i++; break; }
      if (!word.startsWith("-")) break;
      options.push(word);
      if (SYSTEMD_RUN_VALUE_OPTIONS.has(word)) options.push(args[++i] ?? "");
    }
    const user = options.includes("--user");
    const scope = options.includes("--scope");
    // Without --user, systemd-run asks the system manager, which an unprivileged daemon may not use.
    if (!user) throw execError(cmd, SYSTEM_MANAGER_REFUSED);
    const scoped = program(args.slice(i));
    const where = { wrapped: true, user, scope };
    if (scoped.name === "tmux") return this.tmux(cmd, scoped.args, where, detached, true);
    if (isShell(scoped.name)) {
      const c = scoped.args.indexOf("-c");
      const script = c >= 0 ? scoped.args[c + 1] ?? "" : "";
      let output = "";
      for (const inner of splitCommands(script)) {
        const parsed = parseSimple(inner.text);
        const run = program(parsed.argv);
        if (run.name !== "tmux") continue;
        const innerDetached = inner.end === "&" && parsed.stdoutAway && parsed.stderrAway;
        output = this.tmux(cmd, run.args, where, detached || innerDetached, true);
      }
      return output;
    }
    return "";
  }

  private tmux(cmd: string, args: string[], where: { wrapped: boolean; user: boolean; scope: boolean },
    detached: boolean, scoped = false): string {
    if (scoped) this.scopedTmux.push(args);
    if (args.includes("has-session")) {
      const target = args[args.indexOf("-t") + 1] ?? "";
      throw this.serverUp
        ? execError(cmd, { stdout: "", stderr: `can't find session: ${target}\n`, exit: 1 })
        : execError(cmd, { stdout: "", stderr: `no server running on ${this.socket}\n`, exit: 1 });
    }
    if (startsServer(args)) {
      if (!scoped && args.includes("-D")) this.looseStartAttempts.push(cmd);
      if (!this.serverUp) {
        this.serverUp = true;
        // `tmux -D` stays in the foreground: exec resolves only once it is detached from exec's pipes.
        this.starts.push({ ...where, blocking: args.includes("-D") && !detached, command: cmd });
      }
    }
    if (!this.serverUp) throw execError(cmd, { stdout: "", stderr: `no server running on ${this.socket}\n`, exit: 1 });
    if (args.includes("source-file")) return "%1\n";
    return "";
  }
}

// ---- fixture ----------------------------------------------------------------------------------------------
describe("seat tmux server in its own systemd user scope (#2710)", { timeout: 120000 }, () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const savedEnv = { HOME: process.env.HOME, OPENRIG_HOME: process.env.OPENRIG_HOME, RIGGED_HOME: process.env.RIGGED_HOME };
  let createDaemon: CreateDaemon;
  let TmuxAdapter: typeof TmuxAdapterClass;
  let home: string;
  let dir: string;
  let marker: string;
  let sockets: net.Server[] = [];
  let logs: string[] = [];

  beforeAll(async () => {
    new Database(":memory:").close();
    // The composition reads OPENRIG_HOME once, at import, and the user's home (skills, settings) at run time:
    // both point at a private directory before the daemon's modules load, so the host's ~/.openrig never shapes the result.
    home = fs.mkdtempSync(path.join(os.tmpdir(), "or-sd-home-"));
    process.env.HOME = home;
    process.env.OPENRIG_HOME = path.join(home, ".openrig");
    delete process.env.RIGGED_HOME;
    ({ createDaemon } = await import("../src/startup.js"));
    ({ TmuxAdapter } = await import("../src/adapters/tmux.js"));
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(home, { recursive: true, force: true });
  });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "or-sd-"));
    marker = path.join(dir, "host-systemd-called");
    // Guard: a systemd-run or systemctl that bypasses the injected exec lands here, never on the host.
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    for (const name of ["systemd-run", "systemctl"]) {
      fs.writeFileSync(path.join(bin, name),
        `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> '${marker}'\necho 'Failed to connect to bus: guard' >&2\nexit 1\n`, { mode: 0o755 });
    }
    vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
    vi.stubEnv("HOME", home);
    vi.stubEnv("OPENRIG_HOME", path.join(home, ".openrig"));
    vi.stubEnv("OPENRIG_TMUX_SERVER", "inherit");
    vi.stubEnv("OPENRIG_TMUX_CONTROL", undefined);
    vi.stubEnv("TMUX_TMPDIR", path.join(dir, "tmux"));
    fs.mkdirSync(path.join(dir, "tmux"));
    vi.stubEnv("TMUX", undefined);
    vi.stubEnv("OPENRIG_NO_KERNEL", "1");
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    Object.defineProperty(process, "platform", platform);
    vi.unstubAllEnvs();
    await Promise.all(sockets.map(server => new Promise(resolve => server.close(resolve))));
    sockets = [];
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Every user-manager signal present (runtime dir with live private and bus sockets, bus address, a manager
   *  that launched the daemon) or every one absent. Which signal the daemon reads is its own choice. */
  async function userManagerEnv(present: boolean): Promise<void> {
    for (const key of ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "INVOCATION_ID", "MANAGERPID"]) vi.stubEnv(key, undefined);
    if (!present) return;
    const runtime = path.join(dir, "run");
    fs.mkdirSync(path.join(runtime, "systemd"), { recursive: true, mode: 0o700 });
    for (const socket of [path.join(runtime, "systemd", "private"), path.join(runtime, "bus")]) {
      const server = net.createServer(connection => connection.destroy());
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socket, resolve); });
      sockets.push(server);
    }
    vi.stubEnv("XDG_RUNTIME_DIR", runtime);
    vi.stubEnv("DBUS_SESSION_BUS_ADDRESS", `unix:path=${path.join(runtime, "bus")}`);
    vi.stubEnv("INVOCATION_ID", "0123456789abcdef0123456789abcdef");
    vi.stubEnv("MANAGERPID", String(process.pid));
  }

  /** Records every console line written while `act` runs. */
  async function observe(host: FakeHost, act: () => Promise<void>): Promise<void> {
    host.serverUp = false;
    host.calls.length = 0;
    host.starts.length = 0;
    host.looseStartAttempts.length = 0;
    host.scopedTmux.length = 0;
    logs = [];
    for (const level of ["warn", "log", "error", "info"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(" ")); });
    }
    try { await act(); } finally { vi.restoreAllMocks(); }
  }

  async function withDaemon(mode: Mode, managerSignals: boolean,
    act: (daemon: Daemon, host: FakeHost) => Promise<void>): Promise<void> {
    await userManagerEnv(managerSignals);
    const host = new FakeHost(mode, path.join(dir, "tmux", `tmux-${process.getuid?.() ?? 0}`, "default"));
    const daemon = await createDaemon({ dbPath: ":memory:", cmuxFactory, tmuxExec: host.exec });
    try {
      // Only what the action does is observed: composition's own reads are not under test.
      await observe(host, () => act(daemon, host));
    } finally {
      daemon.eventLoopMonitor.stop();
      daemon.db.close();
    }
  }

  const loose = (command: string): ServerStart => ({ wrapped: false, user: false, scope: false, blocking: false, command });

  it("capture: the fixture is the real host's answers", () => {
    expect(REAL.isSystemRunningUp).toEqual({ stdout: "degraded\n", stderr: "", exit: 1 });
    expect(REAL.noManager.stderr).toBe("Failed to connect to bus: No medium found\n");
    expect(REAL.busRefused.stderr).toBe("Failed to connect to bus: Connection refused\n");
    expect(REAL.systemdRunMissing).toMatchObject({ stderr: "/bin/sh: 1: systemd-run: not found\n", exit: 127 });
    expect(TODAY_START.startsWith(`${REAL.serverCmdline} `)).toBe(true);
  });

  // G1
  it("with a user manager (is-system-running says degraded, exit 1), the server starts inside systemd-run --user --scope", async () => {
    await withDaemon("manager", true, async (daemon, host) => {
      const result = await daemon.deps.tmuxAdapter.startServer();
      expect(result).toMatchObject({ ok: true });
      expect(host.starts, host.calls.join("\n")).toHaveLength(1);
      expect(host.starts[0], host.calls.join("\n")).toMatchObject({ wrapped: true, user: true, scope: true, blocking: false });
      expect(host.looseStartAttempts, "a tmux -D outside the scope").toEqual([]);
      expect(fs.existsSync(marker), "systemd was called outside the daemon's exec").toBe(false);
    });
  });

  // G1b
  it("with a user manager, a launch that starts the server itself (start-server ; source-file) starts it in the scope too", async () => {
    vi.stubEnv("OPENRIG_TERMINAL_INHERIT_TMUX_ENVIRONMENT", "1");
    await withDaemon("manager", true, async (daemon, host) => {
      const adapter = daemon.deps.tmuxAdapter;
      // The lifecycle lease is not under test here: only how the first launch reaches a server.
      adapter.deliveryGuard = undefined;
      const result = await adapter.createSession("seat-2710", undefined, { OPENRIG_NODE_ID: "node-2710" });
      expect(result.ok, JSON.stringify(result)).toBe(true);
      expect(host.starts, host.calls.join("\n")).toHaveLength(1);
      expect(host.starts[0], host.calls.join("\n")).toMatchObject({ wrapped: true, user: true, scope: true, blocking: false });
      expect(fs.existsSync(marker), "systemd was called outside the daemon's exec").toBe(false);
    });
  });

  // G1c
  it("with a user manager and a daemon on its own tmux socket (-S), the server in the scope is started on that socket", async () => {
    await userManagerEnv(true);
    const socket = path.join(dir, "tmux", "openrig-isolated");
    const host = new FakeHost("manager", socket);
    // The adapter as startup builds it for terminal.tmux_server=isolated (createDaemon selects no server when
    // the exec is injected, so the selection is passed the way startup.ts passes tmuxSelection.executionArgs).
    const adapter = new TmuxAdapter(host.exec, undefined, undefined, ["-S", socket]);
    await observe(host, async () => {
      const result = await adapter.startServer();
      expect(result).toMatchObject({ ok: true });
      expect(host.starts, host.calls.join("\n")).toHaveLength(1);
      expect(host.starts[0], host.calls.join("\n")).toMatchObject({ wrapped: true, user: true, scope: true, blocking: false });
      const started = host.scopedTmux.filter(args => args.includes("-D"));
      expect(started, host.calls.join("\n")).toHaveLength(1);
      const args = started[0]!;
      const s = args.indexOf("-S");
      expect(s >= 0 && args[s + 1] === socket && s < args.indexOf("-D"), `tmux ${args.join(" ")}`).toBe(true);
      expect(fs.existsSync(marker), "systemd was called outside the daemon's exec").toBe(false);
    });
  });

  // G2
  it("without a user manager (Failed to connect to bus: No medium found), the server starts as today, with a log line", async () => {
    await withDaemon("no-manager", false, async (daemon, host) => {
      const result = await daemon.deps.tmuxAdapter.startServer();
      expect(result).toMatchObject({ ok: true });
      expect(host.starts, host.calls.join("\n")).toEqual([loose(TODAY_START)]);
      expect(logs.length, "no line logged for the fallback").toBeGreaterThanOrEqual(1);
      expect(fs.existsSync(marker), "systemd was called outside the daemon's exec").toBe(false);
    });
  });

  // G3
  it("when the manager is advertised but systemd-run fails (Connection refused), the server starts as today and the log gives the reason", async () => {
    await withDaemon("bus-refused", true, async (daemon, host) => {
      const result = await daemon.deps.tmuxAdapter.startServer();
      expect(result).toMatchObject({ ok: true });
      expect(host.starts, host.calls.join("\n")).toEqual([loose(TODAY_START)]);
      expect(logs.filter(line => line.includes("Connection refused")), logs.join("\n")).not.toEqual([]);
      expect(fs.existsSync(marker), "systemd was called outside the daemon's exec").toBe(false);
    });
  });

  // G3b
  it("when systemd-run is not installed (exit 127), the server starts as today and the log gives the reason", async () => {
    await withDaemon("systemd-run-missing", true, async (daemon, host) => {
      const result = await daemon.deps.tmuxAdapter.startServer();
      expect(result).toMatchObject({ ok: true });
      expect(host.starts, host.calls.join("\n")).toEqual([loose(TODAY_START)]);
      const reason = logs.filter(line => /systemd-run/.test(line) && /not found|127|ENOENT|missing|not installed|unavailable/i.test(line));
      expect(reason, logs.join("\n")).not.toEqual([]);
      expect(fs.existsSync(marker), "systemd was called outside the daemon's exec").toBe(false);
    });
  });

  // G4
  it("on macOS (no systemd-run on the host), the server starts as today", async () => {
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    await withDaemon("systemd-run-missing", false, async (daemon, host) => {
      const result = await daemon.deps.tmuxAdapter.startServer();
      expect(result).toMatchObject({ ok: true });
      expect(host.starts, host.calls.join("\n")).toEqual([loose(TODAY_START)]);
      expect(fs.existsSync(marker), "systemd was called outside the daemon's exec").toBe(false);
    });
  });
});
