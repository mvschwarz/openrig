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
import { wireViewEventBridge } from "../src/domain/view-event-bridge.js";
import { viewsRoutes } from "../src/routes/views.js";
import { expectLimitParsing } from "./helpers/limit-query-cases.js";

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
    // A pinned clock keeps generatedAt equal across the requests a test compares.
    projector = new ViewProjector(db, bus, { now: () => new Date("2026-10-01T00:00:00.000Z") });
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

  it("GET /api/views/:viewName refuses only a non-numeric limit (#586)", async () => {
    // The projector clamps the limit to 1-1000, so large values keep working here.
    await expectLimitParsing(app, "/api/views/recently-active", { boundIntoSql: false });
  });

  it("GET /api/views/:viewName refuses a non-numeric limit only where the view binds it (#586)", async () => {
    const status = async (url: string) => (await app.request(url)).status;
    projector.registerCustomView({ viewName: "own-limit", definition: "SELECT qitem_id FROM queue_items LIMIT 1", registeredBySession: "alice@product-lab" });
    projector.registerCustomView({ viewName: "no-limit", definition: "SELECT qitem_id FROM queue_items", registeredBySession: "alice@product-lab" });

    // A custom view with its own LIMIT never uses ?limit=, so it answers as without one.
    const own = await app.request("/api/views/own-limit?limit=abc");
    expect(own.status).toBe(200);
    expect(((await own.json()) as { rowCount: number }).rowCount).toBe(1);
    // The execution view doesn't read the limit either.
    expect(await status("/api/views/execution?limit=abc")).toBe(await status("/api/views/execution"));
    // An unregistered name is still not found.
    expect(await status("/api/views/nope?limit=abc")).toBe(404);
    // Views that bind the limit refuse it.
    expect(await status("/api/views/no-limit?limit=abc")).toBe(400);
    expect(await status("/api/views/recently-active?limit=abc")).toBe(400);
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

  // ---- SSE consumer observes view.changed when queue mutates ----
  // Route-level test that mutates queue state and observes a view.changed
  // event. Wires the view-event-bridge in the test so the production code
  // path is exercised.
  it("R1 BLOCKER 2: queue mutation triggers view.changed visible to SSE consumer", async () => {
    // Wire the bridge so queue.created → view.changed flows through the
    // event-bus the SSE handler is subscribed to.
    wireViewEventBridge(bus, projector);

    // Subscribe to the SSE stream and read until we see a view.changed
    // line for the recently-active view (caused by queue.created), or
    // bail out after a short timeout.
    const sseResPromise = app.request("/api/views/recently-active/sse");

    // Mutate queue state in parallel: create a new qitem.
    await queueRepo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "trigger view.changed",
      nudge: false,
    });

    const res = await sseResPromise;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");

    // Read SSE body for up to ~1.5s and look for a view.changed event.
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const deadline = Date.now() + 1500;
    let observed = false;
    try {
      while (Date.now() < deadline && !observed) {
        const readP = reader.read();
        const tickP = new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), 200),
        );
        const { done, value } = (await Promise.race([readP, tickP])) as { done: boolean; value?: Uint8Array };
        if (!done && value) buffer += decoder.decode(value, { stream: true });
        if (buffer.includes('"type":"view.changed"') && buffer.includes('"viewName":"recently-active"')) {
          observed = true;
          break;
        }
        // Push another mutation if we haven't seen the event yet — the
        // first one may have raced past the SSE handler's subscription.
        if (Date.now() < deadline && !observed) {
          await queueRepo.create({
            sourceSession: "alice@rig",
            destinationSession: "bob@rig",
            body: `nudge-${Date.now()}`,
            nudge: false,
          });
        }
      }
    } finally {
      // Cancel via the reader (releases the stream lock cleanly).
      await reader.cancel().catch(() => {});
    }

    expect(observed).toBe(true);
  });

  // ---- queue.updated triggers view.changed visible to SSE consumer ----
  // pending → blocked / in-progress → done / closure / escalation
  // transitions through QueueRepository.update() must emit
  // queue.updated → view.changed. Without this, normal state mutations
  // never wake SSE consumers on /api/views/:name/sse.
  it("R2 BLOCKER: queue.update mutation triggers view.changed (cause=queue.updated) visible to SSE consumer", async () => {
    wireViewEventBridge(bus, projector);

    // Pre-create + claim a qitem so we can run an update path.
    const item = await queueRepo.create({
      sourceSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "pre-existing for update",
      nudge: false,
    });
    queueRepo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });

    // Subscribe to view SSE first so we don't miss the event.
    const sseResPromise = app.request("/api/views/recently-active/sse");

    // Run an update through the general state mutator (in-progress → done).
    queueRepo.update({
      qitemId: item.qitemId,
      actorSession: "bob@rig",
      state: "done",
      closureReason: "no-follow-on",
    });

    const res = await sseResPromise;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const deadline = Date.now() + 1500;
    let observed = false;
    try {
      while (Date.now() < deadline && !observed) {
        const readP = reader.read();
        const tickP = new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), 200),
        );
        const { done, value } = (await Promise.race([readP, tickP])) as { done: boolean; value?: Uint8Array };
        if (!done && value) buffer += decoder.decode(value, { stream: true });
        if (
          buffer.includes('"type":"view.changed"') &&
          buffer.includes('"viewName":"recently-active"') &&
          buffer.includes('"cause":"queue.updated"')
        ) {
          observed = true;
          break;
        }
        if (Date.now() < deadline && !observed) {
          const item2 = await queueRepo.create({
            sourceSession: "alice@rig",
            destinationSession: "bob@rig",
            body: `nudge-${Date.now()}`,
            nudge: false,
          });
          queueRepo.update({
            qitemId: item2.qitemId,
            actorSession: "bob@rig",
            state: "blocked",
            transitionNote: "nudge",
          });
        }
      }
    } finally {
      await reader.cancel().catch(() => {});
    }

    expect(observed).toBe(true);
  });
});
