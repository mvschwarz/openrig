import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SeatHandoverPlanner, parseHandoverSource } from "../src/domain/seat-handover-planner.js";

describe("SeatHandoverPlanner", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let planner: SeatHandoverPlanner;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    planner = new SeatHandoverPlanner({ rigRepo });
  });

  afterEach(() => {
    db.close();
  });

  function seedSeat() {
    const rig = rigRepo.createRig("seat-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex", cwd: "/project" });
    const session = sessionRegistry.registerSession(node.id, "dev-impl@seat-rig");
    sessionRegistry.updateStatus(session.id, "running");
    sessionRegistry.updateStartupStatus(session.id, "ready", "2026-04-20T12:00:00Z");
    sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@seat-rig" });
    return { rig, node, session };
  }

  function durableRows(): string {
    const tables = ["nodes", "sessions", "bindings"] as const;
    return JSON.stringify(Object.fromEntries(tables.map((table) => [
      table,
      db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
    ])));
  }

  it("builds a stable dry-run plan with current seat status and no mutations", () => {
    seedSeat();
    const before = durableRows();

    const result = planner.plan({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: "fork:0b0165d7",
      operator: "orch-lead@seat-rig",
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.plan).toMatchObject({
      ok: true,
      dryRun: true,
      willMutate: false,
      seat: {
        ref: "dev-impl@seat-rig",
        rigName: "seat-rig",
        logicalId: "dev.impl",
        runtime: "codex",
      },
      source: { mode: "fork", ref: "0b0165d7", raw: "fork:0b0165d7", defaulted: false },
      reason: "context-wall",
      operator: "orch-lead@seat-rig",
      currentOccupant: "dev-impl@seat-rig",
      currentStatus: {
        sessionStatus: "running",
        startupStatus: "ready",
        occupantLifecycle: "active",
        continuityOutcome: null,
        handoverResult: null,
      },
    });
    expect(result.plan.phases.map((phase) => phase.id)).toEqual(["prepare", "commit"]);
    expect(result.plan.phases.flatMap((phase) => phase.steps.map((step) => step.id))).toEqual([
      "validate-seat",
      "capture-departing-context",
      "create-successor",
      "verify-successor-readiness",
      "archive-departing-occupant",
      "rebind-seat",
      "deliver-startup-context",
      "record-provenance",
    ]);
    expect(result.plan.phases.flatMap((phase) => phase.steps).every((step) => step.willMutate === false)).toBe(true);
    expect(durableRows()).toBe(before);
  });

  it("defaults source to fresh and parses rebuild and fork sources", () => {
    expect(parseHandoverSource(null)).toMatchObject({
      ok: true,
      source: { mode: "fresh", ref: null, raw: "fresh", defaulted: true },
    });
    expect(parseHandoverSource("default")).toMatchObject({
      ok: true,
      source: { mode: "fresh", ref: null, raw: "default", defaulted: true },
    });
    expect(parseHandoverSource("rebuild")).toMatchObject({
      ok: true,
      source: { mode: "rebuild", ref: null, raw: "rebuild", defaulted: false },
    });
    expect(parseHandoverSource("fork:abc123")).toMatchObject({
      ok: true,
      source: { mode: "fork", ref: "abc123", raw: "fork:abc123", defaulted: false },
    });
  });

  it("requires a reason before planning", () => {
    seedSeat();

    const result = planner.plan({ seatRef: "dev-impl@seat-rig", dryRun: true });

    expect(result).toMatchObject({
      ok: false,
      code: "missing_reason",
      message: "Missing required option: --reason <reason>",
    });
  });

  it("returns seat lookup guidance for an unknown seat", () => {
    const result = planner.plan({
      seatRef: "missing@seat-rig",
      reason: "context-wall",
      dryRun: true,
    });

    expect(result).toMatchObject({
      ok: false,
      code: "seat_not_found",
      guidance: "List seats with: rig ps --nodes",
    });
  });

  it("refuses non-dry-run mutation", () => {
    seedSeat();

    const result = planner.plan({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      dryRun: false,
    });

    expect(result).toMatchObject({
      ok: false,
      code: "mutation_disabled",
      message: "Seat handover mutation is not implemented in this slice.",
    });
  });

  it("wires the daemon /api/seat/handover route", async () => {
    const setup = createTestApp(db);
    const rig = setup.rigRepo.createRig("seat-rig");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex" });
    const session = setup.sessionRegistry.registerSession(node.id, "dev-impl@seat-rig");
    setup.sessionRegistry.updateStatus(session.id, "running");

    const res = await setup.app.request("/api/seat/handover/dev-impl%40seat-rig", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "context-wall", source: "rebuild", dryRun: true }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      dryRun: true,
      willMutate: false,
      source: { mode: "rebuild", ref: null },
      currentOccupant: "dev-impl@seat-rig",
    });
  });
});
