import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { DiscoveryRepository } from "../src/domain/discovery-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { SeatHandoverService } from "../src/domain/seat-handover-service.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";
import type { RuntimeAdapter } from "../src/domain/runtime-adapter.js";

describe("SeatHandoverService", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let sessionRegistry: SessionRegistry;
  let discoveryRepo: DiscoveryRepository;
  let eventBus: EventBus;
  let hasSession: ReturnType<typeof vi.fn>;
  let createSession: ReturnType<typeof vi.fn>;
  let listPanes: ReturnType<typeof vi.fn>;
  let killSession: ReturnType<typeof vi.fn>;
  let sendText: ReturnType<typeof vi.fn>;
  let sendKeys: ReturnType<typeof vi.fn>;
  let capturePaneScreen: ReturnType<typeof vi.fn>;
  let launchHarness: ReturnType<typeof vi.fn>;
  let checkReady: ReturnType<typeof vi.fn>;
  let readSidecar: ReturnType<typeof vi.fn>;
  let captureCodexThreadId: ReturnType<typeof vi.fn>;
  let service: SeatHandoverService;

  beforeEach(() => {
    db = createFullTestDb();
    rigRepo = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    discoveryRepo = new DiscoveryRepository(db);
    eventBus = new EventBus(db);
    hasSession = vi.fn(async () => true);
    createSession = vi.fn(async () => ({ ok: true }));
    listPanes = vi.fn(async () => [{ id: "%9", index: 0, cwd: "/project", width: 80, height: 24, active: true }]);
    killSession = vi.fn(async () => ({ ok: true }));
    sendText = vi.fn(async () => ({ ok: true }));
    sendKeys = vi.fn(async () => ({ ok: true }));
    capturePaneScreen = vi.fn(async () => "predecessor screen tail");
    // B1 — a fresh successor is launched into a live agent (launchHarness +
    // readiness) with a scraped resume token (B2 launched-mode).
    launchHarness = vi.fn(async () => ({ ok: true, resumeToken: "codex-launch-tok", resumeType: "codex_id" }));
    checkReady = vi.fn(async () => ({ ready: true }));
    // B2 — discovered-mode derive-helper deps (Codex thread-id capturer by default).
    readSidecar = vi.fn(() => ({ ok: true, data: { session_id: "claude-sid-123" } }));
    captureCodexThreadId = vi.fn(async () => "codex-discovered-tok");
    service = newService();
  });

  afterEach(() => {
    db.close();
  });

  function tmux(): TmuxAdapter {
    return { hasSession, createSession, listPanes, killSession, sendText, sendKeys, capturePaneScreen } as unknown as TmuxAdapter;
  }

  function codexAdapter(): RuntimeAdapter {
    return { runtime: "codex", launchHarness, checkReady } as unknown as RuntimeAdapter;
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
      newSuccessorId: () => "01SUCCID0",
      runtimeAdapters: { codex: codexAdapter() },
      contextUsageStore: { readSidecar } as never,
      resumeTokenCapturer: { captureCodexThreadId } as never,
      readinessTimeoutMs: 50,
      sleep: async () => {},
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
    const event = db.prepare("SELECT type, payload FROM events WHERE type = 'seat.handover_completed' ORDER BY seq DESC LIMIT 1").get() as { type: string; payload: string };
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
    ["discovered source", "discovered:some-id"],
  ])("keeps dry-run mutation-free across %s (AC-1)", async (_label, source) => {
    seedSeat();
    const before = durableRows();

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source,
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    expect(result.ok && "plan" in result && result.plan.willMutate).toBe(false);
    expect(createSession).not.toHaveBeenCalled();
    expect(hasSession).not.toHaveBeenCalled();
    expect(durableRows()).toBe(before);
  });

  const SUCCESSOR_NAME = "dev-impl@seat-rig-h1SUCCID0";

  it("composes the full cycle for a fresh source: create -> deliver -> verify -> rebind", async () => {
    const { node } = seedSeat({ runtime: "codex" });

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "context-wall",
      source: "fresh",
      operator: "orch-lead@seat-rig",
    });

    expect(result.ok).toBe(true);
    if (!result.ok || !("result" in result)) throw new Error("expected handover result");
    expect(result.result).toMatchObject({
      ok: true,
      mutated: true,
      previousOccupant: "dev-impl@seat-rig",
      currentOccupant: SUCCESSOR_NAME,
      source: { mode: "fresh" },
      sideEffects: { startupContextDelivered: true },
    });

    // Driver note 1: createSession called with the successor name + node cwd + identity env.
    expect(createSession).toHaveBeenCalledTimes(1);
    const [name, cwd, env] = createSession.mock.calls[0]!;
    expect(name).toBe(SUCCESSOR_NAME);
    expect(cwd).toBe("/project");
    expect(env).toMatchObject({
      OPENRIG_NODE_ID: node.id,
      OPENRIG_SESSION_NAME: SUCCESSOR_NAME,
      OPENRIG_RUNTIME: "codex",
    });

    // Driver note 2: pane resolved AFTER create, BEFORE the discovery upsert; the
    // resolved pane ("%9" from listPanes) is what the discovery candidate carries.
    expect(listPanes.mock.invocationCallOrder[0]!).toBeGreaterThan(createSession.mock.invocationCallOrder[0]!);
    expect(result.result.discovery.tmuxPane).toBe("%9");
    const successorRow = db.prepare("SELECT tmux_pane FROM discovered_sessions WHERE tmux_session = ?").get(SUCCESSOR_NAME) as { tmux_pane: string };
    expect(successorRow.tmux_pane).toBe("%9");

    // Driver note 3: the restore packet is delivered to the successor BEFORE the
    // continuity-verify presence probe (never verify an un-restored seat).
    expect(sendText).toHaveBeenCalledTimes(1);
    const [target, packet] = sendText.mock.calls[0]!;
    expect(target).toBe(SUCCESSOR_NAME);
    expect(packet).toContain("OpenRig seat handover");
    expect(packet).toContain("predecessor screen tail");
    expect(sendKeys).toHaveBeenCalledWith(SUCCESSOR_NAME, ["C-m"]);
    expect(sendText.mock.invocationCallOrder[0]!).toBeLessThan(hasSession.mock.invocationCallOrder[0]!);

    // B1: the successor was launched into a LIVE agent (launchHarness +
    // readiness) BEFORE commit — not a bare shell that only received text.
    expect(launchHarness).toHaveBeenCalledTimes(1);
    expect(checkReady).toHaveBeenCalled();
    // Rebind landed on the created successor.
    expect(sessionRegistry.getBindingForNode(node.id)?.tmuxSession).toBe(SUCCESSOR_NAME);
    const nodeRow = db.prepare("SELECT occupant_lifecycle, handover_result, previous_occupant FROM nodes WHERE id = ?").get(node.id) as Record<string, string | null>;
    expect(nodeRow).toMatchObject({ occupant_lifecycle: "active", handover_result: "complete", previous_occupant: "dev-impl@seat-rig" });

    // B2 (launched/fresh): the launch-scraped resume token is persisted on the
    // new claimed session atomically with the commit (provenance scrape).
    const newSession = db.prepare(
      "SELECT resume_type, resume_token, resume_provenance FROM sessions WHERE node_id = ? AND session_name = ?"
    ).get(node.id, SUCCESSOR_NAME) as Record<string, string | null>;
    expect(newSession).toMatchObject({ resume_type: "codex_id", resume_token: "codex-launch-tok", resume_provenance: "scrape" });
  });

  it.each([
    ["rebuild", "rebuild"],
    ["fork", "fork:0b0165d7"],
  ])("B3: loudly REJECTS a live %s handover (never a blank successor reported complete)", async (_label, source) => {
    const { node } = seedSeat({ runtime: "codex" });
    const before = durableRows();

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source });

    // Loud rejection BEFORE any successor is created; nothing committed.
    expect(result).toMatchObject({ ok: false, code: "source_not_supported" });
    expect(createSession).not.toHaveBeenCalled();
    expect(launchHarness).not.toHaveBeenCalled();
    expect(sendText).not.toHaveBeenCalled();
    expect(hasSession).not.toHaveBeenCalled();
    // Original seat/binding untouched; no node marked handover complete.
    expect(sessionRegistry.getBindingForNode(node.id)?.tmuxSession).toBe("dev-impl@seat-rig");
    const nodeRow = db.prepare("SELECT handover_result FROM nodes WHERE id = ?").get(node.id) as Record<string, string | null>;
    expect(nodeRow.handover_result).not.toBe("complete");
    expect(durableRows()).toBe(before);
  });

  it("B3: still returns a dry-run PLAN for fork/rebuild (planning is not blocked)", async () => {
    seedSeat({ runtime: "codex" });
    const before = durableRows();

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fork:abc", dryRun: true });

    expect(result.ok).toBe(true);
    expect(result.ok && "plan" in result && result.plan.willMutate).toBe(false);
    expect(durableRows()).toBe(before);
  });

  it("B2: captures the discovered successor's live resume token at commit (codex)", async () => {
    const { node } = seedSeat({ runtime: "codex" });
    const discovered = seedDiscovery();

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "mvp-proof",
      source: `discovered:${discovered.id}`,
    });

    expect(result.ok).toBe(true);
    if (!result.ok || !("result" in result)) throw new Error("expected handover result");
    // The FR-3 derive-helper was reused; the token is persisted with provenance
    // "adoption" on the new claimed session, and never appears in the event log.
    expect(captureCodexThreadId).toHaveBeenCalledWith("successor-session");
    const newSession = db.prepare(
      "SELECT resume_type, resume_token, resume_provenance FROM sessions WHERE node_id = ? AND session_name = ?"
    ).get(node.id, "successor-session") as Record<string, string | null>;
    expect(newSession).toMatchObject({ resume_type: "codex_id", resume_token: "codex-discovered-tok", resume_provenance: "adoption" });
    const captureEvent = db.prepare("SELECT payload FROM events WHERE type = 'session.resume_token_captured' ORDER BY seq DESC LIMIT 1").get() as { payload: string } | undefined;
    expect(captureEvent).toBeTruthy();
    const payload = JSON.parse(captureEvent!.payload);
    expect(payload).toMatchObject({ outcome: "captured", provenance: "adoption", redacted: true });
    expect(JSON.stringify(payload)).not.toContain("codex-discovered-tok");
  });

  it("B2: honest redacted skip when the discovered token cannot be derived", async () => {
    const { node } = seedSeat({ runtime: "codex" });
    const discovered = seedDiscovery();
    captureCodexThreadId.mockResolvedValue(undefined); // probe found nothing

    const result = await service.handover({
      seatRef: "dev-impl@seat-rig",
      reason: "mvp-proof",
      source: `discovered:${discovered.id}`,
    });

    // Handover still succeeds; token stays NULL; a redacted skip event is emitted.
    expect(result.ok).toBe(true);
    const newSession = db.prepare(
      "SELECT resume_token FROM sessions WHERE node_id = ? AND session_name = ?"
    ).get(node.id, "successor-session") as Record<string, string | null>;
    expect(newSession.resume_token).toBeNull();
    const skipEvent = db.prepare("SELECT payload FROM events WHERE type = 'session.resume_token_captured' ORDER BY seq DESC LIMIT 1").get() as { payload: string };
    expect(JSON.parse(skipEvent.payload)).toMatchObject({ outcome: "skipped", reason: "probe_timeout", redacted: true });
  });

  it("fails loudly and leaves the original binding when successor create fails", async () => {
    const { node } = seedSeat();
    createSession.mockResolvedValue({ ok: false, code: "duplicate_session", message: "duplicate session" });
    const before = durableRows();

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fresh" });

    expect(result).toMatchObject({ ok: false, code: "successor_create_failed" });
    expect((result as { message: string }).message).toContain("create_successor");
    expect(sendText).not.toHaveBeenCalled();
    expect(hasSession).not.toHaveBeenCalled();
    // Original seat/binding untouched — commit never ran.
    expect(sessionRegistry.getBindingForNode(node.id)?.tmuxSession).toBe("dev-impl@seat-rig");
    expect(durableRows()).toBe(before);
  });

  it("maps a listPanes THROW after create to a loud successor_create_failed (no rejection, binding intact)", async () => {
    const { node } = seedSeat();
    // Successor tmux session created, but the pane probe rethrows.
    listPanes.mockRejectedValue(new Error("socket permission denied"));
    const before = durableRows();

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fresh" });

    expect(result).toMatchObject({ ok: false, code: "successor_create_failed" });
    expect((result as { message: string }).message).toContain("resolve_pane");
    // The launcher killed the orphan; verify + delivery never ran; original intact.
    expect(killSession).toHaveBeenCalledWith(SUCCESSOR_NAME);
    expect(sendText).not.toHaveBeenCalled();
    expect(hasSession).not.toHaveBeenCalled();
    expect(sessionRegistry.getBindingForNode(node.id)?.tmuxSession).toBe("dev-impl@seat-rig");
    expect(durableRows()).toBe(before);
  });

  it("unwinds the created successor when context delivery fails (no false-green)", async () => {
    const { node } = seedSeat();
    sendText.mockResolvedValue({ ok: false, code: "session_not_found", message: "can't find session" });

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fresh" });

    expect(result).toMatchObject({ ok: false, code: "context_delivery_failed" });
    expect((result as { message: string }).message).toContain("deliver-restore-packet");
    // Continuity verify never ran; the unmanaged successor is unwound.
    expect(hasSession).not.toHaveBeenCalled();
    expect(killSession).toHaveBeenCalledWith(SUCCESSOR_NAME);
    const successorRow = db.prepare("SELECT status FROM discovered_sessions WHERE tmux_session = ?").get(SUCCESSOR_NAME) as { status: string };
    expect(successorRow.status).toBe("vanished");
    // Original seat/binding intact.
    expect(sessionRegistry.getBindingForNode(node.id)?.tmuxSession).toBe("dev-impl@seat-rig");
  });

  it("unwinds the created successor when continuity verify fails after delivery", async () => {
    const { node } = seedSeat();
    hasSession.mockResolvedValue(false);

    const result = await service.handover({ seatRef: "dev-impl@seat-rig", reason: "context-wall", source: "fresh" });

    expect(result).toMatchObject({ ok: false, code: "successor_tmux_absent" });
    // Delivery happened, THEN verify failed, THEN cleanup.
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(killSession).toHaveBeenCalledWith(SUCCESSOR_NAME);
    const successorRow = db.prepare("SELECT status FROM discovered_sessions WHERE tmux_session = ?").get(SUCCESSOR_NAME) as { status: string };
    expect(successorRow.status).toBe("vanished");
    expect(sessionRegistry.getBindingForNode(node.id)?.tmuxSession).toBe("dev-impl@seat-rig");
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
