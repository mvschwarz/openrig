import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { streamItemsSchema } from "../src/db/migrations/023_stream_items.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { inboxEntriesSchema } from "../src/db/migrations/026_inbox_entries.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { EventBus } from "../src/domain/event-bus.js";
import { StreamStore } from "../src/domain/stream-store.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { InboxHandler } from "../src/domain/inbox-handler.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { streamRoutes } from "../src/routes/stream.js";
import { queueRoutes } from "../src/routes/queue.js";

/**
 * Integration tests across the full coordination stack:
 *   stream emit → hint → inbox drop → absorb → claim → handoff → terminal close.
 *
 * Mirrors the cross-loop POC scenarios used by RSI v2: the same event
 * timeline is reproducible via the daemon path (HTTP) so the upcoming
 * dogfood window can compare apples-to-apples against the filesystem POC.
 */

function buildApp(deps: {
  bus: EventBus;
  store: StreamStore;
  repo: QueueRepository;
  inbox: InboxHandler;
  outbox: OutboxHandler;
}): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("eventBus" as never, deps.bus);
    c.set("streamStore" as never, deps.store);
    c.set("queueRepo" as never, deps.repo);
    c.set("inboxHandler" as never, deps.inbox);
    c.set("outboxHandler" as never, deps.outbox);
    await next();
  });
  app.route("/api/stream", streamRoutes());
  app.route("/api/queue", queueRoutes());
  return app;
}

describe("coordination integration — stream → queue → inbox handoff chain", () => {
  let db: Database.Database;
  let bus: EventBus;
  let store: StreamStore;
  let repo: QueueRepository;
  let inbox: InboxHandler;
  let outbox: OutboxHandler;
  let app: Hono;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema,
      eventsSchema,
      streamItemsSchema,
      queueItemsSchema,
      queueTransitionsSchema,
      inboxEntriesSchema,
      outboxEntriesSchema,
    ]);
    bus = new EventBus(db);
    store = new StreamStore(db, bus);
    repo = new QueueRepository(db, bus);
    inbox = new InboxHandler(db, bus, repo);
    outbox = new OutboxHandler(db);
    app = buildApp({ bus, store, repo, inbox, outbox });
  });

  afterEach(() => db.close());

  it("full cross-loop chain: stream-emit → inbox-drop → absorb → claim → handoff → close", async () => {
    // 1. Stream emit (intake / audit root)
    const streamRes = await app.request("/api/stream/emit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceSession: "loop-discovery@rsi-v2",
        body: "found regression in product lab handoff",
        hintDestination: "loop-product-lab@rsi-v2",
        hintType: "review",
        hintUrgency: "urgent",
      }),
    });
    expect(streamRes.status).toBe(201);

    // 2. Drop into product-lab's inbox (mailbox path; not direct queue write)
    const dropRes = await app.request("/api/queue/inbox/drop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        destinationSession: "loop-product-lab@rsi-v2",
        senderSession: "loop-discovery@rsi-v2",
        body: "investigate regression — see stream item",
        urgency: "urgent",
      }),
    });
    expect(dropRes.status).toBe(201);
    const inboxEntry = (await dropRes.json()) as { inboxId: string };

    // 3. Receiver absorbs into main queue
    const absorbRes = await app.request(`/api/queue/inbox/${inboxEntry.inboxId}/absorb`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ receiverSession: "loop-product-lab@rsi-v2" }),
    });
    expect(absorbRes.status).toBe(200);
    const absorbed = (await absorbRes.json()) as { qitemId: string };

    // 4. Claim
    const claimRes = await app.request(`/api/queue/${absorbed.qitemId}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ destinationSession: "loop-product-lab@rsi-v2" }),
    });
    expect(claimRes.status).toBe(200);
    const claimed = (await claimRes.json()) as { state: string };
    expect(claimed.state).toBe("in-progress");

    // 5. Handoff to delivery loop (transactional close + create)
    const handoffRes = await app.request(`/api/queue/${absorbed.qitemId}/handoff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fromSession: "loop-product-lab@rsi-v2",
        toSession: "loop-delivery@rsi-v2",
        transitionNote: "spec ready for delivery",
      }),
    });
    expect(handoffRes.status).toBe(201);
    const handoff = (await handoffRes.json()) as {
      closed: { state: string; closureReason: string };
      created: { qitemId: string; destinationSession: string };
    };
    expect(handoff.closed.state).toBe("handed-off");
    expect(handoff.closed.closureReason).toBe("handed_off_to");

    // 6. Delivery loop claims + closes terminally
    const newQitem = handoff.created.qitemId;
    await app.request(`/api/queue/${newQitem}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ destinationSession: "loop-delivery@rsi-v2" }),
    });
    const closeRes = await app.request(`/api/queue/${newQitem}/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        actorSession: "loop-delivery@rsi-v2",
        state: "done",
        closureReason: "no-follow-on",
      }),
    });
    expect(closeRes.status).toBe(200);

    // 7. Verify the audit trail spans the whole chain via transitions
    const transitionsRes = await app.request(`/api/queue/${absorbed.qitemId}/transitions`);
    const transitions = (await transitionsRes.json()) as Array<{ state: string }>;
    expect(transitions.map((t) => t.state)).toEqual(["pending", "in-progress", "handed-off"]);

    const newTransitionsRes = await app.request(`/api/queue/${newQitem}/transitions`);
    const newTransitions = (await newTransitionsRes.json()) as Array<{ state: string }>;
    expect(newTransitions.map((t) => t.state)).toEqual(["pending", "in-progress", "done"]);
  });

  it("hot-potato strict-rejection blocks done without closure_reason at every layer", async () => {
    const create = await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceSession: "a@r", destinationSession: "b@r", body: "x" }),
    });
    const item = (await create.json()) as { qitemId: string };

    const update = await app.request(`/api/queue/${item.qitemId}/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorSession: "b@r", state: "done" }),
    });
    expect(update.status).toBe(400);
    const data = (await update.json()) as { error: string; validReasons: string[] };
    expect(data.error).toBe("missing_closure_reason");
    expect(data.validReasons).toHaveLength(6);
  });

  it("event-bus emits the full coordination event sequence", async () => {
    const captured: Array<{ type: string }> = [];
    bus.subscribe((e) => captured.push({ type: e.type }));

    await app.request("/api/stream/emit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceSession: "a@r", body: "x" }),
    });
    const create = await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceSession: "a@r", destinationSession: "b@r", body: "y" }),
    });
    const item = (await create.json()) as { qitemId: string };
    await app.request(`/api/queue/${item.qitemId}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ destinationSession: "b@r" }),
    });
    await app.request(`/api/queue/${item.qitemId}/handoff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fromSession: "b@r", toSession: "c@r" }),
    });

    const types = captured.map((e) => e.type);
    expect(types).toContain("stream.emitted");
    expect(types).toContain("queue.created");
    expect(types).toContain("queue.claimed");
    expect(types).toContain("queue.handed_off");
  });
});
