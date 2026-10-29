import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ClaudeManagedLaunch } from "../src/domain/claude-managed-launch.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import { claudeCommandSessionToken, verifyClaudePaneProcess, observeClaudeDelivery, type NativeProcessRow } from "../src/domain/native-process-lineage.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const EMPTY = '{"mcpServers":{}}';
const fsOps = { readFile: () => "", writeFile: () => {}, exists: () => false, mkdirp: () => {}, copyFile: () => {} };
function rows(args: string[]): NativeProcessRow[] {
  return [
    { pid: 100, ppid: 1, pgid: 100, tpgid: 101, executableName: "bash", command: "bash", startedAt: "stable" },
    { pid: 101, ppid: 100, pgid: 101, tpgid: 101, executableName: "claude", command: `claude ${args.join(" ")}`, startedAt: "stable" },
  ];
}

// Execute the generated shell against a private argv-printing fake. This verifies quoting and command
// plumbing, not the installed provider's MCP enforcement; readiness uses a simulated process table.
function fixture(managed: boolean) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "claude-mcp-argv-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "seat's workspace"), bin = path.join(root, "bin"), home = path.join(root, "home");
  for (const dir of [cwd, bin, home]) mkdirSync(dir);
  const executable = path.join(bin, "claude");
  writeFileSync(executable, `#!${process.execPath}\nif (process.argv.includes('--help')) console.log('--permission-mode <mode> (choices: "auto", "acceptEdits", "default")'); else console.log(JSON.stringify(process.argv.slice(2)));\n`);
  chmodSync(executable, 0o700);
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
  const listProcesses = async () => rows(args);
  const adapter = new ClaudeCodeAdapter({ tmux, fsOps, claudeManagedLaunch: launcher, sessionIdFactory: () => "fresh-id", listProcesses, sleep: async () => {} });
  const resume = new ClaudeResumeAdapter(tmux, { claudeManagedLaunch: launcher, listProcesses, sleep: async () => {} });
  const binding: NodeBinding = { id: "binding", nodeId: "node", cwd, tmuxSession: "seat", tmuxPane: "%1", tmuxWindow: null,
    cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", ...(managed ? { permissionMode: "auto" } : {}) };
  return { adapter, resume, binding, args: () => args, tmux, db };
}

