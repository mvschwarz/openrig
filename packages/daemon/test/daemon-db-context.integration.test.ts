import { expect, it } from "vitest";
import { copyFileSync, existsSync, readFileSync, realpathSync, utimesSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareHermeticEnv, type HermeticScaffold } from "./helpers/hermetic-env.js";
import { findFreePort, runRig } from "./helpers/scenario-daemon.js";

const rigBin = resolve(dirname(fileURLToPath(import.meta.url)), "../../cli/dist/bin-wrapper.js");
const fixture = () => prepareHermeticEnv({ baseEnv: { PATH: process.env.PATH, TERM: "xterm-256color" } });
async function start(home: HermeticScaffold, db: string) {
  home.env.OPENRIG_DB = db;
  const result = await runRig(["daemon", "start", "--port", String(await findFreePort()), "--no-kernel"], home.env, rigBin, 60_000);
  expect(result.code, result.stdout + result.stderr).toBe(0);
  return result.stdout + result.stderr;
}
async function stop(home: HermeticScaffold) {
  await runRig(["daemon", "stop"], home.env, rigBin);
  home.cleanup();
}

it("honours an outside OPENRIG_DB and explains it at start and in text/JSON status", async () => {
  const home = fixture();
  const db = join(home.stateDir, "outside.sqlite");
  try {
    const started = await start(home, db);
    expect(started).toContain("OPENRIG_DB");
    expect(started).not.toContain("Another live daemon");
    expect(started).toContain(realpathSync(home.openrigHome));
    expect(started).toContain(realpathSync(db));
    expect(existsSync(join(home.openrigHome, "openrig.sqlite"))).toBe(false);
    // Status describes the serving daemon, even if this shell selects a different DB.
    home.env.OPENRIG_DB = join(home.stateDir, "unused.sqlite");
    const text = await runRig(["status"], home.env, rigBin);
    expect(text.code, text.stdout + text.stderr).toBe(0);
    expect(text.stdout).toContain("OPENRIG_DB");
    expect(text.stdout).toContain(realpathSync(db));
    const json = await runRig(["status", "--json"], home.env, rigBin);
    expect(json.code, json.stdout + json.stderr).toBe(0);
    expect(JSON.parse(json.stdout).daemon.databaseWarnings.join("\n")).toContain(realpathSync(home.openrigHome));
  } finally { await stop(home); }
}, 120_000);

it("warns when another live daemon has the same database open and still starts", async () => {
  const first = fixture();
  const second = fixture();
  const db = join(first.stateDir, "shared.sqlite");
  try {
    expect(await start(first, db)).not.toContain("Another live daemon");
    const pid = JSON.parse(readFileSync(join(first.openrigHome, "daemon.json"), "utf8")).pid;
    // A matching stale record beside the DB does not attest the live holder's home.
    const staleRecord = join(first.stateDir, "daemon.json");
    copyFileSync(join(first.openrigHome, "daemon.json"), staleRecord);
    const oldTime = new Date("2020-01-01T00:00:00Z");
    utimesSync(staleRecord, oldTime, oldTime);
    const started = await start(second, db);
    expect(started).toContain("Another live daemon");
    expect(started).toContain(String(pid));
    expect(started).toContain("current home unconfirmed");
    expect(started).toContain("2020-01-01T00:00:00.000Z");
    expect(started).toContain(staleRecord);
    expect(started).toContain(realpathSync(db));
    const status = await runRig(["status", "--json"], second.env, rigBin);
    expect(status.code, status.stdout + status.stderr).toBe(0);
    expect(JSON.parse(status.stdout).daemon.databaseWarnings.join("\n")).toContain("Another live daemon");
  } finally { await stop(second); await stop(first); }
}, 120_000);

it("explains a --db override without promising that unsetting OPENRIG_DB resets it", async () => {
  const home = fixture();
  delete home.env.OPENRIG_DB;
  delete home.env.RIGGED_DB;
  const db = join(home.stateDir, "explicit.sqlite");
  try {
    const result = await runRig(["daemon", "start", "--port", String(await findFreePort()), "--no-kernel", "--db", db], home.env, rigBin, 60_000);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(result.stderr).toContain("--db, db.path, OPENRIG_DB or RIGGED_DB");
    expect(result.stderr).toContain("Remove or correct the selecting override");
    expect(result.stderr).not.toContain("Unset OPENRIG_DB to use");
  } finally { await stop(home); }
}, 120_000);
