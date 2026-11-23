import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { QueueTransferActivation } from "../src/domain/queue-transfer-activation.js";
import { buildQueueTransfer } from "../src/domain/queue-transfer-export.js";
import { mappingDigest } from "../src/domain/queue-transfer-mapping.js";
import { parseQueueTransfer } from "../src/domain/queue-transfer-parse.js";
import { AUTHORIZATION_KIND, RECEIPT_KIND, authorizationDigest, parseAuthorization, parseReceipt, rowsDigest } from "../src/domain/queue-transfer-records.js";
import { QueueTransferStaging } from "../src/domain/queue-transfer-staging.js";
import { QueueTransitionLog } from "../src/domain/queue-transition-log.js";
import { MissionControlActionLog } from "../src/domain/mission-control/mission-control-action-log.js";

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

function stage(state: string, scrubbed = false, history = "") {
  source.prepare(`INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session, state, body, content_erased_at)
    VALUES ('qitem-a', '1', '1', 'a@old', 'b@old', ?, 'secret', ?)`).run(state, scrubbed ? "2" : null);
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
    rowsDigest: rowsDigest(parsed.rows), authorizationDigest: authorizationDigest(authorization), note: "" });
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

it("shows imported actions and transitions as history but not as local receipts or activity", () => {
  const input = stage("blocked", false, `INSERT INTO queue_transitions (transition_id, qitem_id, ts, state, actor_session, transition_note, owner_notification_level)
    VALUES (50, 'qitem-a', '1', 'in-progress', 'a@old', 'relay-owner-notification-accepted notification_key=source-key', 'NOTICE');
    INSERT INTO mission_control_actions (action_id, action_verb, qitem_id, actor_session, acted_at, audit_notes_json)
    VALUES ('action-a', 'approve', 'qitem-a', 'a@old', '1', '{"operation":"source-op"}');`);
  service.activate(input);
  const log = new QueueTransitionLog(db);
  expect(log.listForQitem("qitem-a")[0]).toMatchObject({ importedFrom: { hostId: "origin", mintedAt: "minted", transitionId: 50 } });
  expect(log.listRecentForRig("old").some(row => row.actorSession === "a@old")).toBe(false);
  expect(log.hasRelayOwnerNotificationReceipt("qitem-a", "source-key")).toBe(false);
  expect(log.activeOwnerNotificationEpisodes()).toEqual([]);
  const actions = new MissionControlActionLog(db);
  expect(actions.listForQitem("qitem-a")).toMatchObject([{ importedFrom: "origin/minted" }]);
  expect(actions.findOperation("qitem-a", "source-op")).toBeNull();
});
