// OPR.0.4.0.1 — global live-terminal cap registry (PM-locked architecture).
// Pure, framework-free core: a global cap on simultaneously-live terminals
// across all surfaces; opening past the cap EVICTS THE OLDEST (reverts it to
// static — its revert callback runs). Unit-tested in isolation before the
// React context/component integration.

import { describe, it, expect, vi } from "vitest";
import { LiveTerminalRegistry } from "../src/components/terminal/live-terminal-registry.js";

describe("LiveTerminalRegistry (OPR.0.4.0.1 global cap + oldest-eviction)", () => {
  it("admits terminals up to the cap without eviction", () => {
    const reg = new LiveTerminalRegistry(2);
    const a = vi.fn(); const b = vi.fn();
    reg.requestLive("a", a);
    reg.requestLive("b", b);
    expect(reg.size).toBe(2);
    expect(reg.isLive("a")).toBe(true);
    expect(reg.isLive("b")).toBe(true);
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  it("opening past the cap evicts the OLDEST (its revert runs) and stays at the cap", () => {
    const reg = new LiveTerminalRegistry(2);
    const a = vi.fn(); const b = vi.fn(); const c = vi.fn();
    reg.requestLive("a", a); // oldest
    reg.requestLive("b", b);
    reg.requestLive("c", c); // 3rd -> evicts a
    expect(a).toHaveBeenCalledTimes(1); // a reverted to static
    expect(b).not.toHaveBeenCalled();
    expect(c).not.toHaveBeenCalled();
    expect(reg.isLive("a")).toBe(false);
    expect(reg.isLive("b")).toBe(true);
    expect(reg.isLive("c")).toBe(true);
    expect(reg.size).toBe(2);
  });

  it("eviction order is strict insertion order (oldest first across several evictions)", () => {
    const reg = new LiveTerminalRegistry(2);
    const calls: string[] = [];
    reg.requestLive("a", () => calls.push("a"));
    reg.requestLive("b", () => calls.push("b"));
    reg.requestLive("c", () => calls.push("c")); // evicts a
    reg.requestLive("d", () => calls.push("d")); // evicts b
    expect(calls).toEqual(["a", "b"]);
    expect(reg.isLive("c")).toBe(true);
    expect(reg.isLive("d")).toBe(true);
  });

  it("re-requesting an already-live key does NOT evict and refreshes its recency (becomes newest)", () => {
    const reg = new LiveTerminalRegistry(2);
    const a = vi.fn(); const b = vi.fn(); const c = vi.fn();
    reg.requestLive("a", a);
    reg.requestLive("b", b);
    reg.requestLive("a", a); // touch a -> a is now newest, b is oldest
    expect(a).not.toHaveBeenCalled();
    expect(reg.size).toBe(2);
    reg.requestLive("c", c); // evicts the oldest, which is now b (not a)
    expect(b).toHaveBeenCalledTimes(1);
    expect(reg.isLive("a")).toBe(true);
    expect(reg.isLive("b")).toBe(false);
  });

  it("release() frees a slot without evicting and is idempotent", () => {
    const reg = new LiveTerminalRegistry(2);
    const a = vi.fn(); const b = vi.fn();
    reg.requestLive("a", a);
    reg.requestLive("b", b);
    reg.release("a");
    expect(reg.isLive("a")).toBe(false);
    expect(reg.size).toBe(1);
    expect(a).not.toHaveBeenCalled(); // release is not an eviction; no revert callback
    reg.release("a"); // idempotent
    expect(reg.size).toBe(1);
  });

  it("a freed slot lets a new terminal go live without eviction", () => {
    const reg = new LiveTerminalRegistry(2);
    const a = vi.fn(); const b = vi.fn(); const c = vi.fn();
    reg.requestLive("a", a);
    reg.requestLive("b", b);
    reg.release("a");
    reg.requestLive("c", c); // slot free -> no eviction
    expect(b).not.toHaveBeenCalled();
    expect(reg.size).toBe(2);
    expect(reg.isLive("b")).toBe(true);
    expect(reg.isLive("c")).toBe(true);
  });

  it("clamps a bad cap (0 / negative) to a minimum of 1 (never zero-live)", () => {
    const reg = new LiveTerminalRegistry(0);
    const a = vi.fn(); const b = vi.fn();
    reg.requestLive("a", a);
    reg.requestLive("b", b); // cap clamped to 1 -> evicts a
    expect(a).toHaveBeenCalledTimes(1);
    expect(reg.size).toBe(1);
    expect(reg.isLive("b")).toBe(true);
  });

  it("supports a cap of 3 (the 2->3 config bump) — admits 3 before evicting", () => {
    const reg = new LiveTerminalRegistry(3);
    const a = vi.fn();
    reg.requestLive("a", a);
    reg.requestLive("b", vi.fn());
    reg.requestLive("c", vi.fn());
    expect(reg.size).toBe(3);
    expect(a).not.toHaveBeenCalled();
    reg.requestLive("d", vi.fn()); // 4th -> evicts a
    expect(a).toHaveBeenCalledTimes(1);
    expect(reg.size).toBe(3);
  });
});
