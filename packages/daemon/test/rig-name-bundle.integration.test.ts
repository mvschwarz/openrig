import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareHermeticEnv, type HermeticScaffold } from "./helpers/hermetic-env.js";
import { runRig, spawnScenarioDaemon, type ScenarioDaemon } from "./helpers/scenario-daemon.js";

// `rig up <file>.rigbundle --name <rig>` through POST /api/up: real CLI, daemon, SQLite and tmux in a
// private home and tmux socket, with a scripted stub seat. One archive installs as two named rigs.
const here = dirname(fileURLToPath(import.meta.url));
const rigBin = resolve(here, "../../cli/dist/bin-wrapper.js");

describe("rig up <file>.rigbundle --name", () => {
  let scaffold: HermeticScaffold | undefined;
  let daemon: ScenarioDaemon | undefined;
  const specName = "rig-name-bundle-stub";
  const launched: string[] = [];

  const cli = async (args: string[]) => {
    const r = await runRig(args, daemon!.readEnv, rigBin, 120_000);
    expect(r.code, JSON.stringify({ args, ...r })).toBe(0);
    return JSON.parse(r.stdout);
  };

  beforeAll(async () => {
    scaffold = prepareHermeticEnv({ baseEnv: { PATH: process.env.PATH, TERM: "xterm-256color" } });
    daemon = await spawnScenarioDaemon(scaffold, { rigBin });
  }, 60_000);

  afterAll(async () => {
    if (!daemon) { scaffold?.cleanup(); return; }
    try {
      for (const rig of launched) await runRig(["down", rig, "--json", "--force"], daemon.readEnv, rigBin);
    } finally { await daemon.stop(); }
  }, 60_000);

  it("installs one archive as rigs alpha and beta, with seats named for each, and the installed spec unchanged", async () => {
    const root = scaffold!.root;
    const source = join(root, "author");
    mkdirSync(join(source, "agents/worker"), { recursive: true });
    writeFileSync(join(source, "agents/worker/agent.yaml"), "name: worker\nversion: \"1.0\"\nprofiles:\n  default:\n    uses:\n      skills: []\n");
    writeFileSync(join(source, "rig.yaml"), `version: "0.2"
name: ${specName}
pods:
  - id: work
    label: Work
    members:
      - {id: worker, agent_ref: "local:agents/worker", profile: default, runtime: stub, cwd: .}
    edges: []
edges: []
`);
    const archive = join(root, "team.rigbundle");
    await cli(["bundle", "create", join(source, "rig.yaml"), "--output", archive, "--name", "portable-team", "--json"]);
    rmSync(source, { recursive: true });

    for (const name of ["alpha", "beta"]) {
      const target = join(root, `installed-${name}`);
      const cwd = join(root, `project-${name}`);
      mkdirSync(cwd);
      const up = await cli(["up", archive, "--name", name, "--target", target, "--cwd", cwd, "--yes", "--json"]);
      launched.push(name);
      expect(up.status).toBe("completed");
      // The installed copy keeps the spec's own name; only the rig takes the chosen one.
      expect(readFileSync(join(target, "rig.yaml"), "utf8")).toContain(`name: ${specName}`);
      const nodes = await cli(["ps", "--nodes", "--rig", name, "--json"]);
      expect(nodes.map((n: { canonicalSessionName: string }) => n.canonicalSessionName)).toEqual([`work-worker@${name}`]);
      expect(nodes[0].sessionStatus).toBe("running");
    }
    const rigs = (await cli(["ps", "--json"])) as Array<{ name: string; status: string }>;
    expect(rigs.map((r) => r.name).sort()).toEqual(["alpha", "beta"]);
    expect(rigs.every((r) => r.status === "running")).toBe(true);
  }, 180_000);
});
