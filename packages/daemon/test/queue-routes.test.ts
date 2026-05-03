import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Hono } from "hono";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { inboxEntriesSchema } from "../src/db/migrations/026_inbox_entries.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { InboxHandler } from "../src/domain/inbox-handler.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { CLOSURE_REASONS } from "../src/domain/hot-potato-enforcer.js";
import { queueRoutes } from "../src/routes/queue.js";

function buildApp(opts: {
  eventBus: EventBus;
  queueRepo: QueueRepository;
  inboxHandler: InboxHandler;
  outboxHandler: OutboxHandler;
}): Hono {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("eventBus" as never, opts.eventBus);
    c.set("queueRepo" as never, opts.queueRepo);
    c.set("inboxHandler" as never, opts.inboxHandler);
    c.set("outboxHandler" as never, opts.outboxHandler);
    await next();
  });
  app.route("/api/queue", queueRoutes());
  return app;
}

describe("queue routes", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;
  let inbox: InboxHandler;
  let outbox: OutboxHandler;
  let app: Hono;

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema,
      eventsSchema,
      queueItemsSchema,
      queueTransitionsSchema,
      inboxEntriesSchema,
      outboxEntriesSchema,
    ]);
    bus = new EventBus(db);
    queueRepo = new QueueRepository(db, bus);
    inbox = new InboxHandler(db, bus, queueRepo);
    outbox = new OutboxHandler(db);
    app = buildApp({ eventBus: bus, queueRepo, inboxHandler: inbox, outboxHandler: outbox });
  });

  afterEach(() => db.close());

  it("POST /api/queue/create creates a qitem", async () => {
    const res = await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceSession: "alice@rig",
        destinationSession: "bob@rig",
        body: "do thing",
        priority: "urgent",
      }),
    });
    expect(res.status).toBe(201);
    const data = (await res.json()) as { qitemId: string; state: string; priority: string };
    expect(data.state).toBe("pending");
    expect(data.priority).toBe("urgent");
  });

  it("POST /api/queue/:id/update with state=done WITHOUT closure_reason returns 400 with validReasons", async () => {
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
    expect(data.validReasons).toEqual(CLOSURE_REASONS);
  });

  it("POST /api/queue/:id/update accepts each valid closure reason", async () => {
    for (const reason of CLOSURE_REASONS) {
      const create = await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceSession: "a@r", destinationSession: "b@r", body: `for-${reason}` }),
      });
      const item = (await create.json()) as { qitemId: string };

      const requiresTarget = reason === "handed_off_to" || reason === "blocked_on" || reason === "escalation";
      const update = await app.request(`/api/queue/${item.qitemId}/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actorSession: "b@r",
          state: "done",
          closureReason: reason,
          ...(requiresTarget ? { closureTarget: "downstream-target" } : {}),
        }),
      });
      expect(update.status).toBe(200);
      const data = (await update.json()) as { state: string; closureReason: string };
      expect(data.state).toBe("done");
      expect(data.closureReason).toBe(reason);
    }
  });

  it("POST /api/queue/:id/handoff returns closed + created in one transaction", async () => {
    const create = await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceSession: "a@r", destinationSession: "b@r", body: "x" }),
    });
    const item = (await create.json()) as { qitemId: string };

    const handoff = await app.request(`/api/queue/${item.qitemId}/handoff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fromSession: "b@r", toSession: "c@r", transitionNote: "specialty" }),
    });
    expect(handoff.status).toBe(201);
    const data = (await handoff.json()) as {
      closed: { state: string; closureReason: string; handedOffTo: string };
      created: { state: string; destinationSession: string; handedOffFrom: string };
    };
    expect(data.closed.state).toBe("handed-off");
    expect(data.closed.closureReason).toBe("handed_off_to");
    expect(data.closed.handedOffTo).toBe("c@r");
    expect(data.created.state).toBe("pending");
    expect(data.created.destinationSession).toBe("c@r");
    expect(data.created.handedOffFrom).toBe(item.qitemId);
  });

  it("GET /api/queue/:id returns the qitem; transitions endpoint returns the log", async () => {
    const create = await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceSession: "a@r", destinationSession: "b@r", body: "x" }),
    });
    const item = (await create.json()) as { qitemId: string };

    const get = await app.request(`/api/queue/${item.qitemId}`);
    expect(get.status).toBe(200);

    const transitions = await app.request(`/api/queue/${item.qitemId}/transitions`);
    expect(transitions.status).toBe(200);
    const tlist = (await transitions.json()) as Array<{ state: string }>;
    expect(tlist).toHaveLength(1);
    expect(tlist[0]!.state).toBe("pending");
  });

  it("inbox drop / absorb / deny round-trip", async () => {
    const drop = await app.request("/api/queue/inbox/drop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        destinationSession: "b@r",
        senderSession: "a@r",
        body: "async",
      }),
    });
    expect(drop.status).toBe(201);
    const entry = (await drop.json()) as { inboxId: string };

    const absorb = await app.request(`/api/queue/inbox/${entry.inboxId}/absorb`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ receiverSession: "b@r" }),
    });
    expect(absorb.status).toBe(200);
    const absorbed = (await absorb.json()) as { qitemId: string };
    expect(absorbed.qitemId).toMatch(/^qitem-/);

    // Second drop + deny path
    const drop2 = await app.request("/api/queue/inbox/drop", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ destinationSession: "b@r", senderSession: "a@r", body: "skip" }),
    });
    const entry2 = (await drop2.json()) as { inboxId: string };
    const deny = await app.request(`/api/queue/inbox/${entry2.inboxId}/deny`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ receiverSession: "b@r", reason: "off-topic" }),
    });
    expect(deny.status).toBe(200);
  });

  it("outbox record + list round-trip", async () => {
    const record = await app.request("/api/queue/outbox/record", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ senderSession: "a@r", destinationSession: "b@r", body: "fyi" }),
    });
    expect(record.status).toBe(201);

    const list = await app.request("/api/queue/outbox/list?senderSession=a@r");
    expect(list.status).toBe(200);
    const data = (await list.json()) as Array<{ body: string }>;
    expect(data).toHaveLength(1);
    expect(data[0]!.body).toBe("fyi");
  });

  it("GET /api/queue/list filters by destination + state", async () => {
    await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceSession: "a@r", destinationSession: "b@r", body: "1" }),
    });
    await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceSession: "a@r", destinationSession: "c@r", body: "2" }),
    });
    const res = await app.request("/api/queue/list?destinationSession=b@r");
    const data = (await res.json()) as unknown[];
    expect(data).toHaveLength(1);
  });
});
