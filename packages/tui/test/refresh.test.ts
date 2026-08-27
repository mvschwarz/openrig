import { describe, expect, it } from "vitest";
import { singleFlight } from "../src/refresh.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("single-flight snapshot refresh", () => {
  it("coalesces an overlapping tick into ONE TRAILING pass that commits the newer truth (Wave-O B3, R2 508e383d — the old join-the-flight semantics lost the event)", async () => {
    const firstRead = deferred<string>();
    const commits: string[] = [];
    let hydrateCalls = 0;
    const refresh = singleFlight(async () => {
      hydrateCalls++;
      const snapshot = hydrateCalls === 1 ? await firstRead.promise : "item-6";
      commits.push(snapshot);
    });

    const first = refresh();
    const overlap = refresh();
    expect(overlap).toBe(first); // the caller still shares the flight's settlement…
    expect(hydrateCalls).toBe(1);

    firstRead.resolve("item-7");
    await Promise.all([first, overlap]);
    // …but the overlap is REPRESENTED: exactly one trailing pass commits the newer truth.
    expect(hydrateCalls).toBe(2);
    expect(commits).toEqual(["item-7", "item-6"]);

    await refresh();
    expect(hydrateCalls).toBe(3); // a fresh quiet tick runs exactly once — no residual dirt
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
