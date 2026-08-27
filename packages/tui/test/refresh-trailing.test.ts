import { describe, it, expect, vi } from "vitest";
import { createLiveRefresh } from "../src/live.js";
import { emptySnapshot } from "../src/state.js";
import type { FleetSnapshot } from "../src/types.js";

// WAVE O FIX R1 — B3 (R2 verdict 508e383d): singleFlight returned the in-flight promise
// for overlapping requests, so an oracle push arriving AFTER hydrate 1 read its snapshot
// but BEFORE it settled simply disappeared — the open view stayed stale until unrelated
// activity, violating AM-R18's automatic update. R2's discriminator, preserved: block
// hydrate 1, inject the same live.refresh() the push callback invokes, release, and the
// event must be represented by exactly one TRAILING hydrate — at most one, never zero.

function snap(tag: string): FleetSnapshot {
  return { ...emptySnapshot(), generatedAt: tag } as unknown as FleetSnapshot;
}

function tag(live: ReturnType<typeof createLiveRefresh>): string | undefined {
  return (live.snapshot() as unknown as { generatedAt?: string }).generatedAt;
}

describe("Wave-O B3 — overlapping refreshes coalesce into ONE trailing hydrate, never zero", () => {
  it("R2 DISCRIMINATOR: a push during an in-flight hydrate lands a trailing hydrate with the fresh snapshot", async () => {
    let release!: () => void;
    let calls = 0;
    const hydrate = vi.fn((): Promise<FleetSnapshot> => {
      calls += 1;
      if (calls === 1) return new Promise<FleetSnapshot>((r) => { release = () => r(snap("snapshot-1")); });
      return Promise.resolve(snap(`snapshot-${calls}`));
    });
    const live = createLiveRefresh({ hydrate, onFrame: () => {}, now: () => Date.now() });

    const first = live.refresh();
    await vi.waitFor(() => expect(calls).toBe(1)); // hydrate 1 is in flight, snapshot already read
    const pushed = live.refresh();                 // the oracle push's exact call path
    release();
    await Promise.all([first, pushed]);

    expect(calls).toBe(2); // candidate: 1 — the push joined hydrate 1 and disappeared
    expect(tag(live)).toBe("snapshot-2"); // the trailing read represents the event
  });

  it("bounded: MANY pushes during one flight coalesce into exactly one trailing hydrate", async () => {
    let release!: () => void;
    let calls = 0;
    const hydrate = vi.fn((): Promise<FleetSnapshot> => {
      calls += 1;
      if (calls === 1) return new Promise<FleetSnapshot>((r) => { release = () => r(snap("snapshot-1")); });
      return Promise.resolve(snap(`snapshot-${calls}`));
    });
    const live = createLiveRefresh({ hydrate, onFrame: () => {}, now: () => Date.now() });
    const first = live.refresh();
    await vi.waitFor(() => expect(calls).toBe(1));
    const pushes = [live.refresh(), live.refresh(), live.refresh()];
    release();
    await Promise.all([first, ...pushes]);
    expect(calls).toBe(2); // one trailing run absorbs them all — bounded work
  });

  it("no trailing hydrate when nothing arrived mid-flight (zero idle work preserved)", async () => {
    const hydrate = vi.fn(async () => snap("only"));
    const live = createLiveRefresh({ hydrate, onFrame: () => {}, now: () => Date.now() });
    await live.refresh();
    await new Promise((r) => setTimeout(r, 50));
    expect(hydrate).toHaveBeenCalledTimes(1);
  });

  it("error recovery survives the trailing path: a failed first hydrate still runs the trailing one and keeps the prior snapshot honest", async () => {
    let reject!: (e: Error) => void;
    let calls = 0;
    const hydrate = vi.fn((): Promise<FleetSnapshot> => {
      calls += 1;
      if (calls === 1) return new Promise<FleetSnapshot>((_r, rej) => { reject = () => rej(new Error("boom")); });
      return Promise.resolve(snap("recovered"));
    });
    const live = createLiveRefresh({ hydrate, onFrame: () => {}, now: () => Date.now() });
    const first = live.refresh();
    await vi.waitFor(() => expect(calls).toBe(1));
    const pushed = live.refresh();
    reject(new Error("boom"));
    await Promise.all([first, pushed]); // never rejects (owner contract)
    expect(calls).toBe(2);
    expect(tag(live)).toBe("recovered");
  });
});
