import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { coreSchema } from "../src/db/migrations/001_core_schema.js";
import { eventsSchema } from "../src/db/migrations/003_events.js";
import { queueItemsSchema } from "../src/db/migrations/024_queue_items.js";
import { queueTransitionsSchema } from "../src/db/migrations/025_queue_transitions.js";
import { inboxEntriesSchema } from "../src/db/migrations/026_inbox_entries.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { InboxHandler, InboxHandlerError } from "../src/domain/inbox-handler.js";
import type { PersistedEvent } from "../src/domain/types.js";

describe("InboxHandler", () => {
  let db: Database.Database;
  let bus: EventBus;
  let queueRepo: QueueRepository;
  let inbox: InboxHandler;
  let captured: PersistedEvent[];

  beforeEach(() => {
    db = createDb();
    migrate(db, [
      coreSchema,
      eventsSchema,
      queueItemsSchema,
      queueTransitionsSchema,
      inboxEntriesSchema,
    ]);
    bus = new EventBus(db);
    queueRepo = new QueueRepository(db, bus);
    inbox = new InboxHandler(db, bus, queueRepo);
    captured = [];
    bus.subscribe((e) => captured.push(e));
  });

  afterEach(() => db.close());

  it("drop records sender + tags + audit_pointer", () => {
    const e = inbox.drop({
      destinationSession: "bob@rig",
      senderSession: "alice@rig",
      body: "async work",
      tags: ["batch", "low-prio"],
      auditPointer: "audit/2026/04/28/x.md",
    });
    expect(e.inboxId).toMatch(/^inbox-\d{14}-[a-f0-9]{8}$/);
    expect(e.senderSession).toBe("alice@rig");
    expect(e.tags).toEqual(["batch", "low-prio"]);
    expect(e.state).toBe("pending");
    expect(e.auditPointer).toBe("audit/2026/04/28/x.md");
  });

  it("drop is idempotent on inbox_id", () => {
    const id = "inbox-fixed-test-id-0001";
    const a = inbox.drop({
      inboxId: id,
      destinationSession: "bob@rig",
      senderSession: "alice@rig",
      body: "first",
    });
    const b = inbox.drop({
      inboxId: id,
      destinationSession: "bob@rig",
      senderSession: "alice@rig",
      body: "second-ignored",
    });
    expect(a.inboxId).toBe(b.inboxId);
    expect(b.body).toBe("first");
  });

  // P18 sender-provenance: identity verification moved OUT of the handler to the ONE transport
  // chokepoint. The handler no longer carries an `authenticate` predicate — its allow-all default +
  // body-forwarded principal WERE the fabricated-authority surface. It faithfully records the
  // transport-derived senderSession its caller (the /inbox/drop route) supplies; the forged-sender
  // proof (header-derived vs body-claim + refuse-unattributable) lives at the route.
  it("records exactly the (transport-derived) senderSession it is given", () => {
    const entry = inbox.drop({ destinationSession: "bob@rig", senderSession: "alice@rig", body: "x" });
    expect(entry.senderSession).toBe("alice@rig");
  });

  it("absorb promotes pending entry to a queue_item, emits inbox.absorbed", async () => {
    const entry = inbox.drop({
      destinationSession: "bob@rig",
      senderSession: "alice@rig",
      body: "review this",
      urgency: "urgent",
    });
    const result = await inbox.absorb(entry.inboxId, "bob@rig");
    expect(result.entry.state).toBe("absorbed");
    expect(result.entry.absorbedQitemId).toBe(result.qitemId);

    const qitem = queueRepo.getById(result.qitemId)!;
    expect(qitem.body).toBe("review this");
    expect(qitem.priority).toBe("urgent");
    expect(qitem.sourceSession).toBe("alice@rig");
    expect(qitem.destinationSession).toBe("bob@rig");

    expect(captured.some((e) => e.type === "inbox.absorbed")).toBe(true);
  });

  it("absorb is idempotent — second call returns same qitem_id", async () => {
    const entry = inbox.drop({
      destinationSession: "bob@rig",
      senderSession: "alice@rig",
      body: "x",
    });
    const a = await inbox.absorb(entry.inboxId, "bob@rig");
    const b = await inbox.absorb(entry.inboxId, "bob@rig");
    expect(a.qitemId).toBe(b.qitemId);
  });

  it("absorb refuses if destination doesn't match", async () => {
    const entry = inbox.drop({
      destinationSession: "bob@rig",
      senderSession: "alice@rig",
      body: "x",
    });
    await expect(inbox.absorb(entry.inboxId, "carol@rig")).rejects.toThrow(/destined for/);
  });

  it("overlapping absorb retries promote an inbox entry only once", async () => {
    const entry = inbox.drop({ destinationSession: "bob@rig", senderSession: "alice@rig", body: "one obligation" });
    const results = await Promise.all(Array.from({ length: 5 }, () => inbox.absorb(entry.inboxId, "bob@rig")));
    expect(new Set(results.map(result => result.qitemId)).size).toBe(1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM queue_items").get()).toEqual({ count: 1 });
    expect(captured.filter(event => event.type === "inbox.absorbed")).toHaveLength(1);
    expect(captured.filter(event => event.type === "queue.created")).toHaveLength(1);
  });

  it("rolls back queue promotion when recording the absorption fails", async () => {
    const entry = inbox.drop({ destinationSession: "bob@rig", senderSession: "alice@rig", body: "retry after failure" });
    db.exec(`CREATE TRIGGER fail_absorption BEFORE UPDATE OF state ON inbox_entries
      WHEN NEW.state = 'absorbed' BEGIN SELECT RAISE(ABORT, 'injected absorption failure'); END`);
    await expect(inbox.absorb(entry.inboxId, "bob@rig")).rejects.toThrow("injected absorption failure");
    expect(inbox.getById(entry.inboxId)?.state).toBe("pending");
    expect(db.prepare("SELECT COUNT(*) AS count FROM queue_items").get()).toEqual({ count: 0 });
    expect(captured).toEqual([]);
    db.exec("DROP TRIGGER fail_absorption");
    const result = await inbox.absorb(entry.inboxId, "bob@rig");
    expect(result.entry.absorbedQitemId).toBe(result.qitemId);
    expect(db.prepare("SELECT COUNT(*) AS count FROM queue_items").get()).toEqual({ count: 1 });
  });

  it("publishes the queue promotion only after the inbox is absorbed", async () => {
    const entry = inbox.drop({ destinationSession: "bob@rig", senderSession: "alice@rig", body: "atomic notification" });
    const observed: Array<string | undefined> = [];
    bus.subscribe(event => {
      if (event.type === "queue.created") observed.push(inbox.getById(entry.inboxId)?.state);
    });
    await inbox.absorb(entry.inboxId, "bob@rig");
    expect(observed).toEqual(["absorbed"]);
  });

  it("publishes committed promotion events once in order when a subscriber emits another event", async () => {
    const entry = inbox.drop({ destinationSession: "bob@rig", senderSession: "alice@rig", body: "ordered notification" });
    bus.subscribe(event => {
      if (event.type === "queue.created") bus.emit({ type: "rig.created", rigId: "another-rig" });
    });
    await inbox.absorb(entry.inboxId, "bob@rig");
    expect(captured.map(event => event.type)).toEqual(["queue.created", "inbox.absorbed", "rig.created"]);
    expect(captured.map(event => event.seq)).toEqual([...new Set(captured.map(event => event.seq))].sort((a, b) => a - b));
  });

  it("deny records reason + emits inbox.denied; cannot subsequently absorb", async () => {
    const entry = inbox.drop({
      destinationSession: "bob@rig",
      senderSession: "alice@rig",
      body: "off-topic",
    });
    const denied = inbox.deny(entry.inboxId, "bob@rig", "off-topic-for-this-rig");
    expect(denied.state).toBe("denied");
    expect(denied.deniedReason).toBe("off-topic-for-this-rig");
    expect(captured.some((e) => e.type === "inbox.denied")).toBe(true);
    await expect(inbox.absorb(entry.inboxId, "bob@rig")).rejects.toThrow(/denied/);
  });

  it("listPending returns only pending entries for the given destination", () => {
    inbox.drop({ destinationSession: "bob@rig", senderSession: "a@r", body: "1" });
    const e2 = inbox.drop({ destinationSession: "bob@rig", senderSession: "a@r", body: "2" });
    inbox.drop({ destinationSession: "carol@rig", senderSession: "a@r", body: "3" });
    inbox.deny(e2.inboxId, "bob@rig", "no");

    const pending = inbox.listPending("bob@rig");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.body).toBe("1");
  });
});
