import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { EventBus } from "../src/domain/event-bus.js";
import { OutboxHandler } from "../src/domain/outbox-handler.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { QueueTransferActivation } from "../src/domain/queue-transfer-activation.js";
import { buildQueueTransfer } from "../src/domain/queue-transfer-export.js";
import { mappingDigest } from "../src/domain/queue-transfer-mapping.js";
import { transferSelection } from "../src/domain/queue-transfer-operation.js";
import { parseQueueTransfer } from "../src/domain/queue-transfer-parse.js";
import { AUTHORIZATION_KIND, RECEIPT_KIND, authorizationDigest, parseAuthorization, parseReceipt, rowsDigest } from "../src/domain/queue-transfer-records.js";
import { QueueTransferStaging } from "../src/domain/queue-transfer-staging.js";
import { QueueTransitionLog } from "../src/domain/queue-transition-log.js";
import { QueueWakeRepository } from "../src/domain/queue-wake-repository.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";
import { replayTransfer } from "../src/domain/queue-transfer-recovery.js";

let source: Database.Database;
let db: Database.Database;
let service: QueueTransferActivation;
beforeEach(() => {
  source = new Database(":memory:");
  db = new Database(":memory:");
  for (const store of [source, db]) migrate(store, ALL_MIGRATIONS);
  source.exec("INSERT INTO self_host_identity VALUES (1, 'origin', 'minted', 'reconciled')");
  db.exec("INSERT INTO self_host_identity VALUES (1, 'target', 'minted', 'reconciled')");
  service = new QueueTransferActivation(new QueueRepository(db, new EventBus(db)));
});
afterEach(() => { source.close(); db.close(); });

