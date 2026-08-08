import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { compactionRoutes } from "../src/routes/compaction.js";

const IDENTITY = "orch-lead@rig";
const SEAT = "claude-seat@rig";

describe("W4 compaction-control routes", () => {
  let db: Database.Database;
  let sessionRegistry: SessionRegistry;
  let generationUuid: string;
  let decisions: {
    create: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
  };
  let app: Hono;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    const rigs = new RigRepository(db);
    sessionRegistry = new SessionRegistry(db);
    const rig = rigs.createRig("rig");
    const node = rigs.addNode(rig.id, "claude.seat", { runtime: "claude-code" });
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
    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("db" as never, db);
      c.set("sessionRegistry" as never, sessionRegistry);
      c.set("enforcerDecisionStore" as never, decisions);
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
