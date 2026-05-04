import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { streamItemsSchema } from "../src/db/migrations/023_stream_items.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { viewsCustomSchema } from "../src/db/migrations/030_views_custom.js";
import { missionControlActionsSchema } from "../src/db/migrations/037_mission_control_actions.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { StreamStore } from "../src/domain/stream-store.js";
import { ViewProjector } from "../src/domain/view-projector.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { MissionControlWriteContract } from "../src/domain/mission-control/mission-control-write-contract.js";
import { MissionControlReadLayer } from "../src/domain/mission-control/mission-control-read-layer.js";
import { MissionControlFleetCliCapability } from "../src/domain/mission-control/mission-control-fleet-cli-capability.js";
import { MissionControlAuditBrowse } from "../src/domain/mission-control/audit-browse.js";
import { MissionControlNotificationDispatcher } from "../src/domain/mission-control/notification-dispatcher.js";
import { missionControlRoutes } from "../src/routes/mission-control.js";
import type {
  NotificationAdapter,
  NotificationDeliveryResult,
  NotificationPayload,
} from "../src/domain/mission-control/notification-adapter-types.js";

class FakeAdapter implements NotificationAdapter {
  readonly mechanism = "fake";
  readonly target = "fake://test";
  calls: NotificationPayload[] = [];
  async send(payload: NotificationPayload): Promise<NotificationDeliveryResult> {
    this.calls.push(payload);
    return { ok: true, ack: "fake-ok" };
  }
}

function buildApp(opts: {
  bus: EventBus;
  queueRepo: QueueRepository;
  bearerToken: string | null;
  withDispatcher: boolean;
}): { app: Hono; adapter: FakeAdapter | null; auditBrowse: MissionControlAuditBrowse; actionLog: MissionControlActionLog } {
  const db = (opts.bus as unknown as { db: Database.Database }).db;
  const viewProjector = new ViewProjector(db, opts.bus);
  const streamStore = new StreamStore(db, opts.bus);
  const rigRepo = new RigRepository(db);
  const fleetCli = new MissionControlFleetCliCapability({ db, eventBus: opts.bus, rigRepo });
  const actionLog = new MissionControlActionLog(db);
  const writeContract = new MissionControlWriteContract({
    db,
    eventBus: opts.bus,
    queueRepo: opts.queueRepo,
    actionLog,
  });
  const readLayer = new MissionControlReadLayer({
    db,
    queueRepo: opts.queueRepo,
    viewProjector,
    streamStore,
    fleetCliCapability: fleetCli,
  });
  const auditBrowse = new MissionControlAuditBrowse(db);
  let adapter: FakeAdapter | null = null;
  let dispatcher: MissionControlNotificationDispatcher | null = null;
  if (opts.withDispatcher) {
    adapter = new FakeAdapter();
    dispatcher = new MissionControlNotificationDispatcher({
      db,
      eventBus: opts.bus,
      adapter,
    });
  }
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("eventBus" as never, opts.bus);
    c.set("missionControlReadLayer" as never, readLayer);
    c.set("missionControlWriteContract" as never, writeContract);
    c.set("missionControlActionLog" as never, actionLog);
    c.set("missionControlFleetCliCapability" as never, fleetCli);
    c.set("missionControlAuditBrowse" as never, auditBrowse);
    if (dispatcher) c.set("missionControlNotificationDispatcher" as never, dispatcher);
    await next();
  });
  app.route(
    "/api/mission-control",
    missionControlRoutes({ bearerToken: opts.bearerToken }),
  );
  return { app, adapter, auditBrowse, actionLog };
}

