// OPR.0.5.3.6 — THE DOOR (proof item 3, and the check that would have caught
// r2-B1 the first time): a REAL spawned daemon, the REAL `rig up` verb, a
// clean scratch OPENRIG_HOME — then find the installed chain files at all
// four altitudes under the derived topology.root. Not a unit proof: the unit
// suite was green while the shipped door installed nothing, because the
// installer was wired into materializeValidatedSpec and `rig up` takes the
// bootstrap → instantiate() path. This test drives the user's actual command.
//
// The rig has ONE terminal-runtime member (builtin:terminal, zero startup
// actions) so nothing agent-shaped launches; seats land on the scaffold-owned
// tmux server, never the fleet's. Contention note: spawns a real daemon
// (seconds), bounded by timeout.
import { describe, it, expect, afterEach } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import fs from "node:fs";
import { prepareHermeticEnv, type HermeticScaffold } from "./helpers/hermetic-env.js";
import { spawnScenarioDaemon, runRig, type ScenarioDaemon } from "./helpers/scenario-daemon.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RIG_BIN = resolve(HERE, "../../cli/dist/bin-wrapper.js");

function realBaseEnv() {
  return { HOME: process.env.HOME, PATH: process.env.PATH, TERM: "xterm" };
}

const DOOR_RIG_YAML = `version: "0.2"
name: door-rig
summary: door proof rig for shipped topology defaults
pods:
  - id: ops
    label: Ops
    members:
      - id: term
        agent_ref: "builtin:terminal"
        runtime: terminal
        profile: none
        cwd: "."
    edges: []
`;

