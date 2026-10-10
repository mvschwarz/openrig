import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { wakeResolveRoutes } from "../src/routes/wake-resolve.js";
import { WakeResolveService } from "../src/domain/wake-resolve-service.js";
import type { WakeSessionRow } from "../src/domain/wake-resolver.js";

function row(id: number, token: string | null, runtime = "claude-code"): WakeSessionRow {
  return { id, sessionName: "dev-planner@my-rig", resumeToken: token, runtime, createdAt: `t${id}` };
}

describe("WakeResolveService — L3b route service (query + resolve)", () => {
  it("HTTP fractional generation refuses with known tenures instead of crashing", async () => {
    const svc = new WakeResolveService({ listSessionsBySeat: () => [row(2, "fixture-new"), row(1, "fixture-old")] });
    const app = new Hono();
    app.use("*", async (c, next) => { c.set("wakeResolveService" as never, svc as never); await next(); });
    app.route("/api/wake-resolve", wakeResolveRoutes);
    const response = await app.request("/api/wake-resolve", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seat: "dev-planner@my-rig", generation: 1.5 }),
    });
    expect(response.status).toBe(200);
    const result = await response.json();
    expect(result.resolved).toBe(false);
    expect(result.reason).toContain("Generation 1.5");
    expect(result.known.map((tenure: { generation: number }) => tenure.generation)).toEqual([1, 2]);
    expect(result).not.toHaveProperty("token");
  });

  it.each([NaN, 0.5, -1, Infinity])("refuses non-index generation %s", (generation) => {
    const svc = new WakeResolveService({ listSessionsBySeat: () => [row(2, "fixture-new"), row(1, "fixture-old")] });
    expect(svc.resolve("dev-planner@my-rig", generation).resolved).toBe(false);
  });

  it("queries sessions for the seat (newest-first) and resolves the newest token", () => {
    const listSessionsBySeat = vi.fn((seat: string): WakeSessionRow[] =>
      seat === "dev-planner@my-rig" ? [row(2, "tok2"), row(1, "tok1")] : [],
    );
    const svc = new WakeResolveService({ listSessionsBySeat });
    const res = svc.resolve("dev-planner@my-rig");
    expect(listSessionsBySeat).toHaveBeenCalledWith("dev-planner@my-rig");
    expect(res.resolved).toBe(true);
    if (res.resolved) {
      expect(res.token).toBe("tok2");
      expect(res.runtime).toBe("claude"); // claude-code maps to claude
    }
  });

  it("maps a codex runtime through", () => {
    const svc = new WakeResolveService({ listSessionsBySeat: () => [row(1, "tok", "codex")] });
    const res = svc.resolve("dev-planner@my-rig");
    expect(res.resolved && res.runtime).toBe("codex");
  });

  it("refuses an unknown seat with an empty teaching listing", () => {
    const svc = new WakeResolveService({ listSessionsBySeat: () => [] });
    const res = svc.resolve("ghost@my-rig");
    expect(res.resolved).toBe(false);
    if (!res.resolved) expect(res.known).toHaveLength(0);
  });

  it("passes an explicit generation through to the resolver", () => {
    const svc = new WakeResolveService({ listSessionsBySeat: () => [row(2, "tok2"), row(1, "tok1")] });
    const res = svc.resolve("dev-planner@my-rig", 2);
    expect(res.resolved && res.token).toBe("tok1");
  });
});
