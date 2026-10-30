import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { ClaudeManagedLaunch } from "../src/domain/claude-managed-launch.js";
import { renderWindowsManagedLaunch } from "../src/adapters/windows-launch.js";
import { parseWindowsCommandLine, windowsArguments } from "../src/adapters/windows-argv.js";
import { writeWindowsPrivateConfig } from "../src/adapters/windows-private-config.js";

vi.mock("node:child_process", async importOriginal => ({ ...await importOriginal<typeof import("node:child_process")>(), execFile: vi.fn() }));
const cleanups: (() => void)[] = [];

function queriedCommand(file: string, args: string[], options: { env?: Record<string, string> }) {
  const env = options.env ?? {};
  const count = Number(env.OPENRIG_WINDOWS_PROBE_JOB_COUNT ?? 0);
  if (!count) return { file, args };
  const payload = Array.from({ length: count }, (_, index) => env[`OPENRIG_WINDOWS_PROBE_JOB_${index}`]).join("");
  return JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as { file: string; args: string[] };
}
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); vi.clearAllMocks(); });

function fixture(selected?: string, seat?: { rigEnv: Record<string, string>; memberEnv: Record<string, string>; sessionMarker: string; corePlugin?: boolean }) {
  const created = fs.mkdtempSync(path.join(os.tmpdir(), "rig-win-managed-"));
  const home = process.platform === "win32" ? fs.realpathSync.native(created) : created;
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
  it.runIf(process.platform === "win32")("queries and launches a recognized owned npm Claude entry with a frozen interpreter and script", async () => {
    const f = fixture();
    const node = path.join(f.home, "node.exe"), pkg = path.join(f.home, "node_modules", "@anthropic-ai", "claude-code");
    fs.copyFileSync(process.execPath, node); fs.mkdirSync(pkg, { recursive: true });
    const entry = path.join(pkg, "cli.js");
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code", bin: { claude: "cli.js" } }));
    fs.writeFileSync(path.join(f.home, "claude.cmd"), '@echo off\r\n"%_prog%" "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n');
    fs.writeFileSync(entry, 'console.log(process.argv.includes("--help") ? \'--permission-mode <mode> (choices: "auto", "default")\' : JSON.stringify(process.argv.slice(2)));');
    f.env.PATHEXT = ".CMD;.EXE";
    const native = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    vi.mocked(execFile).mockImplementation(native.execFile);
    const prepared = await f.managed.prepare({ nodeId: "node", session: "seat", pane: "%1" }, "auto");
    expect(prepared.executable).toBe(fs.realpathSync(node));
    expect(prepared.selectedScript).toBe(fs.realpathSync(entry));
    const args = ["--session-id", "owned & %literal%", "--name", "用户 fixture"];
    const command = prepared.command(args);
    const output = await new Promise<string>((resolve, reject) => native.execFile(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")],
      { env: { SystemRoot: process.env.SystemRoot, HOME: f.home, USERPROFILE: f.home, TEMP: f.home, TMP: f.home }, encoding: "utf8", windowsHide: true, timeout: 10000 },
      (error, stdout) => error ? reject(error) : resolve(stdout)));
    expect(JSON.parse(output.trim())).toEqual(args);
    // A continuation retains this pair even when the current PATH has no
    // Claude installation. It must not silently choose a new installation.
    f.env.PATH = path.join(f.home, "unrelated-bin");
    const retained = await f.managed.prepare({ nodeId: "node", session: "seat", pane: "%1", executable: prepared.executable, script: prepared.selectedScript }, "auto");
    expect(retained.executable).toBe(prepared.executable);
    expect(retained.selectedScript).toBe(prepared.selectedScript);
    f.env.PATH = f.home;
    fs.appendFileSync(entry, "\n// changed after preparation");
    expect(() => prepared.assertCurrent()).toThrow(/context changed/);
  });
  it.runIf(process.platform === "win32")("pins selected PATHEXT for capability discovery and the actual child despite pane drift", async () => {
    const f = fixture(); fs.copyFileSync(process.execPath, f.executable);
    f.env.Pathext = ".EXE";
    vi.mocked(execFile).mockImplementation(((_file: string, _args: string[], opts: { env: Record<string, string> }, done: (error: null, help: string) => void) => {
      expect(opts.env.PATHEXT).toBe(".EXE");
      done(null, '--permission-mode <mode> (choices: "auto", "default")');
    }) as never);
    const prepared = await f.managed.prepare({ nodeId: "node", session: "seat", pane: "%1" }, "auto");
    const command = prepared.command(["-e", "console.log(JSON.stringify({extensions:process.env.PATHEXT}))"]);
    const native = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const output = await new Promise<string>((resolve, reject) => native.execFile(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")],
      { env: { SystemRoot: process.env.SystemRoot, HOME: f.home, USERPROFILE: f.home, TEMP: f.home, TMP: f.home, PATHEXT: ".WRONG" }, encoding: "utf8", windowsHide: true, timeout: 10000 },
      (error, stdout) => error ? reject(error) : resolve(stdout)));
    expect(JSON.parse(output.trim())).toEqual({ extensions: ".EXE" });
  });
  it.runIf(process.platform === "win32")("selects native COM by copied PATHEXT order and refuses empty or batch-first selection", async () => {
    const f = fixture();
    const native = path.join(f.home, "claude.com");
    fs.copyFileSync(process.execPath, native);
    f.env.Pathext = ".COM;.EXE";
    const prepared = await f.managed.prepare({ nodeId: "node", session: "seat", pane: "%1" }, "auto");
    expect(prepared.executable).toBe(fs.realpathSync(native));
    f.env.Pathext = ".EXE;.COM";
    expect(() => prepared.assertCurrent()).toThrow(/context changed/);
    f.env.Pathext = "";
    await expect(f.managed.prepare({ nodeId: "node" }, "auto")).rejects.toThrow(/unavailable/);
    fs.writeFileSync(path.join(f.home, "claude.cmd"), "@echo unrelated batch");
    f.env.Pathext = ".CMD;.EXE";
    await expect(f.managed.prepare({ nodeId: "node" }, "auto")).rejects.toThrow(/native executable/);
  });
  it.runIf(process.platform === "win32")("reports copied lower-case credential precedence by name without echoing its value", async () => {
    const f = fixture();
    delete f.env.ANTHROPIC_API_KEY;
    f.env.anthropic_api_key = "synthetic-lower-case-private-value";
    const result = await f.managed.credentialPrecedence("node", { storedLogin: true });
    expect(result.conflicts.some(conflict => conflict.name === "ANTHROPIC_API_KEY")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("synthetic-lower-case-private-value");
  });

  it.runIf(process.platform === "win32")("binds mixed-case copied environment without pane overrides of native home or identity", async () => {
    const f = fixture();
    fs.copyFileSync(process.execPath, f.executable);
    delete f.env.HOME; delete f.env.PATH; delete f.env.OPENRIG_HOME;
    Object.assign(f.env, { home: f.home, Path: `"${f.home}"`, OpenRig_Home: f.home, claude_config_dir: "./selected config", openrig_node_id: "daemon-wrong", Mixed_Flag: "not-typed", "ProgramFiles(x86)": "not-typed-native-location" });
    const prepared = await f.managed.prepare({ nodeId: "node", session: "seat", pane: "%1" }, "auto");
    expect(prepared.configDir).toBe(path.join(f.cwd, "selected config"));
    const source = "console.log(JSON.stringify({home:process.env.HOME,path:process.env.PATH,config:process.env.CLAUDE_CONFIG_DIR,node:process.env.OPENRIG_NODE_ID,instance:process.env.OPENRIG_HOME,mixed:process.env.Mixed_Flag,nativeLocation:process.env['ProgramFiles(x86)']}))";
    const command = prepared.command(["-e", source]);
    expect(command).not.toContain("not-typed");
    const native = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const paneEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PROGRAMFILES(X86)"));
    Object.assign(paneEnv, { HOME: "pane-wrong", openrig_node_id: "pane-wrong", Mixed_Flag: "synthetic-forwarded", "ProgramFiles(x86)": "synthetic-location" });
    const output = await new Promise<string>((resolve, reject) => native.execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], {
      env: paneEnv, encoding: "utf8", windowsHide: true, timeout: 15000,
    }, (error, stdout) => error ? reject(error) : resolve(stdout)));
    expect(JSON.parse(output.trim()), output.trim()).toEqual({ home: f.home, path: f.home, config: path.join(f.cwd, "selected config"), node: "node", instance: f.home, mixed: "synthetic-forwarded", nativeLocation: "synthetic-location" });
  });

  it.runIf(process.platform === "win32").each(["binding", "executable", "cwd", "PATH", "config"] as const)(
    "refuses a changed %s after the capability query without returning a launch command", async change => {
      const f = fixture();
      vi.mocked(execFile).mockImplementation(((file: string, args: string[], options: { env: Record<string, string> }, done: (error: null, help: string) => void) => {
        const selected = queriedCommand(file, args, options);
        expect(selected.file).toBe(fs.realpathSync(f.executable));
        expect(selected.args).toEqual(["--help"]);
        expect(options.env.ANTHROPIC_API_KEY).toBeUndefined();
        if (change === "binding") f.db.exec("UPDATE bindings SET tmux_pane='%2' WHERE node_id='node'");
        if (change === "executable") fs.appendFileSync(f.executable, "\nchanged while querying");
        if (change === "cwd") { fs.renameSync(f.cwd, f.cwd + "-previous"); fs.mkdirSync(f.cwd); }
        if (change === "PATH") f.env.PATH += path.delimiter + f.home;
        if (change === "config") f.env.CLAUDE_CONFIG_DIR = path.join(f.home, "new config");
        done(null, '--permission-mode <mode> (choices: "auto", "default")');
      }) as never);
      await expect(f.managed.prepare({ nodeId: "node", session: "seat", pane: "%1" }, "auto"))
        .rejects.toThrow(/context changed during capability discovery\/input/);
      expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
    });

  it.runIf(process.platform === "win32")("rechecks the native executable at command construction after successful preparation", async () => {
    const f = fixture();
    const prepared = await f.managed.prepare({ nodeId: "node", session: "seat", pane: "%1" }, "auto");
    fs.appendFileSync(f.executable, "\nchanged before dispatch");
    expect(() => prepared.command(["--session-id", "owned-id"])).toThrow(/context changed/);
    expect(vi.mocked(execFile)).toHaveBeenCalledTimes(1);
  });

  it.runIf(process.platform === "win32")("uses the selected API-key reference through preparation and actual child launch", async () => {
    const f = fixture();
    fs.copyFileSync(process.execPath, f.executable);
    const native = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    vi.mocked(execFile).mockImplementation(((file: string, args: string[], opts: object, done: (error: Error | null, output: string) => void) => {
      if (queriedCommand(file, args, opts).args[0] === "--help") done(null, '--permission-mode <mode> (choices: "auto", "default")');
      else return native.execFile(file, args, opts, done as never);
    }) as never);
    const privateFile = await writeWindowsPrivateConfig("synthetic-selected-api-key\r\n");
    try {
      f.db.exec("ALTER TABLE nodes ADD COLUMN claude_token_ref TEXT");
      f.db.prepare("UPDATE nodes SET claude_token_ref=? WHERE id='node'").run(JSON.stringify({ label: "test", tokenFile: privateFile.path, kind: "api-key" }));
      const receiver = path.join(f.home, "api-receiver.cjs");
      fs.writeFileSync(receiver, "console.log(JSON.stringify({selected:process.env.ANTHROPIC_API_KEY==='synthetic-selected-api-key',loginAbsent:process.env.CLAUDE_CODE_OAUTH_TOKEN===undefined,routingAbsent:process.env.ANTHROPIC_BASE_URL===undefined}));");
      const prepared = await f.managed.prepare({ nodeId: "node", session: "seat", pane: "%1" }, "auto");
      const command = prepared.command([receiver]);
      expect(command).not.toContain("synthetic-selected-api-key");
      const output = await new Promise<string>((resolve, reject) => native.execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], {
        env: { ...process.env, ANTHROPIC_API_KEY: "synthetic-other-key", CLAUDE_CODE_OAUTH_TOKEN: "synthetic-old", ANTHROPIC_BASE_URL: "synthetic-other-route" }, encoding: "utf8", windowsHide: true, timeout: 10000,
      }, (error, stdout) => error ? reject(error) : resolve(stdout)));
      expect(JSON.parse(output.trim())).toEqual({ selected: true, loginAbsent: true, routingAbsent: true });
    } finally { await privateFile.dispose(); }
  }, 20000);
  it.runIf(process.platform === "win32")("does not reintroduce credentials through launch overrides for an isolated account", async () => {
    const f = fixture();
    fs.copyFileSync(process.execPath, f.executable);
    f.db.exec("ALTER TABLE nodes ADD COLUMN account_home TEXT");
    f.db.prepare("UPDATE nodes SET account_home=? WHERE id='node'").run(f.home);
    const receiver = path.join(f.home, "isolated-receiver.cjs");
    fs.writeFileSync(receiver, `console.log(JSON.stringify({keyAbsent:process.env.ANTHROPIC_API_KEY===undefined,tokenAbsent:process.env.CLAUDE_CODE_OAUTH_TOKEN===undefined}));`);
    const prepared = await f.managed.prepare({ nodeId: "node", session: "seat", pane: "%1" }, "auto");
    const command = prepared.command([receiver], { ANTHROPIC_API_KEY: "must-not-forward", claude_code_oauth_token: "must-not-forward" });
    expect(command).not.toContain("must-not-forward");
    const native = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const output = await new Promise<string>((resolve, reject) => native.execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], {
      env: { ...process.env, ANTHROPIC_API_KEY: "synthetic-key", CLAUDE_CODE_OAUTH_TOKEN: "synthetic-old" }, encoding: "utf8", windowsHide: true, timeout: 10000,
    }, (error, stdout) => error ? reject(error) : resolve(stdout)));
    expect(JSON.parse(output.trim())).toEqual({ keyAbsent: true, tokenAbsent: true });
  });

  it.runIf(process.platform === "win32")("carries the stored seat token into the managed child without putting its value in the command", async () => {
    const f = fixture();
    fs.copyFileSync(process.execPath, f.executable);
    const tokenFile = path.join(f.home, "subscription token.txt");
    fs.writeFileSync(tokenFile, "synthetic-selected-token\r\n");
    f.db.exec("ALTER TABLE nodes ADD COLUMN claude_token_ref TEXT");
    f.db.prepare("UPDATE nodes SET claude_token_ref=? WHERE id='node'").run(JSON.stringify({ label: "test", tokenFile }));
    const receiver = path.join(f.home, "token-receiver.cjs");
    fs.writeFileSync(receiver, `console.log(JSON.stringify({selected:process.env.CLAUDE_CODE_OAUTH_TOKEN==='synthetic-selected-token',keyAbsent:process.env.ANTHROPIC_API_KEY===undefined}));`);
    const prepared = await f.managed.prepare({ nodeId: "node", session: "seat", pane: "%1" }, "auto");
    const command = prepared.command([receiver]);
    expect(command).not.toContain("synthetic-selected-token");
    expect(command).not.toContain("/bin/cat");
    const native = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const output = await new Promise<string>((resolve, reject) => native.execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], {
      env: { ...process.env, ANTHROPIC_API_KEY: "synthetic-key" }, encoding: "utf8", windowsHide: true, timeout: 10000,
    }, (error, stdout) => error ? reject(error) : resolve(stdout)));
    expect(JSON.parse(output.trim())).toEqual({ selected: true, keyAbsent: true });
  });

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
    const source = "console.log(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd(),home:process.env.HOME,auth:process.env.ANTHROPIC_API_KEY,empty:process.env.DECLARED_EMPTY,unapproved:process.env.UNAPPROVED,parent:process.env.PARENT_ONLY}))";
    const command = renderWindowsManagedLaunch(process.execPath, ["-e", source, ...argv], f.cwd, { HOME: f.home, SYSTEMROOT: process.env.SystemRoot!, PATH: path.dirname(process.execPath) }, ["ANTHROPIC_API_KEY", "DECLARED_EMPTY"]);
    expect(command).not.toContain("synthetic-only-never-in-script");
    const native = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const script = "[Console]::Error.WriteLine('fixture: PowerShell ready'); " + command
      + "; [Console]::Error.WriteLine('fixture: native child completed'); Write-Output ([Environment]::GetEnvironmentVariable('PARENT_ONLY'))";
    const output = await new Promise<string>((resolve, reject) => {
      native.execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], {
        encoding: "utf8", timeout: 30000, windowsHide: true,
        // PowerShell is the parent pane, not the isolated runtime. Keep its OS
        // profile/environment; renderWindowsManagedLaunch isolates only its child.
        env: { ...process.env, ANTHROPIC_API_KEY: f.env.ANTHROPIC_API_KEY!, DECLARED_EMPTY: "", UNAPPROVED: "must-not-forward", PARENT_ONLY: "parent-preserved" },
      }, (error, out, stderr) => error ? reject(new Error(`Native fixture failed: killed=${error.killed}, signal=${error.signal}, code=${error.code}; stderr=${stderr}; stdout=${out}`)) : resolve(out));
    });
    const [child, parent] = output.trim().split(/\r?\n/);
    expect(JSON.parse(child!)).toEqual({ args: argv, cwd: f.cwd, home: f.home, auth: "synthetic-only-never-in-script", empty: "" });
    expect(parent).toBe("parent-preserved");
  }, 40000);
});
