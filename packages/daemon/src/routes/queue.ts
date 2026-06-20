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

/**
 * OPR.0.3.2.20 — attention-class predicate for the `/list?attention=1`
 * filter. Mirrors the mission-control read layer's semantics so the
 * For You Action-required + Approval lenses agree with the
 * single-pane view:
 *
 *   - approval class  → tier === "human-gate"
 *   - action-required → destinationSession matches
 *                       /^human(?:-[A-Za-z0-9._-]+)?@(kernel|host)$/
 *
 * Exported so the predicate is a discrete, testable surface. The route
 * layer composes this with the open-state default so only unresolved
 * items appear — closed/done attention items are not surfaced.
 */
export function isAttentionItem(q: { tier: string | null; destinationSession: string }): boolean {
  if (q.tier === "human-gate") return true;
  return /^human(?:-[A-Za-z0-9._-]+)?@(kernel|host)$/.test(q.destinationSession ?? "");
}


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

  /** PL-007: validate `target_repo` against the source rig's typed
   *  workspace block. Returns 3-part structured error when the repo name
   *  does not match the source rig's RigSpec.workspace.repos[]. Sessions
   *  not associated with a workspace-bearing rig pass-through (target_repo
   *  is honored as a free-form tag for back-compat). */
  function validateTargetRepo(
    c: { get: (key: string) => unknown },
    sourceSession: string,
    targetRepo: string,
  ): { ok: true } | { ok: false; error: string; message: string; meta?: Record<string, unknown> } {
    const rigRepo = c.get("rigRepo" as never) as import("../domain/rig-repository.js").RigRepository | undefined;
    if (!rigRepo) return { ok: true };
    const m = /^[^@]+@(.+)$/.exec(sourceSession);
    if (!m) return { ok: true };
    const rigName = m[1]!;
    const rigs = rigRepo.findRigsByName(rigName);
    if (rigs.length === 0) return { ok: true };
    const rigId = rigs[0]!.id;
    const ws = rigRepo.getRigWorkspace(rigId);
    if (!ws) return { ok: true };
    const known = ws.repos.map((r) => r.name);
    if (!known.includes(targetRepo)) {
      return {
        ok: false,
        error: "unknown_target_repo",
        message: `target_repo "${targetRepo}" does not match any repo in rig ${rigName}'s workspace; check rig whoami --json | jq .workspace.repos to see declared repos`,
        meta: { rigName, knownRepos: known },
      };
    }
    return { ok: true };
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
      targetRepo?: string;
    }>().catch(() => ({} as never));

    if (!body.sourceSession) return c.json({ error: "sourceSession is required" }, 400);
    if (!body.destinationSession) return c.json({ error: "destinationSession is required" }, 400);
    if (!body.body) return c.json({ error: "body is required" }, 400);

    // PL-007: validate target_repo against source rig's workspace.repos[].
    if (body.targetRepo) {
      const validation = validateTargetRepo(c, body.sourceSession, body.targetRepo);
      if (!validation.ok) return c.json({ error: validation.error, message: validation.message, ...(validation.meta ?? {}) }, 400);
    }

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
        targetRepo: body.targetRepo,
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

  // POST /:qitemId/update — general state mutator (incl. done).
  //
  // OPR.0.3.2.21.FR-4(d-docs) — closure ≠ acceptance.
  //
  // `state=done` with `closure_reason=handed_off_to` records that the
  // source seat has DELIVERED the work to the next stage. It does NOT
  // record that the next stage has ACCEPTED the work — that's the next
  // stage's verdict on its own qitem (typically a separate close with
  // its own closure_reason).
  //
  // Closure vocabulary:
  //   - handed_off_to    delivered to next stage; acceptance pending
  //                      that stage's verdict on its own qitem
  //   - blocked_on       waiting on a named blocker (closureTarget)
  //   - denied           the source seat refuses the work
  //   - canceled         work no longer needed (no follow-on)
  //   - no-follow-on     completed in place; no further routing
  //   - escalation       routed to a higher-authority seat
  //
  // The "accepted" state IS NOT a queue state in v0.3.x — the qitem
  // model captures delivery + the receiving stage owns acceptance as
  // a separate transaction. (FR-4d-state schema change adding a
  // distinct "accepted" state is deferred to release-0.3.3.)
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
      targetRepo?: string;
    }>().catch(() => ({} as never));
    if (!body.fromSession) return c.json({ error: "fromSession is required" }, 400);
    if (!body.toSession) return c.json({ error: "toSession is required" }, 400);

    if (body.targetRepo) {
      const validation = validateTargetRepo(c, body.fromSession, body.targetRepo);
      if (!validation.ok) return c.json({ error: validation.error, message: validation.message, ...(validation.meta ?? {}) }, 400);
    }

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
        targetRepo: body.targetRepo,
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
      targetRepo?: string;
    }>().catch(() => ({} as never));
    if (!body.fromSession) return c.json({ error: "fromSession is required" }, 400);
    if (!body.toSession) return c.json({ error: "toSession is required" }, 400);

    if (body.targetRepo) {
      const validation = validateTargetRepo(c, body.fromSession, body.targetRepo);
      if (!validation.ok) return c.json({ error: validation.error, message: validation.message, ...(validation.meta ?? {}) }, 400);
    }

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
        targetRepo: body.targetRepo,
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
  //
  // OPR.0.3.2.20 — `?attention=1` filter for the For You priority
  // windowing slice. Returns OPEN attention-class qitems (the durable
  // source of truth for the UI Action-required + Approval lenses) so
  // those surfaces don't depend on the lossy ephemeral client event
  // FIFO. Class membership matches the mission-control read layer
  // semantics: tier='human-gate' OR destination matches
  // /^human(?:-[A-Za-z0-9._-]+)?@(kernel|host)$/. Open state defaults
  // to pending|in-progress|blocked (callers can still override via
  // `state=...`). Composable with destinationSession/sourceSession/
  // targetRepo/limit.
  app.get("/list", (c) => {
    const destinationSession = c.req.query("destinationSession") || undefined;
    const sourceSession = c.req.query("sourceSession") || undefined;
    const stateRaw = c.req.query("state") || undefined;
    const targetRepo = c.req.query("targetRepo") || undefined;
    const userLimit = c.req.query("limit") ? Number.parseInt(c.req.query("limit")!, 10) : undefined;
    const asSession = c.req.query("as") || undefined;
    const compact = c.req.query("compact") === "1";
    const rig = c.req.query("rig") || undefined;
    const activeOnly = c.req.query("activeOnly") === "1";
    const attention = c.req.query("attention") === "1";

    const state: QueueState[] | undefined = stateRaw
      ? (stateRaw.split(",") as QueueState[])
      : attention
        ? ["pending", "in-progress", "blocked"]
        : undefined;

    if (!attention) {
      const items = getRepo(c).list({
        destinationSession,
        sourceSession,
        state,
        targetRepo,
        limit: userLimit,
        asSession,
        compact,
        rig,
        activeOnly,
      });
      return c.json(items);
    }

    // OPR.0.3.2.20 — attention path goes through
    // QueueRepository.listAttention, which pushes the attention
    // predicate INTO the SQL WHERE clause so the LIMIT applies AFTER
    // attention filtering. Window-independent by construction: an
    // old human-gate item is never evicted by routine open qitems,
    // however many of them land after it (guard re-verify
    // qitem-20260518190827 BLOCKER 1). The earlier fetch-then-filter
    // shape (ATTENTION_FETCH_BOUND) is gone — the LIMIT bound is the
    // user-facing one only, applied at the SQL layer post-predicate.
    //
    // destinationSession/sourceSession/targetRepo are composable with
    // the attention predicate at the SQL layer (guard re-verify
    // qitem-20260518192210 BLOCKER 1 — the previous forward-fix
    // dropped composition). Scoped attention queries (e.g.,
    // attention=1&destinationSession=...) return ONLY the matching
    // attention items.
    const items = getRepo(c).listAttention({
      limit: userLimit,
      state,
      destinationSession,
      sourceSession,
      targetRepo,
    });
    // Defense-in-depth: refine with the JS predicate so the SQL
    // LIKE superset cannot leak a malformed destination through.
    const filtered = items.filter(isAttentionItem);
    return c.json(filtered);
  });

  // GET /overdue — surfaces in-progress qitems past closure_required_at.
  // MUST precede /:qitemId.
  app.get("/overdue", (c) => {
    const items = getRepo(c).findOverdue();
    return c.json(items);
  });

  // ---- SSE watch over coordination events ----
  // MUST precede /:qitemId so the literal `watch` and `sse` paths win
  // over the bare-param route (otherwise GET /api/queue/sse resolves as
  // /:qitemId with qitemId="sse" and returns 404 qitem_not_found).
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

  return app;
}
