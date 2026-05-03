import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { viewsCustomSchema } from "../src/db/migrations/030_views_custom.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { ViewProjector } from "../src/domain/view-projector.js";
import { viewsRoutes } from "../src/routes/views.js";

function buildApp(opts: {
  eventBus: EventBus;
  projector: ViewProjector;
}): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("eventBus" as never, opts.eventBus);
    c.set("viewProjector" as never, opts.projector);
    await next();
  });
  app.route("/api/views", viewsRoutes());
  return app;
}

describe("views routes (PL-004 Phase B)", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;
  let projector: ViewProjector;
  let app: Hono;

  beforeEach(async () => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, queueItemsSchema, queueTransitionsSchema, viewsCustomSchema]);
    bus = new EventBus(db);
    queueRepo = new QueueRepository(db, bus);
    projector = new ViewProjector(db, bus);
    app = buildApp({ eventBus: bus, projector });
    // Seed a few qitems so views have something to project.
    await queueRepo.create({
      sourceSession: "alice@product-lab",
      destinationSession: "planning@product-lab",
      body: "x",
      nudge: false,
    });
    await queueRepo.create({
      sourceSession: "alice@product-lab",
      destinationSession: "delivery@product-lab",
      body: "y",
      nudge: false,
    });
  });

  afterEach(() => db.close());

  it("GET /api/views/list returns built-in + custom view names", async () => {
    const res = await app.request("/api/views/list");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { builtIn: string[]; custom: unknown[] };
    expect(body.builtIn).toContain("recently-active");
    expect(body.builtIn).toContain("founder");
    expect(body.builtIn).toContain("pod-load");
    expect(body.builtIn).toContain("escalations");
    expect(body.builtIn).toContain("held");
    expect(body.builtIn).toContain("activity");
    expect(body.custom).toHaveLength(0);
  });

  it("GET /api/views/recently-active returns rows + viewName + generatedAt", async () => {
    const res = await app.request("/api/views/recently-active");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { viewName: string; rowCount: number; rows: unknown[]; generatedAt: string };
    expect(body.viewName).toBe("recently-active");
    expect(body.rowCount).toBe(2);
    expect(body.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("GET /api/views/<unknown-view> returns 404 view_not_found", async () => {
    const res = await app.request("/api/views/nonexistent-view");
    expect(res.status).toBe(404);
    const err = (await res.json()) as { error: string };
    expect(err.error).toBe("view_not_found");
  });

  it("GET /api/views/recently-active?limit=1 honors limit query", async () => {
    const res = await app.request("/api/views/recently-active?limit=1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rowCount: number };
    expect(body.rowCount).toBe(1);
  });

  it("POST /api/views/custom/register registers custom view; show works via name", async () => {
    const reg = await app.request("/api/views/custom/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        viewName: "all-pending",
        definition: "SELECT qitem_id FROM queue_items WHERE state = 'pending'",
        registeredBySession: "operator@rig",
      }),
    });
    expect(reg.status).toBe(201);
    const res = await app.request("/api/views/all-pending");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { viewName: string; rowCount: number };
    expect(body.viewName).toBe("all-pending");
    expect(body.rowCount).toBeGreaterThan(0);
  });

  it("POST /api/views/custom/register with reserved name returns 409 view_name_reserved", async () => {
    const res = await app.request("/api/views/custom/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        viewName: "recently-active",
        definition: "SELECT 1",
        registeredBySession: "operator@rig",
      }),
    });
    expect(res.status).toBe(409);
    const err = (await res.json()) as { error: string };
    expect(err.error).toBe("view_name_reserved");
  });

  it("R1 SSE pattern: GET /api/views/sse returns 200 + content-type text/event-stream", async () => {
    const res = await app.request("/api/views/sse");
    try {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
    } finally {
      await res.body?.cancel();
    }
  });

  it("R1 SSE pattern: GET /api/views/recently-active/sse returns 200 + content-type text/event-stream", async () => {
    const res = await app.request("/api/views/recently-active/sse");
    try {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
    } finally {
      await res.body?.cancel();
    }
  });

  it("R1 SSE pattern: GET /api/views/sse does NOT return view_not_found (route-order regression guard)", async () => {
    const res = await app.request("/api/views/sse");
    try {
      expect(res.status).not.toBe(404);
      expect(res.headers.get("content-type") ?? "").not.toContain("application/json");
    } finally {
      await res.body?.cancel();
    }
  });
});
