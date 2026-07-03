import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  RouteTimingRecorder,
  expensiveRouteLabel,
  createRouteTimingMiddleware,
} from "../src/domain/route-timing-recorder.js";

describe("expensiveRouteLabel", () => {
  it("labels the four expensive topology routes", () => {
    expect(expensiveRouteLabel("GET", "/api/ps")).toBe("GET /api/ps");
    expect(expensiveRouteLabel("GET", "/api/rigs/summary")).toBe("GET /api/rigs/summary");
    expect(expensiveRouteLabel("GET", "/api/rigs/abc-123/graph")).toBe("GET /api/rigs/:id/graph");
    expect(expensiveRouteLabel("GET", "/api/rigs/abc-123/nodes")).toBe("GET /api/rigs/:id/nodes");
  });

  it("returns null for cheap routes, sub-paths, and non-GET verbs", () => {
    expect(expensiveRouteLabel("GET", "/healthz")).toBeNull();
    expect(expensiveRouteLabel("GET", "/api/rigs")).toBeNull();
    expect(expensiveRouteLabel("GET", "/api/rigs/abc-123")).toBeNull();
    expect(expensiveRouteLabel("GET", "/api/rigs/abc/nodes/deep")).toBeNull();
    expect(expensiveRouteLabel("POST", "/api/ps")).toBeNull();
  });
});

describe("RouteTimingRecorder rolling last / max / count", () => {
  it("tracks last, max, and count per label", () => {
    const r = new RouteTimingRecorder();
    r.record("GET /api/ps", 10);
    r.record("GET /api/ps", 30);
    r.record("GET /api/ps", 20);
    expect(r.snapshot()["GET /api/ps"]).toEqual({ lastMs: 20, maxMs: 30, count: 3 });
  });

  it("snapshot returns an isolated copy (mutation-safe)", () => {
    const r = new RouteTimingRecorder();
    r.record("GET /api/ps", 5);
    const snap = r.snapshot();
    snap["GET /api/ps"]!.maxMs = 999;
    expect(r.snapshot()["GET /api/ps"]!.maxMs).toBe(5);
  });
});

describe("createRouteTimingMiddleware records ONLY expensive routes", () => {
  it("records the expensive route and leaves the cheap route untimed", async () => {
    const recorder = new RouteTimingRecorder();
    const app = new Hono();
    app.use("*", createRouteTimingMiddleware(recorder));
    app.get("/api/ps", (c) => c.json({ ok: true }));
    app.get("/healthz", (c) => c.json({ status: "ok" }));

    await app.request("/api/ps");
    await app.request("/healthz");

    const snap = recorder.snapshot();
    expect(Object.keys(snap)).toEqual(["GET /api/ps"]);
    expect(snap["GET /api/ps"]!.count).toBe(1);
    expect(snap["GET /api/ps"]!.lastMs).toBeGreaterThanOrEqual(0);
  });
});
