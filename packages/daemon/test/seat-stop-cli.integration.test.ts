import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareHermeticEnv, type HermeticScaffold } from "./helpers/hermetic-env.js";
import { runRig, spawnScenarioDaemon, type ScenarioDaemon } from "./helpers/scenario-daemon.js";

const here = dirname(fileURLToPath(import.meta.url));
const rigBin = resolve(here, "../../cli/dist/bin-wrapper.js");
const topology = resolve(here, "../../test-system/scenarios/dev-pair-stub.yaml");
const rigName = "dev-pair-stub";
const worker = `dev-impl@${rigName}`;
const reviewer = `dev-qa@${rigName}`;

interface RigSummary {
  rigId: string;
  rigName: string;
  lifecycleState: string;
  nodeCount: number;
  runningCount: number;
  status: string;
}

interface SeatSummary {
  canonicalSessionName: string;
  sessionStatus: string;
  intentionallyStopped?: boolean;
}

// Real CLI, daemon, SQLite, and private tmux server; no provider credentials.
// The YAML scenario DSL has no seat-stop verb, so drive that shipped command
// through the same hermetic harness used by the scenario runner.
describe("intentional seat stop CLI journey", () => {
  let scaffold: HermeticScaffold | undefined;
  let daemon: ScenarioDaemon | undefined;
  let launched = false;
  let reviewerCrashed = false;

  async function cli<T>(args: string[], timeoutMs = 30_000): Promise<T> {
    const result = await runRig(args, daemon!.readEnv, rigBin, timeoutMs);
    expect(result.code, JSON.stringify({ args, ...result })).toBe(0);
    return JSON.parse(result.stdout) as T;
  }

  async function summary(): Promise<RigSummary> {
    const rigs = await cli<RigSummary[]>(["ps", "--json"]);
    return rigs.find((rig) => rig.rigName === rigName)!;
  }

  async function reviewerSummary(): Promise<SeatSummary> {
    const seats = await cli<SeatSummary[]>(["ps", "--nodes", "--rig", rigName, "--json"]);
    return seats.find((seat) => seat.canonicalSessionName === reviewer)!;
  }

  function sessions(): string[] {
    return execFileSync("tmux", ["-S", scaffold!.tmuxSocketPath, "list-sessions", "-F", "#{session_name}"], {
      env: scaffold!.env, encoding: "utf8",
    }).trim().split("\n").sort();
  }

  beforeAll(async () => {
    scaffold = prepareHermeticEnv({ baseEnv: { PATH: process.env.PATH, TERM: "xterm-256color" } });
    daemon = await spawnScenarioDaemon(scaffold, { rigBin });
    const cwd = join(scaffold.root, "project");
    mkdirSync(cwd);
    await cli(["up", topology, "--cwd", cwd, "--json", "--yes"], 120_000);
    launched = true;
  }, 120_000);

  afterAll(async () => {
    if (!daemon) { scaffold?.cleanup(); return; }
    try {
      // Clear the crashed row while its sibling still keeps our tmux server up.
      if (reviewerCrashed) await cli(["seat", "clean", reviewer, "--reason", "fixture crash cleanup", "--json"]);
      if (launched) await cli(["down", rigName, "--json", "--force"]);
    } finally {
      await daemon.stop();
    }
  }, 60_000);

  it("persists an intentional stop across daemon restart, then detects a fresh occupant's crash", async () => {
    const initial = await summary();
    expect(initial).toMatchObject({ lifecycleState: "running", nodeCount: 2, runningCount: 2 });
    expect(sessions()).toEqual([worker, reviewer].sort());
    const snapshot = await runRig(["snapshot", initial.rigId], daemon!.readEnv, rigBin);
    expect(snapshot.code, JSON.stringify(snapshot)).toBe(0);

    const stopped = await cli<{ sessionId: string }>([
      "seat", "stop", reviewer, "--reason", "review runs on demand", "--json",
    ]);
    expect(sessions()).toEqual([worker]);
    expect(await summary()).toMatchObject({
      lifecycleState: "running", status: "partial", nodeCount: 2, runningCount: 1,
    });
    expect(await reviewerSummary()).toMatchObject({ sessionStatus: "exited", intentionallyStopped: true });

    for (const selection of [["--last"], ["--rigs", rigName]]) {
      const start = await runRig(["start", ...selection, "--json"], daemon!.readEnv, rigBin);
      expect(start.code, JSON.stringify({ selection, ...start })).toBe(1);
      const result = JSON.parse(start.stdout);
      expect(result.candidates).toEqual([{ rigName, lifecycleState: "degraded" }]);
      expect(result.restoredRigs).toEqual([{ rigName, status: "rig_not_stopped", nodes: [] }]);
      expect(sessions()).toEqual([worker]);
    }

    await daemon!.restart();
    expect(sessions()).toEqual([worker]);
    expect(await summary()).toMatchObject({ lifecycleState: "running", runningCount: 1 });
    expect(await reviewerSummary()).toMatchObject({ sessionStatus: "exited", intentionallyStopped: true });

    const fresh = await cli<{ sessionId: string }>([
      "seat", "launch", reviewer, "--fresh", "--reason", "next review", "--json",
    ], 120_000);
    expect(fresh.sessionId).toBeTruthy();
    expect(fresh.sessionId).not.toBe(stopped.sessionId);
    expect(sessions()).toEqual([worker, reviewer].sort());
    expect(await reviewerSummary()).toMatchObject({ sessionStatus: "running", intentionallyStopped: false });
    expect(await summary()).toMatchObject({ lifecycleState: "running", status: "running", runningCount: 2 });

    // Kill only the new reviewer on our private server, without a supported stop.
    execFileSync("tmux", ["-S", scaffold!.tmuxSocketPath, "kill-session", "-t", `=${reviewer}`], { env: scaffold!.env });
    reviewerCrashed = true;
    await expect.poll(summary, { timeout: 30_000 }).toMatchObject({
      lifecycleState: "degraded", status: "partial", runningCount: 1,
    });
    expect(sessions()).toEqual([worker]);
    expect((await reviewerSummary()).intentionallyStopped).toBe(false);
  }, 180_000);
});
