import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import type { Hono } from "hono";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { createApp } from "../src/server.js";
import type { RigRepository } from "../src/domain/rig-repository.js";
import { RestoreCheckService } from "../src/domain/restore-check-service.js";

const VALID_HOST_INFRA_DECLARATION = JSON.stringify({
  schemaVersion: 1,
  daemonBootstrap: {
    declared: true,
    mechanism: "launchd",
    evidence: "com.openrig.daemon",
  },
  supportingInfra: [
    {
      id: "supervisor-wake",
      declared: true,
      required: true,
      evidence: "kernel rig infra seat or host launch agent",
    },
  ],
});

describe("Restore check routes", () => {
  let db: Database.Database;
  let app: Hono;
  let rigRepo: RigRepository;
  let openRigHome: string;
  let originalOpenRigHome: string | undefined;

  beforeEach(() => {
    originalOpenRigHome = process.env["OPENRIG_HOME"];
    openRigHome = fs.mkdtempSync(path.join(os.tmpdir(), "restore-check-route-openrig-home-"));
    process.env["OPENRIG_HOME"] = openRigHome;

    db = createFullTestDb();
    const setup = createTestApp(db);
    app = createApp(setup);
    rigRepo = setup.rigRepo;
  });

  afterEach(() => {
    db.close();
    if (originalOpenRigHome === undefined) delete process.env["OPENRIG_HOME"];
    else process.env["OPENRIG_HOME"] = originalOpenRigHome;
    fs.rmSync(openRigHome, { recursive: true, force: true });
  });

  it("GET /api/restore-check returns JSON with verdict + checks + repairPacket", async () => {
    rigRepo.createRig("test-rig");

    const res = await app.request("/api/restore-check");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.verdict).toBeDefined();
    expect(["restorable", "restorable_with_caveats", "not_restorable", "unknown"]).toContain(body.verdict);
    expect(typeof body.fullyBack).toBe("boolean");
    expect(body.assertion).toBeDefined();
    expect(body.assertion.level).toBe("host");
    expect(body.rigs).toBeInstanceOf(Array);
    expect(body.hostInfra).toBeDefined();
    expect(body.counts).toBeDefined();
    expect(body.checks).toBeInstanceOf(Array);
    // repairPacket is null when restorable, array when caveats/blockers exist
    if (body.verdict === "restorable") {
      expect(body.repairPacket).toBeNull();
    } else {
      expect(body.repairPacket).toBeInstanceOf(Array);
    }

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

  it("GET /api/restore-check returns non-null repairPacket with blocking field for broken fixture", async () => {
    // Create a rig with a node — hooks are yellow by default (Slice 2 unimplemented),
    // producing restorable_with_caveats and a non-null repairPacket
    const rig = rigRepo.createRig("broken-rig");
    rigRepo.addNode(rig.id, "dev.impl", { runtime: "claude-code" });

    const res = await app.request("/api/restore-check?rig=broken-rig");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.fullyBack).toBe(false);
    expect(body.assertion).toBeDefined();
    expect(body.rigs).toBeInstanceOf(Array);
    expect(body.rigs[0]).toEqual(expect.objectContaining({
      rigId: rig.id,
      rigName: "broken-rig",
      expectedNodes: 1,
      runningReadyNodes: expect.any(Number),
      blockedNodes: expect.any(Number),
      caveatNodes: expect.any(Number),
      blockingChecks: expect.any(Array),
      caveatChecks: expect.any(Array),
    }));
    expect(body.hostInfra).toEqual(expect.objectContaining({
      status: "not_declared",
    }));
    // Hooks yellow → restorable_with_caveats → repairPacket populated
    expect(body.repairPacket).toBeInstanceOf(Array);
    expect(body.repairPacket.length).toBeGreaterThan(0);

    // Each repair step has the required fields including blocking
    for (const step of body.repairPacket) {
      expect(typeof step.step).toBe("number");
      expect(typeof step.command).toBe("string");
      expect(typeof step.rationale).toBe("string");
      expect(typeof step.safe).toBe("boolean");
      expect(typeof step.blocking).toBe("boolean");
    }

    // Yellow hooks are non-blocking caveats
    const hookStep = body.repairPacket.find((s: { rationale: string }) => s.rationale.includes("Hook"));
    if (hookStep) {
      expect(hookStep.blocking).toBe(false);
    }
  });

  it("GET /api/restore-check surfaces declared host-infra state from OPENRIG_HOME", async () => {
    fs.writeFileSync(path.join(openRigHome, "host-infra.json"), VALID_HOST_INFRA_DECLARATION);
    rigRepo.createRig("declared-rig");

    const res = await app.request("/api/restore-check?rig=declared-rig");
    expect(res.status).toBe(200);

    const body = await res.json();
    const check = body.checks.find((entry: { check: string }) => entry.check === "host.bootstrap-autostart.declaration");
    expect(check).toEqual(expect.objectContaining({
      status: "green",
    }));
    expect(check.evidence).toContain(path.join(openRigHome, "host-infra.json"));
    expect(check.evidence).toContain("declared, not verified");
    expect(body.hostInfra).toEqual(expect.objectContaining({
      status: "declared",
      evidence: expect.stringContaining("declared, not verified"),
    }));
  });

  it("GET /api/restore-check?rig=nonexistent preserves missing host-infra state", async () => {
    rigRepo.createRig("real-rig");

    const res = await app.request("/api/restore-check?rig=nonexistent&noQueue=true&noHooks=true");
    expect(res.status).toBe(200);

    const body = await res.json();
    const check = body.checks.find((entry: { check: string }) => entry.check === "host.bootstrap-autostart.declaration");
    expect(body.verdict).toBe("not_restorable");
    expect(check).toEqual(expect.objectContaining({
      status: "yellow",
      evidence: expect.stringContaining(path.join(openRigHome, "host-infra.json")),
    }));
    expect(body.hostInfra).toEqual(expect.objectContaining({
      status: "not_declared",
      evidence: check.evidence,
    }));
  });

  it("GET /api/restore-check?rig=nonexistent preserves declared host-infra state", async () => {
    fs.writeFileSync(path.join(openRigHome, "host-infra.json"), VALID_HOST_INFRA_DECLARATION);
    rigRepo.createRig("real-rig");

    const res = await app.request("/api/restore-check?rig=nonexistent&noQueue=true&noHooks=true");
    expect(res.status).toBe(200);

    const body = await res.json();
    const check = body.checks.find((entry: { check: string }) => entry.check === "host.bootstrap-autostart.declaration");
    expect(body.verdict).toBe("not_restorable");
    expect(check).toEqual(expect.objectContaining({
      status: "green",
      evidence: expect.stringContaining(path.join(openRigHome, "host-infra.json")),
    }));
    expect(body.hostInfra).toEqual(expect.objectContaining({
      status: "declared",
      evidence: check.evidence,
    }));
  });

  it("GET /api/restore-check route catch returns actionable repairPacket", async () => {
    const spy = vi.spyOn(RestoreCheckService.prototype, "check").mockImplementationOnce(() => {
      throw new Error("route boom");
    });

    try {
      const res = await app.request("/api/restore-check");
      expect(res.status).toBe(500);

      const body = await res.json();
      expect(body.verdict).toBe("unknown");
      expect(body.fullyBack).toBe(false);
      expect(body.assertion.status).toBe("unknown");
      expect(body.assertion.reason).toBe("unknown_probe_state");
      expect(body.checks[0]).toEqual(expect.objectContaining({
        check: "probe.error",
        status: "red",
        remediation: "Check daemon logs with: rig daemon logs",
      }));
      expect(body.checks[0].evidence).toContain("route boom");
      expect(body.repairPacket).toEqual([{
        step: 1,
        command: "Check daemon logs with: rig daemon logs",
        rationale: expect.stringContaining("route boom"),
        safe: true,
        blocking: true,
      }]);
    } finally {
      spy.mockRestore();
    }
  });

  it("GET /api/restore-check?rig=nonexistent returns repairPacket with blocking:true entry", async () => {
    rigRepo.createRig("real-rig");

    const res = await app.request("/api/restore-check?rig=nonexistent");
    const body = await res.json();

    expect(body.verdict).toBe("not_restorable");
    expect(body.repairPacket).toBeInstanceOf(Array);
    const blocker = body.repairPacket.find((s: { blocking: boolean }) => s.blocking);
    expect(blocker).toBeDefined();
    expect(blocker.command).toContain("rig ps");
  });
});
