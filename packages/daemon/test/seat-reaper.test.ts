import { expect, it } from "vitest";
import { fixture } from "./seat-reaper-fixture.js";

it("leaves a fresh disabled database byte-identical and does not probe", async () => {
  // Given the default disabled posture.
  const f = fixture(); f.settings.enabled = false;
  const before = f.db.serialize();
  f.deps.workspaceProbe = async () => { throw Error("must not probe"); };
  // When a scheduled tick runs.
  await f.tick();
  // Then no state or terminal effects are introduced.
  expect(f.db.serialize()).toEqual(before); expect(f.stops).toEqual([]);
});

it("observes a mature eligible seat without capture or stop", async () => {
  // Given enabled observation.
  const f = fixture(); f.settings.observe = true;
  // When continuously eligible for the full threshold.
  await f.mature();
  // Then the decision is durable but no stop is attempted.
  expect(f.events()).toEqual([expect.objectContaining({ phase: "decision", decision: "would-reap-observe" })]);
  expect(f.stops).toEqual([]);
});

it.each(["unknown", "working"] as const)("resets the idle clock when activity becomes %s", async activity => {
  // Given an almost-mature clock.
  const f = fixture(); await f.tick(); for (let i = 0; i < 59; i++) await f.tick();
  // When proof of idle breaks and returns.
  f.state.activity = activity; await f.tick(); f.state.activity = "idle-at-prompt"; await f.tick();
  // Then the previous idle window cannot authorize a stop.
  expect(f.stops).toEqual([]);
});

it.each(["dirty-workspace", "defer-probe-failed"] as const)("resets the entire rig on workspace %s", async probe => {
  // Given a mature candidate whose workspace is unsafe.
  const f = fixture(); f.workspace(probe);
  // When scanning.
  await f.mature();
  // Then the rig is deferred without a stop.
  expect(f.stops).toEqual([]); expect(f.events()).toContainEqual(expect.objectContaining({ decision: probe }));
});

it("persists capture before checked stop and records refusal unchanged", async () => {
  // Given a checked-stop selection refusal and a ledger observer.
  const f = fixture(); const phases: string[] = [];
  f.bus.subscribe(event => { if (event.type === "seat.reaped") phases.push(event.phase); });
  const stop = f.deps.lifecycle.stopSeat;
  f.deps.lifecycle.stopSeat = async input => { expect(phases.at(-1)).toBe("capture"); return stop(input); };
  // When reaping the eligible seat.
  await f.mature();
  // Then capture precedes the checked call, and refusal is receipted.
  expect(f.stops).toEqual([{ seatRef: "worker@test", expected: { nodeId: "a", sessionId: "s" }, reason: "idle_reap", operator: "daemon:seat-reaper" }]);
  expect(f.events().at(-1)).toMatchObject({ phase: "effect", result: { code: "selection_changed" }, budgetConsumed: false });
});
