import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { prepareHermeticEnv } from "./helpers/hermetic-env.js";
import { runRig, spawnScenarioDaemon, type ScenarioDaemon } from "./helpers/scenario-daemon.js";

const rigBin = fileURLToPath(new URL("../../cli/dist/bin-wrapper.js", import.meta.url));
const workerSpec = fileURLToPath(new URL("../../test-system/scenarios/agents/worker/agent.yaml", import.meta.url));
const pack = ["openrig-onboarding-01.md", "openrig-onboarding-02.md"];

it.each([true, false])("keeps each rig's onboarding choice across launch and restore with daemon default %s", async daemonDefault => {
  const scaffold = prepareHermeticEnv({ baseEnv: {
    PATH: process.env.PATH,
    TERM: "xterm-256color",
    OPENRIG_ONBOARDING_DEFAULT_PACK_ENABLED: String(daemonDefault),
  } });
  let daemon: ScenarioDaemon | undefined;
  try {
    const running = daemon = await spawnScenarioDaemon(scaffold, { rigBin });
    const cli = (args: string[]) => runRig(args, running.readEnv, rigBin, 120_000);
    const rigs = [
      { name: "onboarding-overridden", override: !daemonDefault, expected: daemonDefault ? [] : pack },
      { name: "onboarding-inherited", override: undefined, expected: daemonDefault ? pack : [] },
    ];
    mkdirSync(join(scaffold.root, "worker"));
    writeFileSync(join(scaffold.root, "worker", "agent.yaml"), readFileSync(workerSpec));
    const readGuidance = (name: string) => {
      const content = readFileSync(join(scaffold.root, name, "AGENTS.md"), "utf8");
      const hasBlock = (file: string) => content.includes(`<!-- BEGIN OpenRig MANAGED BLOCK: ${file} -->`);
      expect(hasBlock("openrig-start.md")).toBe(true);
      expect(hasBlock("openrig-context-entry.md")).toBe(true);
      return pack.filter(hasBlock);
    };

    for (const { name, override } of rigs) {
      const cwd = join(scaffold.root, name);
      mkdirSync(cwd);
      const spec = join(scaffold.root, `${name}.yaml`);
      writeFileSync(spec, `version: "0.2"
name: ${name}
${override === undefined ? "" : `default_onboarding_pack: ${override}\n`}pods:
  - id: work
    label: Work
    members:
      - {id: worker, agent_ref: "local:worker", profile: default, runtime: stub, cwd: .}
`);
      const launch = await cli(["up", spec, "--cwd", cwd, "--json", "--yes"]);
      expect(launch.code, JSON.stringify(launch)).toBe(0);
    }

    for (const { name, expected } of rigs) expect(readGuidance(name)).toEqual(expected);

    for (const { name } of rigs) {
      const stopped = await cli(["down", name, "--snapshot", "--json"]);
      expect(stopped.code, JSON.stringify(stopped)).toBe(0);
      // The stub leaves its guidance file behind. Start with a clean file so only restored blocks count.
      writeFileSync(join(scaffold.root, name, "AGENTS.md"), "# Local guidance\n");
    }
    await running.restart();
    for (const { name, expected } of rigs) {
      const restored = await cli(["up", name, "--existing", "--fresh", "work.worker", "--json", "--yes"]);
      expect(JSON.parse(restored.stdout), JSON.stringify(restored)).toMatchObject({
        status: "restored", rigName: name, nodes: [{ logicalId: "work.worker", status: "fresh-primed" }],
      });
      expect(readGuidance(name)).toEqual(expected);
      expect(readFileSync(join(scaffold.root, name, "AGENTS.md"), "utf8")).toContain("# Local guidance");
    }

    for (const { name, override } of rigs) {
      const exported = join(scaffold.root, `${name}-export.yaml`);
      const result = await cli(["export", name, "--output", exported]);
      expect(result.code, JSON.stringify(result)).toBe(0);
      const field = readFileSync(exported, "utf8").split("\n").find(line => line.startsWith("default_onboarding_pack:"));
      expect(field).toBe(override === undefined ? undefined : `default_onboarding_pack: ${override}`);
    }
  } finally {
    if (daemon) await daemon.stop();
    else scaffold.cleanup();
  }
}, 180_000);
