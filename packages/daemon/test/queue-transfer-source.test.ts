import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { buildQueueTransfer } from "../src/domain/queue-transfer-export.js";
import { parseQueueTransfer } from "../src/domain/queue-transfer-parse.js";
import { AUTHORIZATION_KIND, parseAuthorization } from "../src/domain/queue-transfer-records.js";
import { QueueTransferSource } from "../src/domain/queue-transfer-relinquish.js";

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
afterEach(() => db.close());

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
