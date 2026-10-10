import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import Database from "better-sqlite3";
import { SeatLaunchEnvironment, publicSeatEnvironment } from "../src/domain/seat-launch-environment.js";
import { ClaudeManagedLaunch } from "../src/domain/claude-managed-launch.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code-adapter.js";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { ClaudeResumeAdapter } from "../src/adapters/claude-resume.js";
import { CodexResumeAdapter } from "../src/adapters/codex-resume.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";

// Only private fake executables, a loopback fixture and memory SQLite. No daemon,
// provider, native account, tmux server, startup/config bootstrap or global homes.
const exec = promisify(execFile);
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const f of cleanup.splice(0).reverse()) await f(); });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "seat-env-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, "current bin's"); const userBin = path.join(root, "user-bin");
  for (const dir of [bin, userBin, path.join(root, "workspace"), path.join(root, "home")]) mkdirSync(dir);
  const writeExe = (file: string, body: string) => writeFileSync(file, body, { mode: 0o700 });
  writeExe(path.join(userBin, "rig"), "#!/bin/sh\necho wrong-rig\n");
  writeExe(path.join(userBin, "codex"), "#!/bin/sh\necho wrong-codex\n");
  writeExe(path.join(userBin, "user-tool"), "#!/bin/sh\necho user-tool-preserved\n");
  writeExe(path.join(bin, "rig"), `#!${process.execPath}\nconst http=require('node:http');const r=http.get(process.env.OPENRIG_URL+'/whoami',{headers:{authorization:'Bearer '+process.env.OPENRIG_ACTIVITY_HOOK_TOKEN}},s=>{let b='';s.on('data',c=>b+=c);s.on('end',()=>{console.log(JSON.stringify({body:JSON.parse(b),home:process.env.OPENRIG_HOME,node:process.env.OPENRIG_NODE_ID,runtime:process.env.OPENRIG_RUNTIME,generation:process.env.OPENRIG_OCCUPANT_GENERATION,PATH:process.env.PATH,HOME:process.env.HOME,CODEX_HOME:process.env.CODEX_HOME,CLAUDE_CONFIG_DIR:process.env.CLAUDE_CONFIG_DIR,USER_VALUE:process.env.USER_VALUE}));});});r.on('error',e=>{console.error(e.message);process.exitCode=1;});\n`);
  for (const name of ["claude", "codex"]) writeExe(path.join(bin, name), `#!/bin/sh\nif [ "$1" = --help ]; then printf '%s\\n' '--permission-mode <mode> (choices: "auto", "default")'; else rig whoami; user-tool >/dev/null; fi\n`);
  const identity: Record<string, string> = { OPENRIG_NODE_ID: "node-current", OPENRIG_SESSION_NAME: "seat@rig", OPENRIG_RUNTIME: "claude-code", OPENRIG_OCCUPANT_GENERATION: "successor-generation" };
  const tmux = new TmuxAdapter(async cmd => {
    expect(cmd).toMatch(/^tmux show-environment /);
    const key = Object.keys(identity).find(k => cmd.endsWith(shellQuote(k)));
    if (!key) throw Error("unexpected environment read");
    return `${key}=${identity[key]}\n`;
  });
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: path.join(root, "home"), OPENRIG_HOME: path.join(root, "instance"), OPENRIG_URL: "http://127.0.0.1:1", OPENRIG_ACTIVITY_HOOK_TOKEN: "synthetic-channel-secret", ANTHROPIC_API_KEY: "synthetic-provider-secret", CODEX_HOME: "/daemon/codex" };
  const rc = path.join(root, "rc");
  writeFileSync(rc, `export OPENRIG_HOME=/wrong OPENRIG_URL=http://127.0.0.1:1 OPENRIG_NODE_ID=wrong OPENRIG_OCCUPANT_GENERATION=wrong\nexport PATH=${shellQuote(userBin + ":" + bin + ":/usr/bin:/bin")}\nexport HOME=/user/home CODEX_HOME=/user/codex CLAUDE_CONFIG_DIR=/user/claude USER_VALUE=keep\n`);
  const launch = new SeatLaunchEnvironment(tmux, env, root, path.join(bin, "rig"));
  const commands: string[] = [];
  const binding: NodeBinding = { id: "b", nodeId: "node-current", tmuxSession: "seat@rig", tmuxPane: "%1", tmuxWindow: null, cmuxWorkspace: null, cmuxSurface: null, updatedAt: "", cwd: path.join(root, "workspace") };
  const send = async (_session: string, command: string) => { commands.push(command); return { ok: true as const }; };
  vi.spyOn(tmux, "sendText").mockImplementation(send);
  vi.spyOn(tmux, "sendShellCommand").mockImplementation(send);
  vi.spyOn(tmux, "sendKeys").mockResolvedValue({ ok: true });
  vi.spyOn(tmux, "getPaneCommand").mockResolvedValue("claude");
  vi.spyOn(tmux, "capturePaneContent").mockResolvedValue("Claude Code\n> ");
  const fsOps = { readFile: () => "", writeFile: () => { throw Error("no projection"); }, exists: () => false, mkdirp: () => { throw Error("no projection"); }, copyFile: () => { throw Error("no projection"); }, homedir: path.join(root, "home") };
  async function serve() {
    const server = createServer((req, res) => { res.writeHead(req.headers.authorization === "Bearer synthetic-channel-secret" ? 200 : 401); res.end(JSON.stringify({ node: req.headers.authorization === "Bearer synthetic-channel-secret" ? "node-current" : "unauthorized" })); });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    cleanup.push(() => new Promise<void>((r, reject) => server.close(e => e ? reject(e) : r())));
    env.OPENRIG_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }
  async function execute(command: string, managed = false) {
    expect(command).not.toContain(env.OPENRIG_ACTIVITY_HOOK_TOKEN);
    expect(command).not.toContain(env.ANTHROPIC_API_KEY);
    const { stdout } = await exec("/bin/bash", ["--noprofile", "--rcfile", rc, "-ic", command], { env, cwd: binding.cwd, timeout: 5000 });
    const observed = JSON.parse(stdout);
    expect(observed).toMatchObject({ body: { node: "node-current" }, home: env.OPENRIG_HOME, node: "node-current" });
    if (!managed) expect(observed).toMatchObject({ generation: "successor-generation", HOME: "/user/home", CODEX_HOME: "/user/codex", CLAUDE_CONFIG_DIR: "/user/claude", USER_VALUE: "keep" });
    if (!managed) {
      const [owned, ...rest] = observed.PATH.split(":");
      expect(rest.join(":")).toBe(`${userBin}:${bin}:/usr/bin:/bin`);
      expect(readlinkSync(path.join(owned, "rig"))).toBe(path.join(bin, "rig"));
    }
    return observed;
  }
  return { root, bin, env, identity, tmux, launch, binding, fsOps, commands, serve, execute };
}

