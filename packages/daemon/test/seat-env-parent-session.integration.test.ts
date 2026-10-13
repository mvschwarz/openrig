// Seats must not inherit the identity of the Claude Code session or Herdr pane
// that started the daemon. The daemon starts the tmux server, so its environment
// becomes every pane's environment. This drives the real CLI, daemon and a private
// tmux server with a stub seat, then reads what the seat's pane was given.
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareHermeticEnv, type HermeticScaffold } from "./helpers/hermetic-env.js";
import { spawnScenarioDaemon, runRig } from "./helpers/scenario-daemon.js";
import { stageTopologyRoot } from "./helpers/scenario-stage.js";
import { PARENT_SESSION_ENV_KEYS } from "../src/domain/parent-session-env.js";

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const rigBin = resolve(HERE, "../../cli/dist/bin-wrapper.js");

const PARENT_SESSION = Object.fromEntries([...PARENT_SESSION_ENV_KEYS, "CLAUDE_EFFORT"].map((k) => [k, `parent-${k}`]));
const CONFIGURATION = {
  CLAUDE_CONFIG_DIR: "/configured/claude",
  CODEX_HOME: "/configured/codex",
  CLAUDE_CODE_USE_BEDROCK: "1",
  ANTHROPIC_BASE_URL: "https://anthropic.example.test",
  OPENAI_BASE_URL: "https://openai.example.test",
};

function parseEnv(text: string, separator: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const entry of text.split(separator)) {
    const eq = entry.indexOf("=");
    if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
  }
  return env;
}

describe("seat environment from a daemon started inside Claude Code and Herdr", () => {
  const scaffolds: HermeticScaffold[] = [];
  afterEach(() => { for (const s of scaffolds.splice(0)) s.cleanup(); });

  // "daemon": the daemon starts the tmux server. "existing": a tmux server that
  // already carries the parent identity is running before the daemon starts.
  it.each(["daemon", "existing"] as const)("seats receive none of the parent session's identity variables, and configuration passes through unchanged (tmux server: %s)", async (server) => {
    const scaffold = prepareHermeticEnv({
      baseEnv: { HOME: process.env.HOME, PATH: process.env.PATH, TERM: "xterm", ...PARENT_SESSION, ...CONFIGURATION },
    });
    scaffolds.push(scaffold);
    const tmux = (args: string[], env: Record<string, string | undefined> = process.env) =>
      run("tmux", ["-S", scaffold.tmuxSocketPath, ...args], {
        env: { ...env, PATH: process.env.PATH, TMUX: undefined, TMUX_TMPDIR: undefined } as NodeJS.ProcessEnv,
      });
    const environOf = (pid: string): Record<string, string> | null => {
      const environ = `/proc/${pid}/environ`;
      return existsSync(environ) ? parseEnv(readFileSync(environ, "utf8"), "\0") : null;
    };
    const staged = stageTopologyRoot(join(HERE, "fixtures", "scenarios", "topo-stub-baton.yaml"), join(scaffold.root, "topology"));
    if (server === "existing") await tmux(["new-session", "-d", "-s", "owner-anchor", "sleep 300"], scaffold.env);

    const daemon = await spawnScenarioDaemon(scaffold, { rigBin });
    try {
      const up = await runRig(["up", staged.topologyPath, "--json", "--yes"], daemon.readEnv, rigBin, 120_000);
      expect(up.code).toBe(0);

      // What every new pane on the tmux server starts from.
      const global = parseEnv((await tmux(["show-environment", "-g"])).stdout, "\n");
      // What each seat's pane process was actually given, where the OS exposes it.
      const panes = (await tmux(["list-panes", "-a", "-F", "#{session_name} #{pane_pid}"])).stdout
        .trim().split("\n").map((line) => line.split(" ") as [string, string]);
      const seatPanes = panes.filter(([session]) => session.includes("scn-baton"));
      expect(seatPanes.length).toBeGreaterThan(0);
      const seen = seatPanes.map(([, pid]) => environOf(pid)).filter((env): env is Record<string, string> => env !== null);
      if (process.platform === "linux") expect(seen.length).toBe(seatPanes.length);
      if (server === "daemon") seen.push(global);

      for (const env of seen) {
        expect(Object.keys(env).filter((k) => k in PARENT_SESSION)).toEqual([]);
        expect(env).toMatchObject({
          ...CONFIGURATION,
          // The scaffold's tmux wrapper runs tmux with the original PATH.
          PATH: process.env.PATH,
          HOME: scaffold.home,
          OPENRIG_HOME: scaffold.openrigHome,
        });
      }

      if (server === "existing") {
        // Owner state is untouched: the server's global environment and the
        // pre-existing session keep exactly what they had.
        expect(global).toMatchObject(PARENT_SESSION);
        const anchor = panes.find(([session]) => session === "owner-anchor");
        const anchorEnv = anchor && environOf(anchor[1]);
        if (process.platform === "linux") expect(anchorEnv).toBeTruthy();
        if (anchorEnv) expect(anchorEnv).toMatchObject(PARENT_SESSION);
      }
    } finally {
      await runRig(["down", "scn-baton", "--json", "--force"], daemon.readEnv, rigBin, 60_000).catch(() => {});
      await daemon.stop().catch(() => {});
    }
  }, 300_000);
});
