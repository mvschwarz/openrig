import { expect, it } from "vitest";
import { fixture } from "./seat-reaper-fixture.js";
import { getNodeInventory } from "../src/domain/node-inventory.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { noticeRosterReady } from "../src/domain/roster-ready-notice.js";
import { reapEligibility } from "../src/domain/seat-reaper-eligibility.js";
import { SeatReaperService } from "../src/domain/seat-reaper-service.js";

it("keeps an otherwise idle seat eligible with an open roster-ready notice", async () => {
  const f = fixture();
  expect(await noticeRosterReady(new QueueRepository(f.db, f.bus, {}), "r", ["worker@test"])).toEqual([]);
  const [seat] = getNodeInventory(f.db, "r");
  if (!seat) throw new Error("fixture missing seat");

  expect(reapEligibility(f.db, seat, f.state)).toMatchObject({ eligible: true, snapshot: { inbox: 0 } });
});

it.each([
  ["pending", "pinned@test"], ["blocked", "pinned@test"], ["in-progress", "pinned@test"],
  ["pending", "worker@test"], ["blocked", "worker@test"], ["in-progress", "worker@test"],
])("inbox work in %s addressed to %s blocks reaping", async (state, destination) => {
  // Given an addressed live item.
  const f = fixture();
  f.db.exec("UPDATE sessions SET session_name='pinned@test'; UPDATE bindings SET tmux_session='pinned@test'");
  expect(await noticeRosterReady(new QueueRepository(f.db, f.bus, {}), "r", ["pinned@test"])).toEqual([]);
  f.db.prepare(`INSERT INTO queue_items(qitem_id,ts_created,ts_updated,source_session,destination_session,state,body)
    VALUES ('q',datetime('now'),datetime('now'),'sender@test',?,?,'work')`).run(destination, state);
  // When the reaper observes the full threshold.
  await f.mature();
  // Then active inbox work prevents every stop.
  expect(f.stops).toEqual([]); expect(f.events().at(-1)).toMatchObject({ decision: "pending-work" });
});

it.each(["input", "background", "terminal", "restore", "claimed", "protected", "coordination", "opt-out", "missing-activity"])(
  "refuses a seat with the %s predicate broken", async predicate => {
    // Given one broken instantaneous predicate.
    const f = fixture();
    switch (predicate) {
      case "input": f.state.needsInput.count = 1; break;
      case "background": f.state.backgroundWork = { rung: "self-report", observedAt: new Date(0).toISOString() }; break;
      case "terminal": f.db.exec("UPDATE nodes SET runtime='terminal'"); break;
      case "restore": f.db.exec("UPDATE sessions SET startup_status='pending'"); break;
      case "claimed": f.db.exec("UPDATE sessions SET origin='claimed'"); break;
      case "protected": f.settings.protectedRigs = ["test"]; break;
      case "coordination": f.db.exec("UPDATE rigs SET name='coordination'"); f.settings.optInRigs = ["coordination"]; break;
      case "opt-out": f.settings.optInRigs = []; break;
      case "missing-activity": f.deps.activity.getSeatStateBySession = () => null; break;
      default: throw Error(`unexpected predicate ${predicate}`);
    }
    // When it remains unsafe throughout the observation window.
    await f.mature();
    // Then no checked stop is called.
    expect(f.stops).toEqual([]);
  });

it("resets a durable clock after a daemon restart", async () => {
  // Given a mature observe-only clock persisted by the previous instance.
  const f = fixture(); f.settings.observe = true; await f.mature(); f.settings.observe = false;
  const restarted = new SeatReaperService(f.deps);
  // When the new daemon samples the same unchanged seat.
  await restarted.tick();
  // Then it cannot spend the previous daemon's clock.
  expect(f.stops).toEqual([]);
  expect(f.db.prepare("SELECT idle_first_seen_ms FROM seat_reap_state").get()).toEqual({ idle_first_seen_ms: 61 * 60_000 });
});

it("resets on an intervening activity transition even if the next sample is idle", async () => {
  // Given a clock one minute below threshold.
  const f = fixture(); await f.tick(); for (let i = 0; i < 59; i++) await f.tick();
  f.state.seq += 2;
  // When the oracle has observed work and returned to idle between reaper ticks.
  await f.tick();
  // Then the transition sequence fences the old idle window.
  expect(f.stops).toEqual([]);
});

it("resets on a missed sampling window", async () => {
  // Given an almost-mature clock.
  const f = fixture(); await f.tick(); for (let i = 0; i < 59; i++) await f.tick();
  // When the daemon misses more than two scheduled samples.
  await f.tick(3);
  // Then missing observation time is not idle proof.
  expect(f.stops).toEqual([]);
});
