// The stuck sweep yields the event loop, so the scheduler must not start a second pass while one is still running.
import { afterEach, describe, expect, it, vi } from "vitest";

const runStuckSweep = vi.fn();
vi.mock("../src/domain/queue-stuck-sweep.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/domain/queue-stuck-sweep.js")>()),
  runStuckSweep: (...args: unknown[]) => runStuckSweep(...args),
  resolveStuckSweepIntervalSeconds: () => 1,
}));

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); runStuckSweep.mockReset(); });

describe("startStuckSweepScheduler", () => {
  it("skips the ticks that come while a pass is still running, and runs again once it ends", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    runStuckSweep.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { startStuckSweepScheduler } = await import("../src/index.js");
    const handle = startStuckSweepScheduler({ rigRepo: { db: {} as never }, queueRepo: {} as never });
    try {
      expect(runStuckSweep).toHaveBeenCalledTimes(1); // the boot pass
      await vi.advanceTimersByTimeAsync(3_000); // three ticks while the boot pass runs
      expect(runStuckSweep).toHaveBeenCalledTimes(1);
      // each skipped tick says so, with the running pass's start
      expect(errors.mock.calls.filter(([line]) => String(line).startsWith("[stuck-sweep] tick skipped"))).toHaveLength(3);
      finish();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(runStuckSweep).toHaveBeenCalledTimes(2);
    } finally {
      if (handle) clearInterval(handle);
    }
  });
});