function stage(state: string, scrubbed = false, history = "", blockedOn: string | null = null) {
  source.prepare(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body, content_erased_at, blocked_on)
    VALUES ('qitem-a', '1', '1', 'a@old', 'b@old', ?, 'secret', ?, ?)`).run(state, scrubbed ? "2" : null, blockedOn);
  source.exec(history);
  const { archive } = buildQueueTransfer(source, { kind: "host" });
  const manifest = new QueueTransferStaging(db).import(archive).stage;
  if (!manifest) throw new Error("expected staged import");
  const parsed = parseQueueTransfer(archive);
  const seatMapping = [{ from: "b@old", to: "daemon@kernel" }];
  const authorization = parseAuthorization({ kind: AUTHORIZATION_KIND, operationId: "op", archiveDigest: parsed.digest, origin: parsed.origin,
    destination: { hostId: "target", authorizedAt: "3", seatMapping }, intervention: { kind: "operator-attestation", actor: "operator", recordedAt: "3", limits: "offline" } });
  const receipt = parseReceipt({ kind: RECEIPT_KIND, transferId: parsed.transferId, archiveDigest: parsed.digest,
    origin: parsed.origin, destination: { hostId: "target", mappingDigest: mappingDigest(seatMapping) }, sourceState: "isolated",
    method: "operator-attestation", intervention: "power removed", limits: "offline", actor: "operator", recordedAt: "3",
    rowsDigest: rowsDigest(transferSelection(parsed)), authorizationDigest: authorizationDigest(authorization), note: "" });
  return { importId: manifest.importId, authorization, receipt, actor: { actorSession: "operator" } };
}

it("commits terminal history once and returns the recorded result on exact retry", () => {
  const input = stage("done");
  const result = service.activate(input);
  expect(result).toMatchObject({ status: "activated", rows: { terminal: ["qitem-a"], runnable: [] } });
  expect(service.activate(input)).toEqual({ ...result, replayed: true });
  expect(db.prepare("SELECT count(*) AS count FROM queue_transitions").get()).toEqual({ count: 1 });
});

it("imports an empty scrubbed marker and refuses an ID erased after staging", () => {
  const input = stage("done", true);
  db.exec("INSERT INTO queue_erased_ids (qitem_id, erased_at, reason) VALUES ('qitem-a', '4', 'erased')");
  expect(() => service.activate(input)).toThrow(expect.objectContaining({ code: "qitem_erased_at_destination" }));
  db.exec("DELETE FROM queue_erased_ids");
  service.activate(input);
  expect(db.prepare("SELECT body, content_erased_at FROM queue_items").get()).toEqual({ body: "", content_erased_at: "2" });
});

it("rolls back a failed activation write and resumes the activating record", () => {
  const input = stage("blocked");
  db.exec("CREATE TRIGGER interrupt_activation BEFORE INSERT ON queue_transitions BEGIN SELECT RAISE(ABORT, 'interrupted'); END");
  expect(() => service.activate(input)).toThrow(/interrupted/);
  expect(db.prepare("SELECT kind FROM queue_transfer_ledger").get()).toEqual({ kind: "activating" });
  expect(db.prepare("SELECT qitem_id FROM queue_items").get()).toBeUndefined();
  db.exec("DROP TRIGGER interrupt_activation");
  expect(service.activate(input)).toMatchObject({ status: "activated", rows: { blocked: [{ qitemId: "qitem-a" }], runnable: [] } });
});

it("fails closed before recording activation when runnable work has no wake store", () => {
  const input = stage("in-progress");
  expect(() => service.activate(input)).toThrow(expect.objectContaining({ code: "wake_intent_store_unavailable" }));
  expect(db.prepare("SELECT record_id FROM queue_transfer_ledger").get()).toBeUndefined();
});

it("activates a resolvable item beside an unresolved destination without rerouting", () => {
  const repo = new QueueRepository(db, new EventBus(db));
  repo.attachOutbox(new OutboxHandler(db));
  const input = stage("pending", false, `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body)
    VALUES ('qitem-b', '1', '1', 'a@old', 'worker@unknown', 'pending', 'unresolved')`);
  expect(new QueueTransferActivation(repo).activate(input)).toMatchObject({ status: "activated",
    rows: { created: 2, runnable: ["qitem-a"] }, warnings: expect.arrayContaining([{ qitemId: "qitem-b", code: "unresolved_rig", reference: "worker@unknown" }]) });
  expect(repo.getById("qitem-b")).toMatchObject({ state: "pending", destinationSession: "worker@unknown" });
  expect(db.prepare("SELECT 1 FROM outbox_entries WHERE outbox_id = 'wake-intent-qitem-b'").get()).toBeUndefined();
});

it("shows imported actions and transitions as history but not as local receipts or activity", () => {
  const input = stage("blocked", false, `INSERT INTO queue_transitions (transition_id, qitem_id, ts, state, actor_session, transition_note, owner_notification_level)
    VALUES (49, 'qitem-a', '1', 'pending', 'a@old', NULL, NULL),
           (50, 'qitem-a', '2', 'in-progress', 'a@old', 'relay-owner-notification-accepted notification_key=source-key', 'NOTICE'),
           (51, 'qitem-a', '3', 'failed', 'a@old', NULL, NULL);
    INSERT INTO mission_control_actions (action_id, action_verb, qitem_id, actor_session, acted_at, audit_notes_json)
    VALUES ('action-a', 'approve', 'qitem-a', 'a@old', '1', '{"operation":"source-op"}');`);
  service.activate(input);
  const log = new QueueTransitionLog(db);
  expect(log.listForQitem("qitem-a")).toContainEqual(expect.objectContaining({ importedFrom: { hostId: "origin", mintedAt: "minted", transitionId: 50 } }));
  const local = log.append({ qitemId: "qitem-a", state: "done", closureReason: "no-follow-on", actorSession: "local@old" });
  expect(log.listRecentForRig("old").map(row => row.transitionId)).toEqual([local.transitionId]);
  expect(log.hasRelayOwnerNotificationReceipt("qitem-a", "source-key")).toBe(false);
  expect(log.activeOwnerNotificationEpisodes()).toEqual([]);
  const actions = new MissionControlActionLog(db);
  expect(actions.listForQitem("qitem-a")).toMatchObject([{ importedFrom: "origin/minted" }]);
  expect(actions.findOperation("qitem-a", "source-op")).toBeNull();
});

it.each([false, true])("keeps source timer evidence as history without a local timer (fired=%s)", fired => {
  const input = stage("blocked", false, `INSERT INTO queue_transitions (transition_id, qitem_id, ts, state, actor_session)
    VALUES (50, 'qitem-a', '1', 'blocked', 'a@old'), (51, 'qitem-a', '2', 'blocked', 'a@old');
    INSERT INTO queue_transition_wakes VALUES (50, 'qitem-a', 'armed', 'timer', 'source-timer', NULL);
    ${fired ? "INSERT INTO queue_transition_wakes VALUES (51, 'qitem-a', 'fired', 'timer', 'source-timer', 'delivered');" : ""}`);
  expect(service.activate(input)).toMatchObject({ history: { wakeEvidenceImportedNotScheduled: fired ? 2 : 1 } });
  const log = new QueueTransitionLog(db);
  const wakes = new QueueWakeRepository(db);
  expect(log.listForQitem("qitem-a").flatMap(row => wakes.getForTransition(row.transitionId)?.phase ?? [])).toEqual(fired ? ["armed", "fired"] : ["armed"]);
  expect(db.prepare("SELECT 1 FROM watchdog_jobs").get()).toBeUndefined();
  expect(wakes.getStatus("qitem-a")).toBeNull();
  expect(wakes.findQitemsByGeneratedTimer("source-timer")).toEqual([]);
});

it.each(["continuation: inspect the result", "no current plan"])("keeps only the current imported park plan (%s) when restoring a wait", note => {
  db.exec(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body)
    VALUES ('qitem-blocker', '1', '1', 'a@old', 'b@old', 'pending', 'blocker')`);
  const input = stage("blocked", false, `INSERT INTO queue_transitions (transition_id, qitem_id, ts, state, actor_session, transition_note)
    VALUES (48, 'qitem-a', '1', 'blocked', 'b@old', 'continuation: stale plan'),
           (49, 'qitem-a', '2', 'in-progress', 'b@old', NULL),
           (50, 'qitem-a', '3', 'blocked', 'b@old', '${note}')`, "qitem-blocker");
  expect(service.activate(input)).toMatchObject({ waits: { restoredContinuations: ["qitem-a"] } });
  const log = new QueueTransitionLog(db);
  expect(log.listForQitem("qitem-a")).toContainEqual(expect.objectContaining({ transitionNote: note,
    importedFrom: { hostId: "origin", mintedAt: "minted", transitionId: 50 } }));
  expect(log.currentParkContinuation("qitem-a")).toBe(note.startsWith("continuation:") ? "inspect the result" : null);
});

