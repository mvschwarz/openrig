import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { buildQueueTransfer } from "../src/domain/queue-transfer-export.js";
import { parseQueueTransfer } from "../src/domain/queue-transfer-parse.js";
import { ACTIVATION_KIND, AUTHORIZATION_KIND, authorizationDigest, parseAuthorization, type TransferActivation } from "../src/domain/queue-transfer-records.js";
import { QueueTransferSource } from "../src/domain/queue-transfer-relinquish.js";
import { mappingDigest } from "../src/domain/queue-transfer-mapping.js";
import { replayTransfer, transferStatus } from "../src/domain/queue-transfer-recovery.js";

let db: Database.Database;
let repo: QueueRepository;
let source: QueueTransferSource;
beforeEach(() => {
  db = new Database(":memory:");
  migrate(db, ALL_MIGRATIONS);
  db.exec(`INSERT INTO self_host_identity VALUES (1, 'origin', 'minted', 'reconciled');
    INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body)
    VALUES ('qitem-a', '1', '1', 'a@old', 'b@old', 'pending', 'selected'),
           ('qitem-b', '1', '1', 'a@old', 'b@old', 'pending', 'outside');`);
  repo = new QueueRepository(db, new EventBus(db));
  source = new QueueTransferSource(repo);
});
afterEach(() => { db.close(); vi.useRealTimers(); });

function snapshot() {
  const { archive: archiveText } = buildQueueTransfer(db, { kind: "qitems", names: ["qitem-a"] });
  const archive = parseQueueTransfer(archiveText);
  const authorization = parseAuthorization({ kind: AUTHORIZATION_KIND, operationId: "op", archiveDigest: archive.digest, origin: archive.origin,
    destination: { hostId: "target", authorizedAt: "3", seatMapping: [] }, intervention: { kind: "online-handshake", actor: "operator", recordedAt: "3", limits: "local" } });
  return { archiveText, authorization, intervention: "dispatch relinquished", actor: { actorSession: "operator" } };
}

it("writes only a scoped fence and retries the recorded intervention exactly", () => {
  const input = snapshot();
  expect(db.prepare("SELECT qitem_id FROM queue_transfer_relinquished").all()).toEqual([]);
  expect(source.relinquish({ ...input, dryRun: true })).toMatchObject({ archiveCurrent: true, fenced: [] });
  const result = source.relinquish(input);
  expect(result).toMatchObject({ fenced: ["qitem-a"], receipt: { sourceState: "relinquished", intervention: input.intervention } });
  expect(source.relinquish(input)).toMatchObject({ replayed: true, receipt: result.receipt });
  expect(db.prepare("SELECT qitem_id FROM queue_transfer_relinquished").pluck().all()).toEqual(["qitem-a"]);
});

it("refuses a stale archive when only its history drifted", () => {
  const input = snapshot();
  repo.transitionLog.append({ qitemId: "qitem-a", state: "pending", actorSession: "a@old", transitionNote: "late note" });
  expect(() => source.relinquish(input)).toThrow(expect.objectContaining({ code: "archive_stale", detail: { changed: ["qitem-a"], missing: [] } }));
  expect(db.prepare("SELECT record_id FROM queue_transfer_ledger").get()).toBeUndefined();
});

it("refuses claims and reopen on the fenced row but records a late terminal report", async () => {
  source.relinquish(snapshot());
  expect(() => repo.claim({ qitemId: "qitem-a", destinationSession: "b@old" })).toThrow(expect.objectContaining({ code: "qitem_fenced" }));
  expect(() => repo.unclaim("qitem-a", "b@old", "late")).toThrow(expect.objectContaining({ code: "qitem_fenced" }));
  expect(repo.listOpenObligations("b@old", 10).map(row => row.qitemId)).toEqual(["qitem-b"]);
  repo.update({ qitemId: "qitem-a", actorSession: "b@old", state: "done", closureReason: "no-follow-on" });
  expect(() => repo.update({ qitemId: "qitem-a", actorSession: "b@old", state: "pending", reopen: true, transitionNote: "retry" }))
    .toThrow(expect.objectContaining({ code: "qitem_fenced" }));
  expect(repo.claim({ qitemId: "qitem-b", destinationSession: "b@old" }).state).toBe("in-progress");
});

