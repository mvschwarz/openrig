import { describe, expect, it } from "vitest";
import { execFile, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

// The runner conformance check that ships in docs/reference, run against a test double that keeps the contract, and
// against copies of it that each break one promise: the check must pass the first and catch every break.
const CHECK = resolve(__dirname, "../../../docs/reference/runner-conformance/check-runner.mjs");
const RUNNER = resolve(__dirname, "fixtures/runner-conformance/minimal-acp-runner.mjs");
const LATE_TIMERS = resolve(__dirname, "fixtures/runner-conformance/late-check-timers.cjs");
const hasTmux = spawnSync("tmux", ["-V"]).status === 0;

type Check = { name: string; ok: boolean; detail?: string };
type Result = { id: string; status: "pass" | "fail" | "skip" | "advisory"; met?: boolean; checks: Check[]; reason?: string };
type Report = { results: Result[]; summary: { pass: number; fail: number; skip: number; advisory: number } };

async function check(args: string[], runnerFlags = "", nodeArgs: string[] = [], timeoutMs = 90_000): Promise<{ code: number; report: Report }> {
  const runner = `${process.execPath} ${RUNNER} --agent {agent}${runnerFlags}`;
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [...nodeArgs, CHECK, "--runner", runner, "--name", "minimal", "--json", ...args], { timeout: timeoutMs });
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

  // Each break, the case that must catch it, and the check in that case that names it.
  // Each mutation launches many tmux sessions; overlap can fail startup before reaching the intended break.
  it.each([
    ["record-early", "1", "no launch record while session/new is still unanswered"],
    ["record-on-failure", "1b", "no conversation in a launch record"],
    ["split-lines", "2", "one pasted block is exactly one session/prompt"],
    ["abort-in-block", "2", "a line reading /abort inside a block isn't control"],
    ["no-queue", "2", "a block sent mid-turn waits for the next turn"],
    ["cancelled-always", "2", "cancelled is reported only on the agent's own stop reason"],
    ["ctrl-c-ignored", "2", "Ctrl-C outside a paste sends session/cancel"],
    ["no-token", "3", "every post uses the hook token"],
    ["no-sequence", "3", "every post carries the contract's fields"],
    ["refuse-on-404", "4", "404: the agent gets its allow_once option"],
    ["prefer-always", "4", "404: the agent gets its allow_once option"],
    ["refuse-on-unreachable", "4", "unreachable: the agent gets its allow_once option"],
    ["permit-on-deny", "4", "denied_by_seat: the answer is a refusal, never an allow option"],
    ["stop-while-attention", "4", "denied_by_seat: no idle Stop or beat while holding that attention"],
    ["release-refusal-on-abort", "4", "denied_by_seat, then /abort: no idle Stop or beat while holding that attention"],
    ["silent-permission", "4", "denied_by_seat: what was asked is shown in the pane"],
    ["no-submit", "4b", "allow: the request is submitted to /api/activity/permission-requests"],
    ["wrong-request-id", "4b", "requestId is the agent's JSON-RPC id"],
    ["self-prompt", "4b", "OpenRig records the prompt; the runner doesn't post permission_prompt itself"],
    ["deliver-twice", "4b", "allow: it's delivered once"],
    ["refuse-on-refusal", "4b", "duplicate_request: the agent gets its allow_once option"],
    ["cancel-on-read-error", "4b", "unreachable read: the agent gets its allow_once option"],
    ["permit-on-not-current", "4b", "stale_generation: the agent gets cancelled"],
    ["permit-on-not-current", "4b", "activity_grant_stale read: the agent gets cancelled"],
    ["permit-on-refused-read", "4b", "refused read (said_no): the agent gets cancelled"],
    ["hold-on-cancel", "4b", "stale ask: nothing is held"],
    ["hold-after-withdraw", "4b", "turn end: nothing is held once the ask is withdrawn"],
    ["stop-before-end", "4b", "turn end: nothing is held once the ask is withdrawn"],
    ["stop-low-sequence", "4b", "pending: no idle Stop while it waits"],
    // An idle Stop whose occurredAt isn't a string: OpenRig dates it by its arrival, so it counts.
    ["stop-numeric-time", "4b", "pending: no idle Stop while it waits"],
    ["hold-after-withdraw", "4b", "pending: after /abort, the turn's end is reported, holding nothing"],
    ["forget-permitted-ask", "4b", "unreachable read: the ask is still withdrawn at the turn's end"],
    ["cancel-on-revoked", "4b", "activity_grant_revoked: the agent gets its allow_once option"],
    ["cancel-on-unlisted-state", "4b", "unlisted read state (deferred): the agent gets its allow_once option"],
    ["no-withdraw", "4b", "pending: /abort withdraws the ask with turn_cancelled"],
    ["late-deliver", "4b", "pending: an answer after the withdraw isn't delivered"],
    ["paste-answers", "4b", "pending: a pasted message isn't an answer"],
    ["said-as-answer", "4b", "permitted at read, with the person's words: the agent gets its allow_once option"],
    ["wrong-generation", "5", "generation is OPENRIG_OCCUPANT_GENERATION on every post"],
    ["new-on-resume", "6", "other failure: no new conversation starts"],
    ["missing-on-any-error", "6", "other failure: not reported missing or resumed"],
    ["idle-on-exit", "7", "no idle report for the turn it died in"],
    // An idle Stop numbered below the turn's accepted prompt but later in time: OpenRig orders by time first, so it counts.
    ["idle-low-sequence-on-exit", "7", "no idle report for the turn it died in"],
    // An idle Stop at the accepted prompt's time with a string sequence: OpenRig reads no sequence there, so it counts.
    ["idle-string-sequence-on-exit", "7", "no idle report for the turn it died in"],
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

  // Section 7 bounds a read's wait at 25 s and no lower: OpenRig's read takes 0 to 25 or none. A runner that polls without
  // waiting, and sleeps between reads itself, keeps the contract.
  it.each(["0", "none"])("passes 4b for a runner that reads with waitSeconds %s and waits between reads itself", async (wait) => {
    const { code, report } = await check(["--cases", "4b"], ` --read-wait ${wait}`);
    expect(failing(report)).toEqual([]);
    expect(report.results.map((r) => [r.id, r.status])).toEqual([["4b", "pass"]]);
    expect(code).toBe(0);
  }, 90_000);

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

  // The optional working beat (section 4): a runner that beats in a quiet turn keeps 3b's promises, and each way of
  // breaking one is caught by the check that names it. Case 3b's three launches take about 90 s, so it gets a longer bound.
  const CASE_3B_MS = 170_000;
  it("passes 3b for a runner that beats through a quiet turn, stops while a person is asked, and resolves before beating again", async () => {
    const { code, report } = await check(["--cases", "3b"], " --beat", [], CASE_3B_MS);
    expect(failing(report)).toEqual([]);
    expect(report.results.map((r) => [r.id, r.status])).toEqual([["3b", "pass"]]);
    expect(code).toBe(0);
  }, CASE_3B_MS + 10_000);
  it.concurrent.each([
    ["beat-after-stop", "no beat after the turn's Stop"],
    ["beat-during-ask", "asked: no beat while the ask waits on a person"],
    ["no-resolve", "asked: after the answer, active/permission_resolved names the turn and the ask, before any beat"],
    ["beat-time-backwards", "sequence rises with the runner's own time across every post, beats included"],
  ])("catches %s in case 3b", async (broken, name) => {
    const { code, report } = await check(["--cases", "3b"], ` --beat --break ${broken}`, [], CASE_3B_MS);
    const result = report.results.find((r) => r.id === "3b")!;
    expect(result.status).toBe("fail");
    expect(result.checks.filter((c) => !c.ok).map((c) => c.name)).toContainEqual(expect.stringContaining(name));
    expect(code).toBe(1);
  }, CASE_3B_MS + 10_000);

  // Section 7 sets no time limit for a permit after a read OpenRig answered with a status it doesn't list. A runner that
  // retries such a read a few times first keeps the contract, so the check waits its ordinary per-step bound for it.
  it("passes 4b for a runner that retries a failed read three times, 1.5 s apart, before it permits", async () => {
    const { code, report } = await check(["--cases", "4b"], " --read-retries 3");
    expect(failing(report)).toEqual([]);
    expect(report.results.map((r) => [r.id, r.status])).toEqual([["4b", "pass"]]);
    expect(code).toBe(0);
  }, 120_000);

  // A runner may report idle at startup, before any turn: that's neither an idle report while an ask waits (4b) nor one
  // for a turn the agent died in (7), even when its POST arrives after the agent's exit.
  it("passes 4b and 7 for a runner that reports idle at startup, even when that report arrives late", async () => {
    const { code, report } = await check(["--cases", "4b,7"], " --startup-idle 1500");
    expect(failing(report)).toEqual([]);
    expect(report.results.map((r) => [r.id, r.status])).toEqual([["4b", "pass"], ["7", "pass"]]);
    expect(code).toBe(0);
  }, 150_000);

  // The contract doesn't order a turn's Stop and its ask's withdraw. A runner that posts the Stop first keeps it.
  it("passes 4b for a runner that withdraws a cancelled or ended turn's ask after posting its Stop", async () => {
    const { code, report } = await check(["--cases", "4b"], " --withdraw-after-stop");
    expect(failing(report)).toEqual([]);
    expect(report.results.map((r) => [r.id, r.status])).toEqual([["4b", "pass"]]);
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