describe("Claude MCP launch and identity", () => {
  for (const managed of [false, true]) for (const selection of [undefined, "none"] as const) {
    it.skipIf(process.platform === "win32").each(["fresh", "resume", "fork", "legacy"])(`executes %s argv (managed=${managed}, claude_mcp=${selection ?? "omitted"})`, async mode => {
      const f = fixture(managed), binding = { ...f.binding, claudeMcp: selection };
      const result = mode === "legacy"
        ? await f.resume.resume("seat", "claude_id", "history-id", binding.cwd, undefined, undefined, binding.permissionMode, "node",
          undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, selection)
        : await f.adapter.launchHarness(binding, { name: "seat", ...(mode === "resume" ? { resumeToken: "history-id" } : {}),
          ...(mode === "fork" ? { forkSource: { kind: "native_id" as const, value: "parent-id" } } : {}) });
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
      const args = f.args();
      expect(args.filter(arg => arg === "--strict-mcp-config")).toHaveLength(selection ? 1 : 0);
      expect(args.filter(arg => arg === "--mcp-config")).toHaveLength(selection ? 1 : 0);
      if (selection) expect(args[args.indexOf("--mcp-config") + 1]).toBe(EMPTY);
      const expectedToken = mode === "fresh" || mode === "fork" ? "fresh-id" : "history-id";
      expect(claudeCommandSessionToken(`claude ${args.join(" ")}`)).toBe(expectedToken);
    });
  }

  // A same-conversation relaunch may carry the executable the seat was running (#2196); the opt-out travels beside it.
  it.skipIf(process.platform === "win32").each([false, true])("legacy resume keeps the opt-out with a retained executable outside PATH (managed=%s)", async managed => {
    const f = fixture(managed), retained = path.join(path.dirname(f.binding.cwd), "retained", "claude");
    mkdirSync(path.dirname(retained));
    writeFileSync(retained, `#!${process.execPath}\nif (process.argv.includes('--help')) console.log('--permission-mode <mode> (choices: "auto", "acceptEdits", "default")'); else import('node:fs').then(fs => { fs.writeFileSync(process.argv[1] + '.ran', ''); console.log(JSON.stringify(process.argv.slice(2))); });\n`);
    chmodSync(retained, 0o700);
    const result = await f.resume.resume("seat", "claude_id", "history-id", f.binding.cwd, undefined, undefined, f.binding.permissionMode, "node",
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, retained, "none");
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(existsSync(`${retained}.ran`)).toBe(true);
    const args = f.args();
    expect(args.filter(arg => arg === "--strict-mcp-config")).toHaveLength(1);
    expect(args[args.indexOf("--mcp-config") + 1]).toBe(EMPTY);
    expect(claudeCommandSessionToken(`claude ${args.join(" ")}`)).toBe("history-id");
  });

  // A Claude member may name its own subscription token (#2246). The managed launch reads it in the same command that
  // carries the opt-out, so the process gets both.
  it.skipIf(process.platform === "win32").each(["fresh", "legacy"])("a seat's own subscription token reaches the same %s launch as the opt-out", async mode => {
    const f = fixture(true), root = path.dirname(f.binding.cwd), tokenFile = path.join(root, "seat.token");
    const synthetic = "synthetic-fixture-value-not-a-credential", executable = path.join(root, "bin", "claude");
    writeFileSync(tokenFile, `${synthetic}\n`, { mode: 0o600 });
    f.db.exec("ALTER TABLE nodes ADD COLUMN claude_token_ref TEXT");
    f.db.prepare("UPDATE nodes SET claude_token_ref = ? WHERE id = 'node'").run(JSON.stringify({ label: "seat-sub", tokenFile }));
    writeFileSync(executable, `#!${process.execPath}\nif (process.argv.includes('--help')) console.log('--permission-mode <mode> (choices: "auto", "acceptEdits", "default")'); else import('node:fs').then(fs => { fs.writeFileSync(process.argv[1] + '.token', process.env.CLAUDE_CODE_OAUTH_TOKEN === ${JSON.stringify(synthetic)} ? 'applied' : 'missing'); console.log(JSON.stringify(process.argv.slice(2))); });\n`);
    const result = mode === "legacy"
      ? await f.resume.resume("seat", "claude_id", "history-id", f.binding.cwd, undefined, undefined, f.binding.permissionMode, "node",
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, "none")
      : await f.adapter.launchHarness({ ...f.binding, claudeMcp: "none" }, { name: "seat" });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(readFileSync(`${executable}.token`, "utf8")).toBe("applied");
    const args = f.args();
    expect(args.filter(arg => arg === "--strict-mcp-config")).toHaveLength(1);
    expect(args[args.indexOf("--mcp-config") + 1]).toBe(EMPTY);
    expect(claudeCommandSessionToken(`claude ${args.join(" ")}`)).toBe(mode === "legacy" ? "history-id" : "fresh-id");
  });

  it.each([`--strict-mcp-config --mcp-config ${EMPTY}`, `--mcp-config=${EMPTY} --strict-mcp-config`])("keeps strict and delivery identity for the emitted configuration: %s", async flags => {
    const processes = rows(`${flags} --resume history-id`.split(" "));
    const input = { target: "%1", tmux: { getPanePid: async () => 100 }, listProcesses: async () => processes, expectedToken: "history-id" };
    expect(await verifyClaudePaneProcess(input)).toMatchObject({ process: { pid: 101 } });
    expect(await verifyClaudePaneProcess({ ...input, expectedToken: "other-id" })).toBeNull();
    expect(await observeClaudeDelivery(input)).toMatchObject({ state: "verified" });
  });

  it.each([
    "--strict-mcp-config=true", "--mcp-config", "--mcp-config --resume injected", "--mcp-config {}",
    '--mcp-config {"mcpServers":{"x":{"command":"--resume injected"}}}',
    '--mcp-config={"mcpServers":{"x":{"command":"--resume injected"}}}',
    '--mcp-config {"mcpServers":{} --resume injected', "--unknown",
    `--strict-mcp-config --mcp-config ${EMPTY} --session-id other-id`,
  ])("refuses malformed, unknown or conflicting argv: %s", async flags => {
    const processes = rows(`${flags} --resume history-id`.split(" "));
    expect(claudeCommandSessionToken(processes[1]!.command)).toBeNull();
    const input = { target: "%1", tmux: { getPanePid: async () => 100 }, listProcesses: async () => processes, expectedToken: "history-id" };
    expect(await verifyClaudePaneProcess(input)).toBeNull();
    expect(await observeClaudeDelivery(input)).toMatchObject({ state: "unknown" });
  });
});
