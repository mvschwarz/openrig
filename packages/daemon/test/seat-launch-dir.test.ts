import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFullTestDb } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { EventBus } from "../src/domain/event-bus.js";
import { NodeLauncher } from "../src/domain/node-launcher.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { shellQuote } from "../src/adapters/shell-quote.js";
import { ClaudeManagedLaunch } from "../src/domain/claude-managed-launch.js";
import { SEAT_LAUNCH_DIR_ENV, SeatLaunchEnvironment, launchDirEnv } from "../src/domain/seat-launch-environment.js";
import { SEAT_ENV_KEYS_VAR } from "../src/domain/seat-env.js";
import { SEAT_PROJECT_DIR_ENV } from "../src/domain/claude-core-plugin-env.js";

// #3328: OPENRIG_SEAT_LAUNCH_DIR is the absolute folder a seat's launch started it in, for every seat OpenRig launches
// (Claude Code and Codex, with or without the openrig-core plugin), so a seat-scoped tool such as a stdio MCP server can
// find its seat's folder without guessing from its own current directory. These tests start real seats on a private tmux
// server and read the variable back from the agent process's children.

/** A scratch plugins folder with the openrig-core manifest in it, as the daemon's vendoring leaves it. */
function vendoredPlugins(root: string): { pluginsDir: string; vendored: string } {
  const pluginsDir = join(root, "plugins");
  const vendored = join(pluginsDir, "openrig-core");
  mkdirSync(join(vendored, ".claude-plugin"), { recursive: true });
  writeFileSync(join(vendored, ".claude-plugin", "plugin.json"), "{}");
  return { pluginsDir, vendored };
}

/** A fake agent: records the variables it was given, the folder it started in, and what a child that changes
 *  directory first still sees (as a stdio MCP server would), then exits. Its last argument is the result file. */
const FAKE_AGENT = `#!/bin/sh
for out; do :; done
child=$(cd / && /bin/sh -c 'printf "%s|%s" "$(pwd)" "\${OPENRIG_SEAT_LAUNCH_DIR-absent}"')
printf '{"launch":"%s","project":"%s","pwd":"%s","child":"%s"}' "\${OPENRIG_SEAT_LAUNCH_DIR-absent}" "\${OPENRIG_SEAT_PROJECT_DIR-absent}" "$(pwd)" "$child" > "$out.part"
mv "$out.part" "$out"
`;

type Seen = { launch: string; project: string; pwd: string; child: string };

