import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { EventBus } from "../domain/event-bus.js";
import type { ProjectClassifier } from "../domain/project-classifier.js";
import { ProjectClassifierError } from "../domain/project-classifier.js";
import type { ClassifierLeaseManager } from "../domain/classifier-lease-manager.js";
import { ClassifierLeaseError } from "../domain/classifier-lease-manager.js";

/**
 * Coordination L2 — Project (Classifier) HTTP routes (PL-004 Phase B).
 *
 * Backs `rig project` CLI verb. Lease lifecycle endpoints + project
 * (idempotent classify) + operator-verb reclaim + SSE.
 *
 * Per Phase A R1 SSE route-order lesson (slice IMPL § Audit Row 12):
 * SSE/static routes are mounted BEFORE the bare-param /:id catchall.
 */
export function projectsRoutes(): Hono {
  const app = new Hono();

  function getClassifier(c: { get: (key: string) => unknown }): ProjectClassifier {
    return c.get("projectClassifier" as never) as ProjectClassifier;
  }
  function getLease(c: { get: (key: string) => unknown }): ClassifierLeaseManager {
    return c.get("classifierLeaseManager" as never) as ClassifierLeaseManager;
  }
  function getEventBus(c: { get: (key: string) => unknown }): EventBus {
    return c.get("eventBus" as never) as EventBus;
  }

  function errorResponse(c: { json: (body: unknown, status?: number) => Response }, err: unknown): Response {
    if (err instanceof ProjectClassifierError) {
      const status = err.code === "idempotency_violation" ? 409
        : err.code === "project_not_found" ? 404
        : 500;
      return c.json({ error: err.code, message: err.message, ...(err.meta ?? {}) }, status as 200);
    }
    if (err instanceof ClassifierLeaseError) {
      const status = err.code === "lease_held" ? 409
        : err.code === "lease_session_mismatch" ? 403
        : err.code === "lease_not_active" ? 409
        : err.code === "lease_expired" ? 409
        : err.code === "lease_not_found" ? 404
        : err.code === "no_active_lease" ? 409
        : err.code === "lease_still_active" ? 409
        : 500;
      return c.json({ error: err.code, message: err.message, ...(err.meta ?? {}) }, status as 200);
    }
    const message = err instanceof Error ? err.message : "internal error";
    return c.json({ error: "internal_error", message }, 500);
  }

  // POST /lease/acquire — acquire active classifier lease for caller.
  app.post("/lease/acquire", async (c) => {
    const body = await c.req.json<{ classifierSession?: string }>().catch(() => ({} as never));
    if (!body.classifierSession) return c.json({ error: "classifierSession is required" }, 400);
    try {
      const lease = getLease(c).acquire(body.classifierSession);
      return c.json(lease, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // POST /lease/heartbeat — update last_heartbeat + extend expires_at.
  app.post("/lease/heartbeat", async (c) => {
    const body = await c.req.json<{ leaseId?: string; classifierSession?: string }>().catch(() => ({} as never));
    if (!body.leaseId) return c.json({ error: "leaseId is required" }, 400);
    if (!body.classifierSession) return c.json({ error: "classifierSession is required" }, 400);
    try {
      const lease = getLease(c).heartbeat(body.leaseId, body.classifierSession);
      return c.json(lease);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // POST /reclaim-classifier — operator-verb reclaim (per PRD § L2 hard rule).
  app.post("/reclaim-classifier", async (c) => {
    const body = await c.req.json<{
      byClassifierSession?: string;
      ifDead?: boolean;
      reason?: string;
    }>().catch(() => ({} as never));
    if (!body.byClassifierSession) return c.json({ error: "byClassifierSession is required" }, 400);
    try {
      const lease = getLease(c).reclaim(body.byClassifierSession, {
        ifDead: body.ifDead,
        reason: body.reason,
      });
      return c.json(lease);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // POST /project — project a stream item (idempotent on stream_item_id).
  app.post("/project", async (c) => {
    const body = await c.req.json<{
      streamItemId?: string;
      classifierSession?: string;
      classificationType?: string;
      classificationUrgency?: string;
      classificationMaturity?: string;
      classificationConfidence?: string;
      classificationDestination?: string;
      action?: string;
    }>().catch(() => ({} as never));
    if (!body.streamItemId) return c.json({ error: "streamItemId is required" }, 400);
    if (!body.classifierSession) return c.json({ error: "classifierSession is required" }, 400);
    try {
      const project = getClassifier(c).classify({
        streamItemId: body.streamItemId,
        classifierSession: body.classifierSession,
        classificationType: body.classificationType,
        classificationUrgency: body.classificationUrgency,
        classificationMaturity: body.classificationMaturity,
        classificationConfidence: body.classificationConfidence,
        classificationDestination: body.classificationDestination,
        action: body.action,
      });
      return c.json(project, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // GET /lease — show active lease.
  // MUST precede /:projectId so the literal path wins.
  app.get("/lease", (c) => {
    const lease = getLease(c).getActiveLease();
    if (!lease) return c.json({ error: "no_active_lease" }, 404);
    return c.json(lease);
  });

  // GET /list — list classifications with filters.
  // MUST precede /:projectId so the literal path wins.
  app.get("/list", (c) => {
    const classifierSession = c.req.query("classifierSession") || undefined;
    const classificationDestination = c.req.query("classificationDestination") || undefined;
    const limit = c.req.query("limit") ? Number.parseInt(c.req.query("limit")!, 10) : undefined;
    const items = getClassifier(c).list({ classifierSession, classificationDestination, limit });
    return c.json(items);
  });

  // ---- SSE for project + classifier events ----
  // MUST precede /:projectId so the literal `sse` and `watch` paths win
  // over the bare-param route. Per Phase A R1 SSE route-order lesson.
  const sseHandler = (c: Parameters<typeof streamSSE>[0]) => {
    const eventBus = getEventBus(c);
    return streamSSE(c, async (stream) => {
      const unsubscribe = eventBus.subscribe((event) => {
        if (
          event.type !== "project.classified" &&
          event.type !== "classifier.lease_acquired" &&
          event.type !== "classifier.lease_expired" &&
          event.type !== "classifier.dead" &&
          event.type !== "classifier.reclaimed"
        ) return;
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

  // GET /:projectId — show one project (must come AFTER literal routes).
  app.get("/:projectId", (c) => {
    const projectId = c.req.param("projectId");
    const project = getClassifier(c).getById(projectId);
    if (!project) return c.json({ error: "project_not_found" }, 404);
    return c.json(project);
  });

  return app;
}
