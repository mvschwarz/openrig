import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { ClaudeManagedLaunch } from "../src/domain/claude-managed-launch.js";
import { renderWindowsManagedLaunch } from "../src/adapters/windows-launch.js";
import { parseWindowsCommandLine, windowsArguments } from "../src/adapters/windows-argv.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.clearAllMocks(); });

function fixture(selected?: string, seat?: { rigEnv: Record<string, string>; memberEnv: Record<string, string>; sessionMarker: string; corePlugin?: boolean }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rig-win-managed-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true }));
  const cwd = path.join(home, "中文 space"); fs.mkdirSync(cwd);
  const executable = path.join(home, "claude.exe"); fs.writeFileSync(executable, "inert fixture", { mode: 0o700 });
  const db = new Database(":memory:"); cleanups.push(() => db.close());
  const pluginsDir = path.join(home, "plugins");
  if (seat?.corePlugin) {
    const plugin = path.join(pluginsDir, "openrig-core");
    fs.mkdirSync(path.join(plugin, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(plugin, ".claude-plugin", "plugin.json"), "{}");
    db.exec("CREATE TABLE node_startup_context(node_id TEXT, projection_entries_json TEXT)");
    db.prepare("INSERT INTO node_startup_context VALUES ('node', ?)").run(JSON.stringify([{ category: "plugin", absolutePath: plugin }]));
  }
  db.exec("CREATE TABLE nodes(id TEXT, runtime TEXT, cwd TEXT); CREATE TABLE bindings(id TEXT,node_id TEXT,tmux_session TEXT,tmux_pane TEXT); CREATE TABLE occupant_tenures(node_id TEXT,generation_uuid TEXT,generation_ordinal INTEGER)");
  db.prepare("INSERT INTO nodes VALUES ('node','claude-code',?)").run(cwd);
  db.exec("INSERT INTO bindings VALUES ('binding','node','seat','%1'); INSERT INTO occupant_tenures VALUES ('node','generation',1)");
  if (seat) {
    db.exec("CREATE TABLE rigs(id TEXT,env_json TEXT); ALTER TABLE nodes ADD COLUMN rig_id TEXT; ALTER TABLE nodes ADD COLUMN env_json TEXT;");
    db.prepare("INSERT INTO rigs VALUES ('rig', ?)").run(JSON.stringify(seat.rigEnv));
    db.prepare("UPDATE nodes SET rig_id='rig',env_json=? WHERE id='node'").run(JSON.stringify(seat.memberEnv));
  }
  const env: Record<string, string> = { HOME: home, PATH: home, OPENRIG_HOME: home, ANTHROPIC_API_KEY: "synthetic-only-never-in-script" };
  if (selected !== undefined) env.CLAUDE_CONFIG_DIR = selected;
  vi.mocked(execFile).mockImplementation(((_file: string, _args: string[], _opts: unknown, done: (error: null, help: string) => void) => done(null, '--permission-mode <mode> (choices: "auto", "default")')) as never);
  return { home, cwd, executable, db, env, managed: new ClaudeManagedLaunch(db, env, {}, seat ? async () => seat.sessionMarker : undefined, pluginsDir, "win32") };
}

