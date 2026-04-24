import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SeatHandoverService } from "../src/domain/seat-handover-service.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

describe("SeatHandoverService", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let discoveryRepo: DiscoveryRepository;
  let eventBus: EventBus;
  let hasSession: ReturnType<typeof vi.fn>;
  let service: SeatHandoverService;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    discoveryRepo = new DiscoveryRepository(db);
    eventBus = new EventBus(db);
    hasSession = vi.fn(async () => true);
    service = newService();
  });

  afterEach(() => {
    db.close();
  });

  function tmux(): TmuxAdapter {
    return { hasSession } as unknown as TmuxAdapter;
  }

  function newService(): SeatHandoverService {
    return new SeatHandoverService({
      db,
      rigRepo,
      sessionRegistry,
      discoveryRepo,
      eventBus,
      tmuxAdapter: tmux(),
      now: () => new Date("2026-04-24T18:30:00.000Z"),
    });
  }

  function seedSeat(opts?: { runtime?: string; withSession?: boolean }) {
    const rig = rigRepo.createRig("seat-rig");
    const node = rigRepo.addNode(rig.id, "dev.impl", { runtime: opts?.runtime ?? "codex", cwd: "/project" });
    let sessionId: string | null = null;
    if (opts?.withSession !== false) {
      const session = sessionRegistry.registerSession(node.id, "dev-impl@seat-rig");
      sessionRegistry.updateStatus(session.id, "running");
      sessionRegistry.updateStartupStatus(session.id, "ready", "2026-04-20T12:00:00Z");
      sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@seat-rig", tmuxPane: "%0" });
      sessionId = session.id;
    }
    return { rig, node, sessionId };
  }

  function seedDiscovery(opts?: { id?: string; tmuxSession?: string; tmuxPane?: string; runtimeHint?: "codex" | "claude-code" | "terminal" | "unknown" }) {
    const discovered = discoveryRepo.upsertDiscoveredSession({
      tmuxSession: opts?.tmuxSession ?? "successor-session",
      tmuxPane: opts?.tmuxPane ?? "%1",
      tmuxWindow: "0",
      runtimeHint: opts?.runtimeHint ?? "codex",
      confidence: "high",
      cwd: "/project",
    });
    if (opts?.id && opts.id !== discovered.id) {
      db.prepare("UPDATE discovered_sessions SET id = ? WHERE id = ?").run(opts.id, discovered.id);
      return discoveryRepo.getDiscoveredSession(opts.id)!;
    }
    return discovered;
  }

  function durableRows(): string {
    const tables = ["nodes", "sessions", "bindings", "discovered_sessions", "events"] as const;
    return JSON.stringify(Object.fromEntries(tables.map((table) => [
      table,
      db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
    ])));
  }

  it("binds an active seat to an already-created discovered successor", async () => {
    const { rig, node, sessionId } = seedSeat();
    const discovered = seedDiscovery();

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "mvp-proof",
      source: `discovered:${discovered.id}`,
      operator: "orch-lead@seat-rig",
    });

    expect(result.ok).toBe(true);
    if (!result.ok || !("result" in result)) throw new Error("expected handover result");
    expect(result.result).toMatchObject({
      ok: true,
      dryRun: false,
      mutated: true,
      continuityTransferred: false,
      previousOccupant: "dev-impl@seat-rig",
      currentOccupant: "successor-session",
      source: { mode: "discovered", ref: discovered.id },
      currentStatus: {
        sessionStatus: "running",
        startupStatus: "ready",
        occupantLifecycle: "active",
        continuityOutcome: null,
        handoverResult: "complete",
        previousOccupant: "dev-impl@seat-rig",
        handoverAt: "2026-04-24T18:30:00.000Z",
      },
      sideEffects: {
        departingSessionKilled: false,
        startupContextDelivered: false,
        provenanceRecordWritten: false,
      },
    });
    expect(result.result.previousSessionIdsSuperseded).toContain(sessionId);
    expect(hasSession).toHaveBeenCalledWith("successor-session");

    const sessions = sessionRegistry.getSessionsForRig(rig.id).filter((session) => session.nodeId === node.id);
    expect(sessions.map((session) => ({ name: session.sessionName, status: session.status, origin: session.origin, startup: session.startupStatus }))).toEqual([
      { name: "dev-impl@seat-rig", status: "superseded", origin: "launched", startup: "ready" },
      { name: "successor-session", status: "running", origin: "claimed", startup: "ready" },
    ]);
    expect(sessionRegistry.getBindingForNode(node.id)?.tmuxSession).toBe("successor-session");
    const claimed = discoveryRepo.getDiscoveredSession(discovered.id);
    expect(claimed?.status).toBe("claimed");
    expect(claimed?.claimedNodeId).toBe(node.id);
    const nodeRow = db.prepare("SELECT occupant_lifecycle, continuity_outcome, handover_result, previous_occupant, handover_at FROM nodes WHERE id = ?").get(node.id) as Record<string, string | null>;
    expect(nodeRow).toEqual({
      occupant_lifecycle: "active",
      continuity_outcome: null,
      handover_result: "complete",
      previous_occupant: "dev-impl@seat-rig",
      handover_at: "2026-04-24T18:30:00.000Z",
    });
    const event = db.prepare("SELECT type, payload FROM events ORDER BY seq DESC LIMIT 1").get() as { type: string; payload: string };
    expect(event.type).toBe("seat.handover_completed");
    expect(JSON.parse(event.payload)).toMatchObject({
      type: "seat.handover_completed",
      rigId: rig.id,
      nodeId: node.id,
      logicalId: "dev.impl",
      previousOccupant: "dev-impl@seat-rig",
      currentOccupant: "successor-session",
      source: `discovered:${discovered.id}`,
      reason: "mvp-proof",
      operator: "orch-lead@seat-rig",
    });
  });

  it("keeps dry-run side-effect free", async () => {
    seedSeat();
    const discovered = seedDiscovery();
    const before = durableRows();

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: `discovered:${discovered.id}`,
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    expect(result.ok && "plan" in result && result.plan.willMutate).toBe(false);
    expect(durableRows()).toBe(before);
  });

  it.each([
    ["default source", undefined],
    ["fresh source", "fresh"],
    ["rebuild source", "rebuild"],
    ["fork source", "fork:abc123"],
  ])("refuses unsupported non-dry-run %s without mutation", async (_label, source) => {
    seedSeat();
    const before = durableRows();

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source,
    });

    expect(result).toMatchObject({
      ok: false,
      code: "successor_creation_not_implemented",
    });
    expect(hasSession).not.toHaveBeenCalled();
    expect(durableRows()).toBe(before);
  });

  it("fails before mutation when discovered id is missing", async () => {
    seedSeat();
    const before = durableRows();

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: "discovered:missing",
    });

    expect(result).toMatchObject({ ok: false, code: "discovered_not_found" });
    expect(durableRows()).toBe(before);
  });

  it("fails before mutation when discovered successor vanished", async () => {
    seedSeat();
    const discovered = seedDiscovery();
    discoveryRepo.markVanished([discovered.id]);
    const before = durableRows();

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: `discovered:${discovered.id}`,
    });

    expect(result).toMatchObject({ ok: false, code: "discovered_not_active" });
    expect(hasSession).not.toHaveBeenCalled();
    expect(durableRows()).toBe(before);
  });

  it("fails before mutation when discovered successor is already claimed", async () => {
    const { node } = seedSeat();
    const discovered = seedDiscovery();
    discoveryRepo.markClaimed(discovered.id, node.id);
    const before = durableRows();

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: `discovered:${discovered.id}`,
    });

    expect(result).toMatchObject({ ok: false, code: "discovered_not_active" });
    expect(hasSession).not.toHaveBeenCalled();
    expect(durableRows()).toBe(before);
  });

  it("fails before mutation when successor tmux session is absent", async () => {
    seedSeat();
    const discovered = seedDiscovery();
    hasSession.mockResolvedValue(false);
    const before = durableRows();

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: `discovered:${discovered.id}`,
    });

    expect(result).toMatchObject({ ok: false, code: "successor_tmux_absent" });
    expect(durableRows()).toBe(before);
  });

  it("fails closed when tmux probe throws", async () => {
    seedSeat();
    const discovered = seedDiscovery();
    hasSession.mockRejectedValue(new Error("socket permission denied"));
    const before = durableRows();

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: `discovered:${discovered.id}`,
    });

    expect(result).toMatchObject({ ok: false, code: "tmux_probe_failed" });
    expect(durableRows()).toBe(before);
  });

  it("fails before mutation on runtime mismatch", async () => {
    seedSeat({ runtime: "codex" });
    const discovered = seedDiscovery({ runtimeHint: "claude-code" });
    const before = durableRows();

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: `discovered:${discovered.id}`,
    });

    expect(result).toMatchObject({ ok: false, code: "runtime_mismatch" });
    expect(hasSession).not.toHaveBeenCalled();
    expect(durableRows()).toBe(before);
  });

  it("fails before mutation when successor is already managed elsewhere", async () => {
    seedSeat();
    const discovered = seedDiscovery();
    const otherRig = rigRepo.createRig("other-rig");
    const otherNode = rigRepo.addNode(otherRig.id, "dev.other", { runtime: "codex" });
    sessionRegistry.updateBinding(otherNode.id, { tmuxSession: "successor-session" });
    const before = durableRows();

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: `discovered:${discovered.id}`,
    });

    expect(result).toMatchObject({ ok: false, code: "successor_already_managed" });
    expect(durableRows()).toBe(before);
  });

  it("fails before mutation when the seat has no current occupant", async () => {
    seedSeat({ withSession: false });
    const discovered = seedDiscovery();
    const before = durableRows();

    const result = await service.handover({
      seatRef: "dev.impl@seat-rig",
      reason: "context-wall",
      source: `discovered:${discovered.id}`,
    });

    expect(result).toMatchObject({ ok: false, code: "current_occupant_required" });
    expect(durableRows()).toBe(before);
  });

  it("wires the daemon route for discovered live mutation", async () => {
    const routeTmux = { hasSession: vi.fn(async () => true) } as unknown as TmuxAdapter;
    const setup = createTestApp(db, { tmux: routeTmux });
    const rig = setup.rigRepo.createRig("seat-rig");
    const node = setup.rigRepo.addNode(rig.id, "dev.impl", { runtime: "codex" });
    const session = setup.sessionRegistry.registerSession(node.id, "dev-impl@seat-rig");
    setup.sessionRegistry.updateStatus(session.id, "running");
    setup.sessionRegistry.updateBinding(node.id, { tmuxSession: "dev-impl@seat-rig" });
    const discovered = setup.discoveryRepo.upsertDiscoveredSession({
      tmuxSession: "route-successor",
      tmuxPane: "%2",
      runtimeHint: "codex",
      confidence: "high",
    });

    const res = await setup.app.request("/api/seat/handover/dev-impl%40seat-rig", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        reason: "mvp-proof",
        source: `discovered:${discovered.id}`,
        operator: "orch-lead@seat-rig",
      }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      ok: true,
      dryRun: false,
      mutated: true,
      continuityTransferred: false,
      previousOccupant: "dev-impl@seat-rig",
      currentOccupant: "route-successor",
      currentStatus: { handoverResult: "complete" },
    });
  });
});
