// #1278: a queue wake keeps the input-box reading the transport returned for that wake attempt, so
// `rig queue show --json` can tell an exact-text-still-in-the-box wake from a busy seat or a collapsed
// paste. The reading is diagnostic only: the wake result, its claim presentation and every delivery
// decision are unchanged, and an attempt without a reading never shows an earlier attempt's reading.

import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository, type QueueNudgeTransport } from "../src/domain/queue-repository.js";
import type { InputBoxEvidence } from "../src/domain/session-transport.js";

type SendResult = Awaited<ReturnType<QueueNudgeTransport["send"]>>;

const TEXT_STILL_IN_BOX: InputBoxEvidence = { seat: "idle", before: "exact", after: "exact", sameProcess: true };
const BUSY_SEAT: InputBoxEvidence = { seat: "not-idle", before: "exact", after: "queued", sameProcess: true };
const COLLAPSED_PASTE: InputBoxEvidence = { seat: "idle", before: "hidden", after: "empty", sameProcess: true };

function harness(opts: { outbox?: boolean } = {}) {
  const db = createDb();
  migrate(db, ALL_MIGRATIONS);
  const repo = new QueueRepository(db, new EventBus(db), { validateRig: () => true });
  const outbox = opts.outbox === false ? null : new OutboxHandler(db);
  if (outbox) repo.attachOutbox(outbox);
  const results: Array<SendResult | Error> = [];
  const sent: string[] = [];
  repo.attachTransport({
    async send(session) {
      sent.push(session);
      const result = results.shift();
      if (result instanceof Error) throw result;
      return result ?? { ok: true, verified: true };
    },
  });
  return { db, repo, results, sent };
}