describe("topology defaults DOOR (real daemon, real rig up)", () => {
  let scaffold: HermeticScaffold | undefined;
  let daemon: ScenarioDaemon | undefined;

  afterEach(async () => {
    if (daemon) await daemon.stop().catch(() => {});
    else if (scaffold) scaffold.cleanup();
    daemon = undefined;
    scaffold = undefined;
  });

  it("rig up rejects an unknown topology key before daemon or filesystem topology mutation", async () => {
    scaffold = prepareHermeticEnv({ baseEnv: realBaseEnv() });
    daemon = await spawnScenarioDaemon(scaffold, { rigBin: RIG_BIN });

    const specDir = join(scaffold.root, "specs", "typo-rig");
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(
      join(specDir, "rig.yaml"),
      DOOR_RIG_YAML.replace("name: door-rig", "name: typo-rig\noperating_mod: lab"),
      "utf-8",
    );

    const up = await runRig(["up", join(specDir, "rig.yaml"), "--json"], daemon.readEnv, RIG_BIN);
    expect(up.code).toBe(2);
    expect(JSON.parse(up.stdout).error).toContain(
      'operating_mod: unknown key "operating_mod"; refusing the spec because normalization would otherwise discard it and alter the requested topology',
    );

    const ps = await runRig(["ps", "--json"], daemon.readEnv, RIG_BIN);
    expect(ps.code).toBe(0);
    expect(JSON.parse(ps.stdout).some((rig: { name?: string }) => rig.name === "typo-rig")).toBe(false);
    expect(fs.existsSync(join(scaffold.openrigHome, "topology", "rigs", "typo-rig"))).toBe(false);
  }, 120_000);

  it("rig up then context trace walks runtime-matching instance, rig, pod, and seat defaults", async () => {
    scaffold = prepareHermeticEnv({ baseEnv: realBaseEnv() });
    daemon = await spawnScenarioDaemon(scaffold, { rigBin: RIG_BIN });

    // A spec dir INSIDE the scaffold carrying topology/ defaults at all four altitudes.
    const specDir = join(scaffold.root, "specs", "door-rig");
    fs.mkdirSync(join(specDir, "topology", "instance"), { recursive: true });
    fs.mkdirSync(join(specDir, "topology", "rig"), { recursive: true });
    fs.mkdirSync(join(specDir, "topology", "pods", "ops"), { recursive: true });
    fs.mkdirSync(join(specDir, "topology", "seats", "ops-term"), { recursive: true });
    fs.writeFileSync(join(specDir, "rig.yaml"), DOOR_RIG_YAML, "utf-8");
    fs.writeFileSync(join(specDir, "topology", "instance", "CRAFT.md"), "instance default (door)", "utf-8");
    fs.writeFileSync(join(specDir, "topology", "rig", "CRAFT.md"), "rig default (door)", "utf-8");
    fs.writeFileSync(join(specDir, "topology", "pods", "ops", "CRAFT.md"), "pod ops default (door)", "utf-8");
    fs.writeFileSync(join(specDir, "topology", "seats", "ops-term", "CRAFT.md"), "seat default (door)", "utf-8");

    // THE DOOR: the user's actual command against the scenario-local daemon.
    const up = await runRig(["up", join(specDir, "rig.yaml"), "--json"], daemon.readEnv, RIG_BIN);
    expect(up.code, `rig up failed: ${up.stdout} ${up.stderr}`).toBe(0);

    // The find receipt: all four altitudes populated, instance at the TOP of the root.
    const topoRoot = join(scaffold.openrigHome, "topology");
    expect(fs.readFileSync(join(topoRoot, "CRAFT.md"), "utf-8")).toBe("instance default (door)");
    expect(fs.readFileSync(join(topoRoot, "rigs", "door-rig", "CRAFT.md"), "utf-8")).toBe("rig default (door)");
    expect(fs.readFileSync(join(topoRoot, "rigs", "door-rig", "pods", "ops", "CRAFT.md"), "utf-8")).toBe("pod ops default (door)");
    expect(fs.readFileSync(join(topoRoot, "rigs", "door-rig", "seats", "ops-term", "CRAFT.md"), "utf-8")).toBe("seat default (door)");

    const ps = await runRig(["ps", "--nodes", "--rig", "door-rig", "--json", "--fields", "rigName,podNamespace,logicalId"], daemon.readEnv, RIG_BIN);
    expect(ps.code, `rig ps failed: ${ps.stdout} ${ps.stderr}`).toBe(0);
    expect(JSON.parse(ps.stdout)).toMatchObject({
      entries: [{ rigName: "door-rig", podNamespace: "ops", logicalId: "ops.term" }],
      totalNodes: 1,
      truncated: false,
    });

    const trace = await runRig(["context", "trace", "--rig", "door-rig", "--pod", "ops", "--seat", "ops-term", "--name", "CRAFT.md", "--json"], daemon.readEnv, RIG_BIN);
    expect(trace.code, `rig context trace failed: ${trace.stdout} ${trace.stderr}`).toBe(0);
    expect(JSON.parse(trace.stdout).levels.map((level: { altitude: string; content: string }) => [level.altitude, level.content])).toEqual([
      ["instance", "instance default (door)"],
      ["rig", "rig default (door)"],
      ["pod", "pod ops default (door)"],
      ["seat", "seat default (door)"],
    ]);
  }, 120_000);

  it("source discriminator: shipped product-team topology bytes install through the real door", async () => {
    // r2 residual: the synthetic door proved the MECHANISM; this case proves
    // the product-team spec's actual topology/ folder from source lands
    // byte-identical through the real `rig up`. It is deliberately separate
    // from the clean-checkout packaging discriminator in check-packing.test.mjs;
    // neither test is labeled as the whole locked proof item by itself.
    // DISCLOSED STAND-IN: the member set is one terminal seat, not the real
    // 7-agent roster (launching claude/codex agents in a hermetic scaffold
    // proves nothing about defaults and costs real runtimes); the installer
    // keys on the spec dir's topology/ folder and the rig NAME, both of which
    // are the shipped ones here.
    const shippedTopology = resolve(HERE, "../specs/rigs/preview/product-team/topology");
    expect(fs.statSync(shippedTopology).isDirectory()).toBe(true);

    scaffold = prepareHermeticEnv({ baseEnv: realBaseEnv() });
    daemon = await spawnScenarioDaemon(scaffold, { rigBin: RIG_BIN });

    const specDir = join(scaffold.root, "specs", "product-team");
    fs.mkdirSync(specDir, { recursive: true });
    fs.cpSync(shippedTopology, join(specDir, "topology"), { recursive: true });
    fs.writeFileSync(join(specDir, "rig.yaml"), DOOR_RIG_YAML.replace("name: door-rig", "name: product-team"), "utf-8");

    const up = await runRig(["up", join(specDir, "rig.yaml"), "--json"], daemon.readEnv, RIG_BIN);
    expect(up.code, `rig up failed: ${up.stdout} ${up.stderr}`).toBe(0);

    const topoRoot = join(scaffold.openrigHome, "topology");
    const shipped = (rel: string) => fs.readFileSync(join(shippedTopology, rel), "utf-8");
    expect(fs.readFileSync(join(topoRoot, "CRAFT.md"), "utf-8")).toBe(shipped("instance/CRAFT.md"));
    expect(fs.readFileSync(join(topoRoot, "rigs", "product-team", "CRAFT.md"), "utf-8")).toBe(shipped("rig/CRAFT.md"));
    expect(fs.readFileSync(join(topoRoot, "rigs", "product-team", "ORCHESTRATION-CRAFT.md"), "utf-8")).toBe(shipped("rig/ORCHESTRATION-CRAFT.md"));
    for (const seat of ["orch1-lead", "rev1-r1", "rev1-r2", "dev1-qa"]) {
      expect(fs.readFileSync(join(topoRoot, "rigs", "product-team", "seats", seat, "CRAFT.md"), "utf-8"))
        .toBe(shipped(`seats/${seat}/CRAFT.md`));
    }
  }, 120_000);
});
