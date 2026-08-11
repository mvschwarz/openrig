import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScenarioFile } from "./helpers/scenario-pipeline.js";
import type { RunRecord } from "./helpers/scenario-run-record.js";

// 51-02 delta D8 (guard binding) — SCENARIO-LEVEL determinism.
//
// Guard rejected the first shape as vacuous: a PASS result and its run-record row
// carry only scenario name + verdict, so running a passing scenario twice and
// comparing them proves NO scenario-controlled observable was stable. The
// discriminator therefore runs a deliberately STABLE-FAILING expect, whose DIFF
// embeds the last OBSERVED value — one differing byte in what the scenario
// controls flips the comparison.

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const INJECTED_CLOCK = "2026-08-11T00:00:00.000Z";

/** Runner-local fields excluded from the byte comparison, NAMED (never a blanket strip):
 *  wall-clock duration is machine timing, not a scenario-controlled observable. */
const RUNNER_LOCAL_RECORD_FIELDS = ["durationMs"] as const;

function normalizeRecord(rec: RunRecord): Record<string, unknown> {
  const copy = { ...(rec as unknown as Record<string, unknown>) };
  for (const f of RUNNER_LOCAL_RECORD_FIELDS) delete copy[f];
  return copy;
}

function scenarioDir(): string {
  const d = mkdtempSync(join(tmpdir(), "determinism-"));
  dirs.push(d);
  writeFileSync(join(d, "topo.yaml"), [
    'version: "0.2"', "name: scn-det", "pods:", "  - id: dev", "    label: Dev",
    "    members:", "      - id: worker", '        agent_ref: "local:agents/worker"',
    "        profile: default", "        runtime: stub", "        cwd: .", "    edges: []", "",
  ].join("\n"));
  // A rig bin whose observable output is FIXED — so any run-to-run difference
  // would come from the runner, which is exactly what this pins.
  writeFileSync(join(d, "rig.mjs"), [
    'const args = process.argv.slice(2);',
    'if (args[0] === "up") { process.stdout.write(JSON.stringify({ rigId: "r1", rigName: "scn-det" })); }',
    'else if (args[0] === "queue") { process.stdout.write(JSON.stringify([{ qitemId: "fixed-1", state: "pending" }])); }',
    'else { process.stdout.write("{}"); }',
    "",
  ].join("\n"));
  // The stable-FAILING expect: the observed value is fixed and never matches, so
  // the DIFF carries a real observable rather than an empty PASS row.
  writeFileSync(join(d, "s.yaml"), [
    "scenario: determinism-discriminator",
    "topology: ./topo.yaml",
    "steps:",
    "  - up: {}",
    "  - expect:",
    "      surface: queue",
    "      within: 0ms",
    "      match:",
    "        - qitemId: never-present",
    "          state: in-progress",
    "",
  ].join("\n"));
  return d;
}

async function runOnce(d: string, records: RunRecord[]) {
  return runScenarioFile(join(d, "s.yaml"), {
    rigBin: join(d, "rig.mjs"),
    baseEnv: { HOME: d, PATH: process.env.PATH, TERM: "xterm" },
    daemon: (async () => ({
      readEnv: { PATH: process.env.PATH }, baseUrl: "http://127.0.0.1:1",
      sigterm: async () => {}, restart: async () => {}, stop: async () => {},
    })) as never,
    deps: {
      defaults: { withinMs: 0, pollIntervalMs: 1 },
      appendRecord: (r: RunRecord) => records.push(r),
    },
  });
}

describe("D8 — the same scenario twice under the injected clock is byte-identical where it counts", () => {
  it("verdict, failed step, and the DIFF's observed value are identical across runs", async () => {
    const d = scenarioDir();

    const recordsA: RunRecord[] = [];
    const recordsB: RunRecord[] = [];
    const a = await runOnce(d, recordsA);
    const b = await runOnce(d, recordsB);

    // the discriminator is a real FAIL carrying an observed value...
    expect(a.verdict).toBe("FAIL");
    expect(a.diff).toContain("never-present");   // expected side
    expect(a.diff).toContain("fixed-1");         // OBSERVED side — the actual byte payload
    // ...and it is identical run to run
    expect(b.verdict).toBe(a.verdict);
    expect(b.failedStep).toBe(a.failedStep);
    expect(b.diff).toBe(a.diff);
    expect(recordsB.map(normalizeRecord)).toEqual(recordsA.map(normalizeRecord));
    expect(recordsA.length).toBeGreaterThan(0);
  });

  it("FAILS when one observed byte differs while clock and scenario stay fixed (the pin has teeth)", async () => {
    const d = scenarioDir();
    const recordsA: RunRecord[] = [];
    const a = await runOnce(d, recordsA);

    // change ONLY the observable the scenario reads
    writeFileSync(join(d, "rig.mjs"), [
      'const args = process.argv.slice(2);',
      'if (args[0] === "up") { process.stdout.write(JSON.stringify({ rigId: "r1", rigName: "scn-det" })); }',
      'else if (args[0] === "queue") { process.stdout.write(JSON.stringify([{ qitemId: "fixed-2", state: "pending" }])); }',
      'else { process.stdout.write("{}"); }',
      "",
    ].join("\n"));
    const recordsB: RunRecord[] = [];
    const b = await runOnce(d, recordsB);

    expect(b.verdict).toBe(a.verdict);   // still a FAIL...
    expect(b.diff).not.toBe(a.diff);     // ...but the pin CATCHES the one-byte drift
  });

  it("the injected clock is the scaffold's own (an ambient one is refused, so runs cannot inherit time)", async () => {
    const d = scenarioDir();
    const { prepareHermeticEnv, AmbientClockHazardError } = await import("./helpers/hermetic-env.js");
    expect(() =>
      prepareHermeticEnv({ baseEnv: { HOME: d, PATH: process.env.PATH, OPENRIG_TEST_CLOCK_NOW: INJECTED_CLOCK } }),
    ).toThrow(AmbientClockHazardError);
    const s = prepareHermeticEnv({ baseEnv: { HOME: d, PATH: process.env.PATH }, injectClockNow: INJECTED_CLOCK });
    expect(s.env.OPENRIG_TEST_CLOCK_NOW).toBe(INJECTED_CLOCK);
    s.cleanup();
  });
});
