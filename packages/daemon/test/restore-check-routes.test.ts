import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import type { Hono } from "hono";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { createApp } from "../src/server.js";
import type { RigRepository } from "../src/domain/rig-repository.js";

describe("Restore check routes", () => {
  let db: Database.Database;
  let app: Hono;
  let rigRepo: RigRepository;

  beforeEach(() => {
    db = createFullTestDb();
    const setup = createTestApp(db);
    app = createApp(setup);
    rigRepo = setup.rigRepo;
  });

  afterEach(() => {
    db.close();
  });

  it("GET /api/restore-check returns JSON with verdict + checks + repairPacket", async () => {
    rigRepo.createRig("test-rig");

    const res = await app.request("/api/restore-check");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.verdict).toBeDefined();
    expect(["restorable", "restorable_with_caveats", "not_restorable", "unknown"]).toContain(body.verdict);
    expect(body.counts).toBeDefined();
    expect(body.checks).toBeInstanceOf(Array);
    expect(body.repairPacket).toBeNull();

    // Every check has required fields
    for (const check of body.checks) {
      expect(typeof check.check).toBe("string");
      expect(["green", "yellow", "red"]).toContain(check.status);
      expect(typeof check.evidence).toBe("string");
      expect(typeof check.remediation).toBe("string");
    }
  });

  it("GET /api/restore-check?rig=test-rig filters to named rig", async () => {
    rigRepo.createRig("rig-a");
    rigRepo.createRig("rig-b");

    const res = await app.request("/api/restore-check?rig=rig-a");
    const body = await res.json();

    const rigChecks = body.checks.filter((c: { check: string }) => c.check.includes("rig."));
    expect(rigChecks.every((c: { check: string }) => !c.check.includes("rig-b"))).toBe(true);
  });

  it("GET /api/restore-check?rig=unknown returns not_restorable with red check", async () => {
    rigRepo.createRig("real-rig");

    const res = await app.request("/api/restore-check?rig=nonexistent");
    const body = await res.json();

    expect(body.verdict).toBe("not_restorable");
    const notFound = body.checks.find((c: { check: string }) => c.check.includes("nonexistent"));
    expect(notFound).toBeDefined();
    expect(notFound.status).toBe("red");
  });

  it("GET /api/restore-check?noQueue=true skips queue checks", async () => {
    const rig = rigRepo.createRig("test-rig");
    rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });

    const res = await app.request("/api/restore-check?noQueue=true");
    const body = await res.json();

    const queueChecks = body.checks.filter((c: { check: string }) => c.check.includes("queue-file"));
    expect(queueChecks).toHaveLength(0);
  });

  it("GET /api/restore-check?noHooks=true skips hook checks", async () => {
    const rig = rigRepo.createRig("test-rig");
    rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });

    const res = await app.request("/api/restore-check?noHooks=true");
    const body = await res.json();

    const hookChecks = body.checks.filter((c: { check: string }) => c.check.includes("hooks"));
    expect(hookChecks).toHaveLength(0);
  });

  it("daemon.reachable is green inside daemon route (self-proof)", async () => {
    rigRepo.createRig("test-rig");

    const res = await app.request("/api/restore-check");
    const body = await res.json();

    const daemon = body.checks.find((c: { check: string }) => c.check === "daemon.reachable");
    expect(daemon).toBeDefined();
    expect(daemon.status).toBe("green");
    expect(daemon.evidence).toContain("Daemon running");
  });
});
