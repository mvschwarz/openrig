import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { TerminalFollowing } from "../src/domain/terminal/terminal-following.js";
import type { FollowingSelector } from "../src/domain/terminal/terminal-following.js";
import type { FollowControls } from "../src/domain/terminal/terminal-follow-policy.js";
import type { EventBus } from "../src/domain/event-bus.js";
import type { OpenViewResult } from "../src/domain/terminal/terminal-provider.js";

const roots: string[] = [], services: TerminalFollowing[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.stop(); vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const selector = { view: "qitem:task", provider: "herdr" as const };
const answer = (): OpenViewResult => ({ provider: "herdr", ok: true, opened: ["a"], absent: [], degraded: [], pages: 1,
  following: { id: "same", enabled: true, state: "following", maxTiles: 8, tiles: [], events: [], overflow: [] } });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "following-controller-")); roots.push(root);
  let callback: Parameters<EventBus["subscribe"]>[0] = () => {};
  const unsubscribe = vi.fn(), render = vi.fn(async (_selector: FollowingSelector, _controls: FollowControls) => answer());
  const bus = { subscribe: (cb: typeof callback) => { callback = cb; return unsubscribe; } };
  const file = path.join(root, "selectors.json");
  const create = () => { const service = new TerminalFollowing(file, bus, render); services.push(service); return service; };
  const emit = (type: string) => callback({ type } as Parameters<typeof callback>[0]);
  return { create, emit, render, unsubscribe };
}
describe("Core-event terminal following", () => {
  it("coalesces membership events and never polls between events", async () => {
    vi.useFakeTimers(); const f = fixture(), service = f.create();
    await service.open(selector, { enabled: true });
    for (let i = 0; i < 50; i++) f.emit("queue.updated");
    await vi.advanceTimersByTimeAsync(100);
    expect(f.render).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(600000);
    expect(f.render).toHaveBeenCalledTimes(2);
  });
  it("activity hooks from unrelated working agents never wake a render", async () => {
    vi.useFakeTimers(); const f = fixture(), service = f.create();
    await service.open(selector, { enabled: true });
    for (let tick = 0; tick < 100; tick++) {
      f.emit("agent.activity"); await vi.advanceTimersByTimeAsync(100);
    }
    expect(f.render).toHaveBeenCalledTimes(1);
    f.emit("session.started"); await vi.advanceTimersByTimeAsync(100);
    expect(f.render).toHaveBeenCalledTimes(2);
  });
  it("one-shot deadlines resume retention without replaying pin/suppress commands", async () => {
    vi.useFakeTimers(); const f = fixture(), service = f.create();
    f.render.mockResolvedValueOnce({ ...answer(), following: { ...answer().following!, nextAt: Date.now() + 4000 } });
    await service.open(selector, { enabled: true, suppress: ["a"] });
    await vi.advanceTimersByTimeAsync(4100);
    expect(f.render.mock.calls[1]).toEqual([selector, { enabled: true }]);
    await vi.advanceTimersByTimeAsync(600000); expect(f.render).toHaveBeenCalledTimes(2);
  });
  it("restores selectors from disk, derives current membership, and stops cleanly", async () => {
    vi.useFakeTimers(); const f = fixture(), first = f.create();
    await first.open(selector, { enabled: true }); await first.stop();
    const restored = f.create(); await vi.advanceTimersByTimeAsync(100);
    expect(f.render).toHaveBeenCalledTimes(2);
    await restored.stop(); f.emit("queue.created"); await vi.advanceTimersByTimeAsync(1000);
    expect(f.render).toHaveBeenCalledTimes(2); expect(f.unsubscribe).toHaveBeenCalled();
  });
  it("disable retains the fixed view and removes its automatic selector", async () => {
    vi.useFakeTimers(); const f = fixture(), service = f.create();
    await service.open(selector, { enabled: true }); await service.open(selector, { enabled: false });
    expect(service.list()).toEqual([]);
    f.emit("node.updated"); await vi.advanceTimersByTimeAsync(10000);
    expect(f.render).toHaveBeenCalledTimes(2);
  });
  it("complete empty tasks retire, do no event work and do not consume the 64 active slots", async () => {
    vi.useFakeTimers(); const f = fixture(), service = f.create();
    f.render.mockImplementation(async () => ({ ...answer(), opened: [], following: { ...answer().following!, state: "empty" } }));
    for (let i = 0; i < 65; i++) {
      const result = await service.open({ ...selector, view: `qitem:empty-${i}` }, { enabled: true });
      expect(result).toMatchObject({ ok: true, following: { state: "empty", enabled: false } });
    }
    expect(service.list()).toEqual([]);
    f.emit("queue.created"); f.emit("node.updated"); await vi.advanceTimersByTimeAsync(10000);
    expect(f.render).toHaveBeenCalledTimes(65);
    // Retired selectors do not revive from disk either.
    await service.stop(); const restored = f.create(); await vi.advanceTimersByTimeAsync(1000);
    expect(f.render).toHaveBeenCalledTimes(65);
    const resumed = await restored.open({ ...selector, view: "qitem:empty-0" }, { enabled: true });
    expect(resumed.ok).toBe(true); expect(f.render).toHaveBeenCalledTimes(66);
  });
});


describe("scope selector lifetime", () => {
  it("keeps a known empty slice enabled and repopulates on a queue event", async () => {
    vi.useFakeTimers(); const f = fixture(), service = f.create();
    f.render.mockResolvedValueOnce({ ...answer(), opened: [], following: { ...answer().following!, state: "empty" } });
    const result = await service.open({ ...selector, view: "slice:build" }, { enabled: true });
    expect(result.following?.enabled).toBe(true);
    expect(service.list()).toHaveLength(1);
    f.emit("queue.created"); await vi.advanceTimersByTimeAsync(100);
    expect(f.render).toHaveBeenCalledTimes(2);
    expect(service.list()[0]?.status?.state).toBe("following");
  });
  it("restores scope selectors and coalesces explicit scope-source changes without polling", async () => {
    vi.useFakeTimers(); const f = fixture(), first = f.create();
    await first.open({ ...selector, view: "slice:build" }, { enabled: true }); await first.stop();
    const second = f.create(); await vi.advanceTimersByTimeAsync(100);
    expect(second.list()).toHaveLength(1);
    const before = f.render.mock.calls.length;
    for (let n = 0; n < 10; n++) f.emit("scope.sources_changed");
    await vi.advanceTimersByTimeAsync(100); expect(f.render).toHaveBeenCalledTimes(before + 1);
    await vi.advanceTimersByTimeAsync(600000); expect(f.render).toHaveBeenCalledTimes(before + 1);
  });
});
