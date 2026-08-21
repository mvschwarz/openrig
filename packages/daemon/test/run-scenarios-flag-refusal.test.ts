// B12-S (ruled safety fix) — the STANDALONE scenario runner (scripts/run-scenarios.mjs)
// refuses unknown flags BEFORE running any scenario.
//
// The hazard it guards (run-scenarios.mjs:34-37, pre-fix): argv was mapped straight to
// resolve(a), so a dash-prefixed arg became a bogus path that threw INSIDE the run loop
// and was counted as one failed "scenario" — WHILE the remaining files still ran in
// host-mode. `run-scenarios.mjs --container x.yaml` therefore printed one [ERROR] plus a
// partial-success summary that a reader could mistake for container mode having run.
// The refusal must fire pre-execution: nonzero exit, the exact flag named, ZERO scenarios.
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.resolve(HERE, "../scripts/run-scenarios.mjs");
// A REAL scenario yaml (door-test shape): proves the file AFTER the flag is never run.
const REAL_SCENARIO = "test/fixtures/scenarios/scenario-01-per-seat-scripts.yaml";

function runWith(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", RUNNER, ...args], {
    encoding: "utf-8",
    env: { ...process.env },
  });
}

// A scenario ledger line or the partial summary — the tell that something ran.
const RAN_SOMETHING = /\[(PASS|FAIL|ERROR)\]|scenarios passed/;

describe("run-scenarios standalone runner — unknown-flag refusal (B12-S)", () => {
  it("refuses '--container <yaml>' pre-execution: nonzero exit, names --container, ZERO scenarios run", () => {
    const r = runWith(["--container", REAL_SCENARIO]);
    expect(r.status).toBe(2); // nonzero, distinct from the 1 = scenario-failures code
    expect(r.stderr).toContain("[REFUSED]");
    expect(r.stderr).toContain("--container");
    // Nothing executed: no scenario ledger line, no partial summary, empty stdout.
    expect(r.stdout).not.toMatch(RAN_SOMETHING);
    expect(r.stdout.trim()).toBe("");
  });

  it("names the EXACT offending flag (a bare '-x') and still runs nothing", () => {
    const r = runWith(["-x"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("'-x'");
    expect(r.stdout).not.toMatch(RAN_SOMETHING);
  });
});
