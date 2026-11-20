import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { outboxEntriesSchema } from "../src/db/migrations/027_outbox_entries.js";
import { seatDeliveryGuardSchema } from "../src/db/migrations/087_seat_delivery_guard.js";
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

  it("recovery metadata reads are empty without the existing native receipt column", () => {
    expect(outbox.runnerRecovery("node-1")).toEqual([]);
    expect(outbox.hasRunnerReconciliation("node-1", "run-1")).toBe(false);
  });
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
  it("projects only unresolved metadata with exact old JSON semantics and keeps reconciliation guards run-local", () => {
    const raw = (id: string, patch: Record<string, unknown>) => {
      db.prepare("UPDATE outbox_entries SET guard_delivery=? WHERE outbox_id=?").run(JSON.stringify({ runner: { ...outbox.runnerReceipt(id), ...patch } }), id);
    };
    for (const runId of ["run-1", "old-run"]) for (const kind of ["input", "wake"] as const) {
      const id = `${runId}-${kind}`, text = "PRIVATE LARGE CONTENT".repeat(50000);
      outbox.admitRunner({ ...input(id, runId), body: text, kind, payload: kind === "input" ? { text } : { question: text } });
      raw(id, { stage: "completed" });
    }
    outbox.admitRunner(input("group")); raw("group", { memberIds: ["group", "member"], withdrawal: { stage: "pending", startedAt: "2026-11-16T00:00:00Z", pendingSubmissions: 1 } });
    const confirmations = [undefined, null, false, true, 0, 1, "true"];
    confirmations.forEach((confirmed, index) => {
      const id = `cancel-${index}`; outbox.admitRunner({ ...input(id, "old-run"), kind: "cancel", payload: { target: { runId: "old-run", nativeTurnId: id } } });
      raw(id, { stage: "completed", result: { outcome: "requested", ...(confirmed === undefined ? {} : { confirmed }), detail: "PRIVATE DETAIL" }, ...(index === 1 ? { payload: { target: null }, erasedAt: "2026-11-16T01:00:00Z", withdrawal: { stage: "confirmed", startedAt: "start", confirmedAt: "confirmed", pendingSubmissions: 0 } } : {}) });
      if (index === 1) db.prepare("UPDATE outbox_entries SET sender_session='',destination_session='' WHERE outbox_id=?").run(id);
    });
    for (const [id, stage] of [["missing-stage", undefined], ["null-stage", null]] as const) { outbox.admitRunner(input(id)); raw(id, { stage }); }
    outbox.admitRunner(input("old-reconciled", "old-run")); raw("old-reconciled", { reconciliation: "receiver_state_lost" });
    outbox.admitRunner({ ...input("cancel-reconciled"), kind: "cancel", payload: { target: { runId: "run-1", nativeTurnId: "E" } } }); raw("cancel-reconciled", { reconciliation: "receiver_state_lost" });
    expect(outbox.hasRunnerReconciliation("node-1", "run-1")).toBe(false);
    expect(outbox.hasRunnerReconciliation("node-1", "old-run")).toBe(true);
    const reference = outbox.runnerReceipts("node-1").filter(receipt => receipt.reconciliation || !["completed", "rejected"].includes(receipt.stage)
      || receipt.kind === "cancel" && receipt.result?.outcome === "requested" && receipt.result.confirmed !== true).map(receipt => {
      const entry = outbox.getById(receipt.requestId)!;
      return { requestId: receipt.requestId, runId: receipt.runId, kind: receipt.kind, stage: receipt.stage,
        ...(receipt.erasedAt ? { erasedAt: receipt.erasedAt } : {}), sender: entry.senderSession, destination: entry.destinationSession,
        ...(receipt.memberIds ? { memberIds: receipt.memberIds } : {}), ...(receipt.kind === "cancel" ? { target: receipt.payload.target } : {}),
        ...(receipt.withdrawal ? { withdrawal: { stage: receipt.withdrawal.stage, startedAt: receipt.withdrawal.startedAt, ...(receipt.withdrawal.confirmedAt ? { confirmedAt: receipt.withdrawal.confirmedAt } : {}), pendingSubmissions: receipt.withdrawal.pendingSubmissions } } : {}),
        ...(receipt.reconciliation ? { reconciliation: receipt.reconciliation } : {}), ...(receipt.result?.outcome ? { outcome: receipt.result.outcome, confirmed: receipt.result.confirmed } : {}) };
    });
    expect(outbox.runnerRecovery("node-1")).toEqual(reference);
    expect(outbox.runnerRecovery("other-node")).toEqual([]);
    expect(JSON.stringify(outbox.runnerRecovery("node-1"))).not.toContain("PRIVATE");
    outbox.admitRunner(input("current-erased-reconciled")); raw("current-erased-reconciled", { kind: null, reconciliation: "receiver_state_lost", erasedAt: "2026-11-16T01:00:00Z" });
    expect(outbox.hasRunnerReconciliation("node-1", "run-1")).toBe(true);
  });
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
  it("a held wake cannot become an ordinary input through grouped secondary membership", () => {
    const held = input("held-wake");
    outbox.bindInputRoute(held, "native", "wake");
    outbox.record(input("first"));
    expect(() => outbox.admitRunner({ ...input("first"), memberIds: ["first", "held-wake"] })).toThrow(/different/);
    expect(outbox.runnerReceipt("first")).toBeNull();
    expect(outbox.inputKind("held-wake")).toBe("wake");
  });
  it("a missing primary cannot be recreated by direct native admission of its surviving member", () => {
    for (const id of ["owner", "member"]) outbox.record({ ...input(id), body: id });
    outbox.admitRunner({ ...input("owner"), body: "owner", memberIds: ["owner", "member"] });
    db.prepare("DELETE FROM outbox_entries WHERE outbox_id='owner'").run();
    expect(() => outbox.admitRunner({ ...input("member"), body: "member" })).toThrow(/different|unavailable/);
    expect(() => outbox.admitRunner({ ...input("owner"), body: "owner" })).toThrow(/unavailable/);
    expect(outbox.runnerReceipt("member")).toBeNull();
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
  it("never changes a completed input's epoch, accepted ordinal, result, node or run on a late report", () => {
    outbox.admitRunner(input());
    for (const stage of ["offered", "accepted", "submitted"] as const) outbox.updateRunner("node-1", "run-1", "native-1", 1, stage);
    const evidence = { nativeTurnId: "epoch-E", acceptedTurnId: "1", result: { kind: "input", accepted: true } };
    const saved = outbox.updateRunner("node-1", "run-1", "native-1", 1, "completed", evidence);
    for (const changed of [{ ...evidence, nativeTurnId: "epoch-F" }, { ...evidence, acceptedTurnId: "2" }, { ...evidence, result: { kind: "input", accepted: false } }])
      expect(() => outbox.updateRunner("node-1", "run-1", "native-1", 1, "completed", changed)).toThrow();
    expect(() => outbox.updateRunner("node-1", "other-run", "native-1", 1, "completed", evidence)).toThrow();
    expect(() => outbox.updateRunner("other-node", "run-1", "native-1", 1, "completed", evidence)).toThrow();
    expect(outbox.updateRunner("node-1", "run-1", "native-1", 1, "completed", evidence)).toEqual(saved);
    expect(outbox.runnerReceipt("native-1")).toEqual(saved);
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
  it("retains terminal native submission uncertainty without claiming delivery", () => {
    outbox.admitRunner(input()); outbox.updateRunner("node-1", "run-1", "native-1", 1, "offered");
    outbox.updateRunner("node-1", "run-1", "native-1", 1, "accepted");
    const result = { kind: "input", completion: "unknown", submissionUnknown: true };
    expect(outbox.updateRunner("node-1", "run-1", "native-1", 1, "completed", { result }).result).toEqual(result);
    expect(outbox.getById("native-1")?.deliveryState).toBe("indeterminate");
  });
  it.each(["pending", "offered", "accepted", "submitted", "requested", "cancelled"] as const)("committed run replacement preserves cancellation truth and custody (%s)", phase => {
    const request = { ...input(), kind: "cancel" as const, payload: { target: { runId: "run-1", nativeTurnId: "E" } } };
    outbox.admitRunner(request);
    if (phase !== "pending") outbox.updateRunner("node-1", "run-1", "native-1", 1, "offered");
    if (!["pending", "offered"].includes(phase)) outbox.updateRunner("node-1", "run-1", "native-1", 1, "accepted");
    if (["submitted", "requested", "cancelled"].includes(phase)) outbox.updateRunner("node-1", "run-1", "native-1", 1, "submitted", { result: { kind: "cancel", outcome: "requested", confirmed: false } });
    if (["requested", "cancelled"].includes(phase)) outbox.updateRunner("node-1", "run-1", "native-1", 1, "completed", { result: { kind: "cancel", outcome: phase, confirmed: phase === "cancelled" } });
    const saved = outbox.runnerReceipt("native-1")!; outbox.replaceRunnerRun("node-1", "run-2");
    const receipt = outbox.runnerReceipt("native-1")!;
    if (phase === "pending") expect(receipt).toMatchObject({ stage: "rejected", result: { kind: "cancel", accepted: false } });
    else if (["requested", "cancelled"].includes(phase)) expect(receipt).toEqual(saved);
    else {
      expect(receipt).toEqual({ ...saved, reconciliation: "receiver_state_lost" });
      expect(() => outbox.updateRunner("node-1", "run-1", "native-1", 1, "completed", { result: { kind: "cancel", outcome: "cancelled", confirmed: true } })).toThrow();
    }
    expect(outbox.claimForDelivery("native-1")).toBe(false);
  });
  it("erased cancellation retains only opaque target/withdrawal proof and refuses replay or late writes", () => {
    migrate(db, [seatDeliveryGuardSchema]);
    const request = { ...input(), kind: "cancel" as const, payload: { target: { runId: "run-1", nativeTurnId: "E" } } };
    outbox.admitRunner(request);
    for (const stage of ["offered", "accepted"] as const) outbox.updateRunner("node-1", "run-1", "native-1", 1, stage);
    outbox.recordRunnerWithdrawal("node-1", "run-1", "native-1", 1, { confirmed: true, pendingSubmissions: 0, withdrawn: 2 });
    outbox.updateRunner("node-1", "run-1", "native-1", 1, "submitted", { result: { kind: "cancel", outcome: "requested", confirmed: false, detail: "PRIVATE DETAIL", extra: "PRIVATE RESULT" } });
    const hash = outbox.runnerReceipt("native-1")!.bindingHash;
    outbox.eraseRunner("native-1", "2026-11-12T00:00:00Z");
    const erased = outbox.runnerReceipt("native-1")!;
    expect(erased).toMatchObject({ payload: request.payload, bindingHash: hash, withdrawal: { stage: "confirmed", withdrawn: 2 }, result: { kind: "cancel", outcome: "requested", confirmed: false } });
    expect(JSON.stringify(erased)).not.toContain("PRIVATE");
    expect(() => outbox.admitRunner(request)).toThrow(/erased/);
    expect(() => outbox.updateRunner("node-1", "run-1", "native-1", 1, "completed", { result: { kind: "cancel", outcome: "cancelled", confirmed: true } })).toThrow(/erased/);
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
