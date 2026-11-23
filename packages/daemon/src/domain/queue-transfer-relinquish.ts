import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { QueueRepository } from "./queue-repository.js";
import { readQueueTransfer } from "./queue-transfer-export.js";
import { canonicalQueueJson } from "./queue-transfer-format.js";
import { mappingDigest } from "./queue-transfer-mapping.js";
import { assertAuthorization, assertTransferSchema, QueueTransferOperationError, transferSelection, type TransferActor } from "./queue-transfer-operation.js";
import { parseQueueTransfer } from "./queue-transfer-parse.js";
import { authorizationDigest, parseReceipt, RECEIPT_KIND, rowsDigest, type TransferAuthorization, type TransferReceipt } from "./queue-transfer-records.js";
import { SelfHostIdentityStore } from "./seat-identity-store.js";

type RelinquishInput = { readonly archiveText: string; readonly authorization: TransferAuthorization;
  readonly intervention: string; readonly limits?: string; readonly actor: TransferActor; readonly dryRun?: boolean };

export function recordTransferFence(db: Database.Database, recordId: string, receipt: TransferReceipt): string[] {
  const insert = db.prepare(`INSERT INTO queue_transfer_relinquished (qitem_id, record_id, archive_digest, destination_host_id, source_state)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(qitem_id) DO NOTHING`);
  const retire = db.prepare(`UPDATE outbox_entries SET delivery_state = 'failed',
    tags = json_insert(COALESCE(tags, '[]'), '$[#]', 'queue:wake-superseded')
    WHERE delivery_state = 'pending' AND (outbox_id = 'wake-intent-' || ? OR (audit_pointer = ? AND outbox_id GLOB 'wake-intent-blocker-*'))`);
  return (receipt.selection ?? []).flatMap(({ qitemId, state }) => {
    if (state === "erased") return [];
    const added = insert.run(qitemId, recordId, receipt.archiveDigest, receipt.destination.hostId, state).changes;
    retire.run(qitemId, qitemId);
    return added ? [qitemId] : [];
  });
}

export function insertRelinquishment(db: Database.Database, receipt: TransferReceipt): string {
  const id = `rel-${randomUUID()}`;
  db.prepare(`INSERT INTO queue_transfer_ledger (record_id, side, kind, transfer_id, archive_digest, origin_host_id,
    origin_minted_at, destination_host_id, authorization_digest, mapping_digest, actor, recorded_at, receipt_json)
    VALUES (?, 'origin', 'relinquished', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, receipt.transferId, receipt.archiveDigest,
    receipt.origin.hostId, receipt.origin.mintedAt, receipt.destination.hostId, receipt.authorizationDigest,
    receipt.destination.mappingDigest, receipt.actor, receipt.recordedAt, JSON.stringify(receipt));
  return id;
}

export class QueueTransferSource {
  constructor(private readonly repo: QueueRepository) {}

  relinquish(input: RelinquishInput) {
    const db = this.repo.db;
    assertTransferSchema(db);
    const { authorization, intervention, actor, dryRun } = input;
    const archive = parseQueueTransfer(input.archiveText);
    const host = new SelfHostIdentityStore(db).get();
    if (host?.hostId !== archive.origin.hostId || host.mintedAt !== archive.origin.mintedAt) throw new QueueTransferOperationError("not_origin", 409);
    const destination = { hostId: authorization.destination.hostId, mappingDigest: mappingDigest(authorization.destination.seatMapping) };
    assertAuthorization(archive, authorization, destination.hostId);
    if (authorization.intervention.kind !== "online-handshake") throw new QueueTransferOperationError("authorization_mismatch", 409);
    if (!intervention.trim()) throw new QueueTransferOperationError("intervention_required", 400);
    const authDigest = authorizationDigest(authorization);
    return db.transaction(() => {
      const prior = db.prepare<[string, string], { receiptJson: string }>(`SELECT receipt_json AS receiptJson FROM queue_transfer_ledger
        WHERE kind = 'relinquished' AND archive_digest = ? AND destination_host_id = ?`).get(archive.digest, destination.hostId);
      if (prior) {
        const receipt = parseReceipt(JSON.parse(prior.receiptJson));
        if (receipt.authorizationDigest !== authDigest) throw new QueueTransferOperationError("already_relinquished", 409);
        return { receipt, replayed: true, archiveCurrent: true, fenced: receipt.selection?.filter(row => row.state !== "erased").map(row => row.qitemId) ?? [], workflowState: receipt.workflowState ?? [] };
      }
      const selection = transferSelection(archive);
      const ids = JSON.stringify(archive.selection.qitemIds);
      const missing = db.prepare<[string], string>(`SELECT value FROM json_each(?) WHERE value NOT IN (SELECT qitem_id FROM queue_items)
        AND value NOT IN (SELECT qitem_id FROM queue_erased_ids)`).pluck().all(ids);
      const present = archive.selection.qitemIds.filter(id => !missing.includes(id));
      const current = present.length ? readQueueTransfer(db, { kind: "qitems", names: present }) : { rows: [], erasedIds: [] };
      const byId = new Map(current.rows.map(row => [row.qitemId, canonicalQueueJson(row)]));
      for (const row of current.erasedIds) byId.set(String(row.qitemId), canonicalQueueJson(row));
      const changed = [...archive.rows.map(row => row.wire), ...archive.erasedIdRows].flatMap(row => {
        const id = String(row.qitemId);
        return byId.has(id) && byId.get(id) !== canonicalQueueJson(row) ? [id] : [];
      });
      if (missing.length || changed.length) throw new QueueTransferOperationError("archive_stale", 409, { changed, missing });
      const fenced = db.prepare<[string], string>("SELECT qitem_id FROM queue_transfer_relinquished WHERE qitem_id IN (SELECT value FROM json_each(?))").pluck().all(ids);
      if (fenced.length) throw new QueueTransferOperationError("already_relinquished", 409, { qitemIds: fenced });
      const workflowState = db.prepare<[string], { qitemId: string; instanceId: string }>(`WITH selected AS (SELECT value FROM json_each(?))
        SELECT packet_id AS qitemId, instance_id AS instanceId FROM workflow_frontier_bindings WHERE packet_id IN selected
        UNION SELECT next_qitem_id, instance_id FROM workflow_step_trails WHERE next_qitem_id IN selected
        UNION SELECT prior_qitem_id, instance_id FROM workflow_step_trails WHERE prior_qitem_id IN selected ORDER BY qitemId, instanceId`).all(ids);
      if (dryRun) return { archiveCurrent: true, fenced: [], workflowState, replayed: false };
      const receipt: TransferReceipt = { kind: RECEIPT_KIND, transferId: archive.transferId, archiveDigest: archive.digest, authorizationDigest: authDigest,
        origin: archive.origin, destination, sourceState: "relinquished", method: "online-handshake", intervention,
        limits: input.limits ?? authorization.intervention.limits, workflowState, recordedAt: new Date().toISOString(), actor: actor.actorSession,
        rowsDigest: rowsDigest(selection), selection, note: "Only daemon dispatch is restricted; running work must be stopped by the operator." };
      const recordId = insertRelinquishment(db, receipt);
      const restricted = recordTransferFence(db, recordId, receipt);
      for (const { qitemId, state } of archive.rows) this.repo.transitionLog.append({ ...actor, qitemId, state,
        transitionNote: `relinquished: ownership moved to ${destination.hostId} for transfer ${archive.transferId} (archive ${archive.digest.slice(0, 12)}); fenced: awaiting reconciliation` });
      return { receipt, archiveCurrent: true, fenced: restricted, workflowState, replayed: false };
    }).immediate();
  }
}
