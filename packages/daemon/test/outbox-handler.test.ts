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

  // W1-b (transactional closure) — INDETERMINATE is the ambiguous-outcome state:
  // a delivery whose landing could not be confirmed (transport res.ok but not
  // verified) records `indeterminate`, never silently `delivered` and never
  // `failed`. It is a holding state resolved out-of-band, not a retry state.
  it("markIndeterminate transitions pending → indeterminate (CAS from pending)", () => {
    const e = outbox.record({
      senderSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "x",
    });
    const indet = outbox.markIndeterminate(e.outboxId);
    expect(indet.deliveryState).toBe("indeterminate");
  });

  it("markIndeterminate NEVER clobbers a confirmed delivery (delivered stays delivered)", () => {
    const e = outbox.record({
      senderSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "x",
    });
    outbox.markDelivered(e.outboxId);
    // A late/racing indeterminate resolution must not overwrite a delivered row —
    // the CAS guards on delivery_state='pending', so this is a no-op.
    const after = outbox.markIndeterminate(e.outboxId);
    expect(after.deliveryState).toBe("delivered");
  });

  // RULED (W1-b, planner-confirmed): indeterminate is TERMINAL-BY-CAS. markDelivered
  // and markFailed both gate on delivery_state='pending', so neither can afterwards
  // touch an indeterminate row. This is intended — an ambiguous outcome is never
  // silently flipped to delivered (we cannot confirm) nor to failed (it may have
  // landed); re-delivering would risk a double-send. Reconciliation of an
  // indeterminate row is an out-of-scope follow-on, not a W1 transition.
  it("indeterminate is terminal-by-CAS: markDelivered is a no-op on it", () => {
    const e = outbox.record({
      senderSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "x",
    });
    outbox.markIndeterminate(e.outboxId);
    const after = outbox.markDelivered(e.outboxId);
    expect(after.deliveryState).toBe("indeterminate");
  });

  it("indeterminate is terminal-by-CAS: markFailed is a no-op on it", () => {
    const e = outbox.record({
      senderSession: "alice@rig",
      destinationSession: "bob@rig",
      body: "x",
    });
    outbox.markIndeterminate(e.outboxId);
    const after = outbox.markFailed(e.outboxId);
    expect(after.deliveryState).toBe("indeterminate");
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
