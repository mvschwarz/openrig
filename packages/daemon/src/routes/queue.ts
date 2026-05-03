import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { EventBus } from "../domain/event-bus.js";
import type {
  QueueRepository,
  QueuePriority,
  QueueState,
} from "../domain/queue-repository.js";
import { QueueRepositoryError } from "../domain/queue-repository.js";
import type { InboxHandler } from "../domain/inbox-handler.js";
import { InboxHandlerError } from "../domain/inbox-handler.js";
import type { OutboxHandler } from "../domain/outbox-handler.js";

/**
 * Coordination L3 — Queue HTTP routes (PL-004 Phase A).
 *
 * Host-scoped. Backs `rig queue create|claim|update|handoff|show|list|inbox-*`.
 * Hot-potato strict-rejection happens in the domain layer; routes surface
 * structured errors with the validReasons enum so CLIs can render help.
 */
export function queueRoutes(): Hono {
  const app = new Hono();

  function getRepo(c: { get: (key: string) => unknown }): QueueRepository {
    return c.get("queueRepo" as never) as QueueRepository;
  }
  function getInbox(c: { get: (key: string) => unknown }): InboxHandler {
    return c.get("inboxHandler" as never) as InboxHandler;
  }
  function getOutbox(c: { get: (key: string) => unknown }): OutboxHandler {
    return c.get("outboxHandler" as never) as OutboxHandler;
  }
  function getEventBus(c: { get: (key: string) => unknown }): EventBus {
    return c.get("eventBus" as never) as EventBus;
  }

  function errorResponse(c: { json: (body: unknown, status?: number) => Response }, err: unknown): Response {
    if (err instanceof QueueRepositoryError) {
      const status = err.code === "qitem_not_found" ? 404
        : err.code === "missing_closure_reason" ? 400
        : err.code === "invalid_closure_reason" ? 400
        : err.code === "missing_closure_target" ? 400
        : err.code === "invalid_state" ? 400
        : err.code === "claim_destination_mismatch" ? 403
        : err.code === "qitem_not_claimable" ? 409
        : err.code === "qitem_not_in_progress" ? 409
        : err.code === "qitem_already_terminal" ? 409
        : err.code === "unknown_destination_rig" ? 400
        : 500;
      return c.json({ error: err.code, message: err.message, ...(err.meta ?? {}) }, status as 200);
    }
    if (err instanceof InboxHandlerError) {
      const status = err.code === "inbox_not_found" ? 404
        : err.code === "auth_failed" ? 401
        : err.code === "absorb_destination_mismatch" ? 403
        : err.code === "deny_destination_mismatch" ? 403
        : err.code === "inbox_already_denied" ? 409
        : err.code === "inbox_not_pending" ? 409
        : 500;
      return c.json({ error: err.code, message: err.message }, status as 200);
    }
    const message = err instanceof Error ? err.message : "internal error";
    return c.json({ error: "internal_error", message }, 500);
  }

  // POST /create
  app.post("/create", async (c) => {
    const body = await c.req.json<{
      qitemId?: string;
      sourceSession?: string;
      destinationSession?: string;
      body?: string;
      priority?: QueuePriority;
      tier?: string;
      tags?: string[];
      expiresAt?: string;
      chainOfRecord?: string[];
    }>().catch(() => ({} as never));

    if (!body.sourceSession) return c.json({ error: "sourceSession is required" }, 400);
    if (!body.destinationSession) return c.json({ error: "destinationSession is required" }, 400);
    if (!body.body) return c.json({ error: "body is required" }, 400);

    try {
      const item = await getRepo(c).create({
        qitemId: body.qitemId,
        sourceSession: body.sourceSession,
        destinationSession: body.destinationSession,
        body: body.body,
        priority: body.priority,
        tier: body.tier,
        tags: body.tags,
        expiresAt: body.expiresAt,
        chainOfRecord: body.chainOfRecord,
        nudge: (body as { nudge?: boolean }).nudge,
      });
      return c.json(item, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // POST /:qitemId/claim
  app.post("/:qitemId/claim", async (c) => {
    const qitemId = c.req.param("qitemId");
    const body = await c.req.json<{ destinationSession?: string }>().catch(() => ({} as never));
    if (!body.destinationSession) return c.json({ error: "destinationSession is required" }, 400);
    try {
      const item = getRepo(c).claim({ qitemId, destinationSession: body.destinationSession });
      return c.json(item);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // POST /:qitemId/unclaim
  app.post("/:qitemId/unclaim", async (c) => {
    const qitemId = c.req.param("qitemId");
    const body = await c.req.json<{ destinationSession?: string; reason?: string }>().catch(() => ({} as never));
    if (!body.destinationSession) return c.json({ error: "destinationSession is required" }, 400);
    try {
      const item = getRepo(c).unclaim(qitemId, body.destinationSession, body.reason ?? "manual");
      return c.json(item);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // POST /:qitemId/update — general state mutator (incl. done)
  app.post("/:qitemId/update", async (c) => {
    const qitemId = c.req.param("qitemId");
    const body = await c.req.json<{
      actorSession?: string;
      state?: QueueState;
      transitionNote?: string;
      closureReason?: string;
      closureTarget?: string;
    }>().catch(() => ({} as never));
    if (!body.actorSession) return c.json({ error: "actorSession is required" }, 400);
    if (!body.state) return c.json({ error: "state is required" }, 400);

    try {
      const item = getRepo(c).update({
        qitemId,
        actorSession: body.actorSession,
        state: body.state,
        transitionNote: body.transitionNote,
        closureReason: body.closureReason,
        closureTarget: body.closureTarget,
      });
      return c.json(item);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // POST /:qitemId/handoff — transactional close+create
  app.post("/:qitemId/handoff", async (c) => {
    const qitemId = c.req.param("qitemId");
    const body = await c.req.json<{
      fromSession?: string;
      toSession?: string;
      body?: string;
      transitionNote?: string;
      priority?: QueuePriority;
      tier?: string;
      tags?: string[];
    }>().catch(() => ({} as never));
    if (!body.fromSession) return c.json({ error: "fromSession is required" }, 400);
    if (!body.toSession) return c.json({ error: "toSession is required" }, 400);

    try {
      const result = await getRepo(c).handoff({
        qitemId,
        fromSession: body.fromSession,
        toSession: body.toSession,
        body: body.body,
        transitionNote: body.transitionNote,
        priority: body.priority,
        tier: body.tier,
        tags: body.tags,
        nudge: (body as { nudge?: boolean }).nudge,
      });
      return c.json(result, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // POST /:qitemId/handoff-and-complete — variant of handoff that closes
  // source as `done` (terminal) instead of `handed-off` (intermediate).
  // Same atomic close+create + chain_of_record + default-nudge contract.
  app.post("/:qitemId/handoff-and-complete", async (c) => {
    const qitemId = c.req.param("qitemId");
    const body = await c.req.json<{
      fromSession?: string;
      toSession?: string;
      body?: string;
      transitionNote?: string;
      priority?: QueuePriority;
      tier?: string;
      tags?: string[];
      nudge?: boolean;
    }>().catch(() => ({} as never));
    if (!body.fromSession) return c.json({ error: "fromSession is required" }, 400);
    if (!body.toSession) return c.json({ error: "toSession is required" }, 400);

    try {
      const result = await getRepo(c).handoffAndComplete({
        qitemId,
        fromSession: body.fromSession,
        toSession: body.toSession,
        body: body.body,
        transitionNote: body.transitionNote,
        priority: body.priority,
        tier: body.tier,
        tags: body.tags,
        nudge: body.nudge,
      });
      return c.json(result, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // POST /:qitemId/fallback
  app.post("/:qitemId/fallback", async (c) => {
    const qitemId = c.req.param("qitemId");
    const body = await c.req.json<{ fallbackDestination?: string; reason?: string }>().catch(() => ({} as never));
    if (!body.fallbackDestination) return c.json({ error: "fallbackDestination is required" }, 400);
    try {
      const item = getRepo(c).routeToFallback(qitemId, body.fallbackDestination, body.reason ?? "manual");
      return c.json(item);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  // GET /whoami — caller's queue position from the daemon's perspective.
  // MUST precede /:qitemId so the literal path wins.
  app.get("/whoami", (c) => {
    const session = c.req.query("session");
    if (!session) return c.json({ error: "session is required" }, 400);
    const recentLimit = c.req.query("recentLimit")
      ? Number.parseInt(c.req.query("recentLimit")!, 10)
      : undefined;
    return c.json(getRepo(c).whoami(session, { recentLimit }));
  });

  // GET /list — list with filters. MUST precede /:qitemId so the literal path wins.
  app.get("/list", (c) => {
    const destinationSession = c.req.query("destinationSession") || undefined;
    const sourceSession = c.req.query("sourceSession") || undefined;
    const stateRaw = c.req.query("state") || undefined;
    const limit = c.req.query("limit") ? Number.parseInt(c.req.query("limit")!, 10) : undefined;
    const state = stateRaw ? (stateRaw.split(",") as QueueState[]) : undefined;
    const items = getRepo(c).list({ destinationSession, sourceSession, state, limit });
    return c.json(items);
  });

  // GET /overdue — surfaces in-progress qitems past closure_required_at.
  // MUST precede /:qitemId.
  app.get("/overdue", (c) => {
    const items = getRepo(c).findOverdue();
    return c.json(items);
  });

  // GET /:qitemId/transitions — registered before /:qitemId so the literal
  // suffix wins over the bare param route.
  app.get("/:qitemId/transitions", (c) => {
    const qitemId = c.req.param("qitemId");
    const repo = getRepo(c);
    if (!repo.getById(qitemId)) return c.json({ error: "qitem_not_found" }, 404);
    return c.json(repo.transitionLog.listForQitem(qitemId));
  });

  // GET /:qitemId — show one
  app.get("/:qitemId", (c) => {
    const qitemId = c.req.param("qitemId");
    const item = getRepo(c).getById(qitemId);
    if (!item) return c.json({ error: "qitem_not_found" }, 404);
    return c.json(item);
  });

  // ---- Inbox routes (mailbox) ----

  app.post("/inbox/drop", async (c) => {
    const body = await c.req.json<{
      inboxId?: string;
      destinationSession?: string;
      senderSession?: string;
      body?: string;
      tags?: string[];
      urgency?: string;
      auditPointer?: string;
      authenticatedSender?: string;
    }>().catch(() => ({} as never));
    if (!body.destinationSession) return c.json({ error: "destinationSession is required" }, 400);
    if (!body.senderSession) return c.json({ error: "senderSession is required" }, 400);
    if (!body.body) return c.json({ error: "body is required" }, 400);

    try {
      const entry = getInbox(c).drop(
        {
          inboxId: body.inboxId,
          destinationSession: body.destinationSession,
          senderSession: body.senderSession,
          body: body.body,
          tags: body.tags,
          urgency: body.urgency,
          auditPointer: body.auditPointer,
        },
        body.authenticatedSender
      );
      return c.json(entry, 201);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.post("/inbox/:inboxId/absorb", async (c) => {
    const inboxId = c.req.param("inboxId");
    const body = await c.req.json<{ receiverSession?: string }>().catch(() => ({} as never));
    if (!body.receiverSession) return c.json({ error: "receiverSession is required" }, 400);
    try {
      const result = await getInbox(c).absorb(inboxId, body.receiverSession);
      return c.json(result);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.post("/inbox/:inboxId/deny", async (c) => {
    const inboxId = c.req.param("inboxId");
    const body = await c.req.json<{ receiverSession?: string; reason?: string }>().catch(() => ({} as never));
    if (!body.receiverSession) return c.json({ error: "receiverSession is required" }, 400);
    if (!body.reason) return c.json({ error: "reason is required" }, 400);
    try {
      const entry = getInbox(c).deny(inboxId, body.receiverSession, body.reason);
      return c.json(entry);
    } catch (err) {
      return errorResponse(c, err);
    }
  });

  app.get("/inbox/pending", (c) => {
    const destinationSession = c.req.query("destinationSession");
    if (!destinationSession) return c.json({ error: "destinationSession is required" }, 400);
    return c.json(getInbox(c).listPending(destinationSession));
  });

  app.get("/inbox/list", (c) => {
    const destinationSession = c.req.query("destinationSession");
    if (!destinationSession) return c.json({ error: "destinationSession is required" }, 400);
    const limit = c.req.query("limit") ? Number.parseInt(c.req.query("limit")!, 10) : undefined;
    return c.json(getInbox(c).listForDestination(destinationSession, limit));
  });

  // ---- Outbox routes ----

  app.post("/outbox/record", async (c) => {
    const body = await c.req.json<{
      outboxId?: string;
      senderSession?: string;
      destinationSession?: string;
      body?: string;
      tags?: string[];
      urgency?: string;
      auditPointer?: string;
    }>().catch(() => ({} as never));
    if (!body.senderSession) return c.json({ error: "senderSession is required" }, 400);
    if (!body.destinationSession) return c.json({ error: "destinationSession is required" }, 400);
    if (!body.body) return c.json({ error: "body is required" }, 400);

    const entry = getOutbox(c).record({
      outboxId: body.outboxId,
      senderSession: body.senderSession,
      destinationSession: body.destinationSession,
      body: body.body,
      tags: body.tags,
      urgency: body.urgency,
      auditPointer: body.auditPointer,
    });
    return c.json(entry, 201);
  });

  app.get("/outbox/list", (c) => {
    const senderSession = c.req.query("senderSession");
    if (!senderSession) return c.json({ error: "senderSession is required" }, 400);
    const limit = c.req.query("limit") ? Number.parseInt(c.req.query("limit")!, 10) : undefined;
    return c.json(getOutbox(c).listForSender(senderSession, limit));
  });

  // ---- SSE watch over coordination events ----
  // Mounted at both /watch (legacy alias) and /sse (Phase A contract per IMPL).
  // Same handler; either path emits the identical event stream.

  const sseHandler = (c: Parameters<typeof streamSSE>[0]) => {
    const eventBus = getEventBus(c);

    return streamSSE(c, async (stream) => {
      const unsubscribe = eventBus.subscribe((event) => {
        if (
          event.type !== "queue.created" &&
          event.type !== "queue.handed_off" &&
          event.type !== "queue.claimed" &&
          event.type !== "queue.unclaimed" &&
          event.type !== "qitem.fallback_routed" &&
          event.type !== "qitem.closure_overdue" &&
          event.type !== "inbox.absorbed" &&
          event.type !== "inbox.denied"
        ) return;
        const sse = { id: String(event.seq), data: JSON.stringify(event) };
        stream.writeSSE(sse).catch(() => {});
      });

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

  return app;
}
