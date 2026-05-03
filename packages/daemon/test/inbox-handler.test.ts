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

  it("auth check rejects spoofed sender_session", () => {
    const strictInbox = new InboxHandler(db, bus, queueRepo, {
      authenticate: (sender, claimed) => sender === claimed,
    });
    expect(() =>
      strictInbox.drop(
        { destinationSession: "bob@rig", senderSession: "alice@rig", body: "x" },
        "mallory@rig"
      )
    ).toThrow(InboxHandlerError);
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
