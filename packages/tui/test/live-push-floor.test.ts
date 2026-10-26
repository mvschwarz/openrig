import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONNECTED_QUIET_REFRESH_MS, createLiveRefresh, PUSH_REFRESH_FLOOR_MS, QUIET_REFRESH_MS } from "../src/live.js";
import { emptySnapshot } from "../src/state.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

afterEach(() => {
  vi.useRealTimers();
});

function setup() {
  vi.useFakeTimers();
  const start = Date.now();
  const hydrate = vi.fn(async () => emptySnapshot());
  const live = createLiveRefresh({ hydrate, onFrame: () => {}, now: () => Date.now() });
  const at = async (ms: number) => { await vi.advanceTimersByTimeAsync(start + ms - Date.now()); };
  return { hydrate, live, at };
}

describe("activity pushes refresh at most once per 15 seconds", () => {
  it("the first push refreshes at once; pushes inside the window share one trailing refresh at its end", async () => {
    const { hydrate, live, at } = setup();
    live.pushed();
    await at(0);
    expect(hydrate).toHaveBeenCalledTimes(1);
    for (const ms of [1_000, 2_000, 5_000]) { await at(ms); live.pushed(); }
    await at(PUSH_REFRESH_FLOOR_MS - 1);
    expect(hydrate).toHaveBeenCalledTimes(1);
    await at(PUSH_REFRESH_FLOOR_MS);
    expect(hydrate).toHaveBeenCalledTimes(2);

    // A push a full window after the last read refreshes at once.
    await at(PUSH_REFRESH_FLOOR_MS * 2);
    live.pushed();
    await at(PUSH_REFRESH_FLOOR_MS * 2);
    expect(hydrate).toHaveBeenCalledTimes(3);
    live.close();
  });

  it("a push waiting for its trailing refresh doesn't mark the page stale", async () => {
    const { live, at } = setup();
    live.pushed();
    await at(0);
    await at(1_000);
    live.pushed();
    expect(live.load().stale).toBe(false);
    live.close();
  });

  it("a refresh the person asks for runs at once, and covers a waiting push", async () => {
    const { hydrate, live, at } = setup();
    live.pushed();
    await at(0);
    await at(1_000);
    live.pushed();
    await at(2_000);
    await live.refresh();
    expect(hydrate).toHaveBeenCalledTimes(2);
    await at(PUSH_REFRESH_FLOOR_MS + 5_000);
    expect(hydrate).toHaveBeenCalledTimes(2);
    live.close();
  });

  it("a build mismatch cancels a waiting push refresh, and later pushes don't refresh", async () => {
    const { hydrate, live, at } = setup();
    live.pushed();
    await at(0);
    await at(1_000);
    live.pushed();
    live.stopBackground("Restart rig tui: daemon is now 0.6.12 (9e5382dd); auto-refresh off.");
    await at(PUSH_REFRESH_FLOOR_MS + 5_000);
    live.pushed();
    await at(PUSH_REFRESH_FLOOR_MS * 3);
    expect(hydrate).toHaveBeenCalledTimes(1);
    live.close();
  });

  it("main sends activity pushes through the floor", () => {
    const main = readFileSync(join(repoRoot, "packages", "tui", "src", "main.ts"), "utf8");
    expect(main).toContain("live.pushed();");
    expect(main).not.toContain("void live.invalidate(); }");
  });
});

describe("the quiet fallback", () => {
  it("keeps the connected cadence when navigating to a new page", async () => {
    vi.useFakeTimers();
    let scope = "topology";
    const hydrate = vi.fn(async () => emptySnapshot());
    const live = createLiveRefresh({ hydrate, scopeKey: () => scope, onFrame: () => {}, now: () => Date.now() });
    try {
      live.connectionStatus("connected");
      await vi.advanceTimersByTimeAsync(0);
      scope = "attention";
      await live.refresh();
      expect(live.load().connection).toBe("connected");
      await vi.advanceTimersByTimeAsync(CONNECTED_QUIET_REFRESH_MS - 1);
      expect(hydrate).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(hydrate).toHaveBeenCalledTimes(3);
    } finally { live.close(); }
  });

  it("does not restore a cached page's connection after the stream drops", async () => {
    vi.useFakeTimers();
    let scope = "topology";
    const hydrate = vi.fn(async () => emptySnapshot());
    const live = createLiveRefresh({ hydrate, scopeKey: () => scope, onFrame: () => {}, now: () => Date.now() });
    try {
      live.connectionStatus("connected");
      await vi.advanceTimersByTimeAsync(0);
      scope = "attention";
      await live.refresh();
      live.connectionStatus("dropped");
      scope = "topology";
      await live.refresh();
      expect(live.load().connection).toBe("dropped");
      await vi.advanceTimersByTimeAsync(QUIET_REFRESH_MS - 1);
      expect(hydrate).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(hydrate).toHaveBeenCalledTimes(4);
    } finally { live.close(); }
  });

  it("waits 5 minutes while the activity stream is connected", async () => {
    const { hydrate, live, at } = setup();
    live.connectionStatus("connected");
    await at(0);
    expect(hydrate).toHaveBeenCalledTimes(1);
    await at(QUIET_REFRESH_MS * 2);
    expect(hydrate).toHaveBeenCalledTimes(1);
    await at(CONNECTED_QUIET_REFRESH_MS);
    expect(hydrate).toHaveBeenCalledTimes(2);
    live.close();
  });

  it("doesn't call an idle connected page stale between its 5-minute reads; a drop does at once", async () => {
    const { live, at } = setup();
    live.connectionStatus("connected");
    await at(0);
    await at(61_000);
    expect(live.load().stale).toBe(false);
    await at(299_000);
    expect(live.load().stale).toBe(false);
    live.connectionStatus("dropped");
    expect(live.load().stale).toBe(true);
    live.close();
  });

  it("calls a page stale past 60 seconds without the stream, as before", async () => {
    const { at } = setup();
    let calls = 0;
    // The first read succeeds; the quiet read at 30 s never finishes, so only the age rule can mark the page stale.
    const live = createLiveRefresh({ hydrate: () => (++calls === 1 ? Promise.resolve(emptySnapshot()) : new Promise(() => {})), onFrame: () => {}, now: () => Date.now() });
    await live.refresh();
    await at(59_000);
    expect(live.load().stale).toBe(false);
    await at(61_000);
    expect(live.load().stale).toBe(true);
    live.close();
  });

  it("goes back to 30 seconds when the stream drops", async () => {
    const { hydrate, live, at } = setup();
    live.connectionStatus("connected");
    await at(0);
    await at(60_000);
    live.connectionStatus("dropped");
    await at(60_000 + QUIET_REFRESH_MS - 1);
    expect(hydrate).toHaveBeenCalledTimes(1);
    await at(60_000 + QUIET_REFRESH_MS);
    expect(hydrate).toHaveBeenCalledTimes(2);
    live.close();
  });

  it("stays 30 seconds when the stream is unavailable", async () => {
    const { hydrate, live, at } = setup();
    live.connectionStatus("unavailable");
    await live.refresh();
    expect(hydrate).toHaveBeenCalledTimes(1);
    await at(QUIET_REFRESH_MS);
    expect(hydrate).toHaveBeenCalledTimes(2);
    live.close();
  });
});
