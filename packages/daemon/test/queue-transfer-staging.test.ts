import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { migrate } from "../src/db/migrate.js";
import { buildQueueTransfer } from "../src/domain/queue-transfer-export.js";
import { QUEUE_TRANSFER_MAX_BYTES, sealQueueTransfer } from "../src/domain/queue-transfer-format.js";
import type { QueueTransferObject } from "../src/domain/queue-transfer-format.js";
import { QueueTransferStaging } from "../src/domain/queue-transfer-staging.js";

let root: string;
let db: Database.Database;
let archive: string;
const work = `INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session,
  state, body, evidence_ref, reply_to) VALUES ('qitem-a', '1', '1', 'a@missing', 'b@demo',
  'pending', 'archive body', '/not/copied', 'qitem-outside');`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "openrig-stage-"));
  db = new Database(join(root, "destination.db"));
  migrate(db, ALL_MIGRATIONS);
  db.exec("INSERT INTO rigs (id, name) VALUES ('demo-id','demo')");
  const source = new Database(":memory:");
  try {
    migrate(source, ALL_MIGRATIONS);
    source.exec(`INSERT INTO self_host_identity VALUES (1, 'origin', 'minted', 'reconciled'); ${work}`);
    archive = buildQueueTransfer(source, { kind: "host" }).archive;
  } finally {
    source.close();
  }
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function noLiveWork() {
  for (const table of ["queue_items", "queue_transitions", "outbox_entries", "queue_transition_wakes", "mission_control_actions"]) {
    expect(db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get()).toBeUndefined();
  }
}

it("keeps a staged envelope inactive after reopening the migrated database", () => {
  const result = new QueueTransferStaging(db).import(archive);
  expect(result).toMatchObject({ status: "not_ready_for_activation", stage: { status: "staged", rowCount: 1 } });
  db.close();
  db = new Database(join(root, "destination.db"));
  migrate(db, ALL_MIGRATIONS);
  expect(new QueueTransferStaging(db).list()).toEqual([result.stage]);
  expect(db.prepare("SELECT envelope FROM queue_transfer_staging").get()).toEqual({ envelope: Buffer.from(archive) });
  noLiveWork();
});

it("returns the same manifest without rewriting it on an equivalent re-import", () => {
  const store = new QueueTransferStaging(db);
  const first = store.import(archive);
  expect(store.import(` \n${archive}\n`)).toMatchObject({ stage: first.stage, replayed: true });
  expect(store.list()).toHaveLength(1);
  noLiveWork();
});

it("discards the envelope without writing live state", () => {
  const store = new QueueTransferStaging(db);
  const { stage } = store.import(archive);
  if (!stage) throw new Error("test archive did not stage");
  expect(store.discard(stage.importId)).toMatchObject({ status: "discarded" });
  expect(db.prepare("SELECT envelope FROM queue_transfer_staging").get()).toEqual({ envelope: null });
  expect(store.import(archive)).toMatchObject({ stage: { status: "discarded" }, replayed: true });
  noLiveWork();
});

it("reviews the unbound destination without staging or enabling anything", () => {
  const store = new QueueTransferStaging(db);
  const before: unknown = db.prepare("SELECT total_changes() AS writes").get();
  const result = store.import(archive, { dryRun: true });
  expect(result).toMatchObject({ status: "not_ready_for_activation", stage: null,
    counts: { open: 1, terminal: 0, erased: 0 }, wouldBecomeRunnable: [] });
  expect(result.warnings.map(w => w.code)).toEqual(expect.arrayContaining([
    "destination_unbound", "unresolved_rig", "unresolved_seat", "missing_evidence", "dangling_reference",
  ]));
  expect(store.list()).toEqual([]);
  expect(db.prepare("SELECT total_changes() AS writes").get()).toEqual(before);
  noLiveWork();
});

it("counts terminal and scrubbed rows separately and does not project a blocked wait as runnable", () => {
  const source = new Database(":memory:");
  try {
    migrate(source, ALL_MIGRATIONS);
    source.exec(`INSERT INTO self_host_identity VALUES (1, 'origin', 'minted', 'reconciled');
      INSERT INTO queue_items (qitem_id, ts_created, ts_updated, source_session, destination_session,
        state, body, blocked_on, content_erased_at) VALUES
        ('qitem-wait', '1', '1', 'a@demo', 'b@demo', 'blocked', 'waiting', 'qitem-elsewhere', NULL),
        ('qitem-final', '1', '1', 'a@demo', 'b@demo', 'done', 'closed', NULL, NULL),
        ('qitem-scrubbed', '1', '1', 'a@demo', 'b@demo', 'done', 'scrub me', NULL, '2');`);
    const snapshot = buildQueueTransfer(source, { kind: "host" }).archive;
    const result = new QueueTransferStaging(db).import(snapshot);
    expect(result).toMatchObject({ status: "not_ready_for_activation", counts: { open: 1, terminal: 1, erased: 1 }, wouldBecomeRunnable: [] });
    expect(result.warnings).toContainEqual({ code: "dangling_reference", qitemId: "qitem-wait", reference: "qitem-elsewhere" });
    const saved = db.prepare<[], { envelope: Buffer }>("SELECT envelope FROM queue_transfer_staging").get();
    expect(saved?.envelope.toString()).not.toContain("scrub me");
    expect(saved?.envelope.toString()).toContain('"contentErasedAt":"2"');
    noLiveWork();
  } finally {
    source.close();
  }
});

it.each([
  ["format_unsupported", (file: string) => file.replace('"format":"openrig.queue-transfer/v2"', '"format":"openrig.queue-transfer/v3"')],
  ["digest_mismatch", (file: string) => file.replace("archive body", "changed body")],
  ["origin_identity_missing", (file: string) => file.replace('"hostId":"origin"', '"hostId":null')],
])("refuses %s before writing a stage", (code, alter) => {
  const store = new QueueTransferStaging(db);
  expect(store.import(alter(archive))).toMatchObject({ status: "rejected", refusals: [{ code }], stage: null });
  expect(store.list()).toEqual([]);
});

it("accepts a sealed v2 extension but refuses a digest-valid archive whose selection is missing", () => {
  const parsed: QueueTransferObject = JSON.parse(archive);
  const store = new QueueTransferStaging(db);
  const withExtension = sealQueueTransfer({ ...parsed, futureField: { optional: true } }, QUEUE_TRANSFER_MAX_BYTES);
  expect(store.import(withExtension, { dryRun: true })).toMatchObject({ status: "not_ready_for_activation" });
  const withoutSelection = sealQueueTransfer({ ...parsed, scope: null }, QUEUE_TRANSFER_MAX_BYTES);
  expect(store.import(withoutSelection)).toMatchObject({ status: "rejected", refusals: [{ code: "selection_not_shown" }] });
  expect(store.list()).toEqual([]);
});

it.each([
  ["qitem_id_collision", work],
  ["qitem_erased_at_destination", "INSERT INTO queue_erased_ids VALUES ('qitem-a','1','delete')"],
])("refuses %s without changing destination work", (code, seed) => {
  db.exec(seed);
  const store = new QueueTransferStaging(db);
  for (const dryRun of [true, false]) {
    expect(store.import(archive, { dryRun })).toMatchObject({ status: "rejected", refusals: expect.arrayContaining([{ code, qitemId: "qitem-a" }]) });
  }
  expect(store.list()).toEqual([]);
});
