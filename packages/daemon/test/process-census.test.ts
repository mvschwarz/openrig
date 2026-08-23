// OPR.0.5.3.10 mini-req 3 — the census contract: coalescing, freshness reuse,
// honest failure. Deterministic (injected lister + clock).
import { describe, it, expect, vi } from "vitest";
import { ProcessCensus } from "../src/domain/process-census.js";

const ROWS = [{ pid: 1, ppid: 0, command: "init" }];

describe("ProcessCensus", () => {
  it("coalesces concurrent callers onto ONE in-flight enumeration", async () => {
    let release!: (rows: typeof ROWS) => void;
    const list = vi.fn(() => new Promise<typeof ROWS>((r) => { release = r; }));
    const census = new ProcessCensus({ list, now: () => 0 });
    const a = census.list();
    const b = census.list();
    release(ROWS);
    expect(await a).toBe(ROWS);
    expect(await b).toBe(ROWS);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("reuses a recent SUCCESSFUL census inside the freshness window; refetches after it", async () => {
    let t = 0;
    const list = vi.fn(async () => ROWS);
    const census = new ProcessCensus({ list, freshnessMs: 1000, now: () => t });
    await census.list();
    t = 900;
    await census.list();
    expect(list).toHaveBeenCalledTimes(1);
    t = 1001;
    await census.list();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("a FAILED enumeration rejects every coalesced caller, caches nothing, and the next call retries", async () => {
    let calls = 0;
    const list = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("ps ENOMEM");
      return ROWS;
    });
    const census = new ProcessCensus({ list, freshnessMs: 60_000, now: () => 0 });
    const a = census.list();
    const b = census.list();
    await expect(a).rejects.toThrow("ps ENOMEM");
    await expect(b).rejects.toThrow("ps ENOMEM");
    // Failure was NOT cached as success: the next call actually retries.
    expect(await census.list()).toBe(ROWS);
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("cycleLister: at most one underlying census for the cycle, lazily — an idle cycle spawns nothing", async () => {
    const list = vi.fn(async () => ROWS);
    const census = new ProcessCensus({ list, freshnessMs: 0, now: (() => { let t = 0; return () => (t += 10_000); })() });
    const idle = census.cycleLister();
    void idle; // never invoked — no census
    expect(list).toHaveBeenCalledTimes(0);
    const cycle = census.cycleLister();
    await cycle();
    await cycle();
    await cycle();
    // freshness window is defeated by the advancing clock, yet the cycle memo holds: one fetch.
    expect(list).toHaveBeenCalledTimes(1);
    // A NEW cycle fetches again (stale window).
    await census.cycleLister()();
    expect(list).toHaveBeenCalledTimes(2);
  });
});
