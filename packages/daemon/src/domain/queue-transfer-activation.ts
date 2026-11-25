import { OPENRIG_SENDER } from "../lib/pane-envelope.js";
import type { QueueRepository } from "./queue-repository.js";
import { QUEUE_TRANSFER_COLUMNS as columns } from "./queue-transfer-export.js";
import type { QueueTransferObject } from "./queue-transfer-format.js";
import { applyTransferMapping, mappingDigest, transferReadiness } from "./queue-transfer-mapping.js";
import { assertAuthorization, assertTransferSchema, QueueTransferOperationError, transferSelection, type TransferActor } from "./queue-transfer-operation.js";
import { parseQueueTransfer, QueueTransferParseError, type ParsedQueueTransfer } from "./queue-transfer-parse.js";
import { CONTINUATION_MARKER } from "./queue-transition-log.js";
import { ACTIVATION_KIND, authorizationDigest, parseActivationResult, rowsDigest, type TransferActivation, type TransferAuthorization, type TransferReceipt } from "./queue-transfer-records.js";
import { QueueTransferStaging } from "./queue-transfer-staging.js";
import { historyWriter, transferInsert } from "./queue-transfer-write.js";
import { transferRouteWarning } from "./queue-transfer-review.js";
import { SelfHostIdentityStore } from "./seat-identity-store.js";

type ActivationInput = {
  readonly importId: string;
  readonly authorization: TransferAuthorization;
  readonly receipt: TransferReceipt;
  readonly actor: TransferActor;
  readonly dryRun?: boolean;
};

export class QueueTransferActivation {
  constructor(private readonly repo: QueueRepository) {}

