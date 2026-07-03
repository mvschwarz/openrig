import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Hono } from "hono";
import type Database from "better-sqlite3";
import type { RigRepository } from "../src/domain/rig-repository.js";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";

function countSessions(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) as c FROM sessions").get() as { c: number }).c;
}

describe("OPR.0.4.3.22 — rig-status + launch-plan routes", () => {
  let db: Database.Database;
  let app: Hono;
  let repo: RigRepository;

  beforeEach(() => {
    db = createFullTestDb();
    const setup = createTestApp(db);
    app = setup.app;
    repo = setup.rigRepo;
  });

  afterEach(() => {
    db.close();
  });

  it("GET /api/rigs/:id/status → 404 for an unknown rig", async () => {
    const res = await app.request("/api/rigs/nope/status");
    expect(res.status).toBe(404);
  });

  it("GET /api/rigs/:id/status → composed status object with a src provenance array", async () => {
    const rig = repo.createRig("r-status");
    repo.addNode(rig.id, "dev", { role: "dev" });

    const res = await app.request(`/api/rigs/${rig.id}/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rigId).toBe(rig.id);
    expect(body.rigName).toBe("r-status");
    expect(["up", "partial", "down", "blocked", "unknown"]).toContain(body.status);
    // Composed, not inferred — the source signals are visible in the response.
    expect(Array.isArray(body.src)).toBe(true);
    expect(body.src.some((s: string) => s.startsWith("ps:"))).toBe(true);
    expect(Array.isArray(body.perSeat)).toBe(true);
    // A never-launched rig has no running seats → not up.
    expect(body.status).not.toBe("up");
  });

  it("POST /api/rigs/:id/launch-plan is READ-ONLY: returns mutated:false and creates ZERO sessions", async () => {
    const rig = repo.createRig("r-plan");
    repo.addNode(rig.id, "dev", { role: "dev" });

    const before = countSessions(db);
    const res = await app.request(`/api/rigs/${rig.id}/launch-plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("plan");
    expect(body.mutated).toBe(false);
    expect(Array.isArray(body.nodes)).toBe(true);
    // The read-only contract: no session was created / killed / replaced.
    expect(countSessions(db)).toBe(before);
  });

  it("POST /api/rigs/:id/launch-plan → 404 for an unknown rig", async () => {
    const res = await app.request("/api/rigs/nope/launch-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  it("POST /api/rigs/:id/launch-plan with freshLogicalIds forecasts fresh-primed for that seat (no mutation)", async () => {
    const rig = repo.createRig("r-fresh");
    repo.addNode(rig.id, "dev", { role: "dev" });

    const before = countSessions(db);
    const res = await app.request(`/api/rigs/${rig.id}/launch-plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ freshLogicalIds: ["dev"] }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mutated).toBe(false);
    const dev = body.nodes.find((n: { logicalId: string }) => n.logicalId === "dev");
    expect(dev.intendedAction).toBe("fresh-primed");
    expect(countSessions(db)).toBe(before);
  });
});
