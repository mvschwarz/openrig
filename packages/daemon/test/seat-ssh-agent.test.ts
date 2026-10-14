import Database from "better-sqlite3";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { buildPiChildEnv } from "../src/adapters/pi-runner-protocol.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { ClaudeManagedLaunch } from "../src/domain/claude-managed-launch.js";
import { SeatLaunchEnvironment } from "../src/domain/seat-launch-environment.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

const run = promisify(execFile);
const parent = "11111111-1111-4111-8111-111111111111";
const child = "22222222-2222-4222-8222-222222222222";

async function until(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Owned SSH/tmux fixture did not become ready");
}

async function stop(agent: ChildProcess | undefined) {
  if (!agent?.pid || agent.exitCode !== null || agent.signalCode !== null) return;
  const stopped = once(agent, "exit");
  agent.kill();
  const timeout = setTimeout(() => agent.kill("SIGKILL"), 1000);
  try { await stopped; } finally { clearTimeout(timeout); }
}

// Like the existing startup-channel regression, evaluate the real initializer
// without starting a daemon or consulting the operator's environment.
function launchEnvironment(root: string, sourceEnv: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const source = fs.readFileSync(new URL("../src/startup.ts", import.meta.url), "utf8");
  const start = source.indexOf("const launchSessionEnv:");
  expect(start).toBeGreaterThan(-1);
  const expression = source.slice(source.indexOf("{", start), source.indexOf("\n  };", start) + 4);
  return runInNewContext("(" + expression + ")", {
    process: { env: sourceEnv }, OPENRIG_HOME: root, openRigPort: "1", openRigHost: "127.0.0.1",
    resolvedActivityHookUrl: "http://127.0.0.1:1", resolvedActivityHookToken: "synthetic-only",
    providerAuthEnv: {}, daemonHome: root, codexHome: path.join(root, "codex"),
  });
}

