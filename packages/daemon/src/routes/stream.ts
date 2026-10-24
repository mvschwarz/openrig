import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { EventBus } from "../domain/event-bus.js";
import { StreamCursorExpiredError, type StreamStore } from "../domain/stream-store.js";
import { listSubscriptions, readPage, subscribe, unsubscribe } from "../domain/stream-subscriptions.js";
import { requireSenderIdentity, resolveRecordedProvenance } from "./require-sender-identity.js";
import { queryLimit } from "./query-limit.js";

const ISO_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function hasSubMillisecondPrecision(value: string): boolean {
  const fraction = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/.exec(value)?.[1];
  return /[1-9]/.test(fraction?.slice(3) ?? "");
}

function normalizeIsoTimestamp(value: string): string | null {
  const match = ISO_TIMESTAMP.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, 0);
  if (
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() + 1 !== month ||
    local.getUTCDate() !== day ||
    local.getUTCHours() !== hour ||
    local.getUTCMinutes() !== minute ||
    local.getUTCSeconds() !== second
  ) return null;
  const epochMs = Date.parse(value);
  return Number.isFinite(epochMs) ? new Date(epochMs).toISOString() : null;
}

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

    // P21 I3: the stream source is the transport-derived identity, never body.sourceSession.
    const identity = requireSenderIdentity(c, { verb: "stream emit", bodyClaim: body.sourceSession });
    if (!identity.ok) return identity.response;
    if (!body.body) return c.json({ error: "body is required" }, 400);

    const store = getStore(c);
    const item = store.emit({
      streamItemId: body.streamItemId,
      sourceSession: identity.session,
      body: body.body,
      format: body.format,
      hintType: body.hintType ?? null,
      hintUrgency: body.hintUrgency ?? null,
      hintDestination: body.hintDestination ?? null,
      hintTags: body.hintTags ?? null,
      interrupt: body.interrupt,
      identityProvenance: resolveRecordedProvenance(c, identity), // P21 §4 era-stamp: transport:v1 if the header named the actor here, else claimed:v1 (resolveRecordedProvenance degrades)
    });
    return c.json(item, 201);
  });

  // GET /list — paginated list with filters
  app.get("/list", (c) => {
    const parsed = queryLimit(c);
    if (!parsed.ok) return parsed.response;
    const limit = parsed.limit;
    const afterSortKey = c.req.query("afterSortKey") || undefined;
    const direction = c.req.query("direction");
    if (direction && direction !== "chronological" && direction !== "latest") {
      return c.json({ error: "direction must be chronological or latest" }, 400);
    }
    if (direction === "latest" && afterSortKey) {
      return c.json({ error: "direction=latest cannot be combined with afterSortKey" }, 400);
    }
    const parsedDirection = direction === "latest" || direction === "chronological" ? direction : undefined;
    const sourceSession = c.req.query("sourceSession") || undefined;
    const hintDestination = c.req.query("hintDestination") || undefined;
    const hintTag = c.req.query("hintTag") || undefined;
    const sinceInput = c.req.query("since") || undefined;
    const untilInput = c.req.query("until") || undefined;
    let since: string | undefined;
    let until: string | undefined;
    if (sinceInput) {
      if (hasSubMillisecondPrecision(sinceInput)) {
        return c.json({ error: "since must use at most millisecond precision" }, 400);
      }
      since = normalizeIsoTimestamp(sinceInput) ?? undefined;
      if (!since) return c.json({ error: "since must be a valid ISO timestamp" }, 400);
    }
    if (untilInput) {
      if (hasSubMillisecondPrecision(untilInput)) {
        return c.json({ error: "until must use at most millisecond precision" }, 400);
      }
      until = normalizeIsoTimestamp(untilInput) ?? undefined;
      if (!until) return c.json({ error: "until must be a valid ISO timestamp" }, 400);
    }
    if (since && until && since > until) {
      return c.json({ error: "since must not be after until" }, 400);
    }
    const includeArchived = c.req.query("includeArchived") === "true";

    const store = getStore(c);
    try {
      const items = store.list({
        limit,
        afterSortKey,
        sourceSession,
        hintDestination,
        hintTag,
        since,
        until,
        includeArchived,
        ...(parsedDirection ? { direction: parsedDirection } : {}),
      });
      return c.json(items);
    } catch (err) {
      if (!(err instanceof StreamCursorExpiredError)) throw err;
      let prunedThrough: string | null = null;
      try {
        prunedThrough = (store.db.prepare("SELECT pruned_through_ts AS ts FROM stream_retention_marks WHERE id = 1").get() as { ts?: string } | undefined)?.ts ?? null;
      } catch { /* a daemon database without stream retention */ }
      return c.json({ error: "stream_cursor_expired", afterSortKey: err.afterSortKey, prunedThrough,
        message: `No stream item has sort key ${err.afterSortKey}: stream retention pruned it, or it never existed. Items after it may have been pruned too. ` +
          (prunedThrough ? `Resume with --since ${prunedThrough}.` : "Resume with --since <time>.") }, 410);
    }
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

      const aborted = new Promise<void>((resolve) => {
        stream.onAbort(() => resolve());
      });

      try {
        const initial = store.list({ limit: 50 });
        const sentIds = new Set<string>();
        for (const item of initial) {
          await stream.writeSSE({ id: item.streamItemId, data: JSON.stringify(item) });
          sentIds.add(item.streamItemId);
        }

        // Arrivals while this drain yields must join its tail, rather than
        // writing directly ahead of earlier buffered events.
        for (const p of pending) {
          if (!sentIds.has(p.id)) await stream.writeSSE(p);
        }
        initialDone.value = true;

        await aborted;
      } finally {
        unsubscribe();
      }
    });
  };

  app.get("/watch", sseHandler);
  app.get("/sse", sseHandler);

  // Slice 22 outcome 9: hub-reader subscriptions and the reader's bounded read. MUST precede /:streamItemId.
  app.post("/subscriptions", async (c) => {
    const body = await c.req.json<{ readerSession?: string; hintTags?: unknown; hintType?: unknown; actor?: string }>().catch(() => ({} as never));
    const identity = requireSenderIdentity(c, { verb: "stream subscribe", bodyClaim: body.actor });
    if (!identity.ok) return identity.response;
    const reader = typeof body.readerSession === "string" ? body.readerSession.trim() : "";
    if (!/^[^@\s]+@[^@\s]+$/.test(reader)) return c.json({ error: "reader_session_invalid", message: "readerSession must be a seat@rig session name" }, 400);
    const tags = Array.isArray(body.hintTags) ? body.hintTags.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim()) : [];
    const type = typeof body.hintType === "string" && body.hintType.trim() ? body.hintType.trim() : null;
    return c.json(subscribe(getStore(c).db, { readerSession: reader, hintTags: tags, hintType: type, actor: identity.session }));
  });

  app.get("/subscriptions", (c) => c.json(listSubscriptions(getStore(c).db)));

  app.delete("/subscriptions/:readerSession", (c) => {
    const reader = c.req.param("readerSession");
    if (!unsubscribe(getStore(c).db, reader)) return c.json({ error: "subscription_not_found", message: `No stream subscription for ${reader}` }, 404);
    return c.json({ ok: true, readerSession: reader });
  });

  // The reader is the transport identity (a body `reader` only when there is none), so a seat advances only its own cursor.
  app.post("/read", async (c) => {
    const body = await c.req.json<{ reader?: string; limit?: unknown }>().catch(() => ({} as never));
    const identity = requireSenderIdentity(c, { verb: "stream read", bodyClaim: body.reader });
    if (!identity.ok) return identity.response;
    const page = readPage(getStore(c).db, identity.session, { limit: typeof body.limit === "number" ? body.limit : undefined });
    if (!page) return c.json({ error: "subscription_not_found", message: `No stream subscription for ${identity.session}; create one with rig stream subscribe ${identity.session}` }, 404);
    return c.json(page);
  });

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