it.each(["blocked", "done"])("reports a missing restored %s row without reconstructing work", state => {
  const result = service.activate(stage(state));
  if (result?.status !== "activated") throw new Error("expected activation");
  expect(replayTransfer(db, result)).toMatchObject({ restore: "complete" });
  db.exec("DELETE FROM queue_items WHERE qitem_id = 'qitem-a'");
  expect(replayTransfer(db, result)).toMatchObject({ restore: "incomplete", missingRows: ["qitem-a"] });
  expect(db.prepare("SELECT 1 FROM queue_items").get()).toBeUndefined();
});

it("reports a missing restored erased-ID marker without recreating it", () => {
  const result = service.activate(stage("done", false, `INSERT INTO queue_erased_ids (qitem_id, erased_at, reason) VALUES ('qitem-erased', '2', 'erased')`));
  if (result?.status !== "activated") throw new Error("expected activation");
  expect(replayTransfer(db, result)).toMatchObject({ restore: "complete" });
  db.exec("DELETE FROM queue_erased_ids WHERE qitem_id = 'qitem-erased'");
  expect(replayTransfer(db, result)).toMatchObject({ restore: "incomplete", missingRows: ["qitem-erased"] });
  expect(db.prepare("SELECT 1 FROM queue_erased_ids").get()).toBeUndefined();
});

it.each(["queue_transitions", "queue_transition_wakes", "mission_control_actions"])("reports missing imported %s without rebuilding it", table => {
  const result = service.activate(stage("done", false, `INSERT INTO queue_transitions (transition_id, qitem_id, ts, state, actor_session)
    VALUES (50, 'qitem-a', '1', 'blocked', 'a@old');
    INSERT INTO queue_transition_wakes VALUES (50, 'qitem-a', 'armed', 'timer', 'source-timer', NULL);
    INSERT INTO mission_control_actions (action_id, action_verb, qitem_id, actor_session, acted_at, audit_notes_json)
    VALUES ('action-a', 'approve', 'qitem-a', 'a@old', '1', '{}');`));
  if (result?.status !== "activated") throw new Error("expected activation");
  expect(replayTransfer(db, result)).toMatchObject({ restore: "complete" });
  const where = table === "queue_transitions" ? " WHERE transition_id IN (SELECT transition_id FROM queue_transfer_transition_origins)" : "";
  db.exec(`DELETE FROM ${table}${where}`);
  expect(replayTransfer(db, result)).toMatchObject({ restore: "incomplete", missingHistory: ["qitem-a"] });
  expect(db.prepare(`SELECT 1 FROM ${table}${where}`).get()).toBeUndefined();
});