function activation(input: ReturnType<typeof snapshot>): TransferActivation {
  const archive = parseQueueTransfer(input.archiveText);
  const digest = mappingDigest([]);
  return { kind: ACTIVATION_KIND, status: "activated", replayed: false, operationId: "op", importId: "import-1",
    transferId: archive.transferId, archiveDigest: archive.digest, authorizationDigest: authorizationDigest(input.authorization),
    mappingDigest: digest, origin: archive.origin, destination: { hostId: "target", mappingDigest: digest },
    recordedAt: "4", actor: "operator", sourceState: "relinquished", method: "online-handshake",
    rows: { total: 1, created: 1, runnable: ["qitem-a"], projectedToPending: [], blocked: [], terminal: [], erased: [], remapped: [] },
    waits: { restoredContinuations: [], transferredBlocked: [] }, unresolvedContinuations: [], remainingOnSource: [], warnings: [],
    history: { transitionsImported: 0, wakeEvidenceImportedNotScheduled: 0, missionControlActionsImported: 0 } };
}

it.each([false, true])("reconciles a confirmed row without overwriting late reports (late=%s)", late => {
  const input = snapshot();
  const result = activation(input);
  expect(() => source.reconcile({ ...input, result })).toThrow(expect.objectContaining({ code: "not_relinquished" }));
  source.relinquish(input);
  if (late) repo.update({ qitemId: "qitem-a", actorSession: "b@old", state: "done", closureReason: "no-follow-on" });
  const report = source.reconcile({ ...input, result });
  expect(report).toMatchObject({ evacuation: late ? "incomplete" : "complete", rows: [{ qitemId: "qitem-a", outcome: late ? "late_report" : "superseded" }] });
  expect(repo.getById("qitem-a")).toMatchObject(late ? { state: "done" } : { state: "canceled", closureReason: "superseded", closureTarget: "qitem-a@target" });
  expect(source.reconcile({ ...input, result })).toEqual({ ...report, replayed: true });
  expect(() => repo.update({ qitemId: "qitem-a", actorSession: "b@old", state: "pending", reopen: true, transitionNote: "retry" })).toThrow(/fenced/);
});

it.each([false, true])("distinguishes the fence note from a same-millisecond terminal history write (late=%s)", late => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-02-03T04:05:06Z"));
  repo.update({ qitemId: "qitem-a", actorSession: "b@old", state: "done", closureReason: "no-follow-on" });
  const input = snapshot();
  const result = activation(input);
  source.relinquish(input);
  const row = db.prepare("SELECT * FROM queue_items WHERE qitem_id = 'qitem-a'");
  const before = row.get();
  if (late) repo.update({ qitemId: "qitem-a", actorSession: "b@old", state: "done", transitionNote: "late terminal note" });
  const report = source.reconcile({ ...input, result: { ...result, rows: { ...result.rows, runnable: [], terminal: ["qitem-a"] } } });
  expect(row.get()).toEqual(before);
  expect(report).toMatchObject({ evacuation: late ? "incomplete" : "complete",
    rows: [{ qitemId: "qitem-a", outcome: late ? "late_report" : "confirmed_history" }] });
  expect(report.lateReports).toEqual(late ? [{ qitemId: "qitem-a", currentState: "done",
    transitions: [expect.objectContaining({ transitionNote: "late terminal note" })] }] : []);
});

it("restores only the receipt's fence and reports incomplete status without a destination result", () => {
  const restored = new Database(":memory:");
  try {
    migrate(restored, ALL_MIGRATIONS);
    restored.exec("INSERT INTO self_host_identity VALUES (1, 'origin', 'minted', 'reconciled')");
    const { receipt } = source.relinquish(snapshot());
    if (!receipt) throw new Error("expected receipt");
    expect(replayTransfer(restored, receipt)).toMatchObject({ fenced: ["qitem-a"] });
    expect(replayTransfer(restored, receipt)).toMatchObject({ fenced: [] });
    expect(restored.prepare("SELECT qitem_id FROM queue_transfer_relinquished").pluck().all()).toEqual(["qitem-a"]);
    expect(restored.prepare("SELECT 1 FROM outbox_entries").get()).toBeUndefined();
    expect(transferStatus(restored, receipt.archiveDigest)).toMatchObject({ evacuation: "incomplete", transfers: [{ restriction: "scoped", destinationResult: "absent" }] });
    expect(transferStatus(restored, "0".repeat(64))).toMatchObject({ evacuation: "incomplete", transfers: [] });
  } finally {
    restored.close();
  }
});