describe.skipIf(process.platform === "win32")("OPENRIG_SEAT_LAUNCH_DIR on real seats (private tmux server)", () => {
  const pexec = promisify(execFile);
  // tmux as the caller's PATH finds it; its folder stays on the private server's PATH (e.g. /opt/homebrew/bin).
  const tmuxBin = (() => { try { return execFileSync("sh", ["-c", "command -v tmux"], { encoding: "utf8" }).trim() || null; } catch { return null; } })();
  const available = tmuxBin !== null;
  // A path with a space in it, under a real (not symlinked) temp folder so `pwd` reads it back unchanged.
  const root = join(realpathSync(mkdtempSync(join(tmpdir(), "launch-dir-"))), "with space");
  const socket = join(root, "tmux.sock");
  const bin = join(root, "bin");
  const state = join(root, "state");
  const home = join(root, "home");
  // The tmux server under test must not inherit this run's own seat variables or a parent tmux.
  const serverEnv: NodeJS.ProcessEnv = { PATH: [bin, ...(tmuxBin ? [dirname(tmuxBin)] : []), "/usr/bin", "/bin"].join(":"), HOME: home, SHELL: "/bin/sh", TERM: "xterm" };
  const tmux = async (args: string[]) => (await pexec("tmux", ["-S", socket, "-f", "/dev/null", ...args], { env: serverEnv })).stdout;
  const shellExec = async (cmd: string) => {
    if (!cmd.startsWith("tmux ")) throw new Error(`unexpected command ${cmd}`);
    return (await pexec("sh", ["-c", `tmux -S ${shellQuote(socket)} -f /dev/null ${cmd.slice(5)}`], { env: serverEnv })).stdout;
  };
  const dbs: ReturnType<typeof createFullTestDb>[] = [];
  let counter = 0;

  beforeAll(async () => {
    for (const dir of [bin, state, home]) mkdirSync(dir, { recursive: true });
    for (const name of ["claude", "codex"]) { writeFileSync(join(bin, name), FAKE_AGENT); chmodSync(join(bin, name), 0o755); }
    if (available) await tmux(["new-session", "-d", "-s", "anchor", "sleep 600"]);
  });
  afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
  afterAll(async () => {
    await tmux(["kill-server"]).catch(() => {});
    rmSync(join(root, ".."), { recursive: true, force: true });
  });

  /** The daemon's adapter on the private server, with the default launch policy (a scoped `env -i` pane). */
  function adapter(inheritTmuxEnvironment = false): TmuxAdapter {
    const a = new TmuxAdapter(shellExec);
    a.launchEnvironment = () => ({ inheritTmuxEnvironment, env: {} });
    return a;
  }

  /** Launch one seat through NodeLauncher, then start its agent in the pane through the seat launch environment's
   *  ordinary (classic) command for its runtime, and read back what the agent and its child saw. */
  async function launchSeat(opts: { runtime: "claude-code" | "codex"; cwd?: string; selectsCore?: boolean; launchCwd?: string;
    tmuxAdapter?: TmuxAdapter }): Promise<Seen> {
    const { pluginsDir, vendored } = vendoredPlugins(root);
    const db = createFullTestDb(); dbs.push(db);
    const rigRepo = new RigRepository(db);
    const id = `r${++counter}`;
    const rig = rigRepo.createRig(`launch-dir-${id}`);
    rigRepo.addNode(rig.id, "dev.impl", { runtime: opts.runtime, ...(opts.cwd ? { cwd: opts.cwd } : {}) });
    const tmuxAdapter = opts.tmuxAdapter ?? adapter();
    const sessionEnv = { OPENRIG_HOME: state, PATH: `${bin}:/usr/bin:/bin`, HOME: home };
    const launcher = new NodeLauncher({ db, rigRepo, sessionRegistry: new SessionRegistry(db), eventBus: new EventBus(db),
      tmuxAdapter, sessionEnv, pluginsDir });
    const session = `dev-impl@launch-dir-${id}`;
    const launched = await launcher.launchNode(rig.id, "dev.impl", { sessionName: session, pluginPaths: opts.selectsCore ? [vendored] : [],
      ...(opts.launchCwd ? { cwd: opts.launchCwd } : {}) });
    expect(launched.ok, JSON.stringify(launched)).toBe(true);
    const node = rigRepo.getRig(rig.id)!.nodes[0]!;
    const out = join(root, `${id}.json`);
    const seatLaunch = new SeatLaunchEnvironment(tmuxAdapter, sessionEnv, root, join(bin, "claude"));
    const command = await seatLaunch.command(session, `${opts.runtime === "codex" ? "codex" : "claude"} --probe ${shellQuote(out)}`,
      { nodeId: node.id, runtime: opts.runtime, ...(opts.runtime === "codex" ? { codexCwd: node.cwd ?? root } : {}) });
    // Staged and sourced in a pane-shell subshell, as the runtime adapters run it.
    const staged = join(root, `${id}.sh`);
    writeFileSync(staged, `${command}\n`);
    await tmux(["send-keys", "-t", `=${session}:`, "-l", "--", `( . ${shellQuote(staged)} )`]);
    await tmux(["send-keys", "-t", `=${session}:`, "Enter"]);
    for (let i = 0; i < 100 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 100));
    expect(existsSync(out), `no result from the ${opts.runtime} agent; pane:\n${await tmux(["capture-pane", "-p", "-t", `=${session}:`]).catch(() => "")}`).toBe(true);
    return JSON.parse(readFileSync(out, "utf8")) as Seen;
  }

  const seatFolder = (name: string) => { const dir = join(root, "seats", name); mkdirSync(dir, { recursive: true }); return dir; };

  it.runIf(available)("every Claude Code and Codex seat gets its launch folder, with and without openrig-core, and a child keeps it after cd", async () => {
    for (const runtime of ["claude-code", "codex"] as const) {
      for (const selectsCore of [true, false]) {
        const cwd = seatFolder(`${runtime}-${selectsCore ? "core" : "plain"}`); // contains a space: ".../with space/seats/..."
        const seen = await launchSeat({ runtime, cwd, selectsCore });
        const label = `${runtime} core=${selectsCore}`;
        expect(seen.launch, label).toBe(cwd);
        expect(seen.pwd, label).toBe(cwd); // the folder the agent actually started in
        expect(seen.child, label).toBe(`/|${cwd}`); // a child that changed directory keeps the launch value
        // OPENRIG_SEAT_PROJECT_DIR stays tied to the plugin, as before.
        expect(seen.project, label).toBe(selectsCore ? cwd : "absent");
      }
    }
  }, 120_000);

  it.runIf(available)("a seat in a git worktree gets the worktree's folder, not the main checkout's root", async () => {
    const repo = seatFolder("repo");
    const git = (args: string[], cwd = repo) => execFileSync("git", args, { cwd, env: { ...serverEnv, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" }, stdio: "ignore" });
    git(["init", "-q"]); git(["commit", "-q", "--allow-empty", "-m", "init"]);
    const worktree = join(root, "seats", "wt for seat");
    git(["worktree", "add", "-q", "--detach", worktree]);
    for (const runtime of ["claude-code", "codex"] as const) {
      const seen = await launchSeat({ runtime, cwd: worktree });
      expect(seen.launch, runtime).toBe(worktree);
      expect(seen.launch, runtime).not.toBe(repo);
    }
  }, 60_000);

  it.runIf(available)("a launch given another folder (a restore's --cwd) carries that folder, not the saved one", async () => {
    const saved = seatFolder("saved");
    const chosen = seatFolder("chosen");
    const seen = await launchSeat({ runtime: "codex", cwd: saved, launchCwd: chosen });
    expect(seen.launch).toBe(chosen);
    expect(seen.pwd).toBe(chosen);
  }, 60_000);

  it.runIf(available)("a seat started in A, handed over into B, then restarted directly, runs in B and sees B", async () => {
    const a = seatFolder("restart A"), b = seatFolder("restart B");
    const db = createFullTestDb(); dbs.push(db);
    const rigRepo = new RigRepository(db);
    const rig = rigRepo.createRig(`launch-dir-restart-${++counter}`);
    rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex", cwd: a });
    const tmuxAdapter = adapter();
    const sessionEnv = { OPENRIG_HOME: state, PATH: `${bin}:/usr/bin:/bin`, HOME: home };
    const launcher = new NodeLauncher({ db, rigRepo, sessionRegistry: new SessionRegistry(db), eventBus: new EventBus(db), tmuxAdapter, sessionEnv });
    const session = `dev-impl@launch-dir-restart-${counter}`;
    expect((await launcher.launchNode(rig.id, "dev.impl", { sessionName: session })).ok).toBe(true);
    const node = rigRepo.getRig(rig.id)!.nodes[0]!;
    const pane = (await tmux(["list-panes", "-t", `=${session}:`, "-F", "#{pane_id}"])).trim();
    // Each step's process records what it saw and exits; the pane stays (as a restart holds it) for the next respawn.
    await tmux(["set-option", "-p", "-t", pane, "remain-on-exit", "on"]);
    const record = join(root, "record.sh");
    writeFileSync(record, `printf '%s|%s' "\${OPENRIG_SEAT_LAUNCH_DIR-absent}" "$(pwd)" > "$1.part" && mv "$1.part" "$1"\n`);
    const dead = async () => { for (let i = 0; i < 100; i++) { if ((await tmux(["display-message", "-p", "-t", pane, "#{pane_dead}"])).trim() === "1") return; await new Promise((r) => setTimeout(r, 50)); } throw new Error("pane still alive"); };
    const run = async (name: string, respawn: (command: string) => Promise<{ ok: boolean }>) => {
      await dead();
      const out = join(root, `restart-${counter}-${name}.txt`);
      const result = await respawn(`/bin/sh ${shellQuote(record)} ${shellQuote(out)}`);
      expect(result.ok, `${name}: ${JSON.stringify(result)}`).toBe(true);
      for (let i = 0; i < 100 && !existsSync(out); i++) await new Promise((r) => setTimeout(r, 50));
      return readFileSync(out, "utf8");
    };
    await tmux(["send-keys", "-t", pane, "exit", "Enter"]);
    // The handover respawns the pane into B with the seat's environment, as successor-session-launcher.ts does.
    const handedOver = await run("handover", (command) => tmuxAdapter.respawnPane(pane, command, { cwd: b,
      env: { OPENRIG_NODE_ID: node.id, OPENRIG_SESSION_NAME: session, ...launchDirEnv(b) }, processLimitsMode: "recovery" }));
    expect(handedOver).toBe(`${b}|${b}`);
    // The tmux session's own copy is still the first launch's, and a bare respawn would start from it.
    expect((await tmux(["show-environment", "-t", `=${session}`, SEAT_LAUNCH_DIR_ENV])).trim()).toBe(`${SEAT_LAUNCH_DIR_ENV}=${a}`);
    expect(await run("bare", (command) => tmuxAdapter.respawnPane(pane, command, { cwd: b }))).toBe(`${a}|${b}`);
    // The direct restart's respawn (seat-restart-in-place.ts) carries B. This seat has no limit, so with keepLimitOf set it
    // takes the same bare path; the kept-scope command is checked in tmux-seat-process-limits.test.ts.
    for (const keep of [false, true]) {
      const seen = await run(`restart-keep-${keep}`, (command) => tmuxAdapter.respawnPane(pane, command,
        { cwd: b, launchEnv: launchDirEnv(b), ...(keep ? { keepLimitOf: node.id, processLimitsMode: "recovery" as const } : {}) }));
      expect(seen, `keep=${keep}`).toBe(`${b}|${b}`);
    }
  }, 60_000);

  it.runIf(available)("a seat launched without a folder doesn't get the variable, even when the tmux server holds one", async () => {
    await tmux(["set-environment", "-g", SEAT_LAUNCH_DIR_ENV, "/stale/from/the/server"]);
    try {
      const seen = await launchSeat({ runtime: "claude-code" });
      expect(seen.launch).toBe("absent");
    } finally {
      await tmux(["set-environment", "-g", "-u", SEAT_LAUNCH_DIR_ENV]);
    }
  }, 60_000);

  it.runIf(available)("with terminal.inherit_tmux_environment on, a seat's own folder still wins over the server's copy", async () => {
    await tmux(["set-environment", "-g", SEAT_LAUNCH_DIR_ENV, "/stale/from/the/server"]);
    try {
      const cwd = seatFolder("inherit");
      const seen = await launchSeat({ runtime: "claude-code", cwd, tmuxAdapter: adapter(true) });
      expect(seen.launch).toBe(cwd);
    } finally {
      await tmux(["set-environment", "-g", "-u", SEAT_LAUNCH_DIR_ENV]);
    }
  }, 60_000);
});

describe("launchDirEnv", () => {
  it("names an absolute folder exactly as given, and nothing for a relative or missing one", () => {
    expect(launchDirEnv("/work/with space/seat")).toEqual({ [SEAT_LAUNCH_DIR_ENV]: "/work/with space/seat" });
    expect(launchDirEnv("/work/seat/")).toEqual({ [SEAT_LAUNCH_DIR_ENV]: "/work/seat/" });
    for (const cwd of ["relative/seat", ".", "", null, undefined]) expect(launchDirEnv(cwd)).toEqual({});
  });
});

// A Claude seat with a permission mode starts through ClaudeManagedLaunch: `cd <seat folder> && { …; exec env … claude }`
// after clearing the environment. The launch dir is exported explicitly as the folder it cds into, so it is right even
// when the pane holds another value. These run the command in a real shell with a fake claude.
describe.skipIf(process.platform === "win32")("the managed (env -i) Claude launch", () => {
  const exec = promisify(execFile);
  const cleanup: Array<() => void> = [];
  afterEach(() => { for (const f of cleanup.splice(0)) f(); });

  function fixture(selectsCore: boolean) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "managed-launch-dir-")));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const bin = join(root, "bin"), home = join(root, "home"), cwd = join(root, "seat with space");
    for (const dir of [bin, home, cwd]) mkdirSync(dir);
    writeFileSync(join(bin, "claude"), `#!/bin/sh
if [ "$1" = --help ]; then printf '%s\\n' '--permission-mode <mode> (choices: "auto", "default")'; exit 0; fi
child=$(cd / && /bin/sh -c 'printf %s "\${OPENRIG_SEAT_LAUNCH_DIR-absent}"')
printf '{"launch":"%s","project":"%s","pwd":"%s","child":"%s"}' "\${OPENRIG_SEAT_LAUNCH_DIR-absent}" "\${OPENRIG_SEAT_PROJECT_DIR-absent}" "$(pwd)" "$child"
`);
    chmodSync(join(bin, "claude"), 0o700);
    const db = new Database(":memory:"); cleanup.push(() => { db.close(); });
    db.exec(`CREATE TABLE rigs(id TEXT, env_json TEXT);
      CREATE TABLE nodes(id TEXT, rig_id TEXT, logical_id TEXT, runtime TEXT, cwd TEXT, env_json TEXT);
      CREATE TABLE bindings(id TEXT, node_id TEXT, tmux_session TEXT, tmux_pane TEXT);
      CREATE TABLE occupant_tenures(node_id TEXT, generation_uuid TEXT, generation_ordinal INTEGER);
      CREATE TABLE node_startup_context(node_id TEXT, projection_entries_json TEXT);`);
    const { pluginsDir, vendored } = vendoredPlugins(root);
    if (selectsCore) db.prepare("INSERT INTO node_startup_context VALUES ('node', ?)").run(JSON.stringify([{ category: "plugin", absolutePath: vendored }]));
    db.prepare("INSERT INTO rigs VALUES ('rig', NULL)").run();
    db.prepare("INSERT INTO nodes VALUES ('node', 'rig', 'dev.impl', 'claude-code', ?, NULL)").run(cwd);
    db.exec("INSERT INTO bindings VALUES ('b', 'node', 'seat@rig', '%1'); INSERT INTO occupant_tenures VALUES ('node', 'gen', 1)");
    const managed = new ClaudeManagedLaunch(db, { PATH: `${bin}:/usr/bin:/bin`, HOME: home }, {},
      async (_session, key) => key === SEAT_ENV_KEYS_VAR ? undefined : undefined, pluginsDir);
    const run = async (paneEnv: Record<string, string>) => {
      const command = (await managed.prepare({ nodeId: "node", session: "seat@rig", pane: "%1" }, "auto")).command(["--permission-mode", "auto"]);
      // The pane shell starts somewhere else; the launch cds into the seat folder itself.
      const { stdout } = await exec("/bin/sh", ["-c", command], { cwd: home, env: { PATH: "/usr/bin:/bin", ...paneEnv }, timeout: 5000 });
      return JSON.parse(stdout) as Seen;
    };
    return { run, cwd };
  }

  it("exports the folder it starts Claude in, with and without openrig-core, and a child keeps it after cd", async () => {
    for (const selectsCore of [true, false]) {
      const f = fixture(selectsCore);
      const seen = await f.run(selectsCore ? { [SEAT_PROJECT_DIR_ENV]: f.cwd, [SEAT_LAUNCH_DIR_ENV]: f.cwd } : { [SEAT_LAUNCH_DIR_ENV]: f.cwd });
      expect(seen, `core=${selectsCore}`).toEqual({ launch: f.cwd, project: selectsCore ? f.cwd : "absent", pwd: f.cwd, child: f.cwd });
    }
  });

  it("uses its own folder over whatever the pane holds, and sets it when the pane has none", async () => {
    const f = fixture(false);
    expect((await f.run({ [SEAT_LAUNCH_DIR_ENV]: "/somewhere/else" })).launch).toBe(f.cwd);
    expect((await f.run({})).launch).toBe(f.cwd);
  });
});