describe("a queue wake keeps its input-box reading (#1278)", () => {
  let db: Database.Database | null = null;
  afterEach(() => { db?.close(); db = null; });

  it("stores the reading of an unconfirmed wake and reads it back on the row, beside the unchanged wake result", async () => {
    const h = harness({ outbox: false });
    db = h.db;
    h.results.push({ ok: true, verified: false, outcome: "rendered-unconfirmed", inputBox: TEXT_STILL_IN_BOX });
    const item = await h.repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "x" });

    const row = h.repo.getById(item.qitemId)!;
    expect(row.lastNudgeResult).toBe("delivered-ack-pending");
    expect(row.lastNudgeWireResult).toBe("delivered-ack-pending");
    expect(row.lastNudgeInputBox).toEqual(TEXT_STILL_IN_BOX);
    expect(row.pickup).toMatchObject({ state: "unclaimed" });

    // A claim still presents over the unconfirmed wake (#165); the reading stays as recorded.
    const claimed = h.repo.claim({ qitemId: item.qitemId, destinationSession: "bob@rig" });
    expect(claimed.lastNudgeResult).toBe("claimed");
    expect(claimed.lastNudgeWireResult).toBe("delivered-ack-pending");
    expect(claimed.lastNudgeInputBox).toEqual(TEXT_STILL_IN_BOX);
  });

  it.each([TEXT_STILL_IN_BOX, BUSY_SEAT, COLLAPSED_PASTE])("keeps %j diagnostic even when the transport reports verified", async (inputBox) => {
    const h = harness({ outbox: false });
    db = h.db;
    // Deliberately inconsistent synthetic evidence: the repository must trust the transport's
    // verdict, not add its own input-box classifier or another send.
    h.results.push({ ok: true, verified: true, inputBox });
    const item = await h.repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "x" });
    const reader = new QueueRepository(h.db, new EventBus(h.db), { validateRig: () => true });
    expect(reader.getById(item.qitemId)).toMatchObject({
      state: "pending", claimedAt: null, lastNudgeResult: "verified", lastNudgeWireResult: "verified", lastNudgeInputBox: inputBox,
    });
    expect(h.sent).toEqual(["bob@rig"]);
  });

  it("keeps only the structured reading, never any other field the transport attached", async () => {
    const h = harness({ outbox: false });
    db = h.db;
    const withExtra = { ...BUSY_SEAT, pane: "❯ secret pane text" } as unknown as InputBoxEvidence;
    h.results.push({ ok: true, verified: false, inputBox: withExtra });
    const item = await h.repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "x" });

    const stored = (h.db.prepare("SELECT last_nudge_input_box AS v FROM queue_items WHERE qitem_id = ?").get(item.qitemId) as { v: string }).v;
    const row = h.repo.getById(item.qitemId)!;
    // Stored with its attempt's own timestamp; the row shows only the four reading fields.
    expect(JSON.parse(stored)).toEqual({ ...BUSY_SEAT, at: row.lastNudgeAttempt });
    expect(stored).not.toContain("secret");
    expect(row.lastNudgeInputBox).toEqual(BUSY_SEAT);
  });

  it.each([
    ...["seat", "before", "after", "sameProcess"].flatMap((field) => [
      [field, undefined], [field, null], [field, "invalid"], [field, 1],
    ]),
  ])("rejects a missing or invalid %s (%j) on write and read", async (field, value) => {
    const h = harness({ outbox: false });
    db = h.db;
    const malformed = { ...TEXT_STILL_IN_BOX, [field as string]: value } as unknown as InputBoxEvidence;
    h.results.push({ ok: true, verified: true, inputBox: TEXT_STILL_IN_BOX });
    const item = await h.repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "x" });
    h.results.push({ ok: true, verified: true, inputBox: malformed });
    await h.repo.maybeNudge(item.qitemId, "bob@rig", true);
    expect(h.repo.getById(item.qitemId)).toMatchObject({ lastNudgeWireResult: "verified", lastNudgeInputBox: null });
    expect(h.db.prepare("SELECT last_nudge_input_box AS reading FROM queue_items WHERE qitem_id = ?").get(item.qitemId))
      .toEqual({ reading: null });

    // Even a matching attempt timestamp cannot make an incomplete stored reading valid.
    const at = h.repo.getById(item.qitemId)!.lastNudgeAttempt;
    h.db.prepare("UPDATE queue_items SET last_nudge_input_box = ? WHERE qitem_id = ?")
      .run(JSON.stringify({ ...malformed, at }), item.qitemId);
    expect(h.repo.getById(item.qitemId)!.lastNudgeInputBox).toBeNull();
    expect(h.repo.list({}).find((row) => row.qitemId === item.qitemId)!.lastNudgeInputBox).toBeNull();
  });

  it.each(["exact", "ambiguous", "empty", "queued", "hidden", "other", "unrecognized", "unavailable", "unchecked"] as const)(
    "preserves valid %s readings, including false sameProcess", async (reading) => {
      const h = harness({ outbox: false });
      db = h.db;
      for (const seat of ["idle", "not-idle", "unknown", "unchecked"] as const) {
        const inputBox: InputBoxEvidence = { seat, before: reading, after: reading, sameProcess: false };
        h.results.push({ ok: true, verified: true, inputBox });
        const item = await h.repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "x" });
        expect(h.repo.getById(item.qitemId)!.lastNudgeInputBox).toEqual(inputBox);
      }
    },
  );

  it("an attempt an older daemon recorded (time and result only) does not show the earlier attempt's reading", async () => {
    const h = harness({ outbox: false });
    db = h.db;
    const control = await h.repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "control", nudge: false });
    const downgraded = await h.repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "downgraded", nudge: false });

    // Attempt A, recorded by this daemon with a reading.
    for (const item of [control, downgraded]) h.repo.recordNudgeAttempt(item.qitemId, "delivered-ack-pending", TEXT_STILL_IN_BOX);

    // Attempt B, recorded by an older daemon after a downgrade: its UPDATE sets only the time and
    // the result, so A's reading stays in the column.
    const attemptB = new Date(Date.now() + 60_000).toISOString();
    h.db.prepare("UPDATE queue_items SET last_nudge_attempt = ?, last_nudge_result = ? WHERE qitem_id = ?")
      .run(attemptB, "verified", downgraded.qitemId);

    // After upgrading again, B shows no reading rather than A's.
    expect(h.repo.getById(downgraded.qitemId)).toMatchObject({
      lastNudgeAttempt: attemptB, lastNudgeWireResult: "verified", lastNudgeInputBox: null,
    });
    expect(h.repo.list({}).find((row) => row.qitemId === downgraded.qitemId)!.lastNudgeInputBox).toBeNull();

    // Control: with no old-style update after A, A's reading still shows.
    expect(h.repo.getById(control.qitemId)!.lastNudgeInputBox).toEqual(TEXT_STILL_IN_BOX);
  });

  it("a wake with no reading (setting off, a failed send, a retained wake) leaves the reading absent", async () => {
    const h = harness({ outbox: false });
    db = h.db;
    const cases: Array<[SendResult, string]> = [
      [{ ok: true, verified: true }, "verified"],
      [{ ok: true, verified: false }, "delivered-ack-pending"],
      [{ ok: false, error: "Session 'bob@rig' not found" }, "failed:Session 'bob@rig' not found"],
      [{ ok: true, sent: false, verified: false, outcome: "retained", reason: "typing_guard_enabled" } as SendResult, "retained:typing_guard"],
    ];
    for (const [result, expected] of cases) {
      h.results.push(result);
      const item = await h.repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "x" });
      const row = h.repo.getById(item.qitemId)!;
      expect(row.lastNudgeWireResult).toBe(expected);
      expect(row.lastNudgeInputBox).toBeNull();
    }
  });

  it.each<[SendResult, string]>([
    [{ ok: false, error: "send failed" }, "failed:send failed"],
    [{ ok: false, reason: "draft_input_changed", sent: true }, "indeterminate:draft_input_changed"],
    [{ ok: true, outcome: "retained", reason: "draft_present" }, "retained:draft_aware"],
  ])("keeps a returned reading alongside the unchanged outcome %j", async (result, expected) => {
    const h = harness({ outbox: false });
    db = h.db;
    h.results.push({ ...result, inputBox: BUSY_SEAT });
    const item = await h.repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "x" });
    const row = h.repo.getById(item.qitemId)!;
    expect(row.lastNudgeWireResult).toBe(expected);
    expect(row.lastNudgeInputBox).toEqual(BUSY_SEAT);
    expect(row.pickup).toMatchObject({ state: "unclaimed" });
  });

  it("a retry replaces the reading: a newer attempt without one never shows the older reading", async () => {
    const h = harness({ outbox: false });
    db = h.db;
    h.results.push({ ok: true, verified: false, inputBox: TEXT_STILL_IN_BOX });
    const item = await h.repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "x" });
    expect(h.repo.getById(item.qitemId)!.lastNudgeInputBox).toEqual(TEXT_STILL_IN_BOX);

    // The wake ladder's retry goes through maybeNudge; this one gets no reading (setting turned off).
    h.results.push({ ok: true, verified: false });
    await h.repo.maybeNudge(item.qitemId, "bob@rig", true);
    const afterRetry = h.repo.getById(item.qitemId)!;
    expect(afterRetry.lastNudgeWireResult).toBe("delivered-ack-pending");
    expect(afterRetry.lastNudgeInputBox).toBeNull();

    // A later retry with its own reading shows that reading.
    h.results.push({ ok: true, verified: false, inputBox: COLLAPSED_PASTE });
    await h.repo.maybeNudge(item.qitemId, "bob@rig", true);
    expect(h.repo.getById(item.qitemId)!.lastNudgeInputBox).toEqual(COLLAPSED_PASTE);

    // A result recorded without a send (e.g. the parked-owner consumer's failure line) also clears it.
    h.repo.recordNudgeAttempt(item.qitemId, "failed:wake refused");
    expect(h.repo.getById(item.qitemId)!.lastNudgeInputBox).toBeNull();
  });

  it.each([
    [{ ok: true, verified: true }, "verified"],
    [{ ok: false, error: "Session 'bob@rig' not found" }, "failed:Session 'bob@rig' not found"],
    [{ ok: false, sent: false, inputPhase: "not_reached", reason: "caller_cancelled" }, "failed:caller_cancelled"],
    [{ ok: false, reason: "delivery_indeterminate" }, "indeterminate:delivery_indeterminate"],
    [{ ok: false, reason: "submit_failed" }, "indeterminate:submit_failed"],
    [{ ok: false, reason: "send_failed", inputPhase: "attempted" }, "indeterminate:send_failed"],
    [{ ok: true, verified: false, outcome: "retained", reason: "typing_guard_enabled" }, "retained:typing_guard"],
    [new Error("transport broke"), "failed:transport broke"],
    [new Error("ack timed out"), "indeterminate:ack timed out"],
  ] satisfies Array<[SendResult | Error, string]>)("a newer %j attempt clears the previous reading and keeps result %s", async (result, expected) => {
    const h = harness({ outbox: false });
    db = h.db;
    h.results.push({ ok: true, verified: false, inputBox: TEXT_STILL_IN_BOX });
    const item = await h.repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "x" });
    h.results.push(result);

    await h.repo.maybeNudge(item.qitemId, "bob@rig", true);

    expect(h.sent).toEqual(["bob@rig", "bob@rig"]);
    expect(h.repo.getById(item.qitemId)).toMatchObject({
      state: "pending", claimedAt: null, lastNudgeWireResult: expected, lastNudgeInputBox: null,
    });
    expect(h.db.prepare("SELECT last_nudge_input_box AS reading FROM queue_items WHERE qitem_id = ?").get(item.qitemId))
      .toEqual({ reading: null });
  });

  it("staging a delayed wake preserves the last actual attempt until delivery, then replaces only its row", async () => {
    const h = harness();
    db = h.db;
    const item = await h.repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "delayed", nudge: false });
    const sibling = await h.repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "untouched", nudge: false });
    h.repo.recordNudgeAttempt(item.qitemId, "delivered-ack-pending", TEXT_STILL_IN_BOX);
    h.repo.recordNudgeAttempt(sibling.qitemId, "delivered-ack-pending", COLLAPSED_PASTE);
    const previous = h.repo.getById(item.qitemId)!;

    h.repo.stageWakeIntent(item.qitemId, "alice@rig", "bob@rig", null, true);
    await h.repo.maybeNudge(item.qitemId, "bob@rig", false);
    expect(h.sent).toHaveLength(0);
    expect(h.repo.getById(item.qitemId)).toMatchObject({
      lastNudgeAttempt: previous.lastNudgeAttempt, lastNudgeInputBox: TEXT_STILL_IN_BOX,
    });

    h.results.push({ ok: true, verified: true });
    expect(await h.repo.drainPendingWakeIntents()).toEqual({ delivered: 1, indeterminate: 0, failed: 0, retained: 0 });
    expect(h.repo.getById(item.qitemId)).toMatchObject({ state: "pending", claimedAt: null, lastNudgeWireResult: "verified", lastNudgeInputBox: null });
    expect(h.repo.getById(sibling.qitemId)!.lastNudgeInputBox).toEqual(COLLAPSED_PASTE);
    expect(h.db.prepare("SELECT delivery_state AS state FROM outbox_entries WHERE audit_pointer = ?").get(item.qitemId))
      .toEqual({ state: "delivered" });

    expect(await h.repo.drainPendingWakeIntents()).toEqual({ delivered: 0, indeterminate: 0, failed: 0, retained: 0 });
    expect(h.sent).toEqual(["bob@rig"]);
  });

  it("a coalesced wake stores the one send's reading on every row it woke, and a newer coalesced wake replaces it", async () => {
    const h = harness();
    db = h.db;
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const item = await h.repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: `work ${i}`, nudge: false });
      h.repo.recordNudgeAttempt(item.qitemId, "delivered-ack-pending", i === 0 ? TEXT_STILL_IN_BOX : COLLAPSED_PASTE);
      h.repo.stageWakeIntent(item.qitemId, "alice@rig", "bob@rig", null, true);
      h.db.prepare("UPDATE outbox_entries SET tags = ? WHERE outbox_id = ?").run(JSON.stringify(["queue:return:common"]), `wake-intent-${item.qitemId}`);
      ids.push(item.qitemId);
    }
    h.results.push({ ok: true, verified: false, inputBox: BUSY_SEAT });
    expect(await h.repo.drainPendingWakeIntents()).toEqual({ delivered: 0, indeterminate: 1, failed: 0, retained: 0 });
    expect(h.sent).toHaveLength(1);
    for (const id of ids) {
      const row = h.repo.getById(id)!;
      expect(row.lastNudgeWireResult).toBe("delivered-ack-pending");
      expect(row.lastNudgeInputBox).toEqual(BUSY_SEAT);
    }

    // The next recovery pass makes a fresh attempt; its reading replaces the previous attempt's.
    h.results.push({ ok: true, verified: true });
    expect(await h.repo.drainPendingWakeIntents()).toEqual({ delivered: 1, indeterminate: 0, failed: 0, retained: 0 });
    expect(h.sent).toHaveLength(2);
    for (const id of ids) {
      const row = h.repo.getById(id)!;
      expect(row.lastNudgeWireResult).toBe("verified");
      expect(row.lastNudgeInputBox).toBeNull();
    }
  });

  it("a compact listing names the reading as elided rather than showing it empty", async () => {
    const h = harness({ outbox: false });
    db = h.db;
    h.results.push({ ok: true, verified: false, inputBox: TEXT_STILL_IN_BOX });
    await h.repo.create({ sourceSession: "alice@rig", destinationSession: "bob@rig", body: "x" });
    const [row] = h.repo.list({ compact: true }) as Array<Record<string, unknown>>;
    expect(row).not.toHaveProperty("lastNudgeInputBox");
    expect(row!.fieldsElided).toEqual(expect.arrayContaining(["lastNudgeInputBox"]));
  });
});
