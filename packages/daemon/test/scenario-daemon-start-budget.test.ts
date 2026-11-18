import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HermeticScaffold } from "./helpers/hermetic-env.js";
import { spawnScenarioDaemon } from "./helpers/scenario-daemon.js";

// `rig daemon start` waits for its own daemon's readiness for up to the product's start budget. The scenario helper used
// to cut the start off at the per-invocation timeout (30 s by default), so a slow but healthy start read as a failure.
describe("spawnScenarioDaemon: the start gets the product's start budget", () => {
  const dirs: string[] = [];
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

  it("waits for a start that takes longer than the per-invocation timeout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scenario-start-budget-"));
    dirs.push(dir);
    // A stand-in `rig`: its start answers after 800 ms, as a slow daemon start does; stop answers at once.
    const rigBin = join(dir, "rig.mjs");
    writeFileSync(rigBin, `const [verb, op] = process.argv.slice(2);
if (verb === "daemon" && op === "start") setTimeout(() => { console.log("Daemon started"); process.exit(0); }, 800);
else process.exit(0);
`);
    const scaffold = { env: { PATH: process.env.PATH }, stateDir: dir, cleanup: () => {} } as unknown as HermeticScaffold;
    const daemon = await spawnScenarioDaemon(scaffold, { rigBin, timeoutMs: 300 });
    expect(daemon.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    await daemon.stop();
  });
});