  activate(input: ActivationInput) {
    const db = this.repo.db;
    assertTransferSchema(db);
    const { importId, authorization, receipt, actor } = input;
    const { operationId } = authorization;
    const authDigest = authorizationDigest(authorization);
    const stages = new QueueTransferStaging(db);
    const prepare = db.transaction(() => {
      const stage = stages.manifest(importId);
      if (!stage) throw new QueueTransferOperationError("import_not_found", 404);
      if (stage.status === "discarded" || stage.status === "rejected") throw new QueueTransferOperationError("import_not_activatable", 409);
      const prior = db.prepare<[string, string], { recordId: string; archiveDigest: string; authDigest: string; importId: string | null; result: string | null }>(
        `SELECT record_id AS recordId, archive_digest AS archiveDigest, authorization_digest AS authDigest, import_id AS importId, result_json AS result
         FROM queue_transfer_ledger WHERE record_id = ? OR import_id = ? LIMIT 1`).get(operationId, importId);
      if (prior && (prior.recordId !== operationId || prior.importId !== importId || prior.archiveDigest !== stage.digest || prior.authDigest !== authDigest)) {
        throw new QueueTransferOperationError("already_activated", 409);
      }
      if (prior?.result) return { result: { ...parseActivationResult(JSON.parse(prior.result)), replayed: true } };
      if (stage.status === "activated") throw new QueueTransferOperationError("already_activated", 409);
      const bytes = db.prepare<[string], Buffer>("SELECT envelope FROM queue_transfer_staging WHERE import_id = ?").pluck().get(importId);
      let archive: ParsedQueueTransfer;
      try {
        archive = parseQueueTransfer(bytes?.toString("utf8") ?? "");
      } catch (error) {
        if (!(error instanceof QueueTransferParseError)) throw error;
        throw new QueueTransferOperationError("receipt_mismatch", 409);
      }
      if (archive.digest !== stage.digest) throw new QueueTransferOperationError("receipt_mismatch", 409);
      const hostId = new SelfHostIdentityStore(db).get()?.hostId;
      assertAuthorization(archive, authorization, hostId);
      const digest = mappingDigest(authorization.destination.seatMapping);
      if (receipt.transferId !== archive.transferId || receipt.archiveDigest !== archive.digest || receipt.authorizationDigest !== authDigest ||
          receipt.origin.hostId !== archive.origin.hostId || receipt.origin.mintedAt !== archive.origin.mintedAt ||
          receipt.destination.hostId !== hostId || receipt.destination.mappingDigest !== digest || receipt.rowsDigest !== rowsDigest(transferSelection(archive)) ||
          receipt.method !== authorization.intervention.kind || (receipt.selection && rowsDigest(receipt.selection) !== receipt.rowsDigest)) {
        throw new QueueTransferOperationError("receipt_mismatch", 409);
      }
      const review = transferReadiness(db, archive, authorization.destination.seatMapping);
      const rigDigest = db.prepare<[unknown], string>("SELECT members_digest FROM queue_erased_rigs WHERE rig_id = ?").pluck();
      for (const row of archive.erasedRigRows) {
        const existing = rigDigest.get(row.rigId);
        if (existing !== undefined && existing !== row.membersDigest) review.refusals.push({ code: "workspace_has_unrelated_conflict", reference: String(row.rigId) });
      }
      const refusal = review.refusals[0];
      if (refusal) throw new QueueTransferOperationError(refusal.code, 409, { refusals: review.refusals });
      if (review.unresolved.length) throw new QueueTransferOperationError("mapping_incomplete", 409, { qitemIds: review.unresolved });
      if (review.projectedRunnable.length && !this.repo.hasWakeIntentStore) throw new QueueTransferOperationError("wake_intent_store_unavailable", 500);
      const recordedAt = new Date().toISOString();
      if (!input.dryRun && !prior) db.prepare(`INSERT INTO queue_transfer_ledger (record_id, side, kind, transfer_id, archive_digest, origin_host_id,
        origin_minted_at, destination_host_id, import_id, authorization_digest, mapping_digest, actor, recorded_at, receipt_json)
        VALUES (?, 'destination', 'activating', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(operationId, archive.transferId, archive.digest,
        archive.origin.hostId, archive.origin.mintedAt, hostId, importId, authDigest, digest, actor.actorSession, recordedAt, JSON.stringify(receipt));
      return { archive, digest, review, recordedAt };
    });
    const prepared = input.dryRun ? prepare() : prepare.immediate();
    if ("result" in prepared) return prepared.result;
    const { archive, review, recordedAt, digest } = prepared;
    const warnings: TransferActivation["warnings"] = review.warnings.filter(w => !["destination_unbound", "missing_evidence", "evidence_not_checked"].includes(w.code));
    if (input.dryRun) return { status: "ready_for_activation" as const, importId, runnable: review.projectedRunnable, warnings };

    const result = db.transaction((): TransferActivation => {
      const current = stages.manifest(importId);
      if (current?.status !== "staged") throw new QueueTransferOperationError("import_not_activatable", 409);
      const liveReview = transferReadiness(db, archive, authorization.destination.seatMapping);
      const refusal = liveReview.refusals[0];
      if (refusal) throw new QueueTransferOperationError(refusal.code, 409, { refusals: liveReview.refusals });
      if (liveReview.unresolved.length) throw new QueueTransferOperationError("mapping_incomplete", 409, { qitemIds: liveReview.unresolved });
      const addRow = transferInsert(db, "queue_items", columns.queue_items);
      const addErasedId = transferInsert(db, "queue_erased_ids", columns.queue_erased_ids);
      const addErasedRig = transferInsert(db, "queue_erased_rigs", columns.queue_erased_rigs);
      const history = historyWriter(db, operationId, archive.origin);
      const runnable = new Set(liveReview.projectedRunnable);
      const rows: TransferActivation["rows"] = { total: archive.selection.qitemIds.length, created: archive.rows.length,
        runnable: [...runnable], projectedToPending: [], blocked: [], terminal: [], erased: [...archive.erasedIds], remapped: [] };
      const waits: TransferActivation["waits"] = { restoredContinuations: [], transferredBlocked: [] };
      const unresolvedContinuations: TransferActivation["unresolvedContinuations"] = [];
      const remainingOnSource: TransferActivation["remainingOnSource"] = (receipt.workflowState ?? []).map(({ qitemId, instanceId }) => ({ qitemId, kind: "workflow_state", detail: instanceId }));
      const active = new Set(archive.rows.filter(row => !row.erased && ["pending", "in-progress", "blocked"].includes(row.state)).map(row => row.qitemId));
      for (const archived of archive.rows) {
        const { qitemId } = archived;
        const wire: QueueTransferObject & { readonly qitemId: string } = { ...archived.wire, qitemId };
        const { row, remapped } = applyTransferMapping(wire, archive.origin.hostId, authorization.destination.seatMapping);
        const destinationSession = typeof row.destinationSession === "string" ? row.destinationSession : archived.destinationSession;
        const blockedOn = typeof row.blockedOn === "string" ? row.blockedOn : null;
        const projected = archived.state === "in-progress" && !archived.erased;
        const state = projected ? "pending" : archived.state;
        const disposition = authorization.dispositions?.find(entry => entry.qitemId === qitemId);
        const tags: unknown = typeof row["tags"] === "string" ? JSON.parse(row["tags"]) : [];
        addRow({ ...row, state, tsUpdated: recordedAt, tags: archived.erased ? null : JSON.stringify([...(Array.isArray(tags) ? tags : []), `transferred:${operationId}`]),
          lastNudgeAttempt: null, lastNudgeResult: null, lastHeartbeat: null, lastNudgeInputBox: null, mintingGenerationUuid: null,
          ...(projected ? { claimedAt: null, claimedByGenerationUuid: null, closureRequiredAt: null,
            body: `[queue-transfer] In progress at ${archive.origin.hostId}, held by ${archived.destinationSession}, when transferred (operation ${operationId}). Reconcile partial work at the origin before repeating it.\n\n${row["body"]}` } : {}),
          ...(archived.erased ? { body: "", summary: null, resolution: null, humanQuestions: null, humanAnswers: null, relayedAnswers: null, delegatedDecision: null } : {}) });
        history.write(archived);
        this.repo.transitionLog.append({ qitemId, state, ...actor, transitionNote: `activated from ${archive.origin.hostId} (transfer ${archive.transferId}, operation ${operationId}); was ${archived.state}${projected ? "; reconcile partial work before repeating" : ""}${disposition ? `; operator disposition: ${disposition.text}` : ""}` });
        if (runnable.has(qitemId)) this.repo.stageWakeIntent(qitemId, OPENRIG_SENDER, destinationSession, actor.identityProvenance ?? null, true, "openrig");
        if (projected) rows.projectedToPending.push({ qitemId, previouslyClaimedBy: archived.destinationSession });
        rows.remapped.push(...remapped);
        if (archived.erased) rows.erased.push(qitemId);
        else if (state === "blocked") {
          const lastArm = archived.wakes.filter(w => w.phase === "armed").at(-1);
          const localBlocker = blockedOn?.startsWith("qitem-") && !blockedOn.includes("@") && (active.has(blockedOn) ||
            db.prepare("SELECT 1 FROM queue_items WHERE qitem_id = ? AND state IN ('pending','in-progress','blocked') AND content_erased_at IS NULL").get(blockedOn));
          const localSeat = blockedOn && !transferRouteWarning(db, blockedOn);
          const restored = !!disposition || ((localBlocker || localSeat) && lastArm?.wakeKind !== "watchdog" && lastArm?.wakeKind !== "timer");
          rows.blocked.push({ qitemId, blockedOn, wait: restored ? "restored_continuation" : "transferred_blocked" });
          (restored ? waits.restoredContinuations : waits.transferredBlocked).push(qitemId);
          if (restored) {
            const newestFirst = [...archived.transitions].sort((a, b) => Number(b.transitionId) - Number(a.transitionId));
            for (const entry of newestFirst) {
              if (entry.state !== "blocked") break;
              if (typeof entry.transitionNote === "string" && entry.transitionNote.startsWith(CONTINUATION_MARKER)) {
                this.repo.transitionLog.append({ qitemId, state, ...actor, transitionNote: entry.transitionNote });
                break;
              }
            }
          } else {
            warnings.push({ qitemId, code: "wait_without_continuation" });
            unresolvedContinuations.push({ qitemId, kind: "blocked_wait", detail: blockedOn ?? "" });
          }
        } else if (state !== "pending") rows.terminal.push(qitemId);
        for (const [kind, address] of [["return_route", row.returnRoute], ["dependency_route", blockedOn],
          ["open_human_question", row["humanQuestions"] && (state === "pending" || state === "blocked") ? destinationSession : null]] as const) {
          if (typeof address !== "string" || !address.includes("@")) continue;
          if (transferRouteWarning(db, address)) unresolvedContinuations.push({ qitemId, kind, detail: address });
          if (kind !== "dependency_route" && address.endsWith(`@${archive.origin.hostId}`)) remainingOnSource.push({ qitemId, kind, detail: address });
        }
      }
      for (const row of archive.erasedIdRows) addErasedId(row);
      for (const row of archive.erasedRigRows) {
        const existing = db.prepare<[unknown], string>("SELECT members_digest FROM queue_erased_rigs WHERE rig_id = ?").pluck().get(row.rigId);
        if (existing === undefined) addErasedRig(row);
        else if (existing !== row.membersDigest) throw new QueueTransferOperationError("workspace_has_unrelated_conflict", 409);
      }
      const activated: TransferActivation = { kind: ACTIVATION_KIND, status: "activated", replayed: false, operationId, importId,
        transferId: archive.transferId, archiveDigest: archive.digest, authorizationDigest: authDigest, mappingDigest: digest, origin: archive.origin,
        destination: receipt.destination, recordedAt, actor: actor.actorSession, sourceState: receipt.sourceState, method: receipt.method,
        rows, waits, unresolvedContinuations, remainingOnSource, history: history.stats, warnings };
      db.prepare("UPDATE queue_transfer_ledger SET kind = 'activated', result_json = ? WHERE record_id = ?").run(JSON.stringify(activated), operationId);
      stages.markActivated(importId, recordedAt);
      return activated;
    }).immediate();
    this.repo.deliverWakeIntentsAfterCommit(result.rows.runnable.map(id => `wake-intent-${id}`));
    return result;
  }
}
