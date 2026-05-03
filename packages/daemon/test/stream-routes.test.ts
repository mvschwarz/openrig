import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { streamItemsSchema } from "../src/db/migrations/023_stream_items.js";
import { EventBus } from "../src/domain/event-bus.js";
import { StreamStore } from "../src/domain/stream-store.js";
import { streamRoutes } from "../src/routes/stream.js";

function buildApp(opts: { eventBus: EventBus; streamStore: StreamStore }): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("eventBus" as never, opts.eventBus);
    c.set("streamStore" as never, opts.streamStore);
    await next();
  });
  app.route("/api/stream", streamRoutes());
  return app;
}

describe("stream routes", () => {
  let db: Database.Database;
  let bus: EventBus;
  let store: StreamStore;
  let app: Hono;

  beforeEach(() => {
    db = createDb();
    migrate(db, [coreSchema, eventsSchema, streamItemsSchema]);
    bus = new EventBus(db);
    store = new StreamStore(db, bus);
    app = buildApp({ eventBus: bus, streamStore: store });
  });

  afterEach(() => db.close());

  it("POST /api/stream/emit creates and returns the item", async () => {
    const res = await app.request("/api/stream/emit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceSession: "alice@rig",
        body: "hello",
        hintDestination: "bob@rig",
        interrupt: true,
      }),
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as { streamItemId: string; body: string; interrupt: boolean };
    expect(data.body).toBe("hello");
    expect(data.interrupt).toBe(true);
    expect(data.streamItemId).toMatch(/^[0-9A-Z]{26}$/);
  });

  it("POST /api/stream/emit rejects missing required fields", async () => {
    const res = await app.request("/api/stream/emit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceSession: "alice@rig" }),
    });
    expect(res.status).toBe(400);
    const data = (await res.json()) as { error: string };
    expect(data.error).toMatch(/body/);
  });

  it("GET /api/stream/list returns chronological items with filters", async () => {
    store.emit({ sourceSession: "alice@rig", body: "1", hintDestination: "bob@rig" });
    store.emit({ sourceSession: "carol@rig", body: "2", hintDestination: "bob@rig" });
    store.emit({ sourceSession: "alice@rig", body: "3" });

    const res = await app.request("/api/stream/list?sourceSession=alice@rig");
    expect(res.status).toBe(200);
    const data = (await res.json()) as Array<{ body: string }>;
    expect(data).toHaveLength(2);
    expect(data.map((i) => i.body)).toEqual(["1", "3"]);

    const filtered = await app.request("/api/stream/list?hintDestination=bob@rig");
    const filteredData = (await filtered.json()) as Array<{ body: string }>;
    expect(filteredData).toHaveLength(2);
  });

  it("GET /api/stream/:id returns 404 on unknown id", async () => {
    const res = await app.request("/api/stream/nonexistent");
    expect(res.status).toBe(404);
  });

  it("POST /api/stream/:id/archive succeeds and excludes from default list", async () => {
    const item = store.emit({ sourceSession: "alice@rig", body: "x" });
    const res = await app.request(`/api/stream/${item.streamItemId}/archive`, { method: "POST" });
    expect(res.status).toBe(200);
    const list = await app.request("/api/stream/list");
    const data = (await list.json()) as unknown[];
    expect(data).toHaveLength(0);
  });

  // ---- PL-004 Phase A revision (R1): SSE alias ----
  it("/api/stream/sse is mounted alongside /api/stream/watch (same handler)", async () => {
    const watchRes = await app.request("/api/stream/watch", { method: "HEAD" });
    const sseRes = await app.request("/api/stream/sse", { method: "HEAD" });
    expect(watchRes.status).toBe(sseRes.status);
    expect(watchRes.status).toBeLessThan(500);
  });
});