describe.skipIf(process.platform === "win32")("seat launch environment after shell rc", () => {
  it.each(["fresh", "resume", "fork"] as const)("classic Claude %s reaches its daemon without replacing user settings", async kind => {
    const f = fixture(); await f.serve();
    const adapter = new ClaudeCodeAdapter({ tmux: f.tmux, fsOps: f.fsOps, seatLaunchEnvironment: f.launch, sleep: async () => {} });
    vi.spyOn(adapter as any, "verifyResumeLaunch").mockResolvedValue({ ok: true });
    vi.spyOn(adapter as any, "pollForResumeToken").mockResolvedValue("new-native-id");
    const result = await adapter.launchHarness(f.binding, { name: "seat", ...(kind === "resume" ? { resumeToken: "old-id" } : kind === "fork" ? { forkSource: { kind: "native_id" as const, value: "parent-id" } } : {}) });
    expect(result.ok).toBe(true); expect(f.commands).toHaveLength(1);
    await f.execute(f.commands[0]!);
    expect(f.tmux.sendKeys).not.toHaveBeenCalled(); // staged helper owns the one submit
  });
  it.each(["fresh", "resume", "fork"] as const)("Codex %s pins its probed executable but preserves the child tool PATH", async kind => {
    const f = fixture(); await f.serve(); f.identity.OPENRIG_RUNTIME = "codex";
    const adapter = new CodexRuntimeAdapter({ tmux: f.tmux, fsOps: f.fsOps, seatLaunchEnvironment: f.launch, launchPath: f.env.PATH,
      detectDaemonSupport: async () => ({ kind: "supported" }), resolveGitAddDirs: async () => [], listProcesses: () => [], sleep: async () => {} });
    vi.spyOn(adapter as any, "dismissSkippableCodexUpdatePrompt").mockResolvedValue(undefined);
    vi.spyOn(adapter as any, "verifyResumeLaunch").mockResolvedValue({ ok: true });
    vi.spyOn(adapter as any, "captureFreshThreadId").mockResolvedValue("new-native-id");
    const result = await adapter.launchHarness(f.binding, { name: "seat", ...(kind === "resume" ? { resumeToken: "old-id" } : kind === "fork" ? { forkSource: { kind: "native_id" as const, value: "parent-id" } } : {}) });
    expect(result.ok).toBe(true); expect(f.commands).toHaveLength(1);
    expect(f.commands[0]).toContain(`${shellQuote(path.join(f.bin, "codex"))} --no-daemon`);
    await f.execute(f.commands[0]!);
  });
  it.each(["claude", "codex"] as const)("legacy %s resume uses the same correction", async runtime => {
    const f = fixture(); await f.serve();
    const adapter = runtime === "claude" ? new ClaudeResumeAdapter(f.tmux, { seatLaunchEnvironment: f.launch }) : new CodexResumeAdapter(f.tmux, { seatLaunchEnvironment: f.launch, launchPath: f.env.PATH });
    vi.spyOn(adapter as any, "verifyResume").mockResolvedValue({ ok: true });
    expect((await adapter.resume("seat@rig", runtime === "claude" ? "claude_id" : "codex_id", "native-id", f.binding.cwd)).ok).toBe(true);
    await f.execute(f.commands[0]!);
  });
  it("managed Claude has the same public-channel override defect, without changing its bound native environment", async () => {
    const f = fixture(); await f.serve();
    const db = new Database(":memory:"); cleanup.push(() => { db.close(); });
    db.exec("CREATE TABLE nodes(id TEXT,runtime TEXT,cwd TEXT); CREATE TABLE bindings(id TEXT,node_id TEXT,tmux_session TEXT,tmux_pane TEXT); CREATE TABLE occupant_tenures(node_id TEXT,generation_uuid TEXT,generation_ordinal INTEGER)");
    db.prepare("INSERT INTO nodes VALUES ('node-current','claude-code',?)").run(f.binding.cwd);
    db.exec("INSERT INTO bindings VALUES ('b','node-current','seat@rig','%1'); INSERT INTO occupant_tenures VALUES ('node-current','current-generation',1)");
    // Include the same user-tool dir in the existing managed PATH; managed PATH/HOME stay bound.
    f.env.PATH += ":" + path.join(f.root, "user-bin");
    const managed = new ClaudeManagedLaunch(db, f.env, {});
    const prepared = await managed.prepare({ nodeId: "node-current", session: "seat@rig", pane: "%1" }, "auto");
    const observed = await f.execute(prepared.command(["--permission-mode", "auto"]), true);
    expect(observed.HOME).toBe(f.env.HOME); expect(observed.PATH).toBe(f.env.PATH);
    expect(observed.generation).toBe("current-generation");
  });
  it("managed Claude keeps a non-public URL on its inherited channel without changing the native context", async () => {
    const f = fixture();
    f.env.OPENRIG_URL = "http://user:synthetic-private-value@localhost:7433";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = new Database(":memory:"); cleanup.push(() => { db.close(); });
    db.exec("CREATE TABLE nodes(id TEXT,runtime TEXT,cwd TEXT); CREATE TABLE bindings(id TEXT,node_id TEXT,tmux_session TEXT,tmux_pane TEXT); CREATE TABLE occupant_tenures(node_id TEXT,generation_uuid TEXT,generation_ordinal INTEGER)");
    db.prepare("INSERT INTO nodes VALUES ('node-current','claude-code',?)").run(f.binding.cwd);
    db.exec("INSERT INTO bindings VALUES ('b','node-current','seat@rig','%1'); INSERT INTO occupant_tenures VALUES ('node-current','current-generation',1)");
    const prepared = await new ClaudeManagedLaunch(db, f.env, {}).prepare({ nodeId: "node-current", session: "seat@rig", pane: "%1" }, "auto");
    const command = prepared.command(["--permission-mode", "auto"]);
    expect(command).not.toContain(f.env.OPENRIG_URL);
    expect(command).toContain('"OPENRIG_URL=${OPENRIG_URL-}"');
    expect(command).toContain(shellQuote(`HOME=${f.env.HOME}`));
    expect(command).toContain(shellQuote(`PATH=${f.env.PATH}`));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("synthetic-private-value");
  });
  it("same-pane successor reasserts its reserved generation, not tmux's predecessor environment", async () => {
    const f = fixture(); await f.serve(); f.identity.OPENRIG_OCCUPANT_GENERATION = "predecessor-generation"; f.identity.OPENRIG_RUNTIME = "codex";
    const adapter = new ClaudeCodeAdapter({ tmux: f.tmux, fsOps: f.fsOps, seatLaunchEnvironment: f.launch });
    expect((await adapter.launchHarness({ ...f.binding, launchGeneration: "successor-generation" }, { name: "seat" })).ok).toBe(true);
    expect((await f.execute(f.commands[0]!)).runtime).toBe("claude-code");
    expect(await f.launch.command("seat@rig", "claude", { nodeId: "different-node" })).toBe("claude");
  });
  it("preserves the previous command if the metadata transport is unavailable", async () => {
    const f = fixture(); vi.spyOn(f.tmux, "getSessionEnv").mockRejectedValue(Error("unavailable"));
    expect(await f.launch.command("seat@rig", "claude")).toBe("claude");
    expect(f.commands).toEqual([]);
  });
  it("explicit allowlist never types unknown secrets or runtime/user variables", () => {
    expect(publicSeatEnvironment({ OPENRIG_HOME: "/instance", OPENRIG_URL: "http://127.0.0.1:1234", OPENRIG_NEW_SECRET: "secret", OPENRIG_ACTIVITY_HOOK_TOKEN: "token", ANTHROPIC_API_KEY: "key", HOME: "/home", CLAUDE_CONFIG_DIR: "/claude", CODEX_HOME: "/codex" })).toEqual({ OPENRIG_HOME: "/instance", OPENRIG_URL: "http://127.0.0.1:1234" });
    expect(publicSeatEnvironment({ OPENRIG_URL: "http://user:secret@127.0.0.1" })).toEqual({});
  });
});
