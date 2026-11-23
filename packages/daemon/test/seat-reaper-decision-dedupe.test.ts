import { expect, it } from "vitest";
import { fixture } from "./seat-reaper-fixture.js";
import { SeatReaperService } from "../src/domain/seat-reaper-service.js";

// Review finding (slice 2): a decision event per seat per tick flooded the events
// ledger (~72k rows/day on a 50-seat fleet). A seat's decision is recorded when it
// changes, and at most hourly while it stays the same; receipts are unaffected.

it("records an unchanged refusal once, not once per tick", async () => {
  // Given a seat that is refused for a stable reason (a pending queue item).
  const f = fixture();
  f.db.prepare("INSERT INTO queue_items(qitem_id, ts_created, ts_updated, source_session, destination_session, state, body) VALUES ('q','0','0','x','worker@test','pending','b')").run();
  // When the reaper ticks many times without the reason changing.
  for (let i = 0; i < 30; i++) await f.tick();
  // Then the ledger holds one decision, not thirty.
  const decisions = f.events().filter(event => event.phase === "decision");
  expect(decisions).toHaveLength(1);
  expect(decisions[0]).toMatchObject({ decision: "pending-work", nodeId: "a" });
});

it("records the new decision when the refusal reason changes", async () => {
  // Given a seat first refused for pending work, then for being busy.
  const f = fixture();
  f.db.prepare("INSERT INTO queue_items(qitem_id, ts_created, ts_updated, source_session, destination_session, state, body) VALUES ('q','0','0','x','worker@test','pending','b')").run();
  await f.tick();
  f.db.prepare("DELETE FROM queue_items").run();
  f.state.activity = "working";
  // When the reason changes.
  await f.tick();
  // Then both decisions are on record, in order.
  const decisions = f.events().filter(event => event.phase === "decision");
  expect(decisions.map(event => event.decision)).toEqual(["pending-work", "ineligible"]);
});

it("still records would-reap-observe for an eligible seat, once per unchanged state", async () => {
  const f = fixture();
  f.settings.observe = true;
  for (let i = 0; i < 70; i++) await f.tick();
  const decisions = f.events().filter(event => event.phase === "decision");
  expect(decisions).toHaveLength(1);
  expect(decisions[0]).toMatchObject({ decision: "would-reap-observe", idleMinutes: 60 });
  expect(f.stops).toHaveLength(0);
});

it("defers instead of holding the delivery lease when the workspace re-check overruns", async () => {
  // Given a reaper whose in-lease workspace probe never settles.
  const f = fixture();
  // The per-rig pass probe answers clean; only the in-lease re-check never settles.
  let probes = 0;
  // Ticks 1..61 answer clean (61 = the pass probe of the tick that reaches the threshold) (the clock is still maturing); from the first tick past the
  // threshold the probe never settles, so the in-lease re-check must hit its deadline.
  f.deps.workspaceProbe = () => (++probes <= 61 ? Promise.resolve("clean" as const) : new Promise<never>(() => {}));
  f.deps.workspaceRecheckDeadlineMs = 20;
  // When an eligible seat crosses its threshold and the re-check is attempted.
  for (let i = 0; i < 61; i++) await f.tick();
  // Then no stop is attempted and the pass is treated as an uncertain probe.
  expect(f.stops).toHaveLength(0);
  expect(f.events().some(event => event.phase === "decision" && event.decision === "defer-probe-failed")).toBe(true);
}, 30_000);

// #3836 review: shutdown must not exit with an in-flight pass unwritten. stop() prevents
// new passes; drain() awaits the active one (its capture persisted, no stop after shutdown).
it("drains the in-flight pass at shutdown and starts no new one afterwards", async () => {
  const f = fixture();
  let releaseWorkspace: ((value: "clean") => void) | undefined;
  // The in-lease workspace re-check parks until the test releases it: a pass in flight.
  f.deps.workspaceProbe = () => new Promise(resolve => { releaseWorkspace = resolve; });
  const service = new SeatReaperService(f.deps);
  const ticked = service.tick();
  const drained = service.drain();
  service.stop();
  releaseWorkspace?.("clean");
  await drained; await ticked;
  // The pass completed under shutdown, and no new pass starts afterwards.
  expect(f.stops).toHaveLength(0);
  const eventsAfterShutdown = f.bus.replayAll(0).length;
  await service.tick();
  expect(f.bus.replayAll(0).length).toBe(eventsAfterShutdown);
});

// #3836 review: a seat owing a post-compact restore stage reads idle at the prompt with an
// empty inbox; it must be reap-proof both before the threshold and at the in-lease re-check.
it("never reaps a seat that owes a post-compact stage", async () => {
  const f = fixture();
  // Owed through the whole first window: the seat is reap-proof despite proven idle.
  let stagePending = true;
  f.deps.postCompactStagePending = () => stagePending;
  await f.mature();
  expect(f.stops).toHaveLength(0);
  // The stage settles: the next tick may reap.
  console.error("PRED before flip:", f.deps.postCompactStagePending?.());
  stagePending = false;
  console.error("PRED after flip:", f.deps.postCompactStagePending?.(), "stagePending:", stagePending);
  await f.tick();
  console.error("PRED after tick:", f.deps.postCompactStagePending?.(), "stops:", f.stops.length);
  expect(f.stops).toHaveLength(1);
});
