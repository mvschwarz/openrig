import { describe, it, expect } from "vitest";
import {
  EventLoopMonitor,
  evaluateEventLoopHealthy,
  EVENT_LOOP_LAG_UNHEALTHY_MS,
  LAST_TICK_STALE_MS,
} from "../src/domain/event-loop-monitor.js";

// OPR.0.4.3.21 — the named thresholds are PROVEN here (no magic numbers): the
// pure verdict is exercised at its exact boundaries, and the last-tick stall
// signal is proven deterministically against an injected clock.

describe("evaluateEventLoopHealthy — named thresholds proven at the boundary", () => {
  it("healthy when both lag and last-tick are strictly under threshold", () => {
    expect(
      evaluateEventLoopHealthy({
        lagMeanMs: EVENT_LOOP_LAG_UNHEALTHY_MS - 1,
        lastTickAgeMs: LAST_TICK_STALE_MS - 1,
      }),
    ).toBe(true);
  });

  it("unhealthy exactly AT the lag threshold", () => {
    expect(
      evaluateEventLoopHealthy({ lagMeanMs: EVENT_LOOP_LAG_UNHEALTHY_MS, lastTickAgeMs: 0 }),
    ).toBe(false);
  });

  it("unhealthy exactly AT the last-tick stale threshold", () => {
    expect(
      evaluateEventLoopHealthy({ lagMeanMs: 0, lastTickAgeMs: LAST_TICK_STALE_MS }),
    ).toBe(false);
  });
});

describe("EventLoopMonitor — last-tick age grows while the loop does not tick", () => {
  it("reports rising last-tick age and flips healthy=false past the stale threshold", () => {
    let clock = 1_000;
    const monitor = new EventLoopMonitor({ now: () => clock, autoStart: false });
    monitor.recordTick(); // tick recorded at clock=1000

    // Just under the stale threshold: still healthy.
    clock = 1_000 + LAST_TICK_STALE_MS - 1;
    let snap = monitor.snapshot();
    expect(snap.lastTickAgeMs).toBe(LAST_TICK_STALE_MS - 1);
    expect(snap.healthy).toBe(true);

    // Loop stalled: the interval could not fire, so no recordTick — age reaches
    // the stale threshold and the verdict flips.
    clock = 1_000 + LAST_TICK_STALE_MS;
    snap = monitor.snapshot();
    expect(snap.lastTickAgeMs).toBe(LAST_TICK_STALE_MS);
    expect(snap.healthy).toBe(false);

    monitor.stop();
  });

  it("snapshot has a finite, non-negative shape even before the histogram warms up", () => {
    const monitor = new EventLoopMonitor({ autoStart: false });
    const snap = monitor.snapshot();
    expect(Number.isFinite(snap.lagMeanMs)).toBe(true);
    expect(Number.isFinite(snap.lagP99Ms)).toBe(true);
    expect(snap.lastTickAgeMs).toBeGreaterThanOrEqual(0);
    expect(typeof snap.healthy).toBe("boolean");
    monitor.stop();
  });
});

describe("EventLoopMonitor — real histogram captures a synthetic block", () => {
  it("records measurable event-loop delay after a synchronous block", async () => {
    const monitor = new EventLoopMonitor();
    // Block the loop synchronously so the histogram's internal timer fires late.
    const until = Date.now() + 200;
    while (Date.now() < until) { /* busy-wait */ }
    // Let the delayed timer sample land in the histogram.
    await new Promise((r) => setTimeout(r, 30));
    const snap = monitor.snapshot();
    // Loose assertion (real timing is non-deterministic) — proves capture works.
    expect(snap.lagP99Ms).toBeGreaterThan(0);
    monitor.stop();
  });
});
