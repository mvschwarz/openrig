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
import { queueTargetRepoSchema } from "../src/db/migrations/039_queue_target_repo.js";
import { i3IdentityProvenanceSchema } from "../src/db/migrations/067_i3_identity_provenance.js";
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
      streamItemsSchema, // 067's stream_items ALTER needs its base table present
      queueItemsSchema,
      queueTransitionsSchema,
      inboxEntriesSchema,
      outboxEntriesSchema,
      queueTargetRepoSchema, // OPR.0.3.2.20: required for attention=1&targetRepo=X composition tests
      i3IdentityProvenanceSchema, // P21 §4 era-stamp column on the queue-spine stores (last: needs all 4 tables)
    ]);
    bus = new EventBus(db);
    queueRepo = new QueueRepository(db, bus);
    inbox = new InboxHandler(db, bus, queueRepo);
    outbox = new OutboxHandler(db);
    app = buildApp({ eventBus: bus, queueRepo, inboxHandler: inbox, outboxHandler: outbox });
  });

  afterEach(() => db.close());

  // ── P18 sender-provenance: /inbox/drop derives the sender from the authenticated transport
  // header (X-OpenRig-Session), never a request-body claim; refuses-unattributable LOUD when absent. ──
  describe("P18 sender-provenance", () => {
    it("records the TRANSPORT-DERIVED sender (header), IGNORING a forged body senderSession/authenticatedSender", async () => {
      const res = await app.request("/api/queue/inbox/drop", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@rig" },
        body: JSON.stringify({
          destinationSession: "bob@rig", body: "hi",
          senderSession: "mallory@rig", authenticatedSender: "mallory@rig", // forged body claims — must be ignored
        }),
      });
      expect(res.status).toBe(201);
      const entry = await res.json() as { senderSession: string };
      expect(entry.senderSession).toBe("alice@rig"); // the header wins; the forged body claim never lands
    });

    it("REFUSES-unattributable LOUD (401) when the identity header is absent, naming the missing header", async () => {
      const res = await app.request("/api/queue/inbox/drop", {
        method: "POST",
        headers: { "Content-Type": "application/json" }, // NO X-OpenRig-Session
        body: JSON.stringify({ destinationSession: "bob@rig", body: "hi", senderSession: "mallory@rig" }),
      });
      expect(res.status).toBe(401);
      const err = await res.json() as { error: string; message: string };
      expect(err.error).toBe("unattributable_sender");
      expect(err.message).toMatch(/X-OpenRig-Session/);
    });
  });

  it("POST /api/queue/create creates a qitem", async () => {
    const res = await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@rig" },
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

  // P21 I3 — create's sender is the transport header (X-OpenRig-Session), NEVER a body claim.
  // Adopt-drop window: a body sourceSession is tolerated ONLY when it EQUALS the transport identity.
  it("create — 401 unattributable_sender when X-OpenRig-Session is absent", async () => {
    const res = await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceSession: "bob@rig", destinationSession: "dst@rig", body: "hi" }),
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("unattributable_sender");
  });

  it("create — 409 identity_mismatch when the body sourceSession differs from the transport identity", async () => {
    const res = await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@rig" },
      body: JSON.stringify({ sourceSession: "bob@rig", destinationSession: "dst@rig", body: "hi" }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("identity_mismatch");
  });

  it("create — derives source_session from the transport header, never the body (equal claim tolerated)", async () => {
    const res = await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@rig" },
      body: JSON.stringify({ sourceSession: "alice@rig", destinationSession: "dst@rig", body: "hi" }),
    });
    expect(res.status).toBe(201);
    const { qitemId } = (await res.json()) as { qitemId: string };
    const row = db
      .prepare("SELECT source_session FROM queue_items WHERE qitem_id = ?")
      .get(qitemId) as { source_session: string } | undefined;
    expect(row?.source_session).toBe("alice@rig");
  });

  it("create — era-stamps the created transition transport:v1 (P21 §4 derived-era boundary)", async () => {
    const res = await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@rig" },
      body: JSON.stringify({ sourceSession: "alice@rig", destinationSession: "dst@rig", body: "hi" }),
    });
    expect(res.status).toBe(201);
    const { qitemId } = (await res.json()) as { qitemId: string };
    // The 'created' transition's actor is transport-derived → stamped transport:v1 (absence = claimed-era).
    const row = db
      .prepare("SELECT identity_provenance FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid ASC LIMIT 1")
      .get(qitemId) as { identity_provenance: string | null } | undefined;
    expect(row?.identity_provenance).toBe("transport:v1");
  });

  // P21 I3 — update's actor is the transport header (X-OpenRig-Session), NEVER a body claim.
  async function createForUpdate(session: string): Promise<string> {
    const create = await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": session },
      body: JSON.stringify({ sourceSession: session, destinationSession: "worker@r", body: "x" }),
    });
    return ((await create.json()) as { qitemId: string }).qitemId;
  }

  it("update — 401 unattributable_sender when X-OpenRig-Session is absent", async () => {
    const qitemId = await createForUpdate("a@r");
    const res = await app.request(`/api/queue/${qitemId}/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actorSession: "worker@r", state: "in-progress" }),
    });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe("unattributable_sender");
  });

  it("update — 409 identity_mismatch when the body actorSession differs from the transport identity", async () => {
    const qitemId = await createForUpdate("a@r");
    const res = await app.request(`/api/queue/${qitemId}/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "worker@r" },
      body: JSON.stringify({ actorSession: "mallory@r", state: "in-progress" }),
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("identity_mismatch");
  });

  it("update — derives the transition actor from the transport header, never the body", async () => {
    const qitemId = await createForUpdate("a@r");
    const res = await app.request(`/api/queue/${qitemId}/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "worker@r" },
      body: JSON.stringify({ actorSession: "worker@r", state: "in-progress" }),
    });
    expect(res.status).toBe(200);
    const row = db
      .prepare("SELECT actor_session, identity_provenance FROM queue_transitions WHERE qitem_id = ? ORDER BY rowid DESC LIMIT 1")
      .get(qitemId) as { actor_session: string; identity_provenance: string | null } | undefined;
    expect(row?.actor_session).toBe("worker@r");
    // P21 §4 era-stamp: a transport-derived actor is stamped transport:v1 (absence = claimed-era).
    expect(row?.identity_provenance).toBe("transport:v1");
  });

  it("POST /api/queue/:id/update with state=done WITHOUT closure_reason returns 400 with validReasons", async () => {
    const create = await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
      body: JSON.stringify({ sourceSession: "a@r", destinationSession: "b@r", body: "x" }),
    });
    const item = (await create.json()) as { qitemId: string };

    const update = await app.request(`/api/queue/${item.qitemId}/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "b@r" },
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
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
        body: JSON.stringify({ sourceSession: "a@r", destinationSession: "b@r", body: `for-${reason}` }),
      });
      const item = (await create.json()) as { qitemId: string };

      const requiresTarget = reason === "handed_off_to" || reason === "blocked_on" || reason === "escalation";
      const update = await app.request(`/api/queue/${item.qitemId}/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "b@r" },
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
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
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
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
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
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" }, // P18: transport-derived sender
      body: JSON.stringify({
        destinationSession: "b@r",
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
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" }, // P18: transport-derived sender
      body: JSON.stringify({ destinationSession: "b@r", body: "skip" }),
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
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
      body: JSON.stringify({ sourceSession: "a@r", destinationSession: "b@r", body: "1" }),
    });
    await app.request("/api/queue/create", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
      body: JSON.stringify({ sourceSession: "a@r", destinationSession: "c@r", body: "2" }),
    });
    const res = await app.request("/api/queue/list?destinationSession=b@r");
    const data = (await res.json()) as unknown[];
    expect(data).toHaveLength(1);
  });

  // OPR.0.3.2.20 — `?attention=1` filter for the For You priority
  // windowing slice. Returns OPEN attention-class qitems (the durable
  // source of truth) so the UI Action-required + Approval lenses don't
  // depend on the lossy ephemeral event FIFO. HG-4 verified against
  // the mission-control read layer's canonical attention semantics:
  //   - approval class: tier === "human-gate"
  //   - action-required class: destinationSession is human-*@kernel|host
  //   - open state: pending | in-progress | blocked
  describe("OPR.0.3.2.20 GET /api/queue/list?attention=1 — open attention-class items", () => {
    it("HG-4 positive (approval class): tier='human-gate' open qitem is returned", async () => {
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
        body: JSON.stringify({
          sourceSession: "a@r",
          destinationSession: "b@r",
          body: "approve please",
          tier: "human-gate",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
        }),
      });
      const res = await app.request("/api/queue/list?attention=1");
      expect(res.status).toBe(200);
      const data = (await res.json()) as Array<{ tier: string | null; body: string }>;
      expect(data).toHaveLength(1);
      expect(data[0]!.tier).toBe("human-gate");
    });

    it("HG-4 positive (action-required class): destination=human-foo@kernel open qitem is returned", async () => {
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
        body: JSON.stringify({
          sourceSession: "a@r",
          destinationSession: "human-bob@kernel",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
          body: "needs human",
        }),
      });
      const res = await app.request("/api/queue/list?attention=1");
      const data = (await res.json()) as Array<{ destinationSession: string }>;
      expect(data).toHaveLength(1);
      expect(data[0]!.destinationSession).toBe("human-bob@kernel");
    });

    it("HG-4 positive: destination=human@host (bare human prefix) open qitem is returned", async () => {
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
        body: JSON.stringify({
          sourceSession: "a@r",
          destinationSession: "human@host",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
          body: "needs human attention",
        }),
      });
      const res = await app.request("/api/queue/list?attention=1");
      const data = (await res.json()) as unknown[];
      expect(data).toHaveLength(1);
    });

    it("HG-4 negative: routine pending qitem (non-attention tier + non-human destination) is NOT returned", async () => {
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
        body: JSON.stringify({
          sourceSession: "a@r",
          destinationSession: "b@r",
          body: "routine work",
        }),
      });
      const res = await app.request("/api/queue/list?attention=1");
      const data = (await res.json()) as unknown[];
      expect(data).toHaveLength(0);
    });

    it("HG-4 negative: closed attention qitem (state=done) is NOT returned", async () => {
      const create = await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
        body: JSON.stringify({
          sourceSession: "a@r",
          destinationSession: "human-x@kernel",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
          body: "done already",
        }),
      });
      const item = (await create.json()) as { qitemId: string };
      await app.request(`/api/queue/${item.qitemId}/update`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "human-x@kernel" },
        body: JSON.stringify({
          actorSession: "human-x@kernel",
          state: "done",
          closureReason: "no-follow-on",
        }),
      });
      const res = await app.request("/api/queue/list?attention=1");
      const data = (await res.json()) as unknown[];
      expect(data).toHaveLength(0);
    });

    it("HG-5/HG-7 sane bound: ?attention=1&limit=N caps the result", async () => {
      // Seed 5 attention-class qitems
      for (let i = 0; i < 5; i++) {
        await app.request("/api/queue/create", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
          body: JSON.stringify({
            sourceSession: "a@r",
            destinationSession: `human-${i}@kernel`,
            body: `attn ${i}`,
          }),
        });
      }
      const res = await app.request("/api/queue/list?attention=1&limit=3");
      const data = (await res.json()) as unknown[];
      expect(data.length).toBeLessThanOrEqual(3);
    });

    it("HG-2 (the headline): attention-class items survive >100 unrelated routine qitems being created (queue is durable source)", async () => {
      // Seed ONE attention-class item first
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
        body: JSON.stringify({
          sourceSession: "a@r",
          destinationSession: "b@r",
          body: "approve me",
          tier: "human-gate",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
        }),
      });
      // Then create >100 routine qitems (no attention markers); these
      // would saturate any FIFO window in the UI but the queue is the
      // durable source — the attention filter must still surface the
      // human-gate item.
      for (let i = 0; i < 110; i++) {
        await app.request("/api/queue/create", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-OpenRig-Session": `routine-${i}@r` },
          body: JSON.stringify({
            sourceSession: `routine-${i}@r`,
            destinationSession: `other-${i}@r`,
            body: `noise ${i}`,
          }),
        });
      }
      const res = await app.request("/api/queue/list?attention=1");
      const data = (await res.json()) as Array<{ tier: string | null }>;
      // Attention item still present despite 110 routine qitems written
      // after it.
      expect(data.length).toBeGreaterThanOrEqual(1);
      expect(data.some((q) => q.tier === "human-gate")).toBe(true);
    });

    // Guard re-verify-2 (qitem-20260518192210) BLOCKER-1: the prior
    // forward-fix dropped destinationSession/sourceSession/targetRepo
    // composition. The fix routes those params through listAttention
    // into the SQL WHERE so scoped attention queries return only the
    // matching attention items.

    it("BLOCKER re-verify-2: attention=1 + destinationSession=X returns only X-scoped attention items", async () => {
      // Seed 2 attention items at different destinations.
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "advisor@r1" },
        body: JSON.stringify({
          sourceSession: "advisor@r1",
          destinationSession: "human-alice@kernel",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
          body: "for alice",
        }),
      });
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "advisor@r2" },
        body: JSON.stringify({
          sourceSession: "advisor@r2",
          destinationSession: "human-bob@kernel",
          body: "for bob",
          tier: "human-gate",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
        }),
      });
      // Also create a non-attention routine qitem destined to alice;
      // it must not appear.
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "advisor@r1" },
        body: JSON.stringify({
          sourceSession: "advisor@r1",
          destinationSession: "human-alice@kernel",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
          state: "pending",
          body: "another for alice",
        }),
      });

      const res = await app.request("/api/queue/list?attention=1&destinationSession=human-alice@kernel");
      const data = (await res.json()) as Array<{ destinationSession: string; body: string }>;
      expect(data.length).toBeGreaterThanOrEqual(1);
      for (const item of data) {
        expect(item.destinationSession).toBe("human-alice@kernel");
      }
      // None of them should be for bob.
      expect(data.some((q) => q.destinationSession === "human-bob@kernel")).toBe(false);
    });

    it("BLOCKER re-verify-2: attention=1 + sourceSession=X returns only X-sourced attention items", async () => {
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "advisor-a@r" },
        body: JSON.stringify({
          sourceSession: "advisor-a@r",
          destinationSession: "human-x@kernel",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
          body: "from advisor-a",
        }),
      });
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "advisor-b@r" },
        body: JSON.stringify({
          sourceSession: "advisor-b@r",
          destinationSession: "human-y@kernel",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
          body: "from advisor-b",
        }),
      });
      const res = await app.request("/api/queue/list?attention=1&sourceSession=advisor-a@r");
      const data = (await res.json()) as Array<{ sourceSession: string }>;
      expect(data.length).toBeGreaterThanOrEqual(1);
      for (const item of data) {
        expect(item.sourceSession).toBe("advisor-a@r");
      }
    });

    it("BLOCKER re-verify-2: attention=1 unscoped still returns the global attention set (composition is OPT-IN, not required)", async () => {
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
        body: JSON.stringify({
          sourceSession: "a@r",
          destinationSession: "human-x@kernel",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
          body: "global x",
        }),
      });
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "b@r" },
        body: JSON.stringify({
          sourceSession: "b@r",
          destinationSession: "human-y@kernel",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
          body: "global y",
        }),
      });
      const res = await app.request("/api/queue/list?attention=1");
      const data = (await res.json()) as unknown[];
      expect(data.length).toBeGreaterThanOrEqual(2);
    });

    // Guard re-verify BLOCKER 1 (qitem-20260518190827): the prior
    // fetch-then-filter approach (ATTENTION_FETCH_BOUND=1000 then
    // JS filter) would have hidden an attention item behind 1001+
    // newer routine open qitems. The fix pushes the attention
    // predicate INTO SQL so the LIMIT applies AFTER attention
    // filtering. This test scales the routine churn well past the
    // old ATTENTION_FETCH_BOUND to prove window-independence by
    // construction.
    // Guard re-verify-3 (qitem-20260518193005) BLOCKER 1: SQL LIKE
    // was a superset of the regex. Malformed rows like
    // `destination_session='human-@kernel'` (empty name segment)
    // match LIKE `human-%@kernel` but FAIL the strict regex. >LIMIT
    // such rows could fill the SQL window pre-JS-filter and hide
    // valid attention items behind them.
    //
    // Fix: SQLite function `is_human_seat_session` evaluates the
    // exact regex in SQL — malformed rows are rejected BEFORE LIMIT.
    it("BLOCKER re-verify-3: malformed superset rows ('human-@kernel') do NOT evict valid attention items", async () => {
      // Seed 1 valid attention item.
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "advisor@r" },
        body: JSON.stringify({
          sourceSession: "advisor@r",
          destinationSession: "human-alice@kernel",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
          body: "valid attention",
        }),
      });
      // Seed 1100 malformed rows that match LIKE 'human-%@kernel' or
      // similar but FAIL the strict regex (empty name segment;
      // forbidden chars). Mix forms to ensure no single LIKE branch
      // is the leak.
      for (let i = 0; i < 1100; i++) {
        const variant = i % 4;
        const dest = variant === 0
          ? "human-@kernel"          // empty segment between hyphen and @
          : variant === 1
            ? "human- @kernel"       // space (forbidden char) — would match LIKE 'human-%@kernel'
            : variant === 2
              ? "human-x:@kernel"    // colon (forbidden char)
              : "human-x/@kernel";   // slash (forbidden char)
        await app.request("/api/queue/create", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-OpenRig-Session": `garbage-${i}@r` },
          body: JSON.stringify({
            sourceSession: `garbage-${i}@r`,
            destinationSession: dest,
            body: `malformed ${i}`,
          }),
        });
      }
      const res = await app.request("/api/queue/list?attention=1&limit=100");
      const data = (await res.json()) as Array<{ destinationSession: string; body: string }>;
      // Valid item must surface — it is the ONLY row matching the
      // strict regex. Malformed rows must NOT appear.
      const valid = data.find((q) => q.destinationSession === "human-alice@kernel");
      expect(valid).toBeDefined();
      expect(valid!.body).toBe("valid attention");
      // No malformed rows in the result set.
      for (const q of data) {
        expect(q.destinationSession).not.toBe("human-@kernel");
        expect(q.destinationSession).not.toContain(" ");
        expect(q.destinationSession).not.toContain(":");
        expect(q.destinationSession).not.toContain("/");
      }
    });

    // Guard re-verify-3 (qitem-20260518193005) BLOCKER 2: targetRepo
    // composition was implemented in the previous forward-fix but
    // never pinned by a test. This discriminator proves
    // attention=1&targetRepo=X scopes the result + composes with the
    // attention predicate at the SQL stage (LIMIT applies AFTER).
    it("BLOCKER re-verify-3: attention=1 + targetRepo=X scopes attention to repo X", async () => {
      // Seed attention items in different repos.
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
        body: JSON.stringify({
          sourceSession: "a@r",
          destinationSession: "human-bob@kernel",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
          body: "for repo-a",
          targetRepo: "repo-a",
        }),
      });
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
        body: JSON.stringify({
          sourceSession: "a@r",
          destinationSession: "human-carol@kernel",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
          body: "for repo-b",
          targetRepo: "repo-b",
        }),
      });
      const res = await app.request("/api/queue/list?attention=1&targetRepo=repo-a");
      const data = (await res.json()) as Array<{ targetRepo: string | null; body: string }>;
      expect(data.length).toBeGreaterThanOrEqual(1);
      for (const item of data) {
        expect(item.targetRepo).toBe("repo-a");
      }
    });

    it("BLOCKER re-verify-3: targetRepo composition preserves the >1100-routine-open durability guarantee", async () => {
      // Seed 1 attention item with targetRepo=repo-X.
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "a@r" },
        body: JSON.stringify({
          sourceSession: "a@r",
          destinationSession: "human-z@kernel",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
          body: "repo-X attention",
          targetRepo: "repo-X",
        }),
      });
      // 1100 newer routine open qitems in OTHER repos that would
      // otherwise dominate the window if the targetRepo predicate
      // were applied post-LIMIT.
      for (let i = 0; i < 1100; i++) {
        await app.request("/api/queue/create", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-OpenRig-Session": `routine-${i}@r` },
          body: JSON.stringify({
            sourceSession: `routine-${i}@r`,
            destinationSession: `other-${i}@r`,
            body: `noise ${i}`,
            targetRepo: "repo-other",
          }),
        });
      }
      const res = await app.request("/api/queue/list?attention=1&targetRepo=repo-X");
      const data = (await res.json()) as Array<{ targetRepo: string | null; body: string }>;
      expect(data.length).toBe(1);
      expect(data[0]!.targetRepo).toBe("repo-X");
      expect(data[0]!.body).toBe("repo-X attention");
    });

    it("BLOCKER-1: attention item surfaces even when >1100 newer routine OPEN qitems exist (SQL predicate pushdown)", async () => {
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "old@r" },
        body: JSON.stringify({
          sourceSession: "old@r",
          destinationSession: "b@r",
          body: "approve me — oldest",
          tier: "human-gate",
          summary: "test summary (FR-4 human-routed fixture)",
          evidenceRef: "proof/test-evidence.md",
        }),
      });
      // 1100 routine OPEN qitems land AFTER the attention item. They
      // each get a newer ts_created than the attention item; a
      // fetch-then-filter with LIMIT 1000 would never return the
      // attention item.
      for (let i = 0; i < 1100; i++) {
        await app.request("/api/queue/create", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-OpenRig-Session": `routine-${i}@r` },
          body: JSON.stringify({
            sourceSession: `routine-${i}@r`,
            destinationSession: `other-${i}@r`,
            body: `noise ${i}`,
          }),
        });
      }
      const res = await app.request("/api/queue/list?attention=1");
      const data = (await res.json()) as Array<{ tier: string | null; body: string }>;
      expect(data.length).toBeGreaterThanOrEqual(1);
      const found = data.find((q) => q.tier === "human-gate");
      expect(found).toBeDefined();
      expect(found!.body).toContain("oldest");
    });
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
        streamItemsSchema, // 067's stream_items ALTER needs its base table present
        queueItemsSchema,
        queueTransitionsSchema,
        inboxEntriesSchema,
        outboxEntriesSchema,
        i3IdentityProvenanceSchema, // P21 §4 era-stamp column (last: needs all 4 tables)
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
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@known-rig" },
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
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@known-rig" },
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
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@known-rig" },
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
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@known-rig" },
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
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@r" },
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
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@r" },
        body: JSON.stringify({ sourceSession: "alice@r", destinationSession: "bob@r", body: "1" }),
      });
      const itemA = (await a.json()) as { qitemId: string };
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@r" },
        body: JSON.stringify({ sourceSession: "alice@r", destinationSession: "bob@r", body: "2" }),
      });
      await app.request("/api/queue/create", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-OpenRig-Session": "alice@r" },
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
