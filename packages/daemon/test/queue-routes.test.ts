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

  // ---- PL-004 Phase A revision (R1) route tests ----

  describe("R1 cross-rig validation rejection", () => {
    let strictDb: Database.Database;
    let strictBus: EventBus;
    let strictRepo: QueueRepository;
    let strictApp: Hono;

    beforeEach(() => {
      strictDb = createDb();
      migrate(strictDb, [
        coreSchema,
        eventsSchema,
        queueItemsSchema,
        queueTransitionsSchema,
        inboxEntriesSchema,
        outboxEntriesSchema,
      ]);
      strictBus = new EventBus(strictDb);
      strictRepo = new QueueRepository(strictDb, strictBus, {
        // Topology-backed validator stub: only `@known-rig` is recognized.
        validateRig: (s) => /^[^@]+@known-rig$/.test(s),
      });
      const strictInbox = new InboxHandler(strictDb, strictBus, strictRepo);
      const strictOutbox = new OutboxHandler(strictDb);
      strictApp = buildApp({
        eventBus: strictBus,
        queueRepo: strictRepo,
        inboxHandler: strictInbox,
        outboxHandler: strictOutbox,
      });
    });

    afterEach(() => strictDb.close());

    it("POST /api/queue/create rejects unknown rig with 400 + structured error", async () => {
      const res = await strictApp.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceSession: "alice@known-rig",
          destinationSession: "bob@phantom-rig",
          body: "x",
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string; message: string };
      expect(body.error).toBe("unknown_destination_rig");
      expect(body.message).toMatch(/phantom-rig/);
    });

    it("POST /api/queue/create accepts known rig with 201", async () => {
      const res = await strictApp.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceSession: "alice@known-rig",
          destinationSession: "bob@known-rig",
          body: "ok",
        }),
      });
      expect(res.status).toBe(201);
    });

    it("POST /api/queue/:id/handoff rejects unknown destination rig", async () => {
      const created = await strictApp.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceSession: "alice@known-rig",
          destinationSession: "bob@known-rig",
          body: "x",
        }),
      });
      const item = (await created.json()) as { qitemId: string };
      const res = await strictApp.request(`/api/queue/${item.qitemId}/handoff`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fromSession: "bob@known-rig",
          toSession: "carol@phantom-rig",
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("unknown_destination_rig");
    });

    it("POST /api/queue/:id/handoff-and-complete rejects unknown destination rig", async () => {
      const created = await strictApp.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceSession: "alice@known-rig",
          destinationSession: "bob@known-rig",
          body: "x",
        }),
      });
      const item = (await created.json()) as { qitemId: string };
      const res = await strictApp.request(`/api/queue/${item.qitemId}/handoff-and-complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fromSession: "bob@known-rig",
          toSession: "carol@phantom-rig",
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("unknown_destination_rig");
    });
  });

  describe("R1 handoff-and-complete route", () => {
    it("POST /api/queue/:id/handoff-and-complete closes source as done + creates new", async () => {
      const created = await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceSession: "alice@r", destinationSession: "bob@r", body: "x" }),
      });
      const item = (await created.json()) as { qitemId: string };
      const res = await app.request(`/api/queue/${item.qitemId}/handoff-and-complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fromSession: "bob@r",
          toSession: "carol@r",
          body: "carol's piece",
        }),
      });
      expect(res.status).toBe(201);
      const result = (await res.json()) as {
        closed: { state: string; closureReason: string; handedOffTo: string };
        created: { state: string; handedOffFrom: string; destinationSession: string; body: string };
      };
      expect(result.closed.state).toBe("done");
      expect(result.closed.closureReason).toBe("handed_off_to");
      expect(result.closed.handedOffTo).toBe("carol@r");
      expect(result.created.state).toBe("pending");
      expect(result.created.handedOffFrom).toBe(item.qitemId);
      expect(result.created.body).toBe("carol's piece");
    });

    it("POST /api/queue/:id/handoff-and-complete returns 400 on missing fromSession or toSession", async () => {
      const res = await app.request("/api/queue/some-id/handoff-and-complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toSession: "carol@r" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toMatch(/fromSession/);
    });
  });

  describe("R1 whoami route", () => {
    it("GET /api/queue/whoami returns counts + recent for the session", async () => {
      // Seed: 2 pending + 1 in-progress for bob; 1 unrelated for carol.
      const a = await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceSession: "alice@r", destinationSession: "bob@r", body: "1" }),
      });
      const itemA = (await a.json()) as { qitemId: string };
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceSession: "alice@r", destinationSession: "bob@r", body: "2" }),
      });
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceSession: "alice@r", destinationSession: "carol@r", body: "3" }),
      });
      await app.request(`/api/queue/${itemA.qitemId}/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ destinationSession: "bob@r" }),
      });

      const res = await app.request("/api/queue/whoami?session=bob@r");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        session: string;
        asDestination: { pending: number; inProgress: number; recent: unknown[] };
        asSource: { total: number };
      };
      expect(body.session).toBe("bob@r");
      expect(body.asDestination.pending).toBe(1);
      expect(body.asDestination.inProgress).toBe(1);
      expect(body.asDestination.recent).toHaveLength(2);
      expect(body.asSource.total).toBe(0);
    });

    it("GET /api/queue/whoami returns 400 without session query param", async () => {
      const res = await app.request("/api/queue/whoami");
      expect(res.status).toBe(400);
    });
  });

  describe("R1 SSE route — live GET reaches the SSE handler (not shadowed by /:qitemId)", () => {
    // Live GET tests per QA finding: HEAD comparison was inadequate because
    // dynamic route shadowing (/:qitemId catching `sse` and `watch` as ids)
    // returns 404 with `qitem_not_found` instead of the SSE handler.
    // Real GET that asserts content-type: text/event-stream proves the
    // SSE handler is reached. We cancel the response body to release the
    // long-lived stream.

    it("GET /api/queue/sse returns 200 + content-type: text/event-stream (handler reached)", async () => {
      const res = await app.request("/api/queue/sse");
      try {
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
      } finally {
        await res.body?.cancel();
      }
    });

    it("GET /api/queue/watch returns 200 + content-type: text/event-stream (handler reached)", async () => {
      const res = await app.request("/api/queue/watch");
      try {
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type") ?? "").toContain("text/event-stream");
      } finally {
        await res.body?.cancel();
      }
    });

    it("GET /api/queue/sse does NOT return qitem_not_found (route-order regression guard)", async () => {
      const res = await app.request("/api/queue/sse");
      try {
        // If /:qitemId catches `sse` as an id, it returns 404 JSON with
        // {"error":"qitem_not_found"}. This must never happen.
        expect(res.status).not.toBe(404);
        const ct = res.headers.get("content-type") ?? "";
        expect(ct).not.toContain("application/json");
      } finally {
        await res.body?.cancel();
      }
    });
  });
});
