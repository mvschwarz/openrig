// OPENRIG_SEAT_POLL_INTERVAL_MS: the cadence of the seat-activity and structural-activity pollers. On a large fleet
// the fixed 1 s default was a large share of the daemon's CPU, with no knob to trade activity freshness for that
// load. The default is unchanged; the variable only slows the pollers down, up to a ceiling the structural
// observation's expiry allows.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_POLL_INTERVAL_MS, MAX_SEAT_POLL_INTERVAL_MS, MIN_SEAT_POLL_INTERVAL_MS, SeatActivityService,
  resolveSeatPollIntervalMs, startSeatPollers,
} from "../src/domain/seat-activity-service.js";
import {
  DEFAULT_STRUCTURAL_POLL_INTERVAL_MS, DEFAULT_STRUCTURAL_STALE_MS, SeatStructuralActivityService,
} from "../src/domain/seat-structural-activity-service.js";

const env = (v: string) => ({ OPENRIG_SEAT_POLL_INTERVAL_MS: v });

describe("resolveSeatPollIntervalMs", () => {
  it("keeps the 1 s default, silently, when unset or empty", () => {
    const warn = vi.fn();
    for (const e of [{}, env(""), env("  ")]) expect(resolveSeatPollIntervalMs(e, warn)).toBe(DEFAULT_POLL_INTERVAL_MS);
    expect(warn).not.toHaveBeenCalled();
    expect(DEFAULT_POLL_INTERVAL_MS).toBe(1000);
    expect(DEFAULT_STRUCTURAL_POLL_INTERVAL_MS).toBe(DEFAULT_POLL_INTERVAL_MS);
  });

  it("keeps the default, with a warning, when the value is not a whole number of milliseconds", () => {
    for (const v of ["abc", "1.5", "-5", "3s", "1e4"]) {
      const warn = vi.fn();
      expect(resolveSeatPollIntervalMs(env(v), warn)).toBe(DEFAULT_POLL_INTERVAL_MS);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain("not a whole number");
    }
  });

  it("takes a whole number of milliseconds in 1000..2000, trimmed, without a warning", () => {
    const warn = vi.fn();
    expect(resolveSeatPollIntervalMs(env("2000"), warn)).toBe(2000);
    expect(resolveSeatPollIntervalMs(env(" 1500 "), warn)).toBe(1500);
    expect(resolveSeatPollIntervalMs(env("1000"), warn)).toBe(1000);
    expect(warn).not.toHaveBeenCalled();
    expect([MIN_SEAT_POLL_INTERVAL_MS, MAX_SEAT_POLL_INTERVAL_MS]).toEqual([1000, 2000]);
  });

  it("clamps to 1000..2000, with a warning", () => {
    for (const [v, want] of [["999", 1000], ["10", 1000], ["0", 1000], ["2001", 2000], ["3000", 2000], ["999999", 2000]] as const) {
      const warn = vi.fn();
      expect(resolveSeatPollIntervalMs(env(v), warn)).toBe(want);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain(`using ${want} ms`);
    }
  });

  it("keeps two intervals below the structural expiry, the age a working-frame proof can reach", () => {
    expect(2 * MAX_SEAT_POLL_INTERVAL_MS).toBeLessThan(DEFAULT_STRUCTURAL_STALE_MS);
  });
});

describe("both pollers run at the configured cadence", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  const ticksPerMinute = (proto: object, intervalMs?: number): number => {
    const svc = Object.create(proto) as { start(db: never, ms?: number): void; stop(): void };
    let n = 0;
    (svc as unknown as { pollAllRunningTmuxSeats: () => Promise<void> }).pollAllRunningTmuxSeats = async () => { n++; };
    svc.start({} as never, intervalMs);
    vi.advanceTimersByTime(60_000);
    svc.stop();
    return n;
  };

  it("the structural poller ticks half as often at 2000 ms as at the default", () => {
    vi.useFakeTimers();
    expect(ticksPerMinute(SeatStructuralActivityService.prototype)).toBe(60);
    expect(ticksPerMinute(SeatStructuralActivityService.prototype, 2000)).toBe(30);
  });

  it("the seat-activity sampler ticks half as often at 2000 ms as at the default", () => {
    vi.useFakeTimers();
    expect(ticksPerMinute(SeatActivityService.prototype)).toBe(60);
    expect(ticksPerMinute(SeatActivityService.prototype, 2000)).toBe(30);
  });

  it("startSeatPollers starts both with the cadence from the environment", () => {
    const activity = { start: vi.fn() };
    const structural = { start: vi.fn() };
    const db = {} as never;
    expect(startSeatPollers({ activity, structural }, db, env("2000"), vi.fn())).toBe(2000);
    expect(activity.start).toHaveBeenCalledWith(db, 2000);
    expect(structural.start).toHaveBeenCalledWith(db, 2000);
    expect(startSeatPollers({ activity, structural }, db, {}, vi.fn())).toBe(1000);
    expect(activity.start).toHaveBeenLastCalledWith(db, 1000);
    expect(structural.start).toHaveBeenLastCalledWith(db, 1000);
  });
});