async function withAgent(check: (f: {
  root: string; socket: string; receipt: string; helpReceipt: string; cli: string;
  daemonEnv: NodeJS.ProcessEnv; expected: string; db: Database.Database; tmux: TmuxAdapter;
  tm: (args: string[]) => Promise<string>;
}) => Promise<void>) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ssh-seat-")));
  const socket = path.join(root, "agent's socket"), tmuxSocket = path.join(root, "tmux.sock");
  const receipt = path.join(root, "launch.json"), helpReceipt = path.join(root, "help.json");
  const bin = path.join(root, "bin"), cli = path.join(root, "rig");
  fs.mkdirSync(bin);
  const baseEnv = { HOME: root, PATH: process.env.PATH!, TMPDIR: root, TERM: "xterm-256color", HISTFILE: "/dev/null" };
  const daemonEnv = { ...baseEnv, PATH: bin + path.delimiter + baseEnv.PATH, SSH_AUTH_SOCK: socket };
  const tm = async (args: string[]) => (await run("tmux", ["-S", tmuxSocket, "-f", "/dev/null", ...args], { env: baseEnv, timeout: 5000 })).stdout;
  const tmux = new TmuxAdapter(async command => {
    expect(command).toMatch(/^tmux /);
    return (await run("/bin/sh", ["-c", command.replace(/^tmux /, "tmux -S " + shellQuote(tmuxSocket) + " ")], { env: baseEnv, timeout: 5000 })).stdout;
  }, undefined, args => { expect(args[0]).toBe("tmux"); return tm(args.slice(1)); });
  const db = new Database(":memory:");
  db.exec([
    "CREATE TABLE nodes(id TEXT, runtime TEXT, cwd TEXT)",
    "CREATE TABLE bindings(id TEXT, node_id TEXT, tmux_session TEXT, tmux_pane TEXT)",
    "CREATE TABLE occupant_tenures(node_id TEXT, generation_uuid TEXT, generation_ordinal INTEGER)",
    "INSERT INTO bindings VALUES ('binding','node','seat','%1')",
    "INSERT INTO occupant_tenures VALUES ('node','generation-1',1)",
  ].join(";"));
  db.prepare("INSERT INTO nodes VALUES ('node','claude-code',?)").run(root);
  let agent: ChildProcess | undefined;
  try {
    agent = spawn("ssh-agent", ["-D", "-a", socket], { env: baseEnv, stdio: "ignore" });
    let agentError: Error | undefined;
    agent.on("error", error => { agentError = error; });
    await until(() => { if (agentError) throw agentError; return fs.existsSync(socket); });
    const key = path.join(root, "key");
    await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "openrig-test-only", "-f", key], { env: baseEnv, timeout: 5000 });
    await run("ssh-add", [key], { env: daemonEnv, timeout: 5000 });
    const expected = (await run("ssh-add", ["-l"], { env: daemonEnv, timeout: 5000 })).stdout.trim();
    const recorder = [
      "#!" + process.execPath,
      "const fs = require('node:fs'), cp = require('node:child_process');",
      "const keys = ['SSH_AUTH_SOCK','SSH_AGENT_PID','UNRELATED_VALUE'];",
      "const env = Object.fromEntries(keys.filter(k => process.env[k] !== undefined).map(k => [k,process.env[k]]));",
      "if (process.argv.includes('--help')) {",
      "  fs.writeFileSync(" + JSON.stringify(helpReceipt) + ", JSON.stringify(env));",
      "  console.log('Usage: fixture [OPTIONS]\\n--no-daemon\\n--permission-mode <mode> (choices: \"acceptEdits\", \"auto\", \"default\")');",
      "} else {",
      "  const agent = cp.spawnSync('ssh-add', ['-l'], { encoding: 'utf8', timeout: 3000 });",
      "  fs.writeFileSync(" + JSON.stringify(receipt) + ", JSON.stringify({ env, status: agent.status, identities: agent.stdout?.trim(), error: agent.stderr, args: process.argv.slice(2) }));",
      "}",
    ].join("\n");
    for (const runtime of ["claude", "codex"]) fs.writeFileSync(path.join(bin, runtime), recorder, { mode: 0o755 });
    fs.writeFileSync(cli, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await tm(["new-session", "-d", "-s", "bootstrap", "sleep 60"]);
    await tm(["set-option", "-g", "default-shell", "/bin/bash"]);
    // An older server must not override the daemon's explicitly supplied agent.
    await tm(["set-option", "-g", "update-environment", ""]);
    await tm(["set-environment", "-g", "SSH_AUTH_SOCK", path.join(root, "stale.sock")]);
    await check({ root, socket, receipt, helpReceipt, cli, daemonEnv, expected, db, tmux, tm });
  } finally {
    vi.restoreAllMocks();
    await tm(["kill-server"]).catch(() => {});
    await stop(agent);
    db.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

describe.skipIf(process.platform === "win32")("SSH agent in managed seat tools", () => {
  const paths = ["fresh", "fork", "launch-resume", "restore-resume", "respawn"] as const;
  for (const runtime of ["claude-code", "codex"] as const) {
    it.each(paths)(runtime + " %s can query the supplied SSH agent", async kind => {
      await withAgent(async f => {
        const sessionEnv = launchEnvironment(f.root, f.daemonEnv);
        const env = Object.fromEntries(Object.entries({
          ...sessionEnv, OPENRIG_NODE_ID: "node", OPENRIG_SESSION_NAME: "seat", OPENRIG_RUNTIME: runtime,
          OPENRIG_OCCUPANT_GENERATION: "generation-1",
        }).filter((entry): entry is [string, string] => entry[1] !== undefined));
        expect((await f.tmux.createSession("seat", f.root, env)).ok).toBe(true);
        const panes = await f.tmux.listPanes("seat");
        expect(panes).toHaveLength(1);
        const pane = panes[0]!.id;
        f.db.prepare("UPDATE nodes SET runtime=?").run(runtime);
        f.db.prepare("UPDATE bindings SET tmux_pane=?").run(pane);
        if (kind === "respawn") {
          expect((await f.tmux.setRemainOnExit(pane, true)).ok).toBe(true);
          await f.tm(["respawn-pane", "-k", "-t", pane, "/bin/true"]);
          await until(async () => (await f.tm(["display-message", "-p", "-t", pane, "#{pane_dead}"])).trim() === "1");
          expect((await f.tmux.respawnPane(pane, "/bin/bash", { cwd: f.root, env })).ok).toBe(true);
        }
        await until(async () => (await f.tmux.getPaneCommand("seat")) === "bash");
        const launch = new SeatLaunchEnvironment(f.tmux, sessionEnv, f.root, f.cli);
        const managed = new ClaudeManagedLaunch(f.db, sessionEnv, {});
        const fsOps = { readFile: () => "", writeFile: () => {}, exists: () => false, mkdirp: () => {}, copyFile: () => {}, readdir: () => [], homedir: f.root };
        const binding = { id: "binding", nodeId: "node", cwd: f.root, tmuxSession: "seat", tmuxPane: pane,
          launchPosture: "floor", ...(runtime === "claude-code" ? { permissionMode: "auto" } : {}) } as NodeBinding;
        // Offline recorders prove launch/tool environment, not provider identity.
        if (kind === "restore-resume") {
          if (runtime === "claude-code") {
            const adapter = new ClaudeResumeAdapter(f.tmux, { claudeManagedLaunch: managed, seatLaunchEnvironment: launch });
            vi.spyOn(adapter as any, "verifyResume").mockResolvedValue({ ok: true });
            const result = await adapter.resume("seat", "claude_id", parent, f.root, "floor", undefined, "auto", "node");
            expect(result.ok, JSON.stringify(result)).toBe(true);
          } else {
            const adapter = new CodexResumeAdapter(f.tmux, { seatLaunchEnvironment: launch, launchPath: sessionEnv.PATH });
            vi.spyOn(adapter as any, "verifyResume").mockResolvedValue({ ok: true });
            expect((await adapter.resume("seat", "codex_id", parent, f.root)).ok).toBe(true);
          }
        } else {
          const adapter = runtime === "claude-code"
            ? new ClaudeCodeAdapter({ tmux: f.tmux, fsOps, claudeManagedLaunch: managed, seatLaunchEnvironment: launch, sessionIdFactory: () => child })
            : new CodexRuntimeAdapter({ tmux: f.tmux, fsOps, seatLaunchEnvironment: launch, launchPath: sessionEnv.PATH, resolveGitAddDirs: async () => [] });
          vi.spyOn(adapter as any, "verifyResumeLaunch").mockResolvedValue({ ok: true });
          if (runtime === "codex") vi.spyOn(adapter as any, "captureFreshThreadId").mockResolvedValue(child);
          else vi.spyOn(adapter as any, "pollForResumeToken").mockResolvedValue(child);
          const result = await adapter.launchHarness(binding, { name: "seat", ...(kind === "fork" ? { forkSource: { kind: "native_id", value: parent } as const }
            : kind === "launch-resume" ? { resumeToken: parent } : {}) });
          expect(result.ok, JSON.stringify(result)).toBe(true);
        }
        await until(() => fs.existsSync(f.receipt));
        const received = JSON.parse(fs.readFileSync(f.receipt, "utf8"));
        expect(received.env.SSH_AUTH_SOCK).toBe(f.socket);
        expect(received.status).toBe(0);
        expect(received.identities).toBe(f.expected);
        if (runtime === "claude-code") expect(JSON.parse(fs.readFileSync(f.helpReceipt, "utf8"))).toEqual({});
      });
    }, 20_000);
  }

  it.each(["pane-only", "newer-pane", "unset", "empty"] as const)("Claude preserves %s socket semantics at env -i", async kind => {
    await withAgent(async f => {
      const sessionEnv = launchEnvironment(f.root, { ...f.daemonEnv, SSH_AUTH_SOCK: kind === "pane-only" ? undefined : "/old/daemon.sock" });
      const managed = new ClaudeManagedLaunch(f.db, sessionEnv, {});
      const prepared = await managed.prepare({ nodeId: "node", session: "seat" }, "auto");
      const socket = kind === "unset" ? undefined : kind === "empty" ? "" : f.socket;
      await run("/bin/sh", ["-c", prepared.command(["--permission-mode", "auto"])], {
        env: { ...sessionEnv, SSH_AUTH_SOCK: socket, SSH_AGENT_PID: "must-not-forward", UNRELATED_VALUE: "must-not-forward" },
        cwd: f.root, timeout: 5000,
      });
      const received = JSON.parse(fs.readFileSync(f.receipt, "utf8"));
      expect(received.env).toEqual(socket ? { SSH_AUTH_SOCK: socket } : {});
      expect(JSON.parse(fs.readFileSync(f.helpReceipt, "utf8"))).toEqual({});
      if (socket) { expect(received.status).toBe(0); expect(received.identities).toBe(f.expected); }
    });
  }, 15_000);

  it.each(["pi", "omp"] as const)("%s child tools retain only the supplied SSH socket", async runtime => {
    await withAgent(async f => {
      const env = buildPiChildEnv({ ...f.daemonEnv, SSH_AGENT_PID: "must-not-forward", UNRELATED_VALUE: "must-not-forward" }, {
        runtime, agentDir: path.join(f.root, "agent"), sessionsDir: path.join(f.root, "sessions"),
      });
      const identities = await run("ssh-add", ["-l"], { env, timeout: 5000 });
      expect(identities.stdout.trim()).toBe(f.expected);
      expect(env.SSH_AGENT_PID).toBeUndefined();
      expect(env.UNRELATED_VALUE).toBeUndefined();
    });
  }, 15_000);
});
