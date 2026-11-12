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


describe("native runner receipts", () => {
  let db: Database.Database;
  let outbox: OutboxHandler;
  const input = (id = "native-1", runId = "run-1") => ({ outboxId: id, senderSession: "alice@rig", destinationSession: "bob@rig", body: "hello",
    nodeId: "node-1", runId, kind: "input" as const, payload: { text: "hello" }, inputRoute: "native" as const });
  beforeEach(() => {
    db = createDb(); migrate(db, [outboxEntriesSchema]);
    db.exec("ALTER TABLE outbox_entries ADD COLUMN guard_delivery TEXT");
    outbox = new OutboxHandler(db);
  });
  afterEach(() => db.close());
  it("binds immutable IDs and allocates order once per run while preserving receipt keys", () => {
    outbox.record(input());
    db.prepare("UPDATE outbox_entries SET guard_delivery=?").run(JSON.stringify({ ids: ["native-1"], watchdog: { nextAction: "inspect" } }));
    expect(outbox.admitRunner(input())).toMatchObject({ sequence: 1, stage: "pending" });
    expect(outbox.admitRunner(input()).sequence).toBe(1);
    expect(outbox.admitRunner(input("native-2")).sequence).toBe(2);
    expect(outbox.admitRunner(input("native-3", "run-2")).sequence).toBe(1);
    expect(JSON.parse((db.prepare("SELECT guard_delivery FROM outbox_entries WHERE outbox_id='native-1'").get() as { guard_delivery: string }).guard_delivery).watchdog).toEqual({ nextAction: "inspect" });
    for (const change of [{ body: "other" }, { senderSession: "eve@rig" }, { runId: "other" }, { nodeId: "other" }, { payload: { text: "other" } }])
      expect(() => outbox.admitRunner({ ...input(), ...change })).toThrow(/different/);
  });
  it("an admitted native ID cannot gain a different original-conversation constraint on retry", () => {
    outbox.admitRunner(input());
    expect(() => outbox.bindExpectedIdentity(input(), { nodeId: "node-1", sessionName: "bob@rig", runtime: "pi", nativeId: "other" })).toThrow(/different/);
  });
  it("acceptance is durable, monotonic, and never reclaims a native effect through typed recovery", () => {
    outbox.admitRunner(input());
    expect(() => outbox.updateRunner("node-1", "run-1", "native-1", 2, "offered")).toThrow();
    outbox.updateRunner("node-1", "run-1", "native-1", 1, "offered");
    outbox.updateRunner("node-1", "run-1", "native-1", 1, "accepted");
    expect(outbox.claimForDelivery("native-1")).toBe(false);
    expect(() => outbox.updateRunner("node-1", "run-2", "native-1", 1, "submitted")).toThrow();
    outbox.updateRunner("node-1", "run-1", "native-1", 1, "submitted", { acceptedTurnId: "1" });
    expect(outbox.getById("native-1")?.deliveryState).toBe("delivered");
    expect(outbox.updateRunner("node-1", "run-1", "native-1", 1, "accepted").stage).toBe("submitted");
  });
  it("resolves any grouped member after store restart and rejects changed membership or member collisions atomically", () => {
    for (const id of ["first", "second", "third"]) outbox.record({ ...input(id), body: id });
    const operation = { ...input("first"), body: "first", memberIds: ["first", "second"], payload: { text: "combined" } };
    outbox.admitRunner(operation);
    outbox = new OutboxHandler(db);
    expect(outbox.runnerReceipt("second")).toMatchObject({ requestId: "first", sequence: 1 });
    expect(() => outbox.admitRunner({ ...operation, memberIds: ["first", "third"] })).toThrow(/different/);
    expect(() => outbox.admitRunner({ ...input("third"), body: "third", memberIds: ["third", "second"] })).toThrow(/different/);
    expect(outbox.runnerReceipt("third")).toBeNull();
    expect(outbox.runnerReceipts("node-1", "run-1")).toHaveLength(1);
    outbox.updateRunner("node-1", "run-1", "first", 1, "offered");
    outbox.updateRunner("node-1", "run-1", "first", 1, "accepted");
    outbox.updateRunner("node-1", "run-1", "first", 1, "submitted");
    expect(outbox.getById("second")?.deliveryState).toBe("delivered");
    expect(outbox.claimForDelivery("second")).toBe(false);
    db.prepare("DELETE FROM outbox_entries WHERE outbox_id='first'").run();
    expect(outbox.runnerPrimary("second")).toBe("first");
    expect(outbox.runnerReceipt("second")).toBeNull();
    expect(outbox.claimForDelivery("second")).toBe(false);
  });
  it("reconciles lost receiver memory as uncertainty without reoffering", () => {
    outbox.admitRunner(input());
    outbox.updateRunner("node-1", "run-1", "native-1", 1, "offered");
    outbox.forgetRunnerMap("node-1", "run-1");
    expect(outbox.getById("native-1")?.deliveryState).toBe("indeterminate");
    expect(outbox.runnerReceipts("node-1", "run-1")[0]).toMatchObject({ stage: "offered", reconciliation: "receiver_state_lost" });
    expect(outbox.claimForDelivery("native-1")).toBe(false);
  });
});
