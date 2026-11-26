import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { CHECK, LATE_TIMERS, check, failing, hasTmux } from "./helpers/runner-conformance.js";

// The contract as a whole, wrapper support, advisory results, declared skips and tolerance of slow machines. Each break
// in cases 1-9 is in runner-conformance-breaks, case 3b is in runner-conformance-beat, and case 4b's breaks and passing
// variants are in runner-conformance-ask-*.
describe.skipIf(!hasTmux)("the runner conformance check", () => {
  it("passes every case for a runner that keeps the contract", async () => {
    const { code, report } = await check(["--resume", "--first-input"]);
    expect(failing(report)).toEqual([]);
    // 3b, the optional working beat, skips: this double sends no beats unless it's run with --beat.
    expect(report.summary).toEqual({ pass: 12, fail: 0, skip: 2, advisory: 2 });
    expect(report.results.find((r) => r.id === "3b")).toMatchObject({ status: "skip", reason: expect.stringContaining("optional") });
    expect(report.results.find((r) => r.id === "4c")).toMatchObject({ status: "advisory", met: true });
    expect(report.results.find((r) => r.id === "7c")).toMatchObject({ status: "advisory", met: true });
    expect(code).toBe(0);
  }, 120_000);

  it("checks native-child wrapping and environment scrubbing when the runner declares wrapper support", async () => {
    const { code, report } = await check(["--cases", "10", "--launch-wrapper"]);
    expect(failing(report)).toEqual([]);
    expect(report.results.map(r => [r.id, r.status])).toEqual([["10", "pass"]]);
    expect(code).toBe(0);
  }, 60_000);

  it.each(["ignore-wrapper", "leak-wrapper"])("rejects a runner that breaks wrapper conformance: %s", async mutation => {
    const { code, report } = await check(["--cases", "10", "--launch-wrapper"], ` --break ${mutation}`);
    expect(report.results).toMatchObject([{ id: "10", status: "fail" }]);
    expect(code).toBe(1);
  }, 60_000);

  // Section 9 marks the shutdown duty as proposed, and a runner may list what keeps running in its limits. So the check
  // reports it on its own, outside pass and fail and the exit status.
  it("reports an agent left running after the pane closes as an advisory result that doesn't fail the run", async () => {
    const { code, report } = await check(["--cases", "7b,7c"], " --break leave-agent");
    const shutdown = report.results.find((r) => r.id === "7c")!;
    expect(shutdown).toMatchObject({ status: "advisory", met: false });
    expect(shutdown.checks.filter((c) => !c.ok).map((c) => c.name)).toContainEqual(expect.stringContaining("closing the pane ends the agent process"));
    expect(report.results.find((r) => r.id === "7b")!.status).toBe("pass");
    expect(report.summary).toMatchObject({ fail: 0, advisory: 1 });
    expect(code).toBe(0);
  }, 90_000);

  // Section 7 lets a runner drop a person's words (OpenRig's `said`) and still keep the contract, so passing them on is
  // reported on its own, like the shutdown duty.
  it("reports a runner that drops the person's words as an advisory result that doesn't fail the run", async () => {
    const { code, report } = await check(["--cases", "4b,4c"], " --break drop-words");
    const words = report.results.find((r) => r.id === "4c")!;
    expect(words).toMatchObject({ status: "advisory", met: false });
    expect(words.checks.filter((c) => !c.ok).map((c) => c.name)).toContainEqual(expect.stringContaining("the person's words are queued to the agent as a prompt"));
    expect(report.results.find((r) => r.id === "4b")!.status).toBe("pass");
    expect(report.summary).toMatchObject({ fail: 0, advisory: 1 });
    expect(code).toBe(0);
  }, 90_000);

  it("skips resume and first input when the runner's preset declares neither, and says why", async () => {
    const { code, report } = await check(["--cases", "6,9"]);
    expect(report.results.map((r) => [r.id, r.status])).toEqual([["6", "skip"], ["9", "skip"]]);
    expect(report.results.every((r) => r.reason)).toBe(true);
    expect(code).toBe(0);
  }, 60_000);

  // A busy machine delays the check's own timers. Case 1 must still pass a runner that writes its record only after the
  // answer: whether a record came early is read against the fake agent's log, not against a fixed settle.
  it("passes case 1 for a runner that keeps the contract when the check's own timers run late", async () => {
    const { code, report } = await check(["--cases", "1"], "", ["--require", LATE_TIMERS]);
    expect(failing(report)).toEqual([]);
    expect(report.results.map((r) => [r.id, r.status])).toEqual([["1", "pass"]]);
    expect(code).toBe(0);
  }, 90_000);

  // A busy machine also delays the runner. Case 2 must still pass a runner that handles Ctrl-C late: the agent's turn
  // stays open until the cancel arrives, so only the runner's own delivery is timed.
  it("passes case 2 for a runner that keeps the contract when it handles Ctrl-C late", async () => {
    const { code, report } = await check(["--cases", "2"], " --interrupt-delay 4000");
    expect(failing(report)).toEqual([]);
    expect(report.results.map((r) => [r.id, r.status])).toEqual([["2", "pass"]]);
    expect(code).toBe(0);
  }, 90_000);

  // --wait-ms is for slow machines: a larger one must stretch the fake agent's own timings with the check's settling times,
  // so a runner that keeps the contract still passes. With fixed fake timings, a factor of 3 outgrows case 1's handshake
  // delay; case 2's holds would first be outgrown at about a factor of 12.
  it("still passes a runner that keeps the contract when --wait-ms triples every bound", async () => {
    const { code, report } = await check(["--cases", "1,2", "--wait-ms", "24000"]);
    expect(failing(report)).toEqual([]);
    expect(report.results.map((r) => [r.id, r.status])).toEqual([["1", "pass"], ["2", "pass"]]);
    expect(code).toBe(0);
  }, 180_000);

  it("refuses a runner command without {agent}, before starting anything", () => {
    const run = spawnSync(process.execPath, [CHECK, "--runner", "my-runner"], { encoding: "utf8" });
    expect(run.status).toBe(2);
    expect(run.stderr).toContain("{agent}");
  });
});
