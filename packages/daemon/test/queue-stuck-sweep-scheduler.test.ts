// The stuck sweep re-arms after each pass finishes, so passes never overlap and interval config changes apply to the next pass.
import { afterEach, describe, expect, it, vi } from "vitest";

const runStuckSweep = vi.fn();
const intervalSeconds = vi.fn(() => 1);
vi.mock("../src/domain/queue-stuck-sweep.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/domain/queue-stuck-sweep.js")>()),
  runStuckSweep: (...args: unknown[]) => runStuckSweep(...args),
  resolveStuckSweepIntervalSeconds: () => intervalSeconds(),
}));

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); runStuckSweep.mockReset(); intervalSeconds.mockReset(); intervalSeconds.mockReturnValue(1); });

describe("startStuckSweepScheduler", () => {
  it("does not overlap passes and arms the next pass only after the running pass ends", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    runStuckSweep.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { startStuckSweepScheduler } = await import("../src/index.js");
    const handle = startStuckSweepScheduler({ rigRepo: { db: {} as never }, queueRepo: {} as never });
    try {
      expect(runStuckSweep).toHaveBeenCalledTimes(1); // the boot pass
      await vi.advanceTimersByTimeAsync(3_000); // time passes while the boot pass is still running
      expect(runStuckSweep).toHaveBeenCalledTimes(1);
      finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(runStuckSweep).toHaveBeenCalledTimes(1); // wait begins after completion
      await vi.advanceTimersByTimeAsync(1_000);
      expect(runStuckSweep).toHaveBeenCalledTimes(2);
    } finally {
      handle?.stop();
    }
  });

  it("shows the running pass on the status snapshot that /healthz serves", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T12:00:00.000Z"));
    let finish!: () => void;
    runStuckSweep.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { startStuckSweepScheduler } = await import("../src/index.js");
    const deps: Parameters<typeof startStuckSweepScheduler>[0] = { rigRepo: { db: {} as never }, queueRepo: {} as never };
    const handle = startStuckSweepScheduler(deps);
    try {
      const status = deps.stuckSweepStatus!;
      expect(status.snapshot()).toMatchObject({ runningSince: "2026-11-07T12:00:00.000Z", skippedTicks: 0 });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(status.snapshot()).toMatchObject({ runningSince: "2026-11-07T12:00:00.000Z", skippedTicks: 0 });
      finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(status.snapshot()).toMatchObject({ runningSince: null, skippedTicks: 0 });
      await vi.advanceTimersByTimeAsync(1_000);
      expect(status.snapshot()).toMatchObject({ runningSince: "2026-11-07T12:00:03.000Z", skippedTicks: 0 });
    } finally {
      handle?.stop();
    }
  });

  it("re-reads queue.stuck_sweep_interval_seconds for the next pass without a daemon restart (#3635)", async () => {
    vi.useFakeTimers();
    runStuckSweep.mockResolvedValue(undefined);
    intervalSeconds.mockReturnValue(5);
    const { startStuckSweepScheduler } = await import("../src/index.js");
    const handle = startStuckSweepScheduler({ rigRepo: { db: {} as never }, queueRepo: {} as never });
    try {
      expect(runStuckSweep).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(0);
      intervalSeconds.mockReturnValue(2);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(runStuckSweep).toHaveBeenCalledTimes(1); // first pass armed with 5s
      await vi.advanceTimersByTimeAsync(1);
      expect(runStuckSweep).toHaveBeenCalledTimes(2); // second pass starts, re-arms with 2s
      await vi.advanceTimersByTimeAsync(2_000);
      expect(runStuckSweep).toHaveBeenCalledTimes(3);
      handle?.stop();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(runStuckSweep).toHaveBeenCalledTimes(3);
    } finally {
      handle?.stop();
    }
  });
});
