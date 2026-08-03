import { describe, expect, it } from "vitest";
import { singleFlight } from "../src/refresh.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("single-flight snapshot refresh", () => {
  it("coalesces an overlapping tick, then lets the next tick commit newer truth", async () => {
    const firstRead = deferred<string>();
    const commits: string[] = [];
    let hydrateCalls = 0;
    let draws = 0;
    const refresh = singleFlight(async () => {
      hydrateCalls++;
      const snapshot = hydrateCalls === 1 ? await firstRead.promise : "item-6";
      commits.push(snapshot);
      draws++;
    });

    const first = refresh();
    const overlap = refresh();
    expect(overlap).toBe(first);
    expect(hydrateCalls).toBe(1);

    firstRead.resolve("item-7");
    await Promise.all([first, overlap]);
    expect(commits).toEqual(["item-7"]);
    expect(draws).toBe(1);

    await refresh();
    expect(hydrateCalls).toBe(2);
    expect(commits).toEqual(["item-7", "item-6"]);
    expect(draws).toBe(2);
  });

  it("releases the guard after rejection so the next tick retries", async () => {
    let attempts = 0;
    const refresh = singleFlight(async () => {
      attempts++;
      if (attempts === 1) throw new Error("hydrate failed");
    });

    await expect(refresh()).rejects.toThrow("hydrate failed");
    await expect(refresh()).resolves.toBeUndefined();
    expect(attempts).toBe(2);
  });
});
