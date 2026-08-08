import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { ClaudeCompactionEnforcer } from "../src/domain/claude-compaction-enforcer.js";
import { EnforcerDecisionStore } from "../src/domain/enforcer-decision-store.js";
import { DefaultOccupantInvalidator } from "../src/domain/occupant-invalidator.js";
import { compactionRoutes } from "../src/routes/compaction.js";

const IDENTITY = "orch-lead@rig";
const SEAT = "claude-seat@rig";

describe("W4 compaction-control routes", () => {
  let db: Database.Database;
  let sessionRegistry: SessionRegistry;
  let nodeId: string;
  let generationUuid: string;
  let decisions: {
    create: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
  };
  let app: Hono;
  let manualDeps: {
    enforcer: ClaudeCompactionEnforcer;
    transport: Record<string, unknown>;
    usageStore: Record<string, unknown>;
  } | null;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const rigs = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    const rig = rigs.createRig("rig");
    const node = rigs.addNode(rig.id, "claude.seat", { runtime: "claude-code" });
    nodeId = node.id;
    sessionRegistry.registerSession(node.id, SEAT);
    generationUuid = sessionRegistry.currentOccupantGenerationForSession(SEAT)!;
    decisions = {
      create: vi.fn((input) => ({ decisionId: "decision-1", active: true, ...input })),
      list: vi.fn(() => [{
        decisionId: "hold-1",
        sessionName: SEAT,
        direction: "hold",
        active: true,
        lastObservedAt: "2026-08-08T18:00:30.000Z",
        lastObservedOutcome: "human_hold",
      }]),
      clear: vi.fn((input) => ({ decisionId: input.decisionId, active: false, releaseKind: "cleared" })),
    };
    manualDeps = null;
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("db" as never, db);
      c.set("sessionRegistry" as never, sessionRegistry);
      c.set("enforcerDecisionStore" as never, decisions);
      if (manualDeps) {
        c.set("compactionEnforcer" as never, manualDeps.enforcer);
        c.set("sessionTransport" as never, manualDeps.transport);
        c.set("contextUsageStore" as never, manualDeps.usageStore);
      }
      await next();
    });
    app.route("/api/compaction", compactionRoutes());
  });

  afterEach(() => db.close());

  const request = (path: string, body?: Record<string, unknown>, identity = IDENTITY) =>
    app.request(path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(identity ? { "X-OpenRig-Session": identity } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  function makeBoundaryTransport(afterPrep: () => void) {
    const delivered: string[] = [];
    const send = vi.fn(async (
      _sessionName: string,
      message: string,
      opts?: {
        beforeSend?: () =>
          | { reason: string; error?: string }
          | null
          | Promise<{ reason: string; error?: string } | null>;
      },
    ) => {
      if (send.mock.calls.length === 1) {
        delivered.push(message);
        afterPrep();
        return { ok: true as const };
      }
      const refusal = await opts?.beforeSend?.();
      if (refusal) return { ok: false as const, sessionName: SEAT, sent: false, ...refusal };
      delivered.push(message);
      return { ok: true as const };
    });
    return {
      delivered,
      send,
      transport: {
        send,
        resolveSessions: vi.fn(async () => ({ ok: true as const, sessions: [SEAT] })),
      },
    };
  }

  function installManualHarness(store: EnforcerDecisionStore, transport: Record<string, unknown>): void {
    const enforcer = new ClaudeCompactionEnforcer(
      {
        resolveClaudeCompactionPolicy: () => ({
          enabled: true,
          thresholdPercent: 80,
          preCompactInstruction: "prepare",
          compactInstruction: "",
          messageInline: "",
          messageFilePath: "",
          postRestoreAuditInstruction: "audit",
          authorizeTtlMinutes: 15,
        }),
      } as never,
      transport as never,
      {
        resolveOccupantGeneration: (sessionName: string) =>
          sessionRegistry.currentOccupantGenerationForSession(sessionName),
        decisionStore: store,
      },
    );
    manualDeps = {
      enforcer,
      transport,
      usageStore: {
        getForNode: () => ({
          availability: "known",
          usedPercentage: 90,
          transcriptPath: "/tmp/claude.jsonl",
          sessionId: "claude-session",
        }),
      },
    };
    decisions = store as never;
  }

  it("refuses an unattributable hold before writing any record", async () => {
    const response = await request("/api/compaction/control", {
      session: SEAT,
      direction: "hold",
      reason: "mid-fold",
    }, "");
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "unattributable_sender" });
    expect(decisions.create).not.toHaveBeenCalled();
  });

  it("refuses blank reasons and blanket authorizations loudly", async () => {
    const blank = await request("/api/compaction/control", {
      session: SEAT,
      direction: "hold",
      reason: "   ",
    });
    expect(blank.status).toBe(400);
    expect(await blank.json()).toMatchObject({ error: "reason_required" });

    const blanket = await request("/api/compaction/control", {
      session: SEAT,
      direction: "authorize",
      reason: "ignore refusals",
    });
    expect(blanket.status).toBe(400);
    expect(await blanket.json()).toMatchObject({ error: "automatic_reason_required" });
    expect(decisions.create).not.toHaveBeenCalled();
  });

  it.each([
    "runtime_filter",
    "no_usage_data",
    "invalid_policy",
    "below_threshold",
    "already_triggered_above_threshold",
    "dedup_window",
    "send_failed",
  ])("refuses excluded authorization reason %s", async (automaticReason) => {
    const response = await request("/api/compaction/control", {
      session: SEAT,
      direction: "authorize",
      automaticReason,
      reason: "not in locked set",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "automatic_reason_not_authorizable" });
    expect(decisions.create).not.toHaveBeenCalled();
  });

  it("derives actor/provenance and generation when creating a hold", async () => {
    const response = await request("/api/compaction/control", {
      session: SEAT,
      direction: "hold",
      reason: "finish current atomic action",
    });
    expect(response.status).toBe(201);
    expect(decisions.create).toHaveBeenCalledWith({
      enforcerKind: "claude_compaction",
      sessionName: SEAT,
      generationUuid,
      direction: "hold",
      automaticReason: null,
      reason: "finish current atomic action",
      actorSession: IDENTITY,
      identityProvenance: "transport:v1",
    });
  });

  it.each(["disabled", "post_restore_cooldown", "stale_generation"])(
    "creates one reason-matched authorization for %s without accepting caller expiry",
    async (automaticReason) => {
      const response = await request("/api/compaction/control", {
        session: SEAT,
        direction: "authorize",
        automaticReason,
        reason: `allow ${automaticReason} once`,
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
      expect(response.status).toBe(201);
      expect(decisions.create).toHaveBeenCalledWith({
        enforcerKind: "claude_compaction",
        sessionName: SEAT,
        generationUuid,
        direction: "authorize",
        automaticReason,
        reason: `allow ${automaticReason} once`,
        actorSession: IDENTITY,
        identityProvenance: "transport:v1",
      });
      expect(decisions.create.mock.calls[0]?.[0]).not.toHaveProperty("expiresAt");
    },
  );

  it("refuses decision creation when live generation cannot be resolved", async () => {
    const response = await request("/api/compaction/control", {
      session: "missing-seat@rig",
      direction: "hold",
      reason: "cannot scope without a generation",
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "generation_unavailable" });
    expect(decisions.create).not.toHaveBeenCalled();
  });

  it.each(["hold", "authorize"] as const)(
    "rejects historical session aliases for %s and accepts only the current alias",
    async (direction) => {
      const currentSeat = "claude-seat-next@rig";
      sessionRegistry.registerSession(nodeId, currentSeat);
      const automaticReason = direction === "authorize" ? "disabled" : undefined;
      const body = {
        session: SEAT,
        direction,
        ...(automaticReason ? { automaticReason } : {}),
        reason: `current-generation ${direction}`,
      };

      const stale = await request("/api/compaction/control", body);
      expect(stale.status).toBe(409);
      expect(await stale.json()).toMatchObject({
        error: "session_not_current",
        currentSession: currentSeat,
      });
      expect(decisions.create).not.toHaveBeenCalled();

      const current = await request("/api/compaction/control", { ...body, session: currentSeat });
      expect(current.status).toBe(201);
      expect(decisions.create).toHaveBeenCalledWith(expect.objectContaining({
        sessionName: currentSeat,
        generationUuid: sessionRegistry.currentOccupantGenerationForSession(currentSeat),
        direction,
      }));
    },
  );

  it("the public manual trigger honors a current hold, records observation, and sends nothing", async () => {
    const store = new EnforcerDecisionStore(db, {
      now: () => new Date("2026-08-08T18:00:00.000Z"),
      authorizeTtlMinutes: () => 15,
    });
    const hold = store.create({
      enforcerKind: "claude_compaction",
      sessionName: SEAT,
      generationUuid,
      direction: "hold",
      automaticReason: null,
      reason: "finish the current atomic action",
      actorSession: IDENTITY,
      identityProvenance: "transport:v1",
    });
    const send = vi.fn(async () => ({ ok: true as const }));
    const transport = {
      send,
      resolveSessions: vi.fn(async () => ({ ok: true as const, sessions: [SEAT] })),
    };
    const enforcer = new ClaudeCompactionEnforcer(
      {
        resolveClaudeCompactionPolicy: () => ({
          enabled: true,
          thresholdPercent: 80,
          preCompactInstruction: "prepare",
          compactInstruction: "",
          messageInline: "",
          messageFilePath: "",
          postRestoreAuditInstruction: "audit",
          authorizeTtlMinutes: 15,
        }),
      } as never,
      transport as never,
      {
        resolveOccupantGeneration: (sessionName: string) =>
          sessionRegistry.currentOccupantGenerationForSession(sessionName),
        decisionStore: store,
      },
    );
    manualDeps = {
      enforcer,
      transport,
      usageStore: {
        getForNode: () => ({
          availability: "known",
          usedPercentage: 90,
          transcriptPath: "/tmp/claude.jsonl",
          sessionId: "claude-session",
        }),
      },
    };
    decisions = store as never;

    const response = await request("/api/compaction/trigger", { session: SEAT });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      reason: "human_hold",
      decisionId: hold.decisionId,
    });
    expect(send).not.toHaveBeenCalled();
    expect(store.list({ sessionName: SEAT })).toContainEqual(expect.objectContaining({
      decisionId: hold.decisionId,
      lastObservedOutcome: "human_hold",
      lastObservedAt: "2026-08-08T18:00:00.000Z",
    }));
  });

  it("the public manual trigger rejects a historical alias before it can miss the current alias hold", async () => {
    const currentSeat = "claude-seat-next@rig";
    sessionRegistry.registerSession(nodeId, currentSeat);
    const currentGeneration = sessionRegistry.currentOccupantGenerationForSession(currentSeat)!;
    const store = new EnforcerDecisionStore(db, {
      now: () => new Date("2026-08-08T18:00:00.000Z"),
      authorizeTtlMinutes: () => 15,
    });
    const hold = store.create({
      enforcerKind: "claude_compaction",
      sessionName: currentSeat,
      generationUuid: currentGeneration,
      direction: "hold",
      automaticReason: null,
      reason: "finish the current atomic action",
      actorSession: IDENTITY,
      identityProvenance: "transport:v1",
    });
    const send = vi.fn(async () => ({ ok: true as const }));
    const transport = {
      send,
      resolveSessions: vi.fn(async () => ({ ok: true as const, sessions: [SEAT] })),
    };
    const enforcer = new ClaudeCompactionEnforcer(
      {
        resolveClaudeCompactionPolicy: () => ({
          enabled: true,
          thresholdPercent: 80,
          preCompactInstruction: "prepare",
          compactInstruction: "",
          messageInline: "",
          messageFilePath: "",
          postRestoreAuditInstruction: "audit",
          authorizeTtlMinutes: 15,
        }),
      } as never,
      transport as never,
      {
        resolveOccupantGeneration: (sessionName: string) =>
          sessionRegistry.currentOccupantGenerationForSession(sessionName),
        decisionStore: store,
      },
    );
    manualDeps = {
      enforcer,
      transport,
      usageStore: {
        getForNode: () => ({
          availability: "known",
          usedPercentage: 90,
          transcriptPath: "/tmp/claude.jsonl",
          sessionId: "claude-session",
        }),
      },
    };
    decisions = store as never;

    const stale = await request("/api/compaction/trigger", { session: SEAT });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      ok: false,
      error: "session_not_current",
      currentSession: currentSeat,
    });
    expect(send).not.toHaveBeenCalled();
    expect(store.list({ sessionName: currentSeat })).toContainEqual(expect.objectContaining({
      decisionId: hold.decisionId,
      active: true,
      lastObservedAt: null,
    }));

    const current = await request("/api/compaction/trigger", { session: currentSeat });
    expect(current.status).toBe(409);
    expect(await current.json()).toMatchObject({
      ok: false,
      reason: "human_hold",
      decisionId: hold.decisionId,
    });
    expect(send).not.toHaveBeenCalled();
    expect(store.list({ sessionName: currentSeat })).toContainEqual(expect.objectContaining({
      decisionId: hold.decisionId,
      lastObservedOutcome: "human_hold",
    }));
  });

  it("the public manual trigger observes a new-current-alias hold activated during preparation", async () => {
    const currentSeat = "claude-seat-next@rig";
    const store = new EnforcerDecisionStore(db, {
      now: () => new Date("2026-08-08T18:00:00.000Z"),
      authorizeTtlMinutes: () => 15,
    });
    let hold: ReturnType<EnforcerDecisionStore["create"]> | null = null;
    const tx = makeBoundaryTransport(() => {
      sessionRegistry.registerSession(nodeId, currentSeat, "handover");
      hold = store.create({
        enforcerKind: "claude_compaction",
        sessionName: currentSeat,
        generationUuid: sessionRegistry.currentOccupantGenerationForSession(currentSeat)!,
        direction: "hold",
        automaticReason: null,
        reason: "hold the new occupant",
        actorSession: IDENTITY,
        identityProvenance: "transport:v1",
      });
    });
    installManualHarness(store, tx.transport);

    const response = await request("/api/compaction/trigger", { session: SEAT });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      reason: "human_hold",
      decisionId: hold?.decisionId,
    });
    expect(tx.delivered).toHaveLength(1);
    expect(tx.delivered[0]).toContain("automatic compaction preparation");
    expect(store.list({ sessionName: currentSeat })).toContainEqual(expect.objectContaining({
      decisionId: hold?.decisionId,
      lastObservedOutcome: "human_hold",
      lastObservedAt: "2026-08-08T18:00:00.000Z",
    }));
  });

  it("the public manual trigger refuses an alias turnover without a hold at the final boundary", async () => {
    const currentSeat = "claude-seat-next@rig";
    const store = new EnforcerDecisionStore(db, {
      now: () => new Date("2026-08-08T18:00:00.000Z"),
      authorizeTtlMinutes: () => 15,
    });
    const tx = makeBoundaryTransport(() => {
      sessionRegistry.registerSession(nodeId, currentSeat, "handover");
    });
    installManualHarness(store, tx.transport);

    const response = await request("/api/compaction/trigger", { session: SEAT });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      reason: "session_not_current",
    });
    expect(tx.delivered).toHaveLength(1);
  });

  it("the public manual trigger refuses same-alias occupant-tenure drift at the final boundary", async () => {
    const store = new EnforcerDecisionStore(db, {
      now: () => new Date("2026-08-08T18:00:00.000Z"),
      authorizeTtlMinutes: () => 15,
    });
    const tx = makeBoundaryTransport(() => {
      sessionRegistry.mintOccupantTenure(nodeId, "handover");
    });
    installManualHarness(store, tx.transport);

    const response = await request("/api/compaction/trigger", { session: SEAT });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      reason: "occupant_generation_changed",
    });
    expect(tx.delivered).toHaveLength(1);
  });

  it("the public manual trigger refuses a same-alias handover when successor tenure minting fails", async () => {
    const store = new EnforcerDecisionStore(db, {
      now: () => new Date("2026-08-08T18:00:00.000Z"),
      authorizeTtlMinutes: () => 15,
    });
    const startingGeneration = sessionRegistry.currentOccupantGenerationForSession(SEAT);
    let invalidator: DefaultOccupantInvalidator;
    const tx = makeBoundaryTransport(() => {
      const mint = vi.spyOn(sessionRegistry, "mintOccupantTenure").mockImplementationOnce(() => {
        throw new Error("forced successor tenure mint failure");
      });
      sessionRegistry.registerClaimedSession(nodeId, SEAT, "handover");
      mint.mockRestore();

      expect(sessionRegistry.currentOccupantGenerationForSession(SEAT)).toBe(startingGeneration);
      expect(
        (db.prepare("SELECT session_name FROM sessions WHERE node_id = ? ORDER BY id DESC LIMIT 1")
          .get(nodeId) as { session_name: string }).session_name,
      ).toBe(SEAT);
      invalidator.invalidateRetiringOccupant({
        retiringSessionName: SEAT,
        successorSessionName: SEAT,
        retiringGeneration: startingGeneration ?? undefined,
      });
    });
    installManualHarness(store, tx.transport);
    invalidator = new DefaultOccupantInvalidator({
      enforcer: manualDeps!.enforcer,
      contextUsage: { invalidateOccupantSidecar: vi.fn() },
    });

    const response = await request("/api/compaction/trigger", { session: SEAT });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      reason: "occupant_generation_changed",
    });
    expect(tx.delivered).toHaveLength(1);
    expect(tx.delivered[0]).toContain("automatic compaction preparation");
  });

  it("lists durable observation fields without requiring a write identity", async () => {
    const response = await request(`/api/compaction/control?session=${encodeURIComponent(SEAT)}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      decisions: [{
        decisionId: "hold-1",
        sessionName: SEAT,
        direction: "hold",
        active: true,
        lastObservedAt: "2026-08-08T18:00:30.000Z",
        lastObservedOutcome: "human_hold",
      }],
    });
    expect(decisions.list).toHaveBeenCalledWith({ sessionName: SEAT });
  });

  it("clear derives its human actor and records a required release reason", async () => {
    const response = await request("/api/compaction/control/hold-1/clear", {
      reason: "atomic action completed",
    });
    expect(response.status).toBe(200);
    expect(decisions.clear).toHaveBeenCalledWith({
      decisionId: "hold-1",
      actorSession: IDENTITY,
      identityProvenance: "transport:v1",
      reason: "atomic action completed",
    });
  });
});
