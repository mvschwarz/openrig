import { expect, it } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareHermeticEnv } from "./helpers/hermetic-env.js";
import { runRig, spawnScenarioDaemon } from "./helpers/scenario-daemon.js";

const rigBin = resolve(dirname(fileURLToPath(import.meta.url)), "../../cli/dist/bin-wrapper.js");

it("creates a terminal rig and grows another terminal through ordinary spec admission", async () => {
  const scaffold = prepareHermeticEnv({ baseEnv: { PATH: process.env.PATH, TERM: "xterm-256color" } });
  const daemon = await spawnScenarioDaemon(scaffold, { rigBin });
  const name = "terminal-create";
  try {
    const created = await runRig(["create", name, "--runtime", "terminal", "--cwd", scaffold.root, "--json"], daemon.readEnv, rigBin);
    expect(created.code, created.stdout + created.stderr).toBe(0);
    const rig = JSON.parse(created.stdout);
    expect(rig).toMatchObject({ ok: true, source: "builtin:terminal", node: { status: "launched" } });

    const grown = await runRig(["grow", rig.rigId, "shell", "--new-pod", "tools", "--runtime", "terminal", "--cwd", scaffold.root, "--json"], daemon.readEnv, rigBin);
    expect(grown.code, grown.stdout + grown.stderr).toBe(0);
    expect(JSON.parse(grown.stdout)).toMatchObject({ ok: true, source: "builtin:terminal", nodes: [{ status: "launched" }] });

    const listed = await runRig(["ps", "--nodes", "--rig", name, "--json"], daemon.readEnv, rigBin);
    expect(listed.code, listed.stdout + listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout).map((node: { logicalId: string; runtime: string; sessionStatus: string }) =>
      [node.logicalId, node.runtime, node.sessionStatus]).sort()).toEqual([
      ["main.lead", "terminal", "running"],
      ["tools.shell", "terminal", "running"],
    ]);
  } finally {
    await runRig(["down", name, "--force", "--json"], daemon.readEnv, rigBin);
    await daemon.stop();
  }
}, 120_000);
