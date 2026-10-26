// Seats must not inherit the identity of the Claude Code session or Herdr pane
// that started the daemon. Since #1573 a seat's pane starts from a scoped
// environment: the daemon's selected baseline (locale, XDG roots,
// CLAUDE_CONFIG_DIR, PATH, HOME, OpenRig's own values, CODEX_HOME, allowlisted
// provider credentials) plus the names in tmux's update-environment, never the
// rest of what the tmux server or the daemon carries. This drives the real CLI,
// daemon and a private tmux server with a stub seat, then reads what the seat's
// pane process was given.
//
// Linux only: it reads each pane's environment from /proc/<pid>/environ. macOS
// has no /proc, so there it is skipped rather than passed without checking
// anything.
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
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
// Configuration the daemon selects for every seat.
const SELECTED = {
  CLAUDE_CONFIG_DIR: "/configured/claude",
  CODEX_HOME: "/configured/codex",
};
// Configuration the daemon and the tmux server carry that a seat isn't given: none of it is in the selected baseline,
// and this test names no provider credential in recovery.provider_auth_env_allowlist.
const NOT_SELECTED = {
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

describe.runIf(process.platform === "linux")("seat environment from a daemon started inside Claude Code and Herdr", () => {
  const scaffolds: HermeticScaffold[] = [];
  afterEach(() => { for (const s of scaffolds.splice(0)) s.cleanup(); });

  // "daemon": the daemon starts the tmux server. "existing": a tmux server that
  // already carries the parent identity is running before the daemon starts.
  it.each(["daemon", "existing"] as const)("seats receive none of the parent session's identity variables, the selected configuration, and nothing else the tmux server carries (tmux server: %s)", async (server) => {
    const scaffold = prepareHermeticEnv({
      baseEnv: { HOME: process.env.HOME, PATH: process.env.PATH, TERM: "xterm", ...PARENT_SESSION, ...SELECTED, ...NOT_SELECTED },
    });
    scaffolds.push(scaffold);
    const tmux = (args: string[], env: Record<string, string | undefined> = process.env) =>
      run("tmux", ["-S", scaffold.tmuxSocketPath, ...args], {
        env: { ...env, PATH: process.env.PATH, TMUX: undefined, TMUX_TMPDIR: undefined } as NodeJS.ProcessEnv,
      });
    const environOf = (pid: string): Record<string, string> => parseEnv(readFileSync(`/proc/${pid}/environ`, "utf8"), "\0");
    const staged = stageTopologyRoot(join(HERE, "fixtures", "scenarios", "topo-stub-baton.yaml"), join(scaffold.root, "topology"));
    if (server === "existing") await tmux(["new-session", "-d", "-s", "owner-anchor", "sleep 300"], scaffold.env);

    const daemon = await spawnScenarioDaemon(scaffold, { rigBin });
    try {
      const up = await runRig(["up", staged.topologyPath, "--json", "--yes"], daemon.readEnv, rigBin, 120_000);
      expect(up.code).toBe(0);

      // The tmux server's own environment, which a scoped pane doesn't start from.
      const global = parseEnv((await tmux(["show-environment", "-g"])).stdout, "\n");
      // What each seat's pane process was actually given.
      const panes = (await tmux(["list-panes", "-a", "-F", "#{session_name} #{pane_pid}"])).stdout
        .trim().split("\n").map((line) => line.split(" ") as [string, string]);
      const seatPanes = panes.filter(([session]) => session.includes("scn-baton"));
      expect(seatPanes.length).toBeGreaterThan(0);

      for (const [, pid] of seatPanes) {
        const env = environOf(pid);
        expect(Object.keys(env).filter((k) => k in PARENT_SESSION)).toEqual([]);
        expect(Object.keys(env).filter((k) => k in NOT_SELECTED)).toEqual([]);
        expect(env).toMatchObject({
          ...SELECTED,
          // The daemon's own PATH, which the scaffold started it with. (The scaffold's tmux wrapper gives the tmux server
          // the original PATH, so an inherited pane would have that instead.)
          PATH: scaffold.env.PATH,
          HOME: scaffold.home,
          OPENRIG_HOME: scaffold.openrigHome,
        });
      }

      // A server the daemon started has none of the parent session's identity either.
      if (server === "daemon") expect(Object.keys(global).filter((k) => k in PARENT_SESSION)).toEqual([]);

      if (server === "existing") {
        // Owner state is untouched: the server's global environment and the
        // pre-existing session keep exactly what they had.
        expect(global).toMatchObject(PARENT_SESSION);
        const anchor = panes.find(([session]) => session === "owner-anchor");
        expect(anchor).toBeTruthy();
        expect(environOf(anchor![1])).toMatchObject(PARENT_SESSION);
      }
    } finally {
      await runRig(["down", "scn-baton", "--json", "--force"], daemon.readEnv, rigBin, 60_000).catch(() => {});
      await daemon.stop().catch(() => {});
    }
  }, 300_000);
});
