import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { EventBus } from "../domain/event-bus.js";
import type { ViewProjector } from "../domain/view-projector.js";
import { ViewProjectorError } from "../domain/view-projector.js";

/**
 * Coordination L5 — View HTTP routes (PL-004 Phase B).
 *
 * Backs `rig view` CLI verb. Lists registered views (built-in + custom),
 * runs view queries, and exposes view.changed SSE for downstream consumers
 * (PL-005 Operator Status / PL-006 Mission Control / PL-008 progress).
 *
 * Per Phase A R1 SSE route-order lesson (slice IMPL § Audit Row 12):
 * SSE/static routes are mounted BEFORE the bare-param /:name catchall.
 */
export function viewsRoutes(): Hono {
  const app = new Hono();

  function getProjector(c: { get: (key: string) => unknown }): ViewProjector {
    return c.get("viewProjector" as never) as ViewProjector;
  }
  function getEventBus(c: { get: (key: string) => unknown }): EventBus {
    return c.get("eventBus" as never) as EventBus;
  }

  function errorResponse(c: { json: (body: unknown, status?: number) => Response }, err: unknown): Response {
    if (err instanceof ViewProjectorError) {
      const status = err.code === "view_not_found" ? 404
        : err.code === "view_name_reserved" ? 409
        : err.code === "view_query_failed" ? 400
        : 500;
      return c.json({ error: err.code, message: err.message }, status as 200);
    }
    const message = err instanceof Error ? err.message : "internal error";
    return c.json({ error: "internal_error", message }, 500);
  }

  // POST /custom/register — register/update custom view.
  app.post("/custom/register", async (c) => {
    const body = await c.req.json<{
      viewName?: string;
      definition?: string;
      registeredBySession?: string;
    }>().catch(() => ({} as never));
    if (!body.viewName) return c.json({ error: "viewName is required" }, 400);
    if (!body.definition) return c.json({ error: "definition is required" }, 400);
    if (!body.registeredBySession) return c.json({ error: "registeredBySession is required" }, 400);
    try {
      const view = getProjector(c).registerCustomView({
        viewName: body.viewName,
        definition: body.definition,
        registeredBySession: body.registeredBySession,
      });
      return c.json(view, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // GET /list — built-in + custom view names.
  // MUST precede /:viewName so the literal path wins.
  app.get("/list", (c) => {
    return c.json(getProjector(c).list());
  });

  // ---- SSE for view.changed events ----
  // Generic SSE that emits ALL view.changed events. Per Phase A R1 lesson:
  // mount BEFORE /:viewName catchall.
  const sseHandler = (c: Parameters<typeof streamSSE>[0]) => {
    const eventBus = getEventBus(c);
    return streamSSE(c, async (stream) => {
      const unsubscribe = eventBus.subscribe((event) => {
        if (event.type !== "view.changed") return;
        const sse = { id: String(event.seq), data: JSON.stringify(event) };
        stream.writeSSE(sse).catch(() => {});
      });
      try {
        await new Promise<void>((resolve) => stream.onAbort(() => resolve()));
      } finally {
        unsubscribe();
      }
    });
  };
  app.get("/sse", sseHandler);
  app.get("/watch", sseHandler);

  // GET /:viewName/sse — view-specific SSE filtered by viewName.
  // The /:viewName/sse path is more specific than /:viewName so Hono
  // dispatches it correctly even with the catchall registered later.
  app.get("/:viewName/sse", (c) => {
    const viewName = c.req.param("viewName");
    const eventBus = getEventBus(c);
    return streamSSE(c, async (stream) => {
      const unsubscribe = eventBus.subscribe((event) => {
        if (event.type !== "view.changed") return;
        if (event.viewName !== viewName) return;
        const sse = { id: String(event.seq), data: JSON.stringify(event) };
        stream.writeSSE(sse).catch(() => {});
      });
      try {
        await new Promise<void>((resolve) => stream.onAbort(() => resolve()));
      } finally {
        unsubscribe();
      }
    });
  });

  // GET /:viewName — run a view (built-in or custom).
  // Comes LAST so /list, /sse, /watch, /:viewName/sse all win.
  app.get("/:viewName", (c) => {
    const viewName = c.req.param("viewName");
    const rig = c.req.query("rig") || undefined;
    const limit = c.req.query("limit") ? Number.parseInt(c.req.query("limit")!, 10) : undefined;
    try {
      const result = getProjector(c).show(viewName, { rig, limit });
      return c.json(result);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  return app;
}
