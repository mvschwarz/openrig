import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { EventBus } from "../domain/event-bus.js";
import type { StreamStore } from "../domain/stream-store.js";

/**
 * Coordination L1 — Stream HTTP routes (PL-004 Phase A).
 *
 * Host-scoped (no rigId in path). Append-only intake/audit root for the
 * coordination primitive. CLI `rig stream` calls these endpoints.
 */
export function streamRoutes(): Hono {
  const app = new Hono();

  function getStore(c: { get: (key: string) => unknown }): StreamStore {
    return c.get("streamStore" as never) as StreamStore;
  }

  function getEventBus(c: { get: (key: string) => unknown }): EventBus {
    return c.get("eventBus" as never) as EventBus;
  }

  // POST /emit — append a stream item
  app.post("/emit", async (c) => {
    const body = await c.req.json<{
      streamItemId?: string;
      sourceSession?: string;
      body?: string;
      format?: string;
      hintType?: string | null;
      hintUrgency?: string | null;
      hintDestination?: string | null;
      hintTags?: string[] | null;
      interrupt?: boolean;
    }>().catch(() => ({} as never));

    if (!body.sourceSession) return c.json({ error: "sourceSession is required" }, 400);
    if (!body.body) return c.json({ error: "body is required" }, 400);

    const store = getStore(c);
    const item = store.emit({
      streamItemId: body.streamItemId,
      sourceSession: body.sourceSession,
      body: body.body,
      format: body.format,
      hintType: body.hintType ?? null,
      hintUrgency: body.hintUrgency ?? null,
      hintDestination: body.hintDestination ?? null,
      hintTags: body.hintTags ?? null,
      interrupt: body.interrupt,
    });
    return c.json(item, 201);
  });

  // GET /list — paginated list with filters
  app.get("/list", (c) => {
    const limit = c.req.query("limit") ? Number.parseInt(c.req.query("limit")!, 10) : undefined;
    const afterSortKey = c.req.query("afterSortKey") || undefined;
    const sourceSession = c.req.query("sourceSession") || undefined;
    const hintDestination = c.req.query("hintDestination") || undefined;
    const includeArchived = c.req.query("includeArchived") === "true";

    const store = getStore(c);
    const items = store.list({ limit, afterSortKey, sourceSession, hintDestination, includeArchived });
    return c.json(items);
  });

  // GET /watch — SSE for new stream.emitted events.
  // MUST precede /:streamItemId so the literal `watch` and `sse` paths
  // win over the bare-param route (otherwise GET /api/stream/sse resolves
  // as /:streamItemId with id="sse" and returns 404 stream-item-not-found).
  // Mounted at both /watch (legacy alias) and /sse (Phase A contract per
  // IMPL § Routes: GET /api/stream/sse). Same handler; either path emits
  // the identical event stream.
  const sseHandler = (c: Parameters<typeof streamSSE>[0]) => {
    const eventBus = getEventBus(c);
    const store = getStore(c);

    return streamSSE(c, async (stream) => {
      const initialDone = { value: false };
      const pending: Array<{ id: string; data: string }> = [];

      const unsubscribe = eventBus.subscribe((event) => {
        if (event.type !== "stream.emitted") return;
        const item = store.getById(event.streamItemId);
        if (!item) return;
        const sse = { id: item.streamItemId, data: JSON.stringify(item) };
        if (initialDone.value) {
          stream.writeSSE(sse).catch(() => {});
        } else {
          pending.push(sse);
        }
      });

      const initial = store.list({ limit: 50 });
      const sentIds = new Set<string>();
      for (const item of initial) {
        await stream.writeSSE({ id: item.streamItemId, data: JSON.stringify(item) });
        sentIds.add(item.streamItemId);
      }

      initialDone.value = true;
      for (const p of pending) {
        if (!sentIds.has(p.id)) await stream.writeSSE(p);
      }

      try {
        await new Promise<void>((resolve) => {
          stream.onAbort(() => resolve());
        });
      } finally {
        unsubscribe();
      }
    });
  };

  app.get("/watch", sseHandler);
  app.get("/sse", sseHandler);

  // GET /:streamItemId — fetch one
  app.get("/:streamItemId", (c) => {
    const id = c.req.param("streamItemId");
    const store = getStore(c);
    const item = store.getById(id);
    if (!item) return c.json({ error: "stream item not found" }, 404);
    return c.json(item);
  });

  // POST /:streamItemId/archive
  app.post("/:streamItemId/archive", (c) => {
    const id = c.req.param("streamItemId");
    const store = getStore(c);
    const ok = store.archive(id);
    if (!ok) return c.json({ error: "stream item not found or already archived" }, 404);
    return c.json({ ok: true });
  });

  return app;
}