describe("mission-control routes Phase B (PL-005)", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema, eventsSchema, streamItemsSchema,
      queueItemsSchema, queueTransitionsSchema, viewsCustomSchema,
      missionControlActionsSchema,
    ]);
    db.prepare(`INSERT INTO rigs (id, name) VALUES ('r-1', 'rig')`).run();
    bus = new EventBus(db);
    (bus as unknown as { db: Database.Database }).db = db;
    queueRepo = new QueueRepository(db, bus, { validateRig: () => true });
  });

  afterEach(() => db.close());

  describe("Bearer-token gate on POST /action", () => {
    it("returns 401 when bearer required but Authorization missing", async () => {
      const { app } = buildApp({ bus, queueRepo, bearerToken: "secret", withDispatcher: false });
      const created = await queueRepo.create({ sourceSession: "s@r", destinationSession: "d@r", body: "x" });
      const res = await app.request("/api/mission-control/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verb: "approve", qitemId: created.qitemId, actorSession: "h@r" }),
      });
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("unauthorized");
    });

    it("returns 200 when correct bearer provided", async () => {
      const { app } = buildApp({ bus, queueRepo, bearerToken: "secret", withDispatcher: false });
      const created = await queueRepo.create({ sourceSession: "s@r", destinationSession: "d@r", body: "x" });
      const res = await app.request("/api/mission-control/action", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer secret" },
        body: JSON.stringify({ verb: "approve", qitemId: created.qitemId, actorSession: "h@r" }),
      });
      expect(res.status).toBe(200);
    });

    it("returns 200 on writes when bearerToken=null (loopback-only mode passes through)", async () => {
      const { app } = buildApp({ bus, queueRepo, bearerToken: null, withDispatcher: false });
      const created = await queueRepo.create({ sourceSession: "s@r", destinationSession: "d@r", body: "x" });
      const res = await app.request("/api/mission-control/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verb: "approve", qitemId: created.qitemId, actorSession: "h@r" }),
      });
      expect(res.status).toBe(200);
    });

    it("Reads (GET /views/:name) remain UNgated even when bearerToken set (Phase B v0 default per planner brief)", async () => {
      const { app } = buildApp({ bus, queueRepo, bearerToken: "secret", withDispatcher: false });
      const res = await app.request("/api/mission-control/views/active-work");
      expect(res.status).toBe(200);
    });
  });

  describe("GET /audit", () => {
    it("returns rows + pagination metadata", async () => {
      const { app, actionLog } = buildApp({ bus, queueRepo, bearerToken: null, withDispatcher: false });
      // Seed an action.
      const created = await queueRepo.create({ sourceSession: "s@r", destinationSession: "d@r", body: "x" });
      actionLog.record({
        actionVerb: "approve",
        qitemId: created.qitemId,
        actorSession: "alice@r",
        actedAt: "2026-05-04T05:00:00.000Z",
      });
      const res = await app.request("/api/mission-control/audit");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { rows: unknown[]; hasMore: boolean; nextBeforeId: string | null };
      expect(body.rows).toHaveLength(1);
      expect(body.hasMore).toBe(false);
    });

    it("filter by qitem_id", async () => {
      const { app, actionLog } = buildApp({ bus, queueRepo, bearerToken: null, withDispatcher: false });
      const a = await queueRepo.create({ sourceSession: "s@r", destinationSession: "d@r", body: "a" });
      const b = await queueRepo.create({ sourceSession: "s@r", destinationSession: "d@r", body: "b" });
      actionLog.record({ actionVerb: "approve", qitemId: a.qitemId, actorSession: "x@r", actedAt: "2026-05-04T05:00:00Z" });
      actionLog.record({ actionVerb: "approve", qitemId: b.qitemId, actorSession: "x@r", actedAt: "2026-05-04T05:01:00Z" });
      const res = await app.request(`/api/mission-control/audit?qitem_id=${a.qitemId}`);
      const body = (await res.json()) as { rows: Array<{ qitemId: string }> };
      expect(body.rows).toHaveLength(1);
      expect(body.rows[0]!.qitemId).toBe(a.qitemId);
    });

    it("returns 500 on unknown action_verb (audit-browse rejects with structured error)", async () => {
      const { app } = buildApp({ bus, queueRepo, bearerToken: null, withDispatcher: false });
      const res = await app.request("/api/mission-control/audit?action_verb=totally-bogus");
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("audit_query_failed");
    });

    it("audit GET is read-only: POST returns 404 (route not registered for POST)", async () => {
      const { app } = buildApp({ bus, queueRepo, bearerToken: null, withDispatcher: false });
      const res = await app.request("/api/mission-control/audit", { method: "POST" });
      expect(res.status).toBe(404);
    });
  });

  describe("POST /notifications/test", () => {
    it("returns 503 when dispatcher not configured", async () => {
      const { app } = buildApp({ bus, queueRepo, bearerToken: null, withDispatcher: false });
      const res = await app.request("/api/mission-control/notifications/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("notifications_unconfigured");
    });

    it("returns 200 + dispatches synthetic notification when dispatcher wired", async () => {
      const { app, adapter } = buildApp({
        bus,
        queueRepo,
        bearerToken: null,
        withDispatcher: true,
      });
      const res = await app.request("/api/mission-control/notifications/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; mechanism: string };
      expect(body.ok).toBe(true);
      expect(body.mechanism).toBe("fake");
      expect(adapter!.calls).toHaveLength(1);
    });

    it("notifications/test requires bearer when configured", async () => {
      const { app } = buildApp({
        bus,
        queueRepo,
        bearerToken: "secret",
        withDispatcher: true,
      });
      const res = await app.request("/api/mission-control/notifications/test", {
        method: "POST",
      });
      expect(res.status).toBe(401);
    });
  });

  describe("Route-order discipline", () => {
    it("/audit literal path does NOT shadow /views/:view-name", async () => {
      const { app } = buildApp({ bus, queueRepo, bearerToken: null, withDispatcher: false });
      const auditRes = await app.request("/api/mission-control/audit");
      const viewRes = await app.request("/api/mission-control/views/active-work");
      expect(auditRes.status).toBe(200);
      expect(viewRes.status).toBe(200);
      const auditBody = (await auditRes.json()) as { rows: unknown[] };
      const viewBody = (await viewRes.json()) as { viewName?: string };
      expect(auditBody.rows).toBeDefined();
      expect(viewBody.viewName).toBe("active-work");
    });

    it("/notifications/test literal does NOT shadow other POST routes", async () => {
      const { app } = buildApp({ bus, queueRepo, bearerToken: null, withDispatcher: false });
      const created = await queueRepo.create({ sourceSession: "s@r", destinationSession: "d@r", body: "x" });
      const actionRes = await app.request("/api/mission-control/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verb: "approve", qitemId: created.qitemId, actorSession: "h@r" }),
      });
      expect(actionRes.status).toBe(200);
    });
  });
});
