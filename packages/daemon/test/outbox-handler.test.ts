import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";

describe("OutboxHandler", () => {
  let db: Database.Database;
  let outbox: OutboxHandler;

  beforeEach(() => {
    db = createDb();
    migrate(db, [outboxEntriesSchema]);
    outbox = new OutboxHandler(db);
  });

  afterEach(() => db.close());

  it("record creates entry in pending state", () => {
    const e = outbox.record({
      senderSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "fyi",
      tags: ["info"],
    });
    expect(e.outboxId).toMatch(/^outbox-\d{14}-[a-f0-9]{8}$/);
    expect(e.deliveryState).toBe("pending");
    expect(e.tags).toEqual(["info"]);
  });

  it("record is idempotent on outbox_id", () => {
    const id = "outbox-fixed-id-0001";
    const a = outbox.record({
      outboxId: id,
      senderSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "first",
    });
    const b = outbox.record({
      outboxId: id,
      senderSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "second-ignored",
    });
    expect(a.outboxId).toBe(b.outboxId);
    expect(b.body).toBe("first");
  });

  it("markDelivered updates state and timestamp", () => {
    const e = outbox.record({
      senderSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "x",
    });
    const delivered = outbox.markDelivered(e.outboxId);
    expect(delivered.deliveryState).toBe("delivered");
    expect(delivered.deliveredAt).toBeTruthy();
  });

  it("markDelivered on already-delivered is a no-op (returns existing)", () => {
    const e = outbox.record({
      senderSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "x",
    });
    outbox.markDelivered(e.outboxId);
    const second = outbox.markDelivered(e.outboxId);
    expect(second.deliveryState).toBe("delivered");
  });

  it("markFailed transitions pending → failed", () => {
    const e = outbox.record({
      senderSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "x",
    });
    const failed = outbox.markFailed(e.outboxId);
    expect(failed.deliveryState).toBe("failed");
  });

  it("listForSender returns reverse-chronological", () => {
    outbox.record({ senderSession: "a@r", destinationSession: "b@r", body: "1" });
    outbox.record({ senderSession: "a@r", destinationSession: "b@r", body: "2" });
    outbox.record({ senderSession: "x@r", destinationSession: "b@r", body: "3" });
    const list = outbox.listForSender("a@r");
    expect(list).toHaveLength(2);
    expect(list[0]!.body).toBe("2");
  });
});
