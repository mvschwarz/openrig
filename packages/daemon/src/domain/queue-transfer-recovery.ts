import type Database from "better-sqlite3";
import { assertTransferSchema, QueueTransferOperationError } from "./queue-transfer-operation.js";
import { isTransferObject, parseQueueTransfer } from "./queue-transfer-parse.js";
import { RECEIPT_KIND, parseReceipt, rowsDigest, type TransferActivation, type TransferReceipt } from "./queue-transfer-records.js";
import { fenceNote, insertRelinquishment, parseReconciliation, recordTransferFence } from "./queue-transfer-relinquish.js";
import { QueueTransitionLog } from "./queue-transition-log.js";
import type { QueueState } from "./queue-repository.js";
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
  const history = db.prepare<[string, string], { originId: number | null; note: string | null; wakeId: number | null }>(`SELECT o.origin_transition_id AS originId, t.transition_note AS note, w.transition_id AS wakeId
    FROM (SELECT transition_id, qitem_id, transition_note FROM queue_transitions UNION ALL
    SELECT transition_id, qitem_id, transition_note FROM queue_transitions_archive) t
    LEFT JOIN queue_transfer_transition_origins o ON t.transition_id = o.transition_id AND o.record_id = ?
    LEFT JOIN queue_transition_wakes w ON w.transition_id = t.transition_id AND w.qitem_id = t.qitem_id WHERE t.qitem_id = ?`);
  const states = db.prepare<[string], { state: string; erased: string | null }>("SELECT state, content_erased_at AS erased FROM queue_items WHERE qitem_id = ?");
  const expected = new Map([...record.rows.runnable.map(id => [id, "pending"] as const),
    ...record.rows.projectedToPending.map(row => [row.qitemId, "pending"] as const), ...record.rows.blocked.map(row => [row.qitemId, "blocked"] as const)]);
  const sourceRows = new Map(archive?.rows.map(row => [row.qitemId, row]));
  const ids = new Set([...expected.keys(), ...record.rows.terminal, ...sourceRows.keys()]);
  const actionExists = db.prepare("SELECT 1 FROM mission_control_actions WHERE qitem_id = ? AND action_id = ? AND imported_from = ?");
  for (const id of ids) {
    const archived = sourceRows.get(id);
    const state = expected.get(id) ?? (archived?.state === "in-progress" && !archived.erased ? "pending" : archived?.state);
    const current = states.get(id);
    if (current === undefined) missingRows.push(id);
    else if ((state !== undefined && current.state !== state) || (archived?.erased && current.erased === null)) stateMismatch.push(id);
    const entries = history.all(record.operationId, id);
    const origins = new Map(entries.map(row => [row.originId, row]));
    if (!archived || archived.transitions.some(row => typeof row.transitionId !== "number" || !origins.has(row.transitionId)) ||
        archived.wakes.some(row => typeof row.transitionId !== "number" || origins.get(row.transitionId)?.wakeId == null) ||
        archived.actions.some(row => !actionExists.get(id, row.actionId, `${record.origin.hostId}/${record.origin.mintedAt}`)) ||
        !entries.some(row => row.originId === null && row.note?.startsWith(`activated from ${record.origin.hostId} (transfer ${record.transferId}, operation ${record.operationId});`))) missingHistory.push(id);
  }
  const erasedId = db.prepare("SELECT 1 FROM queue_erased_ids WHERE qitem_id = ?");
  for (const id of new Set([...(archive?.erasedIds ?? []), ...record.rows.erased.filter(id => !sourceRows.has(id))])) {
    if (!erasedId.get(id) && !missingRows.includes(id)) missingRows.push(id);
  }
  const erasedRig = db.prepare("SELECT 1 FROM queue_erased_rigs WHERE rig_id = ? AND members_digest = ?");
  const missingErasedRigs = (archive?.erasedRigRows ?? []).filter(row => !erasedRig.get(row.rigId, row.membersDigest)).map(row => row.rigId);
  return { restore: archive && !missingRows.length && !stateMismatch.length && !missingHistory.length && !missingErasedRigs.length ? "complete" : "incomplete",
    missingRows, stateMismatch, missingHistory, missingErasedRigs, ...(archive ? {} : { recordsUnavailable: true }) };
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
  const fence = db.prepare<[string], { id: string; reconciledAt: string | null; outcome: string | null }>(`SELECT qitem_id AS id,
    reconciled_at AS reconciledAt, reconcile_outcome AS outcome
    FROM queue_transfer_relinquished WHERE record_id = ? ORDER BY qitem_id`);
  const history = new QueueTransitionLog(db);
  const liveState = db.prepare<[string], QueueState>(`SELECT state FROM queue_items WHERE qitem_id = ? AND content_erased_at IS NULL`).pluck();
  const transfers = [...groups.values()].flatMap(group => {
    const first = group[0];
    if (!first) return [];
    const relinquished = group.find(row => row.kind === "relinquished");
    const result = group.filter(row => row.kind === "reconciled").at(-1)?.result;
    const reconciliation = result ? parseReconciliation(JSON.parse(result)) : null;
    const fences = relinquished ? fence.all(relinquished.id) : [];
    const fenced = fences.map(row => row.id);
    const reconciliationOwed = fences.filter(row => row.reconciledAt === null).map(row => row.id);
    const receipt = relinquished?.receipt ? parseReceipt(JSON.parse(relinquished.receipt)) : null;
    const priorReports = reconciliation && "lateReports" in reconciliation && Array.isArray(reconciliation.lateReports) ? reconciliation.lateReports : [];
    const priorById = new Map(priorReports.filter(isTransferObject).map(row => [row.qitemId, row]));
    const postReconciliationLateReports = receipt && reconciliation ? fences.flatMap(({ id, reconciledAt, outcome }) => {
      if (!reconciledAt) return [];
      const currentState = liveState.get(id);
      if (!currentState) return [];
      const prior = priorById.get(id);
      const reported = new Set(Array.isArray(prior?.transitions) ? prior.transitions.filter(isTransferObject).map(row => row.transitionId) : []);
      const pointer = `${id}@${first.destinationHostId}`;
      const ownerItem = outcome === "superseded" || outcome === "confirmed_history" || prior?.ownerItem === pointer ? pointer : undefined;
      const entries = history.listForQitem(id).filter(entry => !entry.importedFrom);
      const fencedAt = entries.findIndex(entry => entry.transitionNote === fenceNote(first.destinationHostId, receipt.transferId, first.archiveDigest));
      const afterFence = entries.slice(fencedAt + 1);
      // The supersession transition orders same-millisecond writes without relying on the clock.
      const closedAt = outcome === "superseded" ? afterFence.findIndex(entry => entry.closureReason === "superseded" && entry.closureTarget === pointer) : -1;
      const transitions = closedAt >= 0 ? afterFence.slice(closedAt + 1)
        : afterFence.filter(entry => entry.ts >= reconciledAt && !reported.has(entry.transitionId));
      return transitions.length ? [{ qitemId: id, currentState, ownerItem, transitions }] : [];
    }) : [];
    return [{ archiveDigest: first.archiveDigest, destinationHostId: first.destinationHostId, snapshot: "known",
      intervention: relinquished && receipt ? { actor: relinquished.actor, recordedAt: relinquished.recordedAt, method: receipt.method } : null,
      destinationResult: reconciliation ? "verified" : "absent", sourceReconciliation: reconciliation ? reconciliation.evacuation === "complete" ? "clean" : "has_unresolved" : "absent",
      restriction: fenced.length ? "scoped" : "none", fenced, reconciliationOwed,
      ...(postReconciliationLateReports.length ? { postReconciliationLateReports } : {}),
      evacuation: relinquished && reconciliation?.evacuation === "complete" && !reconciliationOwed.length ? "complete" : "incomplete" }];
  });
  return { transfers, evacuation: transfers.length && transfers.every(row => row.evacuation === "complete") ? "complete" : "incomplete",
    ...(transfers.length ? {} : { recordsUnavailable: true }) };
}
