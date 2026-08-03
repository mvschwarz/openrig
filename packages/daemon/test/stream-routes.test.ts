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

  it("GET /api/stream/list?direction=latest returns the newest active page chronologically", async () => {
    const items = Array.from({ length: 7 }, (_, index) =>
      store.emit({ sourceSession: "alice@rig", body: `item-${index + 1}` }),
    );

    const first = await app.request("/api/stream/list?limit=5&direction=latest");
    expect(first.status).toBe(200);
    expect(((await first.json()) as Array<{ body: string }>).map((item) => item.body)).toEqual([
      "item-3", "item-4", "item-5", "item-6", "item-7",
    ]);

    store.archive(items[6]!.streamItemId);
    const afterArchive = await app.request("/api/stream/list?limit=5&direction=latest");
    expect(((await afterArchive.json()) as Array<{ body: string }>).map((item) => item.body)).toEqual([
      "item-2", "item-3", "item-4", "item-5", "item-6",
    ]);
  });

  it("GET /api/stream/list rejects invalid or ambiguous direction input", async () => {
    expect((await app.request("/api/stream/list?direction=sideways")).status).toBe(400);
    expect((await app.request("/api/stream/list?direction=latest&afterSortKey=k1")).status).toBe(400);
  });

  it("GET /api/stream/list wires exact tag and canonicalized inclusive ISO time filters", async () => {
    const lower = store.emit({ sourceSession: "alice@rig", body: "lower", hintTags: ["context"] });
    const upper = store.emit({ sourceSession: "alice@rig", body: "upper", hintTags: ["context"] });
    const wrongTag = store.emit({ sourceSession: "alice@rig", body: "wrong-tag", hintTags: ["context-extra"] });
    const wrongSource = store.emit({ sourceSession: "bob@rig", body: "wrong-source", hintTags: ["context"] });
    const outsideWindow = store.emit({ sourceSession: "alice@rig", body: "outside-window", hintTags: ["context"] });
    const setTime = db.prepare("UPDATE stream_items SET ts_emitted = ? WHERE stream_item_id = ?");
    setTime.run("2026-08-03T09:00:00.000Z", lower.streamItemId);
    setTime.run("2026-08-03T10:00:00.000Z", upper.streamItemId);
    setTime.run("2026-08-03T09:30:00.000Z", wrongTag.streamItemId);
    setTime.run("2026-08-03T09:45:00.000Z", wrongSource.streamItemId);
    setTime.run("2026-08-03T10:00:00.001Z", outsideWindow.streamItemId);

    const res = await app.request(
      "/api/stream/list?sourceSession=alice%40rig&hintTag=context&since=2026-08-03T11%3A00%3A00%2B02%3A00&until=2026-08-03T06%3A00%3A00-04%3A00",
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as Array<{ body: string }>).map((item) => item.body)).toEqual(["lower", "upper"]);
  });

  it("GET /api/stream/list rejects invalid time windows", async () => {
    const invalidSince = await app.request("/api/stream/list?since=not-a-time");
    expect(invalidSince.status).toBe(400);
    expect(await invalidSince.json()).toEqual({ error: "since must be a valid ISO timestamp" });
    const invalidUntil = await app.request("/api/stream/list?until=not-a-time");
    expect(invalidUntil.status).toBe(400);
    expect(await invalidUntil.json()).toEqual({ error: "until must be a valid ISO timestamp" });
    const reversed = await app.request(
      "/api/stream/list?since=2026-08-03T10%3A00%3A00.000Z&until=2026-08-03T09%3A00%3A00.000Z",
    );
    expect(reversed.status).toBe(400);
    expect(await reversed.json()).toEqual({ error: "since must not be after until" });
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

  // ---- PL-004 Phase A revision (R1): SSE route — live GET reaches handler ----
  // Per QA finding: HEAD comparison was inadequate. Dynamic route shadowing
  // (/:streamItemId catching `sse` and `watch` as ids) returns 404 with
  // `stream item not found` instead of the SSE handler. Live GET asserting
  // content-type: text/event-stream proves the handler is reached.

  it("GET /api/stream/sse returns 200 + content-type: text/event-stream (handler reached)", async () => {
    const res = await app.request("/api/stream/sse");
    try {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
    } finally {
      await res.body?.cancel();
    }
  });

  it("GET /api/stream/watch returns 200 + content-type: text/event-stream (handler reached)", async () => {
    const res = await app.request("/api/stream/watch");
    try {
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
    } finally {
      await res.body?.cancel();
    }
  });

  it("GET /api/stream/sse does NOT return stream-item-not-found (route-order regression guard)", async () => {
    const res = await app.request("/api/stream/sse");
    try {
      expect(res.status).not.toBe(404);
      const ct = res.headers.get("content-type") ?? "";
      expect(ct).not.toContain("application/json");
    } finally {
      await res.body?.cancel();
    }
  });
});
