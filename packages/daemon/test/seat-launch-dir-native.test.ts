import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import { ClaudeManagedLaunch } from "../src/domain/claude-managed-launch.js";
import { SeatLaunchEnvironment } from "../src/domain/seat-launch-environment.js";
import { SEAT_ENV_KEYS_VAR } from "../src/domain/seat-env.js";

// #3328 with the real Claude Code binary. Opt-in: OPENRIG_REAL_CLAUDE_BIN=/path/to/claude (the hermetic setup puts a
// stub `claude` first on PATH, so the real one is named explicitly). No login and no model call: `claude mcp list`
// starts each configured stdio MCP server to check it, which is enough to see what such a server inherits. The probe
// server records its environment, changes directory, records again and exits; Claude then reports it as failed to
// connect, which doesn't matter here.
const realClaude = process.env["OPENRIG_REAL_CLAUDE_BIN"];

const PROBE = `#!/bin/sh
out="$1"
printf '%s|%s|%s\\n' "$(pwd)" "\${OPENRIG_SEAT_LAUNCH_DIR-absent}" "\${OPENRIG_SEAT_PROJECT_DIR-absent}" >> "$out"
cd /
printf '%s|%s|%s\\n' "$(pwd)" "\${OPENRIG_SEAT_LAUNCH_DIR-absent}" "\${OPENRIG_SEAT_PROJECT_DIR-absent}" >> "$out"
`;

