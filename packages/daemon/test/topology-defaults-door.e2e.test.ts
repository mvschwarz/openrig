// OPR.0.5.3.6 — THE DOOR (proof item 3, and the check that would have caught
// r2-B1 the first time): a REAL spawned daemon, the REAL `rig up` verb, a
// clean scratch OPENRIG_HOME — then find the installed chain files at all
// three altitudes under the derived topology.root. Not a unit proof: the unit
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

  it("rig up on a clean environment installs instance, rig, and seat defaults under $OPENRIG_HOME/topology", async () => {
    scaffold = prepareHermeticEnv({ baseEnv: realBaseEnv() });
    daemon = await spawnScenarioDaemon(scaffold, { rigBin: RIG_BIN });

    // A spec dir INSIDE the scaffold carrying topology/ defaults at all three altitudes.
    const specDir = join(scaffold.root, "specs", "door-rig");
    fs.mkdirSync(join(specDir, "topology", "instance"), { recursive: true });
    fs.mkdirSync(join(specDir, "topology", "rig"), { recursive: true });
    fs.mkdirSync(join(specDir, "topology", "seats", "ops-term"), { recursive: true });
    fs.writeFileSync(join(specDir, "rig.yaml"), DOOR_RIG_YAML, "utf-8");
    fs.writeFileSync(join(specDir, "topology", "instance", "CRAFT.md"), "instance default (door)", "utf-8");
    fs.writeFileSync(join(specDir, "topology", "rig", "CRAFT.md"), "rig default (door)", "utf-8");
    fs.writeFileSync(join(specDir, "topology", "seats", "ops-term", "CRAFT.md"), "seat default (door)", "utf-8");

    // THE DOOR: the user's actual command against the scenario-local daemon.
    const up = await runRig(["up", join(specDir, "rig.yaml"), "--json"], daemon.readEnv, RIG_BIN);
    expect(up.code, `rig up failed: ${up.stdout} ${up.stderr}`).toBe(0);

    // The find receipt: all three altitudes populated, instance at the TOP of the root.
    const topoRoot = join(scaffold.openrigHome, "topology");
    expect(fs.readFileSync(join(topoRoot, "CRAFT.md"), "utf-8")).toBe("instance default (door)");
    expect(fs.readFileSync(join(topoRoot, "rigs", "door-rig", "CRAFT.md"), "utf-8")).toBe("rig default (door)");
    expect(fs.readFileSync(join(topoRoot, "rigs", "door-rig", "seats", "ops-term", "CRAFT.md"), "utf-8")).toBe("seat default (door)");
  }, 120_000);
});
