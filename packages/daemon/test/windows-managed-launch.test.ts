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

function fixture(selected?: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rig-win-managed-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true }));
  const cwd = path.join(home, "中文 space"); fs.mkdirSync(cwd);
  const executable = path.join(home, "claude.exe"); fs.writeFileSync(executable, "inert fixture", { mode: 0o700 });
  const db = new Database(":memory:"); cleanups.push(() => db.close());
  db.exec("CREATE TABLE nodes(id TEXT, runtime TEXT, cwd TEXT); CREATE TABLE bindings(id TEXT,node_id TEXT,tmux_session TEXT,tmux_pane TEXT); CREATE TABLE occupant_tenures(node_id TEXT,generation_uuid TEXT,generation_ordinal INTEGER)");
  db.prepare("INSERT INTO nodes VALUES ('node','claude-code',?)").run(cwd);
  db.exec("INSERT INTO bindings VALUES ('binding','node','seat','%1'); INSERT INTO occupant_tenures VALUES ('node','generation',1)");
  const env: Record<string, string> = { HOME: home, PATH: home, OPENRIG_HOME: home, ANTHROPIC_API_KEY: "synthetic-only-never-in-script" };
  if (selected !== undefined) env.CLAUDE_CONFIG_DIR = selected;
  vi.mocked(execFile).mockImplementation(((_file: string, _args: string[], _opts: unknown, done: (error: null, help: string) => void) => done(null, '--permission-mode <mode> (choices: "auto", "default")')) as never);
  return { home, cwd, executable, db, env, managed: new ClaudeManagedLaunch(db, env, {}, "win32") };
}

describe("managed Windows launch", () => {
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
    const script = command + "; Write-Output ([Environment]::GetEnvironmentVariable('PARENT_ONLY'))";
    const output = await new Promise<string>((resolve, reject) => {
      native.execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
        encoding: "utf8", timeout: 30000, windowsHide: true,
        env: { SYSTEMROOT: process.env.SystemRoot!, PATH: process.env.PATH!, ANTHROPIC_API_KEY: f.env.ANTHROPIC_API_KEY!, UNAPPROVED: "must-not-forward", PARENT_ONLY: "parent-preserved" },
      }, (error, out, stderr) => error ? reject(new Error(`Native fixture failed: killed=${error.killed}, signal=${error.signal}, code=${error.code}; stderr=${stderr}; stdout=${out}`)) : resolve(out));
    });
    const [child, parent] = output.trim().split(/\r?\n/);
    expect(JSON.parse(child!)).toEqual({ args: argv, cwd: f.cwd, home: f.home, auth: "synthetic-only-never-in-script" });
    expect(parent).toBe("parent-preserved");
  }, 40000);
});
