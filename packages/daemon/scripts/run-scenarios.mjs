#!/usr/bin/env -S node --import tsx
/*
 * Slice 51-02 - the STANDALONE scenario runner entry (config-wrapper-code; NOT a
 * rig-test verb). Runs one or more scenario YAML files against a forced-local,
 * hermetic scenario-local daemon and prints a PASS/FAIL results ledger.
 *
 * Usage (the tsx loader is needed for the TS pipeline import; the shebang wires it
 * when the file is executed directly, otherwise invoke via node --import tsx):
 *   packages/daemon/scripts/run-scenarios.mjs [scenario.yaml ...]
 *   node --import tsx packages/daemon/scripts/run-scenarios.mjs [scenario.yaml ...]
 *
 * With no args it runs the committed evidence scenarios under
 * test/fixtures/scenarios/. Prerequisite: the built rig bin (npm run build -w
 * packages/cli and -w packages/daemon). The up step stands up real tmux seats, so
 * set TMUX_TMPDIR to an isolated dir to keep off the shared fleet server.
 *
 * The equals mode uses an IDENTITY normalizer here (a v1 interface placeholder;
 * the declarative cross-surface normalizer final shape rides 51-03), so a
 * cross-surface scenario exercises the equals interface but is not expected green
 * until 51-03 supplies the real normalizer.
 */
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runScenarioFile } from "../test/helpers/scenario-pipeline.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const DAEMON_ROOT = resolve(HERE, "..");
const RIG_BIN = resolve(DAEMON_ROOT, "..", "cli", "dist", "bin-wrapper.js");
const FIXTURES = join(DAEMON_ROOT, "test", "fixtures", "scenarios");

const argv = process.argv.slice(2);
const files = argv.length > 0
  ? argv.map((a) => resolve(a))
  : readdirSync(FIXTURES).filter((f) => /^scenario-.*\.ya?ml$/.test(f)).sort().map((f) => join(FIXTURES, f));

const baseEnv = { HOME: process.env.HOME, PATH: process.env.PATH, TERM: "xterm" };
const deps = { normalizer: (_surface, value) => value }; // v1 identity placeholder (rides 51-03)

let failures = 0;
for (const file of files) {
  try {
    const result = await runScenarioFile(file, { rigBin: RIG_BIN, baseEnv, deps });
    const tag = result.verdict === "PASS" ? "PASS" : "FAIL";
    let line = `[${tag}] ${result.scenario}`;
    if (result.verdict === "FAIL") line += `\n  step ${result.failedStep}: ${result.diff}`;
    console.log(line);
    if (result.verdict !== "PASS") failures++;
  } catch (err) {
    failures++;
    console.log(`[ERROR] ${file}\n  ${(err && err.message) || err}`);
  }
}
console.log(`\n${files.length - failures}/${files.length} scenarios passed`);
process.exit(failures > 0 ? 1 : 0);
