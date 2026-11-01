import { afterAll, beforeAll, expect, it } from "vitest";
import Database from "better-sqlite3";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stringify } from "yaml";
import { prepareHermeticEnv, type HermeticScaffold } from "./helpers/hermetic-env.js";
import { runRig, spawnScenarioDaemon, type ScenarioDaemon } from "./helpers/scenario-daemon.js";

// The YAML scenario runner has no bound edge-add or sweep verbs. This journey uses
// the same private daemon/tmux scaffold, actual CLI and the daemon's scheduled sweep.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const rigBin = join(repoRoot, "packages/cli/dist/bin-wrapper.js");
let scaffold: HermeticScaffold | undefined;
let daemon: ScenarioDaemon | undefined;
let db: Database.Database | undefined;
const rigIds: string[] = [];

async function cli(args: string[]) {
  const result = await runRig(args, daemon!.readEnv, rigBin, 120_000);
  expect(result.code, JSON.stringify({ args, ...result })).toBe(0);
  return JSON.parse(result.stdout);
}

beforeAll(async () => {
  scaffold = prepareHermeticEnv({ baseEnv: { PATH: process.env.PATH, TERM: "xterm-256color" } });
  scaffold.env.OPENRIG_QUEUE_STUCK_SWEEP_INTERVAL_SECONDS = "1";
  scaffold.env.OPENRIG_QUEUE_STUCK_SWEEP_UNCLAIMED_AGE_MINUTES = "1";
  cpSync(join(repoRoot, "packages/test-system/scenarios/agents/worker"), join(scaffold.root, "worker-agent"), { recursive: true });
  daemon = await spawnScenarioDaemon(scaffold, { rigBin });
  db = new Database(join(scaffold.stateDir, "scenario.db"));
}, 120_000);

afterAll(async () => {
  try {
    for (const id of rigIds) await cli(["down", id, "--force", "--json"]);
  } finally {
    db?.close();
    if (daemon) await daemon.stop();
    else scaffold?.cleanup();
  }
}, 120_000);

it("imports a deferred route, launches two isolated stub rigs and delivers one scheduled recovery to the other queue", async () => {
  for (const [name, edges] of [
    ["lane", [{ from: "work.lead", to: "work-lead@coord", kind: "escalates_to" }]],
    ["coord", []],
  ] as const) {
    const cwd = join(scaffold!.root, name);
    mkdirSync(cwd);
    const spec = join(scaffold!.root, `${name}.yaml`);
    writeFileSync(spec, stringify({ version: "0.2", name,
      pods: [{ id: "work", label: "Work", members: [{ id: "lead", agent_ref: "local:worker-agent", profile: "default", runtime: "stub", cwd }], edges: [] }], edges }));
    rigIds.push((await cli(["up", spec, "--yes", "--json"])).rigId);
  }
  await cli(["queue", "create", "--id", "cross-rig-work", "--source", "work-lead@coord",
    "--destination", "work-lead@lane", "--body", "Need a scope ruling", "--no-nudge", "--json"]);
  // Fixture aging of an existing row, not a second queue-write implementation.
  db!.prepare("UPDATE queue_items SET ts_created=? WHERE qitem_id='cross-rig-work'")
    .run(new Date(Date.now() - 120_000).toISOString());
  let finding: { qitem_id: string; destination_session: string; body: string; tags: string } | undefined;
  const deadline = Date.now() + 20_000;
  while (!finding && Date.now() < deadline) {
    finding = db!.prepare("SELECT qitem_id,destination_session,body,tags FROM queue_items WHERE tags LIKE '%stuck-sweep:unclaimed-obligation:cross-rig-work%'").get() as typeof finding;
    if (!finding) await new Promise(resolve => setTimeout(resolve, 200));
  }
  expect(finding).toBeDefined();
  expect(finding!.destination_session).toBe("work-lead@coord");
  expect(finding!.body).toContain("escalates_to routed");
  expect(JSON.parse(finding!.tags)).toContain("escalation-route:one-hop");
  const shown = await cli(["queue", "show", finding!.qitem_id, "--full", "--json"]);
  expect(JSON.stringify(shown)).toContain("work-lead@coord");
  expect(db!.prepare("SELECT destination_session FROM queue_items WHERE qitem_id='cross-rig-work'").get())
    .toEqual({ destination_session: "work-lead@lane" });
}, 120_000);
