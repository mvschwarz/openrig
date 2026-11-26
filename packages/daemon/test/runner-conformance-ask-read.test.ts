import { describe, expect, it } from "vitest";
import { check, expectCaught, failing, hasTmux } from "./helpers/runner-conformance.js";

// Case 4b, the ask a person answers: what the runner does with each answer its read of the ask returns, and the ways of
// reading that keep the contract.
describe.skipIf(!hasTmux)("the runner conformance check", () => {
  // Each mutation launches many tmux sessions; overlap can fail startup before reaching the intended break.
  it.each([
    ["cancel-on-read-error", "4b", "unreachable read: the agent gets its allow_once option"],
    ["permit-on-not-current", "4b", "stale_generation: the agent gets cancelled"],
    ["permit-on-not-current", "4b", "activity_grant_stale read: the agent gets cancelled"],
    ["permit-on-refused-read", "4b", "refused read (said_no): the agent gets cancelled"],
    ["forget-permitted-ask", "4b", "unreachable read: the ask is still withdrawn at the turn's end"],
    ["cancel-on-revoked", "4b", "activity_grant_revoked: the agent gets its allow_once option"],
    ["cancel-on-unlisted-state", "4b", "unlisted read state (deferred): the agent gets its allow_once option"],
  ])("catches %s in case %s", (broken, id, name) => expectCaught(broken, id, name), 90_000);

  // Section 7 bounds a read's wait at 25 s and no lower: OpenRig's read takes 0 to 25 or none. A runner that polls without
  // waiting, and sleeps between reads itself, keeps the contract.
  it.each(["0", "none"])("passes 4b for a runner that reads with waitSeconds %s and waits between reads itself", async (wait) => {
    const { code, report } = await check(["--cases", "4b"], ` --read-wait ${wait}`);
    expect(failing(report)).toEqual([]);
    expect(report.results.map((r) => [r.id, r.status])).toEqual([["4b", "pass"]]);
    expect(code).toBe(0);
  }, 90_000);

  // Section 7 sets no time limit for a permit after a read OpenRig answered with a status it doesn't list. A runner that
  // retries such a read a few times first keeps the contract, so the check waits its ordinary per-step bound for it.
  it("passes 4b for a runner that retries a failed read three times, 1.5 s apart, before it permits", async () => {
    const { code, report } = await check(["--cases", "4b"], " --read-retries 3");
    expect(failing(report)).toEqual([]);
    expect(report.results.map((r) => [r.id, r.status])).toEqual([["4b", "pass"]]);
    expect(code).toBe(0);
  }, 120_000);
});
