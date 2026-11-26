import { describe, expect, it } from "vitest";
import { SCALED_CLOCK, check, failing, hasTmux } from "./helpers/runner-conformance.js";

describe.skipIf(!hasTmux)("the runner conformance check", () => {
  // The optional working beat (section 4): a runner that beats in a quiet turn keeps 3b's promises, and each way of
  // breaking one is caught by the check that names it. Case 3b's three launches take about 90 s, so it gets a longer bound.
  // The passing run stays at real speed, the default-path control. The others run on a clock 4 times faster that the check,
  // the double and its fake agent all read (scaled-clock.cjs), so each window, beat and bound keeps its value in scaled
  // time; a passing run on that clock shows it fails nothing a good runner does.
  const CASE_3B_MS = 170_000;
  const scaled = () => ({
    args: ["--pass-env", "NODE_OPTIONS", "--pass-env", "OPENRIG_TEST_CLOCK_SCALE", "--pass-env", "OPENRIG_TEST_CLOCK_EPOCH"],
    env: { ...process.env, NODE_OPTIONS: `--require=${SCALED_CLOCK}`, OPENRIG_TEST_CLOCK_SCALE: "4", OPENRIG_TEST_CLOCK_EPOCH: String(Date.now()) },
  });
  it("passes 3b for a runner that beats through a quiet turn, stops while a person is asked, and resolves before beating again", async () => {
    const { code, report } = await check(["--cases", "3b"], " --beat", [], CASE_3B_MS);
    expect(failing(report)).toEqual([]);
    expect(report.results.map((r) => [r.id, r.status])).toEqual([["3b", "pass"]]);
    expect(code).toBe(0);
  }, CASE_3B_MS + 10_000);
  it("passes 3b on the scaled clock for the same runner", async () => {
    const clock = scaled();
    const { code, report } = await check(["--cases", "3b", ...clock.args], " --beat", [], CASE_3B_MS, clock.env);
    expect(failing(report)).toEqual([]);
    expect(report.results.map((r) => [r.id, r.status])).toEqual([["3b", "pass"]]);
    expect(code).toBe(0);
  }, CASE_3B_MS + 10_000);
  // On the scaled clock each break must fail exactly its own checks, so a timing slip can't stand in for the catch.
  // Without permission_resolved, every beat after the submit counts as during the ask, so no-resolve fails both.
  it.concurrent.each([
    ["beat-after-stop", ["no beat after the turn's Stop"]],
    ["beat-during-ask", ["asked: no beat while the ask waits on a person"]],
    ["no-resolve", ["asked: no beat while the ask waits on a person", "asked: after the answer, active/permission_resolved names the turn and the ask, before any beat"]],
    ["beat-time-backwards", ["sequence rises with the runner's own time across every post, beats included"]],
    // Just past the cadence bound: one beat 17 s into the turn, where livenessSeconds 30 allows at most 15 s (plus 1 s).
    ["beat-too-slow", ["beats come more often than every livenessSeconds / 2"]],
  ])("catches %s in case 3b, on the scaled clock", async (broken, names) => {
    const clock = scaled();
    const { code, report } = await check(["--cases", "3b", ...clock.args], ` --beat --break ${broken}`, [], CASE_3B_MS, clock.env);
    const result = report.results.find((r) => r.id === "3b")!;
    expect(result.status).toBe("fail");
    expect(result.checks.filter((c) => !c.ok).map((c) => c.name)).toEqual(names);
    expect(code).toBe(1);
  }, CASE_3B_MS + 10_000);
});
