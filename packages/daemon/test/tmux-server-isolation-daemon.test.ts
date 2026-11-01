import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { prepareHermeticEnv, type HermeticScaffold } from "./helpers/hermetic-env.js";
import { runRig, spawnScenarioDaemon, type ScenarioDaemon } from "./helpers/scenario-daemon.js";
import { stageTopologyRoot } from "./helpers/scenario-stage.js";
import type { TmuxServerSelection } from "../src/domain/tmux-server-selection.js";

// The scenario grammar has no config-write or socket-inventory surface. Use its
// normal scaffold, daemon lifecycle, topology staging and stub seat, with native
// observations around real CLI commands. No model or desktop provider is used.
const HERE = dirname(fileURLToPath(import.meta.url));
const RIG_BIN = resolve(HERE, "../../cli/dist/bin-wrapper.js");
const SEAT = "dev-worker@scn-baton";
const nativeAvailable = process.platform !== "win32" && (() => {
  try { execFileSync("tmux", ["-V"], { stdio: "ignore" }); return true; }
  catch { return false; }
})();

describe.skipIf(!nativeAvailable)("daemon tmux server selection with a real stub seat", () => {
  let scaffold: HermeticScaffold | undefined;
  let daemon: ScenarioDaemon | undefined;
  const sockets = new Set<string>();
  const native = (socket: string, args: string[]) => execFileSync("tmux", ["-S", socket, ...args], {
    encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"],
    env: { ...scaffold!.env, PATH: process.env.PATH },
  }).trim();

  afterEach(async () => {
    await daemon?.sigterm();
    if (scaffold) {
      // Even a startup/assertion failure must clean up an owned dedicated socket.
      const record = join(scaffold.openrigHome, "tmux-server.json");
      if (existsSync(record)) sockets.add(JSON.parse(readFileSync(record, "utf8")).socketPath);
      const root = realpathSync(scaffold.root);
      for (const socket of sockets) {
        const within = relative(root, socket);
        if (isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`)) {
          throw new Error("Refusing to clean up a tmux socket outside this fixture");
        }
        try { native(socket, ["kill-server"]); } catch { /* Already stopped is normal. */ }
      }
      scaffold.cleanup();
    }
    sockets.clear();
    scaffold = undefined;
    daemon = undefined;
  });

  it("retains live legacy seats, migrates after down, and routes later reads, attachments and destruction to the selected server", async () => {
    scaffold = prepareHermeticEnv({ baseEnv: {
      HOME: process.env.HOME, PATH: process.env.PATH, TERM: "xterm-256color", SHELL: "/bin/sh", MOTD_SHOWN: "update-motd",
    } });
    native(scaffold.tmuxSocketPath, ["-f", "/dev/null", "new-session", "-d", "-s", "personal", "sleep 600"]);
    const personal = realpathSync(scaffold.tmuxSocketPath);
    sockets.add(personal);
    writeFileSync(join(scaffold.home, ".tmux.conf"), "set-option -g @openrig-isolation-fixture loaded\n");
    const staged = stageTopologyRoot(resolve(HERE, "fixtures/scenarios/topo-stub-baton.yaml"), join(scaffold.root, "topology"));
    const active = await spawnScenarioDaemon(scaffold, { rigBin: RIG_BIN, timeoutMs: 60_000 });
    daemon = active;
    const rig = async (args: string[], env = active.readEnv) => {
      const result = await runRig(args, env, RIG_BIN, 120_000);
      expect(result.code, `${args.join(" ")}: ${result.stderr}\n${result.stdout}`).toBe(0);
      return result;
    };
    const status = async (): Promise<TmuxServerSelection> => {
      const data = JSON.parse((await rig(["terminal", "status", "--json"])).stdout);
      expect(data.tmux).toBeDefined();
      sockets.add(data.tmux.socketPath);
      return data.tmux;
    };
    const inventory = async () => {
      const rigs = JSON.parse((await rig(["ps", "--json"])).stdout) as Array<{ rigId: string; rigName: string }>;
      const id = rigs.find(row => row.rigName === "scn-baton")!.rigId;
      const response = await fetch(`${active.baseUrl}/api/rigs/${id}/nodes`);
      expect(response.ok).toBe(true);
      return { id, rows: await response.json() as Array<{ canonicalSessionName: string; tmuxServerArgs: string[]; tmuxServerMode: string; tmuxAttachCommand: string }> };
    };

    expect(await status()).toMatchObject({ mode: "inherit", socketPath: personal, executionArgs: [], migrationPending: false });
    await rig(["up", staged.topologyPath, "--json", "--yes"]);
    const oldPane = native(personal, ["display-message", "-p", "-t", `=${SEAT}:`, "#{pane_id}:#{pane_pid}"]);
    expect(oldPane).toMatch(/^%\d+:\d+$/);
    const initialNodes = await inventory();
    expect(initialNodes.rows.map(row => row.canonicalSessionName)).toContain(SEAT);
    expect(initialNodes.rows.find(row => row.canonicalSessionName === SEAT)!.tmuxServerMode).toBe("inherit");
    expect(native(personal, ["show-environment", "-t", `=${SEAT}`, "OPENRIG_HOME"]))
      .toBe(`OPENRIG_HOME=${realpathSync(scaffold.openrigHome)}`);
    const configured = await rig(["config", "set", "terminal.tmux_server", "isolated"]);
    expect(configured.stderr).toContain("surviving sessions keep their previous server");
    await active.restart();
    expect(native(personal, ["display-message", "-p", "-t", `=${SEAT}:`, "#{pane_id}:#{pane_pid}"])).toBe(oldPane);
    expect(await status()).toMatchObject({ mode: "inherit", requestedMode: "isolated", socketPath: personal,
      migrationPending: true, blockingSessions: [SEAT] });
    expect((await inventory()).rows.find(row => row.canonicalSessionName === SEAT)!.tmuxServerArgs).toEqual(["-S", personal]);
    expect((await rig(["capture", SEAT, "--json"])).stdout).toContain("READY");

    await rig(["down", "scn-baton", "--json", "--force"]);
    expect(native(personal, ["list-sessions", "-F", "#{session_name}"])).toBe("personal");
    await active.restart();
    const selected = await status();
    expect(selected).toMatchObject({ mode: "isolated", executionArgs: selected.serverArgs, migrationPending: false, blockingSessions: [] });
    expect(selected.socketPath).not.toBe(personal);
    // Restore the deliberately stopped team. The stub has no provider resume
    // history, so explicitly request a fresh seat within the same generation.
    // Fresh launches truthfully report partial restoration (CLI exit 1).
    const restored = await runRig(["up", "scn-baton", "--existing", "--fresh", "dev.worker", "--json", "--yes"],
      active.readEnv, RIG_BIN, 120_000);
    expect(restored.code, `${restored.stderr}\n${restored.stdout}`).toBe(1);
    expect(JSON.parse(restored.stdout)).toMatchObject({ status: "restored", rigId: initialNodes.id,
      rigResult: "partially_restored", nodes: [{ logicalId: "dev.worker", status: "fresh-primed" }] });
    expect(native(selected.socketPath!, ["list-sessions", "-F", "#{session_name}"])).toBe(SEAT);
    expect(native(personal, ["list-sessions", "-F", "#{session_name}"])).toBe("personal");
    expect(native(selected.socketPath!, ["show-options", "-gqv", "@openrig-isolation-fixture"])).toBe("loaded");
    expect(native(personal, ["show-options", "-gqv", "@openrig-isolation-fixture"])).toBe("");
    const nodes = await inventory();
    expect(nodes.id).toBe(initialNodes.id);
    expect(nodes.rows).toHaveLength(1);
    expect(nodes.rows[0]!.tmuxServerArgs).toEqual(selected.serverArgs);
    expect(nodes.rows[0]!.tmuxServerMode).toBe("isolated");
    expect(nodes.rows[0]!.tmuxAttachCommand).toContain(selected.socketPath!);
    const preview = await (await fetch(`${active.baseUrl}/api/terminal/preview?view=scn-baton&provider=herdr`)).json();
    expect(preview.tmux).toMatchObject({ mode: "isolated", socketPath: selected.socketPath });
    expect(preview.composed.localTmuxServer).toEqual(selected.serverArgs);
    expect(preview.composed.opened[0].paneCommand).toContain(selected.socketPath!);

    // A personal namesake must neither capture nor adopt as this instance's seat.
    native(personal, ["new-session", "-d", "-s", SEAT, "printf 'PERSONAL_NAMESAKE\\n'; sleep 600"]);
    const personalPane = native(personal, ["display-message", "-p", "-t", `=${SEAT}:`, "#{pane_id}"]);
    expect(personalPane).toMatch(/^%\d+$/);
    const capture = await rig(["capture", SEAT, "--json"]);
    expect(capture.stdout).toContain("READY");
    expect(capture.stdout).not.toContain("PERSONAL_NAMESAKE");
    const attach = await runRig(["attach", "--self", "--rig", nodes.id, "--pod", "dev", "--member", "foreign", "--runtime", "stub", "--json"],
      { ...active.readEnv, TMUX: `${personal},1,0`, TMUX_PANE: personalPane }, RIG_BIN);
    expect(attach.code, `${attach.stderr}\n${attach.stdout}`).toBe(1);
    expect(JSON.parse(attach.stdout)).toMatchObject({ code: "tmux_server_mismatch" });
    expect((await inventory()).rows).toHaveLength(1);

    const isolatedPane = native(selected.socketPath!, ["display-message", "-p", "-t", `=${SEAT}:`, "#{pane_id}:#{pane_pid}"]);
    expect(isolatedPane).toMatch(/^%\d+:\d+$/);
    scaffold.env.TMUX = `${personal},1,0`;
    scaffold.env.TMUX_TMPDIR = join(scaffold.root, "different-tmp");
    mkdirSync(scaffold.env.TMUX_TMPDIR);
    await active.restart();
    expect(await status()).toMatchObject({ mode: "isolated", socketPath: selected.socketPath, migrationPending: false });
    expect(native(selected.socketPath!, ["display-message", "-p", "-t", `=${SEAT}:`, "#{pane_id}:#{pane_pid}"])).toBe(isolatedPane);

    const destroyEnv = {
      ...active.readEnv, OPENRIG_PORT: String(active.port), OPENRIG_DB: join(scaffold.stateDir, "scenario.db"),
    };
    const recordFile = join(scaffold.openrigHome, "tmux-server.json");
    const recorded = readFileSync(recordFile, "utf8");
    unlinkSync(recordFile);
    try {
      const refused = await runRig(["destroy", "--all", "--yes", "--confirm", "destroy-openrig-state"], destroyEnv, RIG_BIN);
      expect(refused.code, `${refused.stderr}\n${refused.stdout}`).toBe(1);
      expect(`${refused.stderr}\n${refused.stdout}`).toContain("Missing tmux server record");
      expect(existsSync(destroyEnv.OPENRIG_DB)).toBe(true);
      expect(await status()).toMatchObject({ mode: "isolated", socketPath: selected.socketPath });
      expect(native(selected.socketPath!, ["display-message", "-p", "-t", `=${SEAT}:`, "#{pane_id}:#{pane_pid}"])).toBe(isolatedPane);
      expect(native(personal, ["capture-pane", "-p", "-t", `=${SEAT}:`])).toContain("PERSONAL_NAMESAKE");
    } finally {
      writeFileSync(recordFile, recorded, { mode: 0o600 });
    }
    await rig(["destroy", "--all", "--yes", "--confirm", "destroy-openrig-state"], destroyEnv);
    daemon = undefined;
    expect(() => native(selected.socketPath!, ["has-session", "-t", `=${SEAT}`])).toThrow();
    expect(native(personal, ["has-session", "-t", `=${SEAT}`])).toBe("");
    expect(native(personal, ["capture-pane", "-p", "-t", `=${SEAT}:`])).toContain("PERSONAL_NAMESAKE");
  // Several daemon restarts and shipped CLI processes share the suite's worker budget.
  }, 420_000);
});
