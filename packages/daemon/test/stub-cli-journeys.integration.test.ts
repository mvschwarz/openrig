import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareHermeticEnv, type HermeticScaffold } from "./helpers/hermetic-env.js";
import { runRig, spawnScenarioDaemon, type ScenarioDaemon } from "./helpers/scenario-daemon.js";

// Real CLI/daemon/SQLite/tmux with two scripted agents. These journeys exercise
// ordinary user commands; they do not model a provider prompt or input consumption.
// Reuse one private fixture to keep the PR cost bounded. Each assertion uses its
// own marker/selector, and only the stream case restarts this fixture's daemon.
const here = dirname(fileURLToPath(import.meta.url));
const rigBin = resolve(here, "../../cli/dist/bin-wrapper.js");
const library = resolve(here, "../../test-system/scenarios");

describe("stub CLI journeys", () => {
  let scaffold: HermeticScaffold | undefined;
  let daemon: ScenarioDaemon | undefined;
  const launchedRigs: string[] = [];
  const sender = "work-worker@rig-alpha";
  const recipient = "work-worker@rig-beta";

  async function cli(args: string[]) {
    const result = await runRig(args, { ...daemon!.readEnv, OPENRIG_SESSION_NAME: sender }, rigBin);
    expect(result.code, JSON.stringify({ args, ...result })).toBe(0);
    return JSON.parse(result.stdout);
  }

  beforeAll(async () => {
    scaffold = prepareHermeticEnv({ baseEnv: { PATH: process.env.PATH, TERM: "xterm-256color" } });
    daemon = await spawnScenarioDaemon(scaffold, { rigBin });
    for (const name of ["alpha", "beta"]) {
      const cwd = join(scaffold.root, name);
      mkdirSync(cwd);
      const result = await runRig(["up", join(library, `rig-${name}-stub.yaml`), "--cwd", cwd, "--json", "--yes"], daemon.readEnv, rigBin, 120_000);
      expect(result.code, JSON.stringify({ name, ...result })).toBe(0);
      launchedRigs.push(`rig-${name}`);
    }
  }, 120_000);

  afterAll(async () => {
    if (!daemon) { scaffold?.cleanup(); return; }
    try {
      // Stop the launched seats while their daemon can still coordinate teardown.
      // Removing the scratch tree with live rigs can race their final writes.
      for (const rig of launchedRigs) await cli(["down", rig, "--json", "--force"]);
    } finally {
      await daemon.stop();
    }
  }, 60_000);

  it("verified send renders in the addressed pane and not its sibling", async () => {
    const marker = `verified-send-${randomUUID()}`;
    const receipt = await cli(["send", recipient, marker, "--verify", "--json"]);
    expect(receipt.verified).toBe(true);
    const target = await cli(["capture", recipient, "--json"]);
    const sibling = await cli(["capture", sender, "--json"]);
    expect(JSON.stringify(target)).toContain(marker);
    expect(JSON.stringify(sibling)).not.toContain(marker);
    // Pane rendering is the contract here. The stub has no consuming input loop.
  }, 60_000);

  it("keeps the current-rig view exact while explicit scopes reach the other live rig", async () => {
    const all = await cli(["ps", "--nodes", "--all-rigs", "--json"]);
    expect(all.map((n: { canonicalSessionName: string }) => n.canonicalSessionName).sort()).toEqual([sender, recipient]);
    for (const [rig, seat] of [["rig-alpha", sender], ["rig-beta", recipient]]) {
      const nodes = await cli(["ps", "--nodes", "--rig", rig, "--json"]);
      expect(nodes.map((n: { canonicalSessionName: string }) => n.canonicalSessionName)).toEqual([seat]);
      expect(nodes[0].sessionStatus).toBe("running");
    }
    const current = await cli(["ps", "--nodes", "--json"]);
    expect(current.entries.map((n: { canonicalSessionName: string }) => n.canonicalSessionName)).toEqual([sender]);
    expect(current.scope).toMatchObject({ rig: "rig-alpha", rigsOnHost: 2 });
    // Exact arrays, not subset matches: an extra sibling is a failure.
  }, 60_000);

  it("replays one exact stream item after restart and an idempotent emit retry", async () => {
    const id = `journey-${randomUUID()}`;
    const tag = `journey-tag-${randomUUID()}`;
    const body = `durable-body-${randomUUID()}`;
    const emit = ["stream", "emit", "--source", sender, "--id", id, "--body", body, "--hint-tags", tag, "--json"];
    const item = await cli(emit);
    expect(item).toMatchObject({ streamItemId: id, sourceSession: sender, body });
    await cli(["stream", "emit", "--source", recipient, "--body", "unrelated-stream-control", "--json"]);
    const read = () => cli(["stream", "list", "--tag", tag, "--json"]);
    expect(await read()).toEqual([item]);
    await daemon!.restart();
    expect(await read()).toEqual([item]);
    expect(await cli(emit)).toEqual(item);
    expect(await read()).toEqual([item]);
    // Durable CLI replay, not an SSE/live-watch or stub-activity-hook claim.
  }, 60_000);
});
