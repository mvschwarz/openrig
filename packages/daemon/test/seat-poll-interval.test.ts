// daemon.seat_poll_interval_ms (OPENRIG_SEAT_POLL_INTERVAL_MS): the cadence of the seat-activity and structural-activity pollers. On a large fleet
// the fixed 1 s default was a large share of the daemon's CPU, with no knob to trade activity freshness for that
// load. The default is unchanged; the variable only slows the pollers down, up to a ceiling the structural
// observation's expiry allows.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_POLL_INTERVAL_MS, MAX_SEAT_POLL_INTERVAL_MS, MIN_SEAT_POLL_INTERVAL_MS, SeatActivityService,
  SEAT_POLL_INTERVAL_KEY, resolveSeatPollIntervalMs, startSeatPollers,
} from "../src/domain/seat-activity-service.js";
import { SettingsStore } from "../src/domain/user-settings/settings-store.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_STRUCTURAL_POLL_INTERVAL_MS, DEFAULT_STRUCTURAL_STALE_MS, SeatStructuralActivityService,
} from "../src/domain/seat-structural-activity-service.js";

const fixed = (value: unknown, source = "file") => () => ({ value, source });

describe("resolveSeatPollIntervalMs (the typed setting daemon.seat_poll_interval_ms)", () => {
  afterEach(() => { vi.unstubAllEnvs(); });

  it("keeps the 1 s default when the setting is unset", () => {
    const warn = vi.fn();
    expect(resolveSeatPollIntervalMs(fixed(1000, "default"), warn)).toBe(DEFAULT_POLL_INTERVAL_MS);
    expect(warn).not.toHaveBeenCalled();
    expect(DEFAULT_POLL_INTERVAL_MS).toBe(1000);
    expect(DEFAULT_STRUCTURAL_POLL_INTERVAL_MS).toBe(DEFAULT_POLL_INTERVAL_MS);
  });

  it("takes a whole number of milliseconds in 1000..2000, without a warning", () => {
    const warn = vi.fn();
    for (const v of [1000, 1500, 2000]) expect(resolveSeatPollIntervalMs(fixed(v), warn)).toBe(v);
    expect(warn).not.toHaveBeenCalled();
    expect([MIN_SEAT_POLL_INTERVAL_MS, MAX_SEAT_POLL_INTERVAL_MS]).toEqual([1000, 2000]);
  });

  it("keeps the default, with a warning, for a value the store could not check (outside 1000..2000 or not a number)", () => {
    for (const v of [999, 2001, 0, 1500.5, "abc"]) {
      const warn = vi.fn();
      expect(resolveSeatPollIntervalMs(fixed(v), warn)).toBe(DEFAULT_POLL_INTERVAL_MS);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain(`using ${DEFAULT_POLL_INTERVAL_MS} ms`);
    }
  });

  it("keeps the default, with a warning, when the setting cannot be read", () => {
    const warn = vi.fn();
    expect(resolveSeatPollIntervalMs(() => { throw new Error("bad config.json"); }, warn)).toBe(DEFAULT_POLL_INTERVAL_MS);
    expect(warn.mock.calls[0][0]).toContain("bad config.json");
  });

  it("reads the real store: config.json, then OPENRIG_SEAT_POLL_INTERVAL_MS over it; an env value out of range is dropped", () => {
    const dir = mkdtempSync(join(tmpdir(), "seat-poll-"));
    try {
      const cfg = join(dir, "config.json");
      writeFileSync(cfg, JSON.stringify({ daemon: { seatPollIntervalMs: 1500 } }));
      const store = new SettingsStore(cfg);
      const read = () => store.resolveOne(SEAT_POLL_INTERVAL_KEY as never);
      vi.stubEnv("OPENRIG_SEAT_POLL_INTERVAL_MS", "");
      expect(read()).toMatchObject({ value: 1500, source: "file" });
      expect(resolveSeatPollIntervalMs(read)).toBe(1500);
      vi.stubEnv("OPENRIG_SEAT_POLL_INTERVAL_MS", "2000");
      expect(read()).toMatchObject({ value: 2000, source: "env" });
      expect(resolveSeatPollIntervalMs(read)).toBe(2000);
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      vi.stubEnv("OPENRIG_SEAT_POLL_INTERVAL_MS", "5000");
      expect(read()).toMatchObject({ value: 1500, source: "file" });  // the bad env is dropped, with a warning
      expect(String(stderr.mock.calls.at(-1)?.[0])).toContain("daemon.seat_poll_interval_ms");
      stderr.mockRestore();
      expect(() => store.set(SEAT_POLL_INTERVAL_KEY as never, "2500")).toThrow(/\[1000, 2000\]/);
      expect(() => store.set(SEAT_POLL_INTERVAL_KEY as never, "999")).toThrow(/\[1000, 2000\]/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
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
    expect(startSeatPollers({ activity, structural }, db, fixed(2000), vi.fn())).toBe(2000);
    expect(activity.start).toHaveBeenCalledWith(db, 2000);
    expect(structural.start).toHaveBeenCalledWith(db, 2000);
    expect(startSeatPollers({ activity, structural }, db, fixed(1000, "default"), vi.fn())).toBe(1000);
    expect(activity.start).toHaveBeenLastCalledWith(db, 1000);
    expect(structural.start).toHaveBeenLastCalledWith(db, 1000);
  });
});
