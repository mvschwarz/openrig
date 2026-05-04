// Preview Terminal v0 (PL-018) — rate limiter unit tests.

import { describe, it, expect } from "vitest";
import { PreviewRateLimiter } from "../src/domain/preview/preview-rate-limiter.js";

describe("PreviewRateLimiter (PL-018)", () => {
  it("returns null on first lookup for an unseen key", () => {
    const r = new PreviewRateLimiter<string>(1000);
    expect(r.get("velocity-driver@x")).toBeNull();
  });

  it("returns the cached payload within the rate-limit window", () => {
    let now = 1000;
    const r = new PreviewRateLimiter<string>(500, () => now);
    r.set("k", "first");
    now = 1100;
    expect(r.get("k")?.payload).toBe("first");
    now = 1499;
    expect(r.get("k")?.payload).toBe("first");
  });

  it("returns null once the window has elapsed", () => {
    let now = 1000;
    const r = new PreviewRateLimiter<string>(500, () => now);
    r.set("k", "first");
    now = 1501;
    expect(r.get("k")).toBeNull();
  });

  it("collapses concurrent requests for the same key into one cache hit", () => {
    let now = 1000;
    const r = new PreviewRateLimiter<string>(1000, () => now);
    r.set("k", "first");
    // Rapid follow-on requests inside the window all see the cached payload.
    expect(r.get("k")?.payload).toBe("first");
    now = 1500;
    expect(r.get("k")?.payload).toBe("first");
  });

  it("clear removes the cache entry", () => {
    let now = 1000;
    const r = new PreviewRateLimiter<string>(1000, () => now);
    r.set("k", "v");
    r.clear("k");
    expect(r.get("k")).toBeNull();
  });

  it("different keys have independent windows", () => {
    let now = 1000;
    const r = new PreviewRateLimiter<string>(500, () => now);
    r.set("a", "alpha");
    now = 1100;
    r.set("b", "beta");
    now = 1499;
    expect(r.get("a")?.payload).toBe("alpha");
    expect(r.get("b")?.payload).toBe("beta");
    now = 1501;
    // a expired (started at 1000) but b (started at 1100) is still fresh
    expect(r.get("a")).toBeNull();
    expect(r.get("b")?.payload).toBe("beta");
  });
});
