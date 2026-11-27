// Synthetic pre-0.7.9 records, then a real upgrade/startup and CLI stop/down on a private stub rig.
// The independently created shell is fixture-owned; no provider, owner daemon or authenticated process is used.
import { afterAll, beforeAll, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDb } from "../src/db/connection.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { prepareHermeticEnv, type HermeticScaffold } from "./helpers/hermetic-env.js";
import { runRig, spawnScenarioDaemon, type ScenarioDaemon } from "./helpers/scenario-daemon.js";

const here = dirname(fileURLToPath(import.meta.url));
const rigBin = resolve(here, "../../cli/dist/bin-wrapper.js");
const rigName = "dev-pair-stub", owned = `dev-impl@${rigName}`, adopted = `dev-qa@${rigName}`;
let scaffold: HermeticScaffold | undefined, daemon: ScenarioDaemon | undefined, running = false;
function tmux(args: string[]): string {
  return execFileSync("tmux", ["-S", scaffold!.tmuxSocketPath, ...args], { env: scaffold!.env, encoding: "utf8" }).trim();
}
async function cli(args: string[]) {
  const r = await runRig(args, daemon!.readEnv, rigBin, 120_000);
  expect(r.code, JSON.stringify({ args, ...r })).toBe(0);
  return JSON.parse(r.stdout);
}
beforeAll(async () => {
  scaffold = prepareHermeticEnv({ baseEnv: { PATH: process.env.PATH, TERM: "xterm-256color" } });
  daemon = await spawnScenarioDaemon(scaffold, { rigBin });
  const cwd = join(scaffold.root, "project"); mkdirSync(cwd);
  await cli(["up", resolve(here, "../../test-system/scenarios/dev-pair-stub.yaml"), "--cwd", cwd, "--json", "--yes"]);
  running = true;
}, 120_000);
afterAll(async () => {
  if (!daemon) { scaffold?.cleanup(); return; }
  try {
    if (running) await cli(["down", rigName, "--json", "--force"]);
  } finally {
    for (const name of [owned, adopted]) {
      try { tmux(["kill-session", "-t", name]); } catch { /* only these fixture sessions; already gone is fine */ }
    }
    await daemon.stop();
  }
}, 120_000);

it("upgrades the established successor and keeps a later adopted process alive through stop, clean and rig down", async () => {
  // Replace the managed reviewer with an independently created shell, then register it by the ordinary claim verb.
  await cli(["seat", "stop", adopted, "--reason", "fixture replaces the managed process", "--json"]);
  tmux(["new-session", "-d", "-s", adopted, "sleep 600"]);
  const db = createDb(join(scaffold!.stateDir, "scenario.db"));
  let countBefore = 0;
  try {
    const initial = db.prepare("SELECT id, node_id, session_name FROM sessions WHERE session_name IN (?, ?) ORDER BY id")
      .all(owned, adopted) as Array<{ id: string; node_id: string; session_name: string }>;
    for (const row of initial) {
      db.prepare("UPDATE nodes SET handover_result='complete', continuity_outcome='fresh', handover_at='2026-11-01T10:00:00.123Z' WHERE id=?").run(row.node_id);
      db.prepare("UPDATE sessions SET origin='claimed', created_at='2026-11-01 10:00:00' WHERE id=?").run(row.id);
      db.prepare("UPDATE occupant_tenures SET kind='handover', boot_at='2026-11-01 10:00:00' WHERE node_id=?").run(row.node_id);
    }
    const nodeId = initial.find(r => r.session_name === adopted)!.node_id;
    const registry = new SessionRegistry(db), claimed = registry.registerClaimedSession(nodeId, adopted);
    db.prepare("UPDATE sessions SET created_at='2026-11-01 10:00:30' WHERE id=?").run(claimed.id);
    db.prepare("UPDATE occupant_tenures SET boot_at='2026-11-01 10:00:30' WHERE node_id=? AND kind='adopt'").run(nodeId);
    registry.updateBinding(nodeId, { tmuxSession: adopted, tmuxPane: tmux(["display-message", "-p", "-t", adopted, "#{pane_id}"]) });
    // This data-only migration has no schema footprint. Removing only its marker models an install before it ran.
    db.prepare("DELETE FROM schema_migrations WHERE name='200_sessions_earlier_handover_origin.sql'").run();
    const before = db.prepare("SELECT id, node_id, session_name, origin, status FROM sessions ORDER BY id").all();
    countBefore = before.length; console.info("UPGRADE-BEFORE", JSON.stringify(before));
  } finally { db.close(); }
  await daemon!.restart();
  expect((await cli(["seat", "status", owned, "--json"])).origin).toBe("launched");
  expect((await cli(["seat", "status", adopted, "--json"])).origin).toBe("claimed");
  await cli(["seat", "stop", owned, "--reason", "stop upgraded successor", "--json"]);
  for (const verb of ["stop", "clean"]) {
    const r = await runRig(["seat", verb, adopted, "--reason", "fixture observes adopted protection", "--json"], daemon!.readEnv, rigBin);
    expect(r.code).not.toBe(0); expect(JSON.parse(r.stdout).code).toBe("claimed_session");
    expect(tmux(["list-sessions", "-F", "#{session_name}"])).toBe(adopted);
  }
  await cli(["down", rigName, "--json", "--force"]); running = false;
  expect(tmux(["list-sessions", "-F", "#{session_name}"])).toBe(adopted);
  const after = createDb(join(scaffold!.stateDir, "scenario.db"));
  try {
    const rows = after.prepare("SELECT id, node_id, session_name, origin, status FROM sessions ORDER BY id").all();
    expect(rows).toHaveLength(countBefore); console.info("UPGRADE-AFTER", JSON.stringify(rows));
  } finally { after.close(); }
}, 180_000);
