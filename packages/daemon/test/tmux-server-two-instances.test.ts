import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CONTROL_OPTION, supportsControlMode } from "../src/adapters/tmux-control.js";
import type { TmuxServerSelection } from "../src/domain/tmux-server-selection.js";
import { prepareHermeticEnv, type HermeticScaffold } from "./helpers/hermetic-env.js";
import { runRig, spawnScenarioDaemon, type ScenarioDaemon } from "./helpers/scenario-daemon.js";
import { stageTopologyRoot } from "./helpers/scenario-stage.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RIG_BIN = resolve(HERE, "../../cli/dist/bin-wrapper.js");
const SEAT = "dev-worker@scn-baton";
const PERSONAL = "PERSONAL_NAMESAKE";
const nativeAvailable = process.platform !== "win32" && (() => {
  try { return supportsControlMode(execFileSync("tmux", ["-V"], { encoding: "utf8" })); }
  catch { return false; }
})();

interface Instance {
  scaffold: HermeticScaffold;
  daemon?: ScenarioDaemon;
  selection?: TmuxServerSelection;
}

// Two real daemons share a scratch OS home, inherited server and tmux wrapper.
// Only OPENRIG_HOME, database and port distinguish them. Scripted agents prove
// native routing and rendered delivery, not a provider's receipt of a message.
describe.skipIf(!nativeAvailable)("two isolated daemon instances with tmux control mode", () => {
  const instances: Instance[] = [];
  const sockets = new Set<string>();
  const ownedSocket = (socket: string) => {
    if (typeof socket !== "string" || !isAbsolute(socket)) throw new Error("Expected an absolute fixture tmux socket");
    let target: string;
    try { target = realpathSync(socket); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      target = join(realpathSync(dirname(socket)), basename(socket));
    }
    if (!instances.some(({ scaffold }) => {
      const root = existsSync(scaffold.root) ? realpathSync(scaffold.root) : resolve(scaffold.root);
      const within = relative(root, target);
      return within !== "" && !isAbsolute(within) && within !== ".." && !within.startsWith(`..${sep}`);
    })) throw new Error("Refusing to use a tmux socket outside these fixtures");
    return target;
  };
  const native = (socket: string, args: string[]) => execFileSync("tmux", ["-S", ownedSocket(socket), ...args], {
    encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
    env: { ...instances[0]!.scaffold.env, PATH: process.env.PATH },
  }).trim();

  afterEach(async () => {
    const failures: unknown[] = [];
    // Also stop a daemon whose start timed out before the helper returned its
    // handle: the CLI resolves only this scaffold's own daemon record.
    for (const { scaffold } of instances) {
      try {
        const stopped = await runRig(["daemon", "stop"], scaffold.env, RIG_BIN, 30_000);
        if (stopped.code !== 0) throw new Error(`Fixture daemon stop failed: ${stopped.stderr}\n${stopped.stdout}`);
      }
      catch (error) { failures.push(error); }
      try {
        const record = join(scaffold.openrigHome, "tmux-server.json");
        if (existsSync(record)) sockets.add(JSON.parse(readFileSync(record, "utf8")).socketPath);
      } catch (error) { failures.push(error); }
    }
    for (const socket of sockets) {
      try {
        try { native(socket, ["kill-server"]); }
        catch (error) {
          if (!/no server running|No such file or directory|Connection refused/.test(String(error))) throw error;
        }
      } catch (error) { failures.push(error); }
    }
    for (const { scaffold } of instances) {
      try { scaffold.cleanup(); }
      catch (error) { failures.push(error); }
    }
    instances.length = 0;
    sockets.clear();
    if (failures.length) throw new AggregateError(failures, "Two-instance fixture cleanup failed");
  }, 120_000);

  it("keeps namesake seats, control clients and shutdown scoped to their own instance", async () => {
    for (let i = 0; i < 2; i++) instances.push({ scaffold: prepareHermeticEnv({ baseEnv: {
      PATH: process.env.PATH, TERM: "xterm-256color", SHELL: "/bin/sh", MOTD_SHOWN: "update-motd",
    } }) });
    const [a, b] = instances as [Instance, Instance];
    const shared = a.scaffold;
    const personal = shared.tmuxSocketPath;
    sockets.add(personal);
    native(personal, ["-f", "/dev/null", "new-session", "-d", "-s", SEAT, `printf '${PERSONAL}\\n'; sleep 600`]);
    const paneIdentity = (socket: string) => native(socket, ["display-message", "-p", "-t", `=${SEAT}:`, "#{pane_id}:#{pane_pid}"]);
    const personalPane = paneIdentity(personal);

    const rig = async (instance: Instance, args: string[], sender = false) => {
      const result = await runRig(args, { ...instance.daemon!.readEnv, ...(sender ? { OPENRIG_SESSION_NAME: SEAT } : {}) }, RIG_BIN, 120_000);
      expect(result.code, `${args.join(" ")}: ${result.stderr}\n${result.stdout}`).toBe(0);
      return result;
    };
    const inventory = async (instance: Instance) => {
      const rigs = JSON.parse((await rig(instance, ["ps", "--json"])).stdout) as Array<{ rigId: string; rigName: string }>;
      const id = rigs.find(row => row.rigName === "scn-baton")?.rigId;
      expect(id).toBeTruthy();
      const response = await fetch(`${instance.daemon!.baseUrl}/api/rigs/${id}/nodes`);
      expect(response.ok).toBe(true);
      return { id, rows: await response.json() as Array<{
        canonicalSessionName: string; tmuxServerArgs: string[]; tmuxServerMode: string; tmuxAttachCommand: string;
      }> };
    };
    const capture = async (instance: Instance) => (await rig(instance, ["capture", SEAT, "--json"])).stdout;
    const controlSessions = (socket: string) => native(socket, ["list-sessions", "-F", `#{session_name}|#{${CONTROL_OPTION}}`])
      .split("\n").filter(row => row.split("|")[1]).map(row => row.split("|")[0]!);

    for (const [index, instance] of instances.entries()) {
      const { scaffold } = instance;
      Object.assign(scaffold.env, {
        HOME: shared.home, XDG_CONFIG_HOME: shared.env.XDG_CONFIG_HOME, XDG_STATE_HOME: shared.env.XDG_STATE_HOME,
        XDG_DATA_HOME: shared.env.XDG_DATA_HOME, XDG_CACHE_HOME: shared.env.XDG_CACHE_HOME,
        PATH: shared.env.PATH, TMUX: `${personal},1,0`, TMUX_TMPDIR: shared.tmuxTmpDir,
        OPENRIG_TMUX_SERVER: "isolated", OPENRIG_TMUX_CONTROL: "1",
      });
      const staged = stageTopologyRoot(resolve(HERE, "fixtures/scenarios/topo-stub-baton.yaml"), join(scaffold.root, "topology"));
      const scriptDir = join(staged.seatCwds["dev-worker"]!, ".openrig", "stub");
      mkdirSync(scriptDir, { recursive: true });
      writeFileSync(join(scriptDir, "script.json"), JSON.stringify({ steps: [{ kind: "say", text: `INSTANCE_${index}_READY` }] }));
      try {
        instance.daemon = await spawnScenarioDaemon(scaffold, { rigBin: RIG_BIN, timeoutMs: 60_000 });
      } catch (error) {
        const log = join(scaffold.openrigHome, "daemon.log");
        const detail = existsSync(log) ? readFileSync(log, "utf8").slice(-8_000) : "No daemon log was written.";
        throw new Error(`${error instanceof Error ? error.message : String(error)}\nFixture daemon log:\n${detail}`, { cause: error });
      }
      const status = JSON.parse((await rig(instance, ["terminal", "status", "--json"])).stdout);
      instance.selection = status.tmux as TmuxServerSelection;
      expect(instance.selection).toMatchObject({ requestedMode: "isolated", mode: "isolated", migrationPending: false });
      const socket = ownedSocket(instance.selection.socketPath!);
      expect(socket).not.toBe(personal);
      sockets.add(socket);
      await rig(instance, ["up", staged.topologyPath, "--json", "--yes"]);
      expect(native(socket, ["display-message", "-p", "-t", `=${SEAT}:`, "#{socket_path}"])).toBe(socket);
      expect(native(socket, ["show-environment", "-t", `=${SEAT}`, "OPENRIG_HOME"]))
        .toBe(`OPENRIG_HOME=${realpathSync(scaffold.openrigHome)}`);
      const paneHome = native(socket, ["show-environment", "-t", `=${SEAT}`, "HOME"]);
      expect(paneHome).toMatch(/^HOME=/);
      expect(realpathSync(paneHome.slice(5))).toBe(realpathSync(shared.home));
    }

    expect(a.scaffold.openrigHome).not.toBe(b.scaffold.openrigHome);
    expect(a.daemon!.port).not.toBe(b.daemon!.port);
    expect(a.selection!.socketPath).not.toBe(b.selection!.socketPath);
    expect(existsSync(join(a.scaffold.stateDir, "scenario.db"))).toBe(true);
    expect(existsSync(join(b.scaffold.stateDir, "scenario.db"))).toBe(true);
    const [nodesA, nodesB] = await Promise.all([inventory(a), inventory(b)]);
    expect(nodesA.id).not.toBe(nodesB.id);
    for (const [instance, nodes] of [[a, nodesA], [b, nodesB]] as const) {
      expect(nodes.rows).toHaveLength(1);
      expect(nodes.rows[0]).toMatchObject({ canonicalSessionName: SEAT,
        tmuxServerArgs: instance.selection!.serverArgs, tmuxServerMode: "isolated" });
      expect(nodes.rows[0]!.tmuxAttachCommand).toContain(instance.selection!.socketPath!);
    }
    for (const [index, instance] of instances.entries()) {
      const initial = await capture(instance);
      expect(initial).toContain(`INSTANCE_${index}_READY`);
      expect(initial).not.toContain(`INSTANCE_${1 - index}_READY`);
      expect(initial).not.toContain(PERSONAL);
      const sent = JSON.parse((await rig(instance, ["send", SEAT, `INSTANCE_${index}_WRITE`, "--verify", "--json"], true)).stdout);
      expect(sent.verified).toBe(true);
    }
    for (const [index, instance] of instances.entries()) {
      const observed = await capture(instance);
      expect(observed).toContain(`INSTANCE_${index}_WRITE`);
      expect(observed).not.toContain(`INSTANCE_${1 - index}_WRITE`);
      expect(observed).not.toContain(PERSONAL);
    }
    // Setting the environment alone is not proof that the control path ran.
    const controlsA = controlSessions(a.selection!.socketPath!);
    const controlsB = controlSessions(b.selection!.socketPath!);
    expect(controlsA).toHaveLength(1);
    expect(controlsB).toHaveLength(1);
    expect(controlSessions(personal)).toEqual([]);
    const survivingPane = paneIdentity(b.selection!.socketPath!);

    await rig(a, ["down", "scn-baton", "--json", "--force", "--yes"]);
    const stopped = await runRig(["daemon", "stop"], a.scaffold.env, RIG_BIN, 30_000);
    expect(stopped.code, `${stopped.stderr}\n${stopped.stdout}`).toBe(0);
    expect(() => native(a.selection!.socketPath!, ["has-session", "-t", `=${SEAT}`])).toThrow();
    expect(paneIdentity(b.selection!.socketPath!)).toBe(survivingPane);
    expect(paneIdentity(personal)).toBe(personalPane);
    expect(controlSessions(b.selection!.socketPath!)).toEqual(controlsB);
    const afterStop = JSON.parse((await rig(b, ["send", SEAT, "INSTANCE_1_SURVIVED", "--verify", "--json"], true)).stdout);
    expect(afterStop.verified).toBe(true);
    expect(await capture(b)).toContain("INSTANCE_1_SURVIVED");
    const personalCapture = native(personal, ["capture-pane", "-p", "-t", `=${SEAT}:`]);
    expect(personalCapture).toContain(PERSONAL);
    expect(personalCapture).not.toContain("INSTANCE_");
  }, 360_000);
});
