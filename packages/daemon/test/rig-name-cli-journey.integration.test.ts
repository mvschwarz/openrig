import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareHermeticEnv, type HermeticScaffold } from "./helpers/hermetic-env.js";
import { runRig, spawnScenarioDaemon, type ScenarioDaemon } from "./helpers/scenario-daemon.js";

// `rig up <spec> --name <rig>` end to end: real CLI, daemon, SQLite and tmux in a private home and tmux
// socket, with a scripted stub seat. It proves the chosen name is the rig's identity through ps, down and
// `--existing` restore; it does not model Claude Code or Codex, and the stub seat has no resume token, so
// the restore relaunches it fresh.
const here = dirname(fileURLToPath(import.meta.url));
const rigBin = resolve(here, "../../cli/dist/bin-wrapper.js");
const spec = resolve(here, "../../test-system/scenarios/solo-stub.yaml");

type RigRow = { name: string; status: string; nodeCount: number; runningCount: number };
type NodeRow = { canonicalSessionName: string; sessionStatus: string };

describe("rig up --name: two named rigs from one spec, and a restore by name", () => {
  let scaffold: HermeticScaffold | undefined;
  let daemon: ScenarioDaemon | undefined;
  const launched: string[] = [];

  async function cli(args: string[]) {
    const result = await runRig(args, daemon!.readEnv, rigBin, 120_000);
    expect(result.code, JSON.stringify({ args, ...result })).toBe(0);
    return JSON.parse(result.stdout);
  }
  const rigs = async () => (await cli(["ps", "--json"])) as RigRow[];
  const seats = async (rig: string) => ((await cli(["ps", "--nodes", "--rig", rig, "--json"])) as NodeRow[]);

  beforeAll(async () => {
    scaffold = prepareHermeticEnv({ baseEnv: { PATH: process.env.PATH, TERM: "xterm-256color" } });
    daemon = await spawnScenarioDaemon(scaffold, { rigBin });
    for (const name of ["alpha", "beta"]) {
      const cwd = join(scaffold.root, name);
      mkdirSync(cwd);
      await cli(["up", spec, "--name", name, "--cwd", cwd, "--json", "--yes"]);
      launched.push(name);
    }
  }, 180_000);

  afterAll(async () => {
    if (!daemon) { scaffold?.cleanup(); return; }
    try {
      for (const rig of launched) await cli(["down", rig, "--json", "--force"]);
    } finally {
      await daemon.stop();
    }
  }, 60_000);

  it("rig down alpha, then rig up alpha --existing, brings alpha back under its name and leaves beta running", async () => {
    await cli(["down", "alpha", "--json"]);
    expect((await rigs()).find((r) => r.name === "alpha")).toMatchObject({ status: "stopped", runningCount: 0 });
    expect((await rigs()).find((r) => r.name === "beta")).toMatchObject({ status: "running", runningCount: 1 });

    // A fresh-primed seat rolls up as partially_restored, which the CLI reports with exit code 1.
    const restore = await runRig(["up", "alpha", "--existing", "--fresh", "work.worker", "--json", "--yes"], daemon!.readEnv, rigBin, 120_000);
    expect(JSON.parse(restore.stdout), JSON.stringify(restore)).toMatchObject({
      status: "restored", rigName: "alpha", rigResult: "partially_restored",
      nodes: [{ logicalId: "work.worker", status: "fresh-primed" }], attachCommand: "tmux attach -t work-worker@alpha",
    });
    const rows = await rigs();
    expect(rows.map((r) => r.name).sort()).toEqual(["alpha", "beta"]);
    expect(rows.find((r) => r.name === "alpha")).toMatchObject({ status: "running", nodeCount: 1, runningCount: 1 });
    expect(rows.find((r) => r.name === "beta")).toMatchObject({ status: "running", runningCount: 1 });
    expect(await seats("alpha")).toEqual([expect.objectContaining({ canonicalSessionName: "work-worker@alpha", sessionStatus: "running" })]);
  }, 120_000);
});
