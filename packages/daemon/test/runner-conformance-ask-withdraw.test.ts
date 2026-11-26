import { describe, expect, it } from "vitest";
import { check, expectCaught, failing, hasTmux } from "./helpers/runner-conformance.js";

// Case 4b, the ask a person answers: what is held while it waits, its withdrawal, and how the turn's end and idle reports
// relate to it.
describe.skipIf(!hasTmux)("the runner conformance check", () => {
  // Each mutation launches many tmux sessions; overlap can fail startup before reaching the intended break.
  it.each([
    ["hold-on-cancel", "4b", "stale ask: nothing is held"],
    ["hold-after-withdraw", "4b", "turn end: nothing is held once the ask is withdrawn"],
    ["stop-before-end", "4b", "turn end: nothing is held once the ask is withdrawn"],
    ["stop-low-sequence", "4b", "pending: no idle Stop while it waits"],
    // An idle Stop whose occurredAt isn't a string: OpenRig dates it by its arrival, so it counts.
    ["stop-numeric-time", "4b", "pending: no idle Stop while it waits"],
    ["hold-after-withdraw", "4b", "pending: after /abort, the turn's end is reported, holding nothing"],
    ["no-withdraw", "4b", "pending: /abort withdraws the ask with turn_cancelled"],
  ])("catches %s in case %s", (broken, id, name) => expectCaught(broken, id, name), 90_000);

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
});
