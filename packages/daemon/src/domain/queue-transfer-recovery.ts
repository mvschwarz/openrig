import type Database from "better-sqlite3";
import { assertTransferSchema, QueueTransferOperationError } from "./queue-transfer-operation.js";
import { parseQueueTransfer } from "./queue-transfer-parse.js";
import { RECEIPT_KIND, parseReceipt, rowsDigest, type TransferActivation, type TransferReceipt } from "./queue-transfer-records.js";
import { insertRelinquishment, parseReconciliation, recordTransferFence } from "./queue-transfer-relinquish.js";
import { SelfHostIdentityStore } from "./seat-identity-store.js";

export function replayTransfer(db: Database.Database, record: TransferReceipt | TransferActivation) {
  assertTransferSchema(db);
  const self = new SelfHostIdentityStore(db).get();
  if (record.kind !== RECEIPT_KIND) {
    if (self?.hostId !== record.destination.hostId) throw new QueueTransferOperationError("not_destination", 409);
    return verifyRestoredActivation(db, record);
  }
  if (self?.hostId !== record.origin.hostId || self.mintedAt !== record.origin.mintedAt) throw new QueueTransferOperationError("not_origin", 409);
  const selection = record.selection;
  if (!selection || rowsDigest(selection) !== record.rowsDigest || new Set(selection.map(row => row.qitemId)).size !== selection.length) {
    throw new QueueTransferOperationError("receipt_mismatch", 409);
  }
  return db.transaction(() => {
    const existing = db.prepare<[string, string], { id: string; receipt: string }>(`SELECT record_id AS id, receipt_json AS receipt
      FROM queue_transfer_ledger WHERE kind = 'relinquished' AND archive_digest = ? AND destination_host_id = ?`).get(record.archiveDigest, record.destination.hostId);
    if (existing && parseReceipt(JSON.parse(existing.receipt)).authorizationDigest !== record.authorizationDigest) throw new QueueTransferOperationError("already_relinquished", 409);
    const foreign = db.prepare<[string, string], string>(`SELECT qitem_id FROM queue_transfer_relinquished WHERE
      qitem_id IN (SELECT value FROM json_each(?)) AND record_id != ?`).pluck().all(JSON.stringify(selection.map(row => row.qitemId)), existing?.id ?? "");
    if (foreign.length) throw new QueueTransferOperationError("already_relinquished", 409, { qitemIds: foreign });
    const fenced = recordTransferFence(db, existing?.id ?? insertRelinquishment(db, record), record);
    return { fenced, replayed: !!existing };
  }).immediate();
}

function verifyRestoredActivation(db: Database.Database, record: TransferActivation) {
  const missingRows: string[] = [];
  const stateMismatch: string[] = [];
  const missingHistory: string[] = [];
  const stored = db.prepare<[string, string], Buffer>("SELECT envelope FROM queue_transfer_staging WHERE import_id = ? AND digest = ?").pluck().get(record.importId, record.archiveDigest);
  const archive = stored ? parseQueueTransfer(stored.toString("utf8")) : null;
  const history = db.prepare<[string, string], { originId: number | null; note: string | null }>(`SELECT o.origin_transition_id AS originId, t.transition_note AS note
    FROM (SELECT transition_id, qitem_id, transition_note FROM queue_transitions UNION ALL
    SELECT transition_id, qitem_id, transition_note FROM queue_transitions_archive) t
    LEFT JOIN queue_transfer_transition_origins o ON t.transition_id = o.transition_id AND o.record_id = ? WHERE t.qitem_id = ?`);
  const states = db.prepare<[string], string>("SELECT state FROM queue_items WHERE qitem_id = ?").pluck();
  const expected = new Map([...record.rows.runnable.map(id => [id, "pending"] as const),
    ...record.rows.projectedToPending.map(row => [row.qitemId, "pending"] as const), ...record.rows.blocked.map(row => [row.qitemId, "blocked"] as const)]);
  const sourceRows = new Map(archive?.rows.map(row => [row.qitemId, row]));
  for (const [id, state] of expected) {
    const current = states.get(id);
    if (current === undefined) missingRows.push(id);
    else if (current !== state) stateMismatch.push(id);
    const entries = history.all(record.operationId, id);
    const originIds = new Set(entries.map(row => row.originId));
    const archived = sourceRows.get(id);
    if (!archived || archived.transitions.some(row => typeof row.transitionId !== "number" || !originIds.has(row.transitionId)) ||
        !entries.some(row => row.originId === null && row.note?.startsWith(`activated from ${record.origin.hostId} (transfer ${record.transferId}, operation ${record.operationId});`))) missingHistory.push(id);
  }
  return { restore: archive && !missingRows.length && !stateMismatch.length && !missingHistory.length ? "complete" : "incomplete",
    missingRows, stateMismatch, missingHistory, ...(archive ? {} : { recordsUnavailable: true }) };
}

export function transferStatus(db: Database.Database, digest?: string) {
  assertTransferSchema(db);
  const records = db.prepare<[string | null, string | null], { id: string; archiveDigest: string; kind: string; actor: string; recordedAt: string;
    destinationHostId: string; receipt: string | null; result: string | null }>(`SELECT record_id AS id, archive_digest AS archiveDigest, kind, actor, recorded_at AS recordedAt,
      destination_host_id AS destinationHostId, receipt_json AS receipt, result_json AS result FROM queue_transfer_ledger
      WHERE (? IS NULL OR archive_digest = ?) ORDER BY recorded_at, record_id`).all(digest ?? null, digest ?? null);
  const groups = new Map<string, typeof records>();
  for (const record of records) {
    const key = JSON.stringify([record.archiveDigest, record.destinationHostId]);
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  const fence = db.prepare<[string], string>("SELECT qitem_id FROM queue_transfer_relinquished WHERE record_id = ? AND reconciled_at IS NULL ORDER BY qitem_id").pluck();
  const transfers = [...groups.values()].flatMap(group => {
    const first = group[0];
    if (!first) return [];
    const relinquished = group.find(row => row.kind === "relinquished");
    const result = group.filter(row => row.kind === "reconciled").at(-1)?.result;
    const reconciliation = result ? parseReconciliation(JSON.parse(result)) : null;
    const fenced = relinquished ? fence.all(relinquished.id) : [];
    return [{ archiveDigest: first.archiveDigest, destinationHostId: first.destinationHostId, snapshot: "known",
      intervention: relinquished?.receipt ? { actor: relinquished.actor, recordedAt: relinquished.recordedAt, method: parseReceipt(JSON.parse(relinquished.receipt)).method } : null,
      destinationResult: reconciliation ? "verified" : "absent", sourceReconciliation: reconciliation ? reconciliation.evacuation === "complete" ? "clean" : "has_unresolved" : "absent",
      restriction: fenced.length ? "scoped" : "none", fenced, evacuation: relinquished && reconciliation?.evacuation === "complete" && !fenced.length ? "complete" : "incomplete" }];
  });
  return { transfers, evacuation: transfers.length && transfers.every(row => row.evacuation === "complete") ? "complete" : "incomplete",
    ...(transfers.length ? {} : { recordsUnavailable: true }) };
}
