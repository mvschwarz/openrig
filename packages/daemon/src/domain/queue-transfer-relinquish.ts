import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { isTerminalState, type QueueRepository, type QueueState } from "./queue-repository.js";
import { QUEUE_TRANSFER_COLUMNS, readQueueTransfer } from "./queue-transfer-export.js";
import { canonicalQueueJson } from "./queue-transfer-format.js";
import { mappingDigest } from "./queue-transfer-mapping.js";
import { assertAuthorization, assertTransferSchema, QueueTransferOperationError, transferSelection, type TransferActor } from "./queue-transfer-operation.js";
import { parseQueueTransfer } from "./queue-transfer-parse.js";
import { authorizationDigest, parseReceipt, RECEIPT_KIND, RECONCILIATION_KIND, recordDigest, rowsDigest, type TransferActivation, type TransferAuthorization, type TransferReceipt } from "./queue-transfer-records.js";
import { SelfHostIdentityStore } from "./seat-identity-store.js";
import { transferWireKey } from "./queue-transfer-write.js";
import type { QueueTransition } from "./queue-transition-log.js";

type RelinquishInput = { readonly archiveText: string; readonly authorization: TransferAuthorization;
  readonly intervention: string; readonly limits?: string; readonly actor: TransferActor; readonly dryRun?: boolean };