describe("managed Windows launch", () => {
  it.runIf(process.platform === "win32")("forwards rig, member and one-off env through the managed child without exposing pane-only variables", async () => {
    const f = fixture(undefined, { rigEnv: { RIG_FLAG: "declared-rig", HOME: "wrong-home", DECLARED_UNSET: "not-in-pane" }, memberEnv: { MEMBER_FLAG: "declared-member" }, sessionMarker: "ONCE_FLAG", corePlugin: true });
    fs.copyFileSync(process.execPath, f.executable);
    const launch = await f.managed.prepare({ nodeId: "node", session: "seat", pane: "%1" }, "auto");
    const source = "console.log(JSON.stringify({rig:process.env.RIG_FLAG,member:process.env.MEMBER_FLAG,once:process.env.ONCE_FLAG,unset:process.env.DECLARED_UNSET,leaked:process.env.PANE_ONLY,home:process.env.HOME,plugin:process.env.CLAUDE_CODE_PLUGIN_DIRS,project:process.env.OPENRIG_SEAT_PROJECT_DIR,terminal:process.env.TERM_PROGRAM,version:process.env.TERM_PROGRAM_VERSION}))";
    const command = launch.command(["-e", source]);
    expect(command).not.toContain("pane-rig-value");
    const native = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const paneEnv: NodeJS.ProcessEnv = { ...process.env, RIG_FLAG: "pane-rig-value", MEMBER_FLAG: "pane-member-value", ONCE_FLAG: "pane-once-value", PANE_ONLY: "must-not-forward" };
    paneEnv.CLAUDE_CODE_PLUGIN_DIRS = path.join(f.home, "plugins", "openrig-core");
    paneEnv.OPENRIG_SEAT_PROJECT_DIR = f.cwd;
    paneEnv.TERM_PROGRAM = "tmux";
    paneEnv.TERM_PROGRAM_VERSION = "test-terminal-version";
    delete paneEnv.DECLARED_UNSET;
    const output = await new Promise<string>((resolve, reject) => {
      native.execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], {
        encoding: "utf8", timeout: 30000, windowsHide: true, env: paneEnv,
      }, (error, out, stderr) => error ? reject(new Error(`Native seat-env fixture failed: ${error.message}; stderr=${stderr}`)) : resolve(out));
    });
    expect(JSON.parse(output.trim())).toEqual({ rig: "pane-rig-value", member: "pane-member-value", once: "pane-once-value", home: f.home,
      plugin: paneEnv.CLAUDE_CODE_PLUGIN_DIRS, project: f.cwd, terminal: "tmux", version: "test-terminal-version" });
  }, 40000);

  it.each([undefined, "", "./config", "./config space"])("preserves native config selection %s and forwards auth by name", async selected => {
    const f = fixture(selected);
    const launch = await f.managed.prepare({ nodeId: "node", session: "seat", pane: "%1" }, "auto");
    expect(launch.executable).toBe(fs.realpathSync(f.executable));
    const query = vi.mocked(execFile).mock.calls[0]!;
    const env = (query[2] as { env: Record<string, string> }).env;
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    if (selected === undefined) expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    else expect(env.CLAUDE_CONFIG_DIR).toBe(path.resolve(f.cwd, selected));
    const command = launch.command(["--session-id", "expected", "--permission-mode", "auto"]);
    expect(command).not.toContain(f.env.ANTHROPIC_API_KEY);
    expect(command).toContain("'ANTHROPIC_API_KEY'");
    expect(command).toContain("EnvironmentVariables.Clear()");
    expect(command).not.toContain("/usr/bin/env");
    f.db.exec("UPDATE occupant_tenures SET generation_uuid='successor'");
    expect(() => launch.command([])).toThrow(/context changed/);
  });

  it("parses OS command lines including paths with spaces and opaque settings arguments", () => {
    const args = ["C:\\program space\\claude.exe", "--settings", '{"note":"--resume wrong"}', "--session-id", "right", "", "backslash\\", 'quoted"name'];
    expect(parseWindowsCommandLine(windowsArguments(args))).toEqual(args);
    expect(parseWindowsCommandLine('"C:\\program space\\claude.exe" --resume exact')).toEqual(["C:\\program space\\claude.exe", "--resume", "exact"]);
  });

  it.runIf(process.platform === "win32")("executes the native child with exact argv and isolated environment without changing its parent", async () => {
    const f = fixture();
    const argv = ["", "中文 space", 'quote"value', "trailing\\", "apostrophe's", "$literal; %PATH%"];
    const source = "console.log(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd(),home:process.env.HOME,auth:process.env.ANTHROPIC_API_KEY,unapproved:process.env.UNAPPROVED,parent:process.env.PARENT_ONLY}))";
    const command = renderWindowsManagedLaunch(process.execPath, ["-e", source, ...argv], f.cwd, { HOME: f.home, SYSTEMROOT: process.env.SystemRoot!, PATH: path.dirname(process.execPath) }, ["ANTHROPIC_API_KEY"]);
    expect(command).not.toContain("synthetic-only-never-in-script");
    const native = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const script = "[Console]::Error.WriteLine('fixture: PowerShell ready'); " + command
      + "; [Console]::Error.WriteLine('fixture: native child completed'); Write-Output ([Environment]::GetEnvironmentVariable('PARENT_ONLY'))";
    const output = await new Promise<string>((resolve, reject) => {
      native.execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
        encoding: "utf8", timeout: 30000, windowsHide: true,
        // PowerShell is the parent pane, not the isolated runtime. Keep its OS
        // profile/environment; renderWindowsManagedLaunch isolates only its child.
        env: { ...process.env, ANTHROPIC_API_KEY: f.env.ANTHROPIC_API_KEY!, UNAPPROVED: "must-not-forward", PARENT_ONLY: "parent-preserved" },
      }, (error, out, stderr) => error ? reject(new Error(`Native fixture failed: killed=${error.killed}, signal=${error.signal}, code=${error.code}; stderr=${stderr}; stdout=${out}`)) : resolve(out));
    });
    const [child, parent] = output.trim().split(/\r?\n/);
    expect(JSON.parse(child!)).toEqual({ args: argv, cwd: f.cwd, home: f.home, auth: "synthetic-only-never-in-script" });
    expect(parent).toBe("parent-preserved");
  }, 40000);
});
