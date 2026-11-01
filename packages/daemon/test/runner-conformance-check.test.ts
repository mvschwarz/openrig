import { describe, expect, it } from "vitest";
import { execFile, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

// The runner conformance check that ships in docs/reference, run against a test double that keeps the contract, and
// against copies of it that each break one promise: the check must pass the first and catch every break.
const CHECK = resolve(__dirname, "../../../docs/reference/runner-conformance/check-runner.mjs");
const RUNNER = resolve(__dirname, "fixtures/runner-conformance/minimal-acp-runner.mjs");
const hasTmux = spawnSync("tmux", ["-V"]).status === 0;

type Check = { name: string; ok: boolean; detail?: string };
type Result = { id: string; status: "pass" | "fail" | "skip" | "advisory"; met?: boolean; checks: Check[]; reason?: string };
type Report = { results: Result[]; summary: { pass: number; fail: number; skip: number; advisory: number } };

async function check(args: string[], runnerFlags = ""): Promise<{ code: number; report: Report }> {
  const runner = `${process.execPath} ${RUNNER} --agent {agent}${runnerFlags}`;
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [CHECK, "--runner", runner, "--name", "minimal", "--json", ...args], { timeout: 90_000 });
    return { code: 0, report: JSON.parse(stdout) };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    if (!failed.stdout) throw new Error(`the check didn't report (exit ${failed.code}): ${failed.stderr}`);
    return { code: failed.code ?? -1, report: JSON.parse(failed.stdout) };
  }
}
const failing = (report: Report) => report.results.filter((r) => r.status === "fail")
  .map((r) => `${r.id}: ${r.checks.filter((c) => !c.ok).map((c) => `${c.name} (${c.detail})`).join("; ")}`);

describe.skipIf(!hasTmux)("the runner conformance check", () => {
  it("passes every case for a runner that keeps the contract", async () => {
    const { code, report } = await check(["--resume", "--first-input"]);
    expect(failing(report)).toEqual([]);
    expect(report.summary).toEqual({ pass: 11, fail: 0, skip: 0, advisory: 1 });
    expect(report.results.find((r) => r.id === "7c")).toMatchObject({ status: "advisory", met: true });
    expect(code).toBe(0);
  }, 120_000);

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

  it("skips resume and first input when the preset declares neither, and says why", async () => {
    const { code, report } = await check(["--cases", "6,9"]);
    expect(report.results.map((r) => [r.id, r.status])).toEqual([["6", "skip"], ["9", "skip"]]);
    expect(report.results.every((r) => r.reason)).toBe(true);
    expect(code).toBe(0);
  }, 60_000);

  // Each break, the case that must catch it, and the check in that case that names it.
  it.concurrent.each([
    ["record-early", "1", "no launch record while session/new is still unanswered"],
    ["record-on-failure", "1b", "no conversation in a launch record"],
    ["split-lines", "2", "one pasted block is exactly one session/prompt"],
    ["abort-in-block", "2", "a line reading /abort inside a block isn't control"],
    ["no-queue", "2", "a block sent mid-turn waits for the next turn"],
    ["cancelled-always", "2", "cancelled is reported only on the agent's own stop reason"],
    ["no-token", "3", "every post uses the hook token"],
    ["no-sequence", "3", "every post carries the contract's fields"],
    ["allow-permission", "4", "the answer is a refusal, never an allow option"],
    ["stop-while-attention", "4", "no idle Stop or beat while holding that attention"],
    ["silent-permission", "4", "what was asked is shown in the pane"],
    ["wrong-generation", "5", "generation is OPENRIG_OCCUPANT_GENERATION on every post"],
    ["new-on-resume", "6", "other failure: no new conversation starts"],
    ["missing-on-any-error", "6", "other failure: not reported missing or resumed"],
    ["idle-on-exit", "7", "no idle Stop after the exit"],
    ["no-error-post", "7b", "a failed session/prompt posts Notification/runtime_error"],
    ["ignore-unknown", "8", "the unknown request is answered -32601"],
    ["first-input-trim", "9", "the first prompt is the file's bytes, newlines and spaces included"],
  ])("catches %s in case %s", async (broken, id, name) => {
    const { code, report } = await check(["--cases", id, "--resume", "--first-input"], ` --break ${broken}`);
    const result = report.results.find((r) => r.id === id)!;
    expect(result.status).toBe("fail");
    // A case with several runs (1b's four failed handshakes, 6's three resumes) names each check after its run.
    expect(result.checks.filter((c) => !c.ok).map((c) => c.name)).toContainEqual(expect.stringContaining(name));
    expect(code).toBe(1);
  }, 90_000);

  // --wait-ms is for slow machines: a larger one must stretch the fake agent's own timings with the check's settling times,
  // so a runner that keeps the contract still passes. A factor of 3 outgrew case 1's handshake delay and case 2's holds.
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