export function fenceNote(destinationHostId: string, transferId: string, archiveDigest: string): string {
  return `relinquished: ownership moved to ${destinationHostId} for transfer ${transferId} (archive ${archiveDigest.slice(0, 12)}); fenced: awaiting reconciliation`;
}

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
    if (missing.length || changed.length) throw new QueueTransferOperationError("archive_stale", 409, {
      changed, missing, next: "Re-export on the source, stage on the destination, then authorize the new digest." });
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
        transitionNote: fenceNote(destination.hostId, archive.transferId, archive.digest) });
      return { receipt, archiveCurrent: true, fenced: restricted, workflowState, replayed: false };
    }).immediate();
  }

  reconcile({ archiveText, result, actor }: { readonly archiveText: string; readonly result: TransferActivation; readonly actor: TransferActor }) {
    const db = this.repo.db;
    assertTransferSchema(db);
    const archive = parseQueueTransfer(archiveText);
    const host = new SelfHostIdentityStore(db).get();
    const destinationHostId = result.destination.hostId;
    if (host?.hostId !== archive.origin.hostId || host.mintedAt !== archive.origin.mintedAt || result.origin.hostId !== archive.origin.hostId ||
        result.origin.mintedAt !== archive.origin.mintedAt || result.archiveDigest !== archive.digest || result.transferId !== archive.transferId) {
      throw new QueueTransferOperationError("receipt_mismatch", 409);
    }
    const { replayed: _replayed, warnings, ...stableResult } = result;
    const resultDigest = recordDigest({ ...stableResult, warnings: warnings.map(({ code, qitemId, reference, message }) =>
      ({ code, qitemId: qitemId ?? null, reference: reference ?? null, message: message ?? null })) });
    const recordId = `rec-${recordDigest([result.operationId, destinationHostId])}`;
    return db.transaction(() => {
      const prior = db.prepare<[string, string], { id: string; auth: string; map: string; recordedAt: string }>(`SELECT record_id AS id,
        authorization_digest AS auth, mapping_digest AS map, recorded_at AS recordedAt FROM queue_transfer_ledger
        WHERE kind = 'relinquished' AND archive_digest = ? AND destination_host_id = ?`).get(archive.digest, destinationHostId);
      if (!prior) throw new QueueTransferOperationError("not_relinquished", 409);
      if (prior.auth !== result.authorizationDigest || prior.map !== result.mappingDigest || prior.map !== result.destination.mappingDigest ||
          result.sourceState !== "relinquished" || result.method !== "online-handshake") throw new QueueTransferOperationError("receipt_mismatch", 409);
      const existing = db.prepare<[string], { receipt: string; report: string }>(`SELECT receipt_json AS receipt, result_json AS report
        FROM queue_transfer_ledger WHERE record_id = ? AND kind = 'reconciled'`).get(recordId);
      if (existing) {
        if (existing.receipt !== resultDigest) throw new QueueTransferOperationError("receipt_mismatch", 409);
        const stored: unknown = JSON.parse(existing.report);
        return { ...parseReconciliation(stored), replayed: true };
      }
      const recordedAt = new Date().toISOString();
      // Activation writes EVERY non-erased archive row, so the destination holds a copy even when it
      // left the row pending (unresolved destination) or projected an in-progress row to pending without waking.
      const created = new Set(archive.rows.filter(row => !row.erased).map(row => row.qitemId));
      const erased = db.prepare<[string]>("SELECT 1 FROM queue_erased_ids WHERE qitem_id = ?");
      const fields = QUEUE_TRANSFER_COLUMNS.queue_items;
      const lookup = db.prepare<[string], Record<string, string | number | null> & { state: QueueState }>(`SELECT ${fields.join(",")} FROM queue_items WHERE qitem_id = ?`);
      const supersede = db.prepare(`UPDATE queue_items SET state = 'canceled', ts_updated = ?, closure_reason = 'superseded',
        closure_target = ?, blocked_on = NULL, closure_required_at = NULL WHERE qitem_id = ?`);
      const mark = db.prepare("UPDATE queue_transfer_relinquished SET reconciled_at = ?, reconcile_outcome = ? WHERE qitem_id = ? AND record_id = ?");
      const counts: Record<string, number> = {};
      const lateReports: { qitemId: string; currentState: QueueState; ownerItem?: string; transitions: QueueTransition[] }[] = [];
      const relinquishedNote = fenceNote(destinationHostId, archive.transferId, archive.digest);
      const rows = transferSelection(archive).map(({ qitemId, state }) => {
        const live = lookup.get(qitemId);
        const archived = archive.rows.find(row => row.qitemId === qitemId);
        let outcome: string;
        if (!live && erased.get(qitemId)) outcome = "confirmed_erased";
        else if (live && archived) {
          const archivedIds = new Set(archived.transitions.map(entry => entry.transitionId));
          const added = this.repo.transitionLog.listForQitem(qitemId).filter(entry => !archivedIds.has(entry.transitionId));
          // The fence append is ordered even when it shares a millisecond with a late report.
          // Replaying a portable receipt restores the fence without necessarily restoring its note.
          const fenceIndex = added.findIndex(entry => entry.transitionNote === relinquishedNote);
          const late = fenceIndex >= 0 ? added.slice(fenceIndex + 1) : added.filter(entry => entry.ts >= prior.recordedAt);
          if (late.length || fields.some(column => (live[column] ?? null) !== (archived.wire[transferWireKey(column)] ?? null))) {
            outcome = "late_report";
            lateReports.push({ qitemId, currentState: live.state, transitions: late,
              ...(created.has(qitemId) ? { ownerItem: `${qitemId}@${destinationHostId}` } : {}) });
          } else if (isTerminalState(state)) outcome = "confirmed_history";
          else if (created.has(qitemId)) {
            outcome = "superseded";
            const closureTarget = `${qitemId}@${destinationHostId}`;
            supersede.run(recordedAt, closureTarget, qitemId);
            this.repo.transitionLog.append({ ...actor, qitemId, state: "canceled", closureReason: "superseded", closureTarget,
              transitionNote: `superseded: transferred to ${destinationHostId} as ${qitemId} (operation ${result.operationId})` });
          } else outcome = !result.rows.erased.includes(qitemId) ? "unconfirmed" : "left_to_operator";
        } else outcome = !created.has(qitemId) && !result.rows.erased.includes(qitemId) ? "unconfirmed" : "left_to_operator";
        mark.run(recordedAt, outcome, qitemId, prior.id);
        counts[outcome] = (counts[outcome] ?? 0) + 1;
        return { qitemId, outcome, ...(live ? { currentState: outcome === "superseded" ? "canceled" : live.state } : {}) };
      });
      const selection = archive.selection;
      const selectedIds = new Set(selection.qitemIds);
      const scope = selection.kind === "host" ? { kind: "host" as const }
        : selection.kind === "rig" ? { kind: "rig" as const, names: selection.rigs }
        : selection.kind === "mission" ? { kind: "mission" as const, names: selection.missions }
        : selection.kind === "slice" ? { kind: "slice" as const, names: selection.slices } : null;
      const outsideArchive = scope ? readQueueTransfer(db, scope).scope.qitemIds.filter(id => !selectedIds.has(id)) : [];
      const evacuation = rows.every(row => ["confirmed_erased", "confirmed_history", "superseded"].includes(row.outcome)) ? "complete" : "incomplete";
      const report = { kind: RECONCILIATION_KIND, archiveDigest: archive.digest, destinationHostId, recordedAt, counts, rows, outsideArchive,
        lateReports, evacuation, replayed: false };
      db.prepare(`INSERT INTO queue_transfer_ledger (record_id, side, kind, transfer_id, archive_digest, origin_host_id, origin_minted_at,
        destination_host_id, import_id, authorization_digest, mapping_digest, actor, recorded_at, receipt_json, result_json)
        VALUES (?, 'origin', 'reconciled', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(recordId, archive.transferId, archive.digest,
        archive.origin.hostId, archive.origin.mintedAt, destinationHostId, result.importId, prior.auth, prior.map, actor.actorSession, recordedAt, resultDigest, JSON.stringify(report));
      return report;
    }).immediate();
  }
}

export function parseReconciliation(value: unknown) {
  if (!value || typeof value !== "object" || !("evacuation" in value) || !["complete", "incomplete"].includes(String(value.evacuation))) {
    throw new QueueTransferOperationError("reconciliation_record_invalid", 500);
  }
  return value;
}