describe.skipIf(!realClaude || process.platform === "win32")("OPENRIG_SEAT_LAUNCH_DIR reaches a real Claude Code's stdio MCP server", () => {
  const pexec = promisify(execFile);
  const root = join(realpathSync(mkdtempSync(join(tmpdir(), "launch-dir-native-"))), "with space");
  const socket = join(root, "tmux.sock");
  const bin = join(root, "bin");
  const state = join(root, "state");
  const home = join(root, "home");
  const probe = join(root, "probe.sh");
  const serverEnv: NodeJS.ProcessEnv = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, SHELL: "/bin/sh", TERM: "xterm" };
  const tmux = async (args: string[]) => (await pexec("tmux", ["-S", socket, "-f", "/dev/null", ...args], { env: serverEnv })).stdout;
  const shellExec = async (cmd: string) => {
    if (!cmd.startsWith("tmux ")) throw new Error(`unexpected command ${cmd}`);
    return (await pexec("sh", ["-c", `tmux -S ${shellQuote(socket)} -f /dev/null ${cmd.slice(5)}`], { env: serverEnv })).stdout;
  };
  const dbs: Array<{ close(): void }> = [];
  let worktree = "";
  let counter = 0;

  beforeAll(async () => {
    for (const dir of [bin, state, home]) mkdirSync(dir, { recursive: true });
    symlinkSync(realClaude!, join(bin, "claude"));
    writeFileSync(probe, PROBE); chmodSync(probe, 0o755);
    // The seat folder is a git worktree whose path contains a space.
    const repo = join(root, "repo");
    mkdirSync(repo);
    const git = (args: string[]) => execFileSync("git", args, { cwd: repo, env: { ...serverEnv, GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" }, stdio: "ignore" });
    git(["init", "-q"]); git(["commit", "-q", "--allow-empty", "-m", "init"]);
    worktree = join(root, "wt for seat");
    git(["worktree", "add", "-q", "--detach", worktree]);
    await tmux(["new-session", "-d", "-s", "anchor", "sleep 600"]);
  });
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
  afterAll(async () => {
    await tmux(["kill-server"]).catch(() => {});
    rmSync(join(root, ".."), { recursive: true, force: true });
  });

  /** A user-scope MCP server entry for the probe, in the seat's (fixture) HOME, writing to `out`. */
  function configureProbe(out: string): void {
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { probe: { type: "stdio", command: probe, args: [out], env: {} } } }));
  }

  function vendoredPlugins(): { pluginsDir: string; vendored: string } {
    const pluginsDir = join(root, "plugins");
    const vendored = join(pluginsDir, "openrig-core");
    mkdirSync(join(vendored, ".claude-plugin"), { recursive: true });
    writeFileSync(join(vendored, ".claude-plugin", "plugin.json"), "{}");
    return { pluginsDir, vendored };
  }

  async function probeLines(out: string, where: () => Promise<string>): Promise<string[]> {
    for (let i = 0; i < 600 && !(existsSync(out) && readFileSync(out, "utf8").split("\n").filter(Boolean).length >= 2); i++) await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(out), `the probe MCP server never ran; ${await where()}`).toBe(true);
    return readFileSync(out, "utf8").split("\n").filter(Boolean).slice(0, 2);
  }

  it("classic launch: a seat started by NodeLauncher runs real claude, whose MCP server gets the launch folder, with and without openrig-core", async () => {
    for (const selectsCore of [true, false]) {
      const { pluginsDir, vendored } = vendoredPlugins();
      const db = createFullTestDb(); dbs.push(db);
      const rigRepo = new RigRepository(db);
      const id = `c${++counter}`;
      const rig = rigRepo.createRig(`launch-dir-native-${id}`);
      rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code", cwd: worktree });
      const tmuxAdapter = new TmuxAdapter(shellExec);
      tmuxAdapter.launchEnvironment = () => ({ inheritTmuxEnvironment: false, env: {} });
      const sessionEnv = { OPENRIG_HOME: state, PATH: `${bin}:/usr/bin:/bin`, HOME: home };
      const launcher = new NodeLauncher({ db, rigRepo, sessionRegistry: new SessionRegistry(db), eventBus: new EventBus(db), tmuxAdapter, sessionEnv, pluginsDir });
      const session = `dev-impl@launch-dir-native-${id}`;
      const launched = await launcher.launchNode(rig.id, "dev.impl", { sessionName: session, pluginPaths: selectsCore ? [vendored] : [] });
      expect(launched.ok, JSON.stringify(launched)).toBe(true);
      const node = rigRepo.getRig(rig.id)!.nodes[0]!;
      const out = join(root, `${id}.txt`);
      configureProbe(out);
      const command = await new SeatLaunchEnvironment(tmuxAdapter, sessionEnv, root, join(bin, "claude"))
        .command(session, "claude mcp list", { nodeId: node.id, runtime: "claude-code" });
      const staged = join(root, `${id}.sh`);
      writeFileSync(staged, `${command}\n`);
      await tmux(["send-keys", "-t", `=${session}:`, "-l", "--", `( . ${shellQuote(staged)} )`]);
      await tmux(["send-keys", "-t", `=${session}:`, "Enter"]);
      const lines = await probeLines(out, async () => `pane:\n${await tmux(["capture-pane", "-p", "-t", `=${session}:`]).catch(() => "")}`);
      const project = selectsCore ? worktree : "absent";
      expect(lines, `core=${selectsCore}`).toEqual([`${worktree}|${worktree}|${project}`, `/|${worktree}|${project}`]);
    }
  }, 180_000);

  it("managed launch (permission mode, env -i): real claude's MCP server gets the folder the launch cds into, even when the pane holds another", async () => {
    for (const selectsCore of [true, false]) {
      const { pluginsDir, vendored } = vendoredPlugins();
      const db = new Database(":memory:"); dbs.push(db);
      db.exec(`CREATE TABLE rigs(id TEXT, env_json TEXT);
        CREATE TABLE nodes(id TEXT, rig_id TEXT, logical_id TEXT, runtime TEXT, cwd TEXT, env_json TEXT);
        CREATE TABLE bindings(id TEXT, node_id TEXT, tmux_session TEXT, tmux_pane TEXT);
        CREATE TABLE occupant_tenures(node_id TEXT, generation_uuid TEXT, generation_ordinal INTEGER);
        CREATE TABLE node_startup_context(node_id TEXT, projection_entries_json TEXT);`);
      if (selectsCore) db.prepare("INSERT INTO node_startup_context VALUES ('node', ?)").run(JSON.stringify([{ category: "plugin", absolutePath: vendored }]));
      db.prepare("INSERT INTO rigs VALUES ('rig', NULL)").run();
      db.prepare("INSERT INTO nodes VALUES ('node', 'rig', 'dev.impl', 'claude-code', ?, NULL)").run(worktree);
      db.exec("INSERT INTO bindings VALUES ('b', 'node', 'seat@rig', '%1'); INSERT INTO occupant_tenures VALUES ('node', 'gen', 1)");
      const managed = new ClaudeManagedLaunch(db, { PATH: `${bin}:/usr/bin:/bin`, HOME: home }, {},
        async (_session, key) => key === SEAT_ENV_KEYS_VAR ? undefined : undefined, pluginsDir);
      const out = join(root, `m${++counter}.txt`);
      configureProbe(out);
      const command = (await managed.prepare({ nodeId: "node", session: "seat@rig", pane: "%1" }, "manual")).command(["mcp", "list"]);
      // The pane shell starts elsewhere and holds a different launch value; the launch cds into the seat folder itself.
      // A plugin seat's pane holds OPENRIG_SEAT_PROJECT_DIR from its terminal launch, which the managed launch passes on.
      const paneEnv: Record<string, string> = { PATH: "/usr/bin:/bin", HOME: home, OPENRIG_SEAT_LAUNCH_DIR: "/somewhere/else",
        ...(selectsCore ? { OPENRIG_SEAT_PROJECT_DIR: worktree } : {}) };
      await pexec("/bin/sh", ["-c", command], { cwd: home, env: paneEnv, timeout: 120_000 })
        .catch((e: { stdout?: string; stderr?: string }) => e);
      const lines = await probeLines(out, async () => `command:\n${command}`);
      const project = selectsCore ? worktree : "absent";
      expect(lines, `core=${selectsCore}`).toEqual([`${worktree}|${worktree}|${project}`, `/|${worktree}|${project}`]);
    }
  }, 300_000);
});
