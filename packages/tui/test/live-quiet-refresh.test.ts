import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLiveRefresh, QUIET_REFRESH_MS } from "../src/live.js";
import { emptySnapshot } from "../src/state.js";
import type { FleetSnapshot } from "../src/types.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("S17 bounded quiet refresh", () => {
  it("a completed hydrate passively rehydrates after 30 seconds, never in a 5-second series", async () => {
    vi.useFakeTimers();
    const hydrate = vi.fn(async () => emptySnapshot());
    const live = createLiveRefresh({ hydrate, onFrame: () => {}, now: () => 0 });

    await live.refresh();
    expect(hydrate).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(hydrate).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(QUIET_REFRESH_MS - 5_000);
    expect(hydrate).toHaveBeenCalledTimes(2);
    live.close();
  });

  it("arms exactly one timeout only after hydrate completion and clears it on close", async () => {
    vi.useFakeTimers();
    const first = deferred<FleetSnapshot>();
    const hydrate = vi.fn(() => first.promise);
    const live = createLiveRefresh({ hydrate, onFrame: () => {}, now: () => 0 });

    const refresh = live.refresh();
    expect(vi.getTimerCount()).toBe(0);

    first.resolve(emptySnapshot());
    await refresh;
    expect(vi.getTimerCount()).toBe(1);

    live.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never schedules a fallback while hydrate is in flight, then re-arms from completion", async () => {
    vi.useFakeTimers();
    const second = deferred<FleetSnapshot>();
    let calls = 0;
    const hydrate = vi.fn(() => {
      calls += 1;
      return calls === 2 ? second.promise : Promise.resolve(emptySnapshot());
    });
    const live = createLiveRefresh({ hydrate, onFrame: () => {}, now: () => 0 });

    await live.refresh();
    await vi.advanceTimersByTimeAsync(QUIET_REFRESH_MS);
    expect(hydrate).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(QUIET_REFRESH_MS * 2);
    expect(hydrate).toHaveBeenCalledTimes(2);

    second.resolve(emptySnapshot());
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(QUIET_REFRESH_MS - 1);
    expect(hydrate).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(hydrate).toHaveBeenCalledTimes(3);
    live.close();
  });

  it("an event/operator refresh clears the old timeout and earns a full new quiet window", async () => {
    vi.useFakeTimers();
    const hydrate = vi.fn(async () => emptySnapshot());
    const live = createLiveRefresh({ hydrate, onFrame: () => {}, now: () => 0 });

    await live.refresh();
    await vi.advanceTimersByTimeAsync(10_000);
    await live.refresh();
    expect(hydrate).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(hydrate).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(hydrate).toHaveBeenCalledTimes(3);
    live.close();
  });

  it("keeps two open clients independent when only one receives an early refresh", async () => {
    vi.useFakeTimers();
    const hydrateA = vi.fn(async () => emptySnapshot());
    const hydrateB = vi.fn(async () => emptySnapshot());
    const liveA = createLiveRefresh({ hydrate: hydrateA, onFrame: () => {}, now: () => 0 });
    const liveB = createLiveRefresh({ hydrate: hydrateB, onFrame: () => {}, now: () => 0 });

    await Promise.all([liveA.refresh(), liveB.refresh()]);
    await vi.advanceTimersByTimeAsync(15_000);
    await liveA.refresh();
    expect(hydrateA).toHaveBeenCalledTimes(2);
    expect(hydrateB).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(hydrateA).toHaveBeenCalledTimes(2);
    expect(hydrateB).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(hydrateA).toHaveBeenCalledTimes(3);
    expect(hydrateB).toHaveBeenCalledTimes(2);
    liveA.close();
    liveB.close();
  });

  it("unrefs the production timeout handle and cancels that exact handle on close", async () => {
    const unref = vi.fn();
    const handle = { unref };
    const setTimeout = vi.fn(() => handle);
    const clearTimeout = vi.fn();
    const live = createLiveRefresh({
      hydrate: async () => emptySnapshot(),
      onFrame: () => {},
      now: () => 0,
      setTimeout,
      clearTimeout,
    });

    await live.refresh();
    expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), QUIET_REFRESH_MS);
    expect(unref).toHaveBeenCalledOnce();

    live.close();
    expect(clearTimeout).toHaveBeenCalledWith(handle);
  });

  it("wires refresh-owner cleanup into the TUI shutdown path", () => {
    const main = readFileSync(join(repoRoot, "packages", "tui", "src", "main.ts"), "utf8");
    const shutdown = main.slice(main.indexOf("async function shutdown"), main.indexOf("process.on(\"SIGINT\""));
    expect(shutdown).toContain("live?.close()");
  });
});
