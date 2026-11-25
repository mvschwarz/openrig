// A fresh launch, resume and restore carry the seat's collector in --settings, optionally throttled.
// A status line configured in the folder wins. An argv-printing fake receives the actual shell command.
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ClaudeManagedLaunch } from "../src/domain/claude-managed-launch.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { withClaudeLaunchTelemetry, type ClaudeLaunchTelemetry } from "../src/adapters/claude-launch-telemetry.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import { claudeCommandSessionToken, type NativeProcessRow } from "../src/domain/native-process-lineage.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.restoreAllMocks(); });

function fixture(throttle: number | null, ownSettings?: unknown) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "claude-statusline-launch-")));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "seat's workspace"), bin = path.join(root, "bin"), home = path.join(root, "home"), state = path.join(root, "openrig");
  const collector = path.join(import.meta.dirname, "../assets/claude-statusline-context.cjs");
  const localSettings = path.join(cwd, ".claude", "settings.local.json");
  for (const dir of [cwd, bin, home, state]) fs.mkdirSync(dir);
  if (ownSettings !== undefined) {
    fs.mkdirSync(path.join(cwd, ".claude"));
    fs.writeFileSync(localSettings, JSON.stringify(ownSettings));
  }
  const executable = path.join(bin, "claude");
  fs.writeFileSync(executable, `#!${process.execPath}\nif (process.argv.includes('--help')) console.log('--permission-mode <mode> (choices: "auto", "acceptEdits", "default")'); else console.log(JSON.stringify(process.argv.slice(2)));\n`);
  fs.chmodSync(executable, 0o700);
  const db = new Database(":memory:"); cleanups.push(() => db.close());
  db.exec(`CREATE TABLE nodes(id TEXT, runtime TEXT, cwd TEXT);
    CREATE TABLE bindings(id TEXT, node_id TEXT, tmux_session TEXT, tmux_pane TEXT);
    CREATE TABLE occupant_tenures(node_id TEXT, generation_uuid TEXT, generation_ordinal INTEGER);`);
  db.prepare("INSERT INTO nodes VALUES ('node', 'claude-code', ?)").run(cwd);
  db.exec("INSERT INTO bindings VALUES ('binding', 'node', 'seat', '%1'); INSERT INTO occupant_tenures VALUES ('node', 'generation-1', 1)");
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home };
  const launcher = new ClaudeManagedLaunch(db, env, {});
  let args: string[] = [];
  const send = async (_target: string, command: string, check?: () => void) => {
    check?.();
    args = JSON.parse(execFileSync("/bin/sh", ["-c", command], { cwd, env, encoding: "utf8", timeout: 5000 }));
    return { ok: true as const };
  };
  const tmux = { sendShellCommand: vi.fn(send), sendText: vi.fn(send), sendKeys: vi.fn(async () => ({ ok: true as const })),
    getPaneCommand: async () => "claude", capturePaneContent: async () => "Claude Code\n>", getPanePid: async () => 100,
    hasSession: async () => true } as unknown as TmuxAdapter;
  const listProcesses = async (): Promise<NativeProcessRow[]> => [
    { pid: 100, ppid: 1, pgid: 100, tpgid: 101, executableName: "bash", command: "bash", startedAt: "stable" },
    { pid: 101, ppid: 100, pgid: 101, tpgid: 101, executableName: "claude", command: `claude ${args.join(" ")}`, startedAt: "stable" },
  ];
  const fsOps = { readFile: (p: string) => fs.readFileSync(p, "utf8"), writeFile: () => {}, exists: (p: string) => fs.existsSync(p),
    mkdirp: () => {}, copyFile: () => {} };
  const launchTelemetry: ClaudeLaunchTelemetry = async ({ args, cwd, configDir, session, warnings }) => withClaudeLaunchTelemetry(args, {
    openrigHome: state, cwd, configDir: configDir ?? path.join(home, ".claude"), session, collector,
    relay: path.join(state, "state", "claude-activity-hooks", "activity-relay.cjs"), events: [], throttleSeconds: throttle,
  }, warnings);
  const adapter = new ClaudeCodeAdapter({ tmux, fsOps, stateDir: state, claudeManagedLaunch: launcher, sessionIdFactory: () => "fresh-id",
    listProcesses, sleep: async () => {}, launchTelemetry });
  const resume = new ClaudeResumeAdapter(tmux, { claudeManagedLaunch: launcher, openrigHome: state, listProcesses, sleep: async () => {},
    launchTelemetry });
  const binding: NodeBinding = { id: "binding", nodeId: "node", cwd, tmuxSession: "seat", tmuxPane: "%1", tmuxWindow: null,
    cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", permissionMode: "auto" };
  const settings = () => {
    const at = args.indexOf("--settings");
    return at < 0 ? {} : JSON.parse(args[at + 1]!) as Record<string, unknown>;
  };
  return { adapter, resume, binding, args: () => args, settings, state, collector, localSettings };
}

const launch = async (f: ReturnType<typeof fixture>, mode: string) => mode === "restore"
  ? f.resume.resume("seat", "claude_id", "history-id", f.binding.cwd, undefined, undefined, f.binding.permissionMode, "node")
  : f.adapter.launchHarness(f.binding, { name: "seat", ...(mode === "resume" ? { resumeToken: "history-id" } : {}) });

describe("the status line throttle at launch (#3416 item 3)", () => {
  it.skipIf(process.platform === "win32").each(["fresh", "resume", "restore"])("puts the throttled status line into the %s launch's --settings", async mode => {
    const f = fixture(30);
    const result = await launch(f, mode);
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(f.args().filter(arg => arg === "--settings")).toHaveLength(1);
    expect(f.settings()["statusLine"]).toMatchObject({ type: "command", command: expect.stringContaining('[ "$a" -lt 30 ]') });
    const { command } = f.settings()["statusLine"] as { command: string };
    expect(command).toContain(`f=${shellQuote(path.join(f.state, "state", "context-usage", "seat"))};`);
    expect(command).toContain(shellQuote(f.collector));
    expect(claudeCommandSessionToken(`claude ${f.args().join(" ")}`)).toBe(mode === "fresh" ? "fresh-id" : "history-id");
  });

  it.skipIf(process.platform === "win32").each(["fresh", "resume", "restore"])("puts the unthrottled collector into the %s launch's --settings", async mode => {
    const f = fixture(null);
    expect(await launch(f, mode)).toMatchObject({ ok: true });
    const collectorArgs = [process.execPath, f.collector,
      path.join(f.state, "state", "context-usage"), path.join(f.state, "state", "provider-usage")];
    expect(f.settings()["statusLine"]).toEqual({ type: "command", command: `exec ${collectorArgs.map(shellQuote).join(" ")}` });
    expect(fs.existsSync(f.localSettings)).toBe(false);
  });

  it.skipIf(process.platform === "win32").each(["fresh", "restore"])("lets the folder's own status line command win on a %s launch, and says so", async mode => {
    const f = fixture(30, { statusLine: { type: "command", command: "sh ~/my-status-line.sh" } });
    const originalSettings = fs.readFileSync(f.localSettings);
    const result = await launch(f, mode) as { ok: boolean; warnings?: string[] };
    expect(result.ok).toBe(true);
    expect(f.settings()).not.toHaveProperty("statusLine");
    expect(result.warnings).toEqual(expect.arrayContaining([expect.stringContaining("kept the configured Claude status line and skipped its context collector throttle")]));
    expect(fs.readFileSync(f.localSettings)).toEqual(originalSettings);
  });
});
