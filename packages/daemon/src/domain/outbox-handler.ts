import { createHash } from "node:crypto";
import type { ExpectedConversation } from "./expected-conversation.js";
import type Database from "better-sqlite3";

/**
 * The EXECUTABLE wake-intent namespace. A durable wake intent is written by the
 * daemon (QueueRepository.stageWakeIntent) with an id under this prefix, and the
 * startup drain EXECUTES every pending row under it as a real wake.
 *
 * NOT a route reservation: the public `/outbox/record` audit route no longer
 * refuses caller-supplied ids under this prefix (the W4-era MF5 guard was unbuilt —
 * founder ruling, over-engineering audit: its justification required an adversary
 * inside this trust domain, where the only caller is the daemon's own localhost
 * client). A caller CAN now record an id under this prefix and the drain will
 * select it. Single source of truth for the drain query only.
 */
export const WAKE_INTENT_PREFIX = "wake-intent-";
/** The sender a watchdog's reminders carry; their audit pointer is the job. */
const WATCHDOG_SENDER = "watchdog@system";
/** Who a coalesced held message records as having retired it (#2430). */
export const COALESCE_ACTOR = "outbox@system";
/** The retirement reason of a held message coalesced into a newer one from the same sender; the id follows. */
export const COALESCED_INTO = "coalesced into ";
/** Senders whose held messages coalesce: not an unattributed sender, and not a watchdog (one reminder per job instead). */
const coalescibleSender = (sender: string | null | undefined): sender is string => !!sender && sender !== "unknown" && sender !== WATCHDOG_SENDER;

// Outcomes retain unresolved uncertainty. Wake recovery can claim failed/indeterminate
// work again; it never steals a live sending claim or interprets unknown as unsent.
// Startup marks abandoned sending claims indeterminate before the bounded recovery pass.
export const OUTBOX_DELIVERY_STATES = ["pending", "sending", "delivered", "failed", "indeterminate", "retained", "retired"] as const;
export type OutboxDeliveryState = (typeof OUTBOX_DELIVERY_STATES)[number];

/**
 * Validate a raw `delivery_state` cell against the closed union before it is typed
 * as an {@link OutboxDeliveryState}. Replaces the prior unchecked `as` cast: a cast
 * never fails, so a stray DB value (corruption, a newer daemon's state read by an
 * older one) would silently masquerade as a typed value and make every downstream
 * narrowing unsound. We control every writer, so an unknown value is a real defect —
 * fail loud rather than fabricate a type.
 */
export function parseDeliveryState(raw: string): OutboxDeliveryState {
  if ((OUTBOX_DELIVERY_STATES as readonly string[]).includes(raw)) {
    return raw as OutboxDeliveryState;
  }
  throw new OutboxHandlerError(
    "invalid_delivery_state",
    `outbox row has unknown delivery_state ${JSON.stringify(raw)} (expected one of ${OUTBOX_DELIVERY_STATES.join(", ")})`,
  );
}

export interface OutboxEntry {
  outboxId: string;
  senderSession: string;
  destinationSession: string;
  body: string;
  tags: string[] | null;
  urgency: string;
  tsDispatched: string;
  deliveryState: OutboxDeliveryState;
  deliveredAt: string | null;
  auditPointer: string | null;
  guardBinding?: { nodeId: string; session: string; occupant: string | null; pane: string | null } | null;
  retiredAt?: string | null;
  retiredBy?: string | null;
  retirementReason?: string | null;
}

interface OutboxEntryRow {
  outbox_id: string;
  sender_session: string;
  destination_session: string;
  body: string;
  tags: string | null;
  urgency: string;
  ts_dispatched: string;
  delivery_state: string;
  delivered_at: string | null;
  audit_pointer: string | null;
  guard_binding?: string | null;
  retired_at?: string | null;
  retired_by?: string | null;
  retirement_reason?: string | null;
}

export interface OutboxRecordInput {
  outboxId?: string;
  senderSession: string;
  destinationSession: string;
  body: string;
  tags?: string[];
  urgency?: string;
  auditPointer?: string;
  /** P21 §4 era-stamp: the route passes `transport:v1` (senderSession derived from the transport
   *  header chokepoint). Written onto the outbox row; absence = claimed-era. */
  identityProvenance?: string | null;
  /** With `principal:v1`: the caller the local MCP adapter named (resolveRecordedIdentity). */
  identityPrincipal?: string | null;
}

/** Native protocol custody and effects share the existing delivery receipt. */
export interface RunnerReceipt {
  version: 1; requestId: string; nodeId: string; runId: string; sequence: number;
  kind: "input" | "wake" | "cancel"; memberIds?: string[]; inputRoute: "native"; payload: Record<string, unknown>;
  stage: "pending" | "offered" | "accepted" | "submitted" | "completed" | "rejected";
  bindingHash?: string; erasedAt?: string; acceptedAt?: string; submittedAt?: string; completedAt?: string;
  acceptedTurnId?: string; nativeTurnId?: string; result?: Record<string, unknown>;
  withdrawal?: { stage: "pending" | "confirmed"; startedAt: string; confirmedAt?: string; pendingSubmissions: number; withdrawn: number };
  reconciliation?: "receiver_state_lost" | "native_ownership_unknown";
}
export type RunnerAdmission = OutboxRecordInput & { outboxId: string; nodeId: string; runId: string;
  kind: RunnerReceipt["kind"]; memberIds?: string[]; inputRoute: "native"; payload: Record<string, unknown> };

/** Object key order is not part of a request's immutable wire content. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value);
}

function runnerBindingHash(input: RunnerAdmission): string {
  return createHash("sha256").update(stable({ id: input.outboxId, sender: input.senderSession, destination: input.destinationSession,
    body: input.body, nodeId: input.nodeId, runId: input.runId, kind: input.kind, inputRoute: input.inputRoute,
    payload: input.payload, memberIds: input.memberIds ?? [input.outboxId] })).digest("hex");
}

export class OutboxHandlerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function newOutboxId(): string {
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const hex = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
  return `outbox-${ts}-${hex}`;
}

/**
 * Sender-side outbox. Symmetric to InboxHandler. Records what a sender
 * dispatched independent of receiver behavior. Idempotent on outbox_id.
 *
 * No event-bus events emitted in Phase A — outbox is pure audit. If a future
 * phase wants delivery-tracking events, add them through this surface.
 */
export class OutboxHandler {
  readonly db: Database.Database;
  /** P21 §4: detected once — a curated-migration test DB (or a pre-067 daemon) may lack the
   *  era-stamp column, so the writer degrades (omits it) instead of throwing. */
  private readonly hasIdentityProvenanceColumn: boolean;
  private readonly hasIdentityPrincipalColumn: boolean;
  private readonly hasGuardDeliveryColumn: boolean;

  constructor(db: Database.Database) {
    this.db = db;
    const columns = (this.db.prepare("PRAGMA table_info(outbox_entries)").all() as Array<{ name: string }>).map((col) => col.name);
    this.hasIdentityProvenanceColumn = columns.includes("identity_provenance");
    this.hasIdentityPrincipalColumn = columns.includes("identity_principal");
    this.hasGuardDeliveryColumn = columns.includes("guard_delivery");
  }

  /** The optional original-conversation constraint shares the existing durable delivery receipt. */
  expectedIdentity(outboxId: string): ExpectedConversation | undefined {
    if (!this.hasGuardDeliveryColumn) return undefined;
    const row = this.db.prepare("SELECT guard_delivery FROM outbox_entries WHERE outbox_id=?").get(outboxId) as { guard_delivery: string | null } | undefined;
    return row?.guard_delivery ? JSON.parse(row.guard_delivery).expectedIdentity : undefined;
  }

  bindExpectedIdentity(input: OutboxRecordInput & { outboxId: string }, expected: ExpectedConversation): void {
    if (!this.hasGuardDeliveryColumn) throw new OutboxHandlerError("expected_identity_unavailable", "The durable conditional-delivery schema is unavailable.");
    this.db.transaction(() => {
      const prior = this.getById(input.outboxId), bound = this.expectedIdentity(input.outboxId);
      if (this.runnerReceipt(input.outboxId) && !bound)
        throw new OutboxHandlerError("delivery_identity_conflict", "This native ID already selects a different original-conversation constraint.");
      if (prior && (prior.senderSession !== input.senderSession || prior.destinationSession !== input.destinationSession || prior.body !== input.body)
        || bound && ["nodeId", "sessionName", "runtime", "nativeId"].some(key => bound[key as keyof ExpectedConversation] !== expected[key as keyof ExpectedConversation]))
        throw new OutboxHandlerError("delivery_identity_conflict", "This delivery ID already selects different input or an original conversation.");
      if (!prior) this.record(input);
      const row = this.db.prepare("SELECT guard_delivery FROM outbox_entries WHERE outbox_id=?").get(input.outboxId) as { guard_delivery: string | null };
      const receipt = row.guard_delivery ? JSON.parse(row.guard_delivery) : { ids: [input.outboxId] };
      this.db.prepare("UPDATE outbox_entries SET guard_delivery=? WHERE outbox_id=?")
        .run(JSON.stringify({ ...receipt, expectedIdentity: expected }), input.outboxId);
    })();
  }

  inputRoute(id: string): "typed" | "native" | null {
    if (!this.hasGuardDeliveryColumn) return null;
    const row = this.db.prepare("SELECT guard_delivery FROM outbox_entries WHERE outbox_id=?").get(id) as { guard_delivery: string | null } | undefined;
    if (!row?.guard_delivery) return null;
    const receipt = JSON.parse(row.guard_delivery);
    return receipt.runner?.inputRoute ?? receipt.inputRoute ?? null;
  }

  inputKind(id: string): RunnerReceipt["kind"] | null {
    if (!this.hasGuardDeliveryColumn) return null;
    const row = this.db.prepare("SELECT guard_delivery FROM outbox_entries WHERE outbox_id=?").get(id) as { guard_delivery: string | null } | undefined;
    const saved = row?.guard_delivery ? JSON.parse(row.guard_delivery) : null;
    return saved?.runner?.kind ?? saved?.kind ?? null;
  }

  bindInputRoute(input: OutboxRecordInput & { outboxId: string }, route: "typed" | "native", kind: RunnerReceipt["kind"] = "input"): void {
    if (!this.hasGuardDeliveryColumn) {
      if (route === "typed") return; // Legacy curated schemas retain their existing typed behavior.
      throw new OutboxHandlerError("runner_receipt_unavailable", "Route receipt schema unavailable.");
    }
    this.db.transaction(() => {
      const entry = this.getById(input.outboxId), prior = this.inputRoute(input.outboxId), priorKind = this.inputKind(input.outboxId);
      if (entry && (entry.senderSession !== input.senderSession || entry.destinationSession !== input.destinationSession || entry.body !== input.body)
        || prior && prior !== route || priorKind && priorKind !== kind) throw new OutboxHandlerError("delivery_identity_conflict", "This ID names different input or route.");
      if (!entry) this.record(input);
      const row = this.db.prepare("SELECT guard_delivery FROM outbox_entries WHERE outbox_id=?").get(input.outboxId) as { guard_delivery: string | null };
      const receipt = row.guard_delivery ? JSON.parse(row.guard_delivery) : { ids: [input.outboxId] };
      this.db.prepare("UPDATE outbox_entries SET guard_delivery=? WHERE outbox_id=?").run(JSON.stringify({ ...receipt, inputRoute: route, ...(route === "native" ? { kind } : {}) }), input.outboxId);
    })();
  }

  runnerPrimary(id: string): string | null {
    if (!this.hasGuardDeliveryColumn) return null;
    const row = this.db.prepare("SELECT guard_delivery FROM outbox_entries WHERE outbox_id=?").get(id) as { guard_delivery: string | null } | undefined;
    if (!row?.guard_delivery) return null;
    const receipt = JSON.parse(row.guard_delivery);
    return receipt.nativeRequestId ?? (receipt.runner ? id : null);
  }

  runnerReceipt(id: string): RunnerReceipt | null {
    if (!this.hasGuardDeliveryColumn) return null;
    const row = this.db.prepare("SELECT guard_delivery FROM outbox_entries WHERE outbox_id=?").get(id) as { guard_delivery: string | null } | undefined;
    if (!row?.guard_delivery) return null;
    const saved = JSON.parse(row.guard_delivery);
    if (saved.runner) return saved.runner;
    if (!saved.nativeRequestId) return null;
    const primary = this.db.prepare("SELECT guard_delivery FROM outbox_entries WHERE outbox_id=?").get(saved.nativeRequestId) as { guard_delivery: string | null } | undefined;
    const receipt = primary?.guard_delivery ? JSON.parse(primary.guard_delivery).runner as RunnerReceipt | undefined : undefined;
    return receipt && receipt.requestId === saved.nativeRequestId && receipt.memberIds?.includes(id) ? receipt : null;
  }

  runnerReceipts(nodeId: string, runId?: string): RunnerReceipt[] {
    if (!this.hasGuardDeliveryColumn) return [];
    return (this.db.prepare(`SELECT guard_delivery FROM outbox_entries
      WHERE json_extract(guard_delivery,'$.runner.nodeId')=? ${runId === undefined ? '' : "AND json_extract(guard_delivery,'$.runner.runId')=?"}
      ORDER BY CAST(json_extract(guard_delivery,'$.runner.sequence') AS INTEGER)`).all(...(runId === undefined ? [nodeId] : [nodeId, runId])) as { guard_delivery: string }[])
      .map(row => JSON.parse(row.guard_delivery).runner as RunnerReceipt);
  }

  /** Status-only metadata: SQLite filters JSON internally; prompt payloads never enter application memory. */
  runnerRecovery(nodeId: string): Record<string, unknown>[] {
    if (!this.hasGuardDeliveryColumn) return [];
    const rows = this.db.prepare(`SELECT
      json_extract(guard_delivery,'$.runner.requestId') AS requestId,
      json_extract(guard_delivery,'$.runner.runId') AS runId,
      json_extract(guard_delivery,'$.runner.kind') AS kind,
      json_extract(guard_delivery,'$.runner.stage') AS stage, json_type(guard_delivery,'$.runner.stage') AS stageType,
      json_extract(guard_delivery,'$.runner.erasedAt') AS erasedAt,
      json_extract(guard_delivery,'$.runner.memberIds') AS memberIds,
      CASE WHEN json_extract(guard_delivery,'$.runner.kind')='cancel' THEN json_quote(json_extract(guard_delivery,'$.runner.payload.target')) END AS target,
      json_type(guard_delivery,'$.runner.payload.target') AS targetType,
      json_type(guard_delivery,'$.runner.withdrawal') AS withdrawalType,
      json_extract(guard_delivery,'$.runner.withdrawal.stage') AS withdrawalStage,
      json_extract(guard_delivery,'$.runner.withdrawal.startedAt') AS startedAt,
      json_extract(guard_delivery,'$.runner.withdrawal.confirmedAt') AS confirmedAt,
      json_extract(guard_delivery,'$.runner.withdrawal.pendingSubmissions') AS pendingSubmissions,
      json_extract(guard_delivery,'$.runner.reconciliation') AS reconciliation,
      json_extract(guard_delivery,'$.runner.result.outcome') AS outcome,
      json_type(guard_delivery,'$.runner.result.confirmed') AS confirmedType,
      CASE json_type(guard_delivery,'$.runner.result.confirmed') WHEN 'true' THEN 'true' WHEN 'false' THEN 'false'
        ELSE json_quote(json_extract(guard_delivery,'$.runner.result.confirmed')) END AS confirmed,
      sender_session AS sender, destination_session AS destination
      FROM outbox_entries WHERE json_extract(guard_delivery,'$.runner.nodeId')=? AND (
        COALESCE(json_extract(guard_delivery,'$.runner.reconciliation'),'') <> ''
        OR COALESCE(json_extract(guard_delivery,'$.runner.stage'),'') NOT IN ('completed','rejected')
        OR (json_extract(guard_delivery,'$.runner.kind')='cancel' AND json_extract(guard_delivery,'$.runner.result.outcome')='requested'
          AND json_type(guard_delivery,'$.runner.result.confirmed') IS NOT 'true'))
      ORDER BY CAST(json_extract(guard_delivery,'$.runner.sequence') AS INTEGER), rowid`).all(nodeId) as Record<string, unknown>[];
    return rows.map(row => ({ requestId: row.requestId, runId: row.runId, kind: row.kind, stage: row.stageType === null ? undefined : row.stage,
      ...(row.erasedAt ? { erasedAt: row.erasedAt } : {}), sender: row.sender, destination: row.destination,
      ...(row.memberIds ? { memberIds: JSON.parse(String(row.memberIds)) } : {}),
      ...(row.kind === "cancel" ? { target: row.targetType === null ? undefined : JSON.parse(String(row.target)) } : {}),
      ...(row.withdrawalType === "object" ? { withdrawal: { stage: row.withdrawalStage ?? undefined, startedAt: row.startedAt ?? undefined,
        ...(row.confirmedAt ? { confirmedAt: row.confirmedAt } : {}), pendingSubmissions: row.pendingSubmissions ?? undefined } } : {}),
      ...(row.reconciliation ? { reconciliation: row.reconciliation } : {}),
      ...(row.outcome ? { outcome: row.outcome, confirmed: row.confirmedType === null ? undefined : JSON.parse(String(row.confirmed)) } : {}) }));
  }

  /** Run-local uncertainty guard; unlike recovery status, cancellation and historical runs do not block input. */
  hasRunnerReconciliation(nodeId: string, runId: string): boolean {
    if (!this.hasGuardDeliveryColumn) return false;
    return !!this.db.prepare(`SELECT 1 FROM outbox_entries WHERE json_extract(guard_delivery,'$.runner.nodeId')=?
      AND json_extract(guard_delivery,'$.runner.runId')=? AND json_extract(guard_delivery,'$.runner.kind') IS NOT 'cancel'
      AND COALESCE(json_extract(guard_delivery,'$.runner.reconciliation'),'') <> '' LIMIT 1`).get(nodeId, runId);
  }

  admitRunner(input: RunnerAdmission): RunnerReceipt {
    if (!this.hasGuardDeliveryColumn) throw new OutboxHandlerError("runner_receipt_unavailable", "Native receipt schema unavailable.");
    return this.db.transaction(() => {
      const entry = this.getById(input.outboxId), primary = this.runnerPrimary(input.outboxId), prior = this.runnerReceipt(input.outboxId);
      if (primary && !prior || !entry && this.db.prepare("SELECT 1 FROM outbox_entries WHERE json_extract(guard_delivery,'$.nativeRequestId')=? LIMIT 1").get(input.outboxId))
        throw new OutboxHandlerError("runner_receipt_unavailable", "Native custody evidence is unavailable; no input offered.");
      if (prior?.erasedAt) throw new OutboxHandlerError(prior.bindingHash === runnerBindingHash(input) ? "runner_receipt_erased" : "delivery_identity_conflict",
        prior.bindingHash === runnerBindingHash(input) ? "This native receipt was erased; no input offered." : "This ID names different erased input.");
      if (primary && primary !== input.outboxId) throw new OutboxHandlerError("delivery_identity_conflict", "This member belongs to a different native operation.");
      const memberIds = input.memberIds ?? [input.outboxId];
      if (!memberIds.length || memberIds[0] !== input.outboxId || new Set(memberIds).size !== memberIds.length)
        throw new OutboxHandlerError("delivery_identity_conflict", "Invalid ordered native membership.");
      for (const id of memberIds) {
        const member = this.getById(id), owner = this.runnerPrimary(id), kind = this.inputKind(id);
        if (owner && owner !== input.outboxId || memberIds.length > 1 && (!member || member.destinationSession !== input.destinationSession)
          || this.inputRoute(id) === "typed" || kind && kind !== input.kind) throw new OutboxHandlerError("delivery_identity_conflict", "Native membership names different target, route or operation.");
      }
      if (this.inputRoute(input.outboxId) === "typed") throw new OutboxHandlerError("delivery_identity_conflict", "This ID names a different input route.");
      if (entry && (entry.senderSession !== input.senderSession || entry.destinationSession !== input.destinationSession || entry.body !== input.body)
        || prior && (prior.nodeId !== input.nodeId || prior.runId !== input.runId || prior.kind !== input.kind || prior.inputRoute !== input.inputRoute
          || stable(prior.payload) !== stable(input.payload) || stable(prior.memberIds ?? [prior.requestId]) !== stable(memberIds)))
        throw new OutboxHandlerError("delivery_identity_conflict", "This request ID names different input, route or target.");
      if (prior) return prior;
      if (entry && !["pending", "sending", "retained"].includes(entry.deliveryState))
        throw new OutboxHandlerError("delivery_identity_conflict", "This request ID already names a different delivery attempt.");
      const receipts = this.runnerReceipts(input.nodeId, input.runId);
      const sequence = (receipts.at(-1)?.sequence ?? 0) + 1;
      if (!Number.isSafeInteger(sequence)) throw new OutboxHandlerError("runner_sequence_exhausted", "Run sequence exhausted.");
      const receipt: RunnerReceipt = { version: 1, requestId: input.outboxId, nodeId: input.nodeId, runId: input.runId, sequence,
        bindingHash: runnerBindingHash(input), kind: input.kind, ...(memberIds.length > 1 ? { memberIds } : {}), inputRoute: input.inputRoute, payload: input.payload, stage: "pending" };
      if (!entry) this.record(input);
      this.writeRunner(receipt);
      for (const id of memberIds) {
        if (id !== input.outboxId) {
          const row = this.db.prepare("SELECT guard_delivery FROM outbox_entries WHERE outbox_id=?").get(id) as { guard_delivery: string | null };
          const previous = row.guard_delivery ? JSON.parse(row.guard_delivery) : {};
          this.db.prepare("UPDATE outbox_entries SET guard_delivery=? WHERE outbox_id=?")
            .run(JSON.stringify({ ...previous, ids: memberIds, inputRoute: "native", nativeRequestId: input.outboxId }), id);
        }
        this.db.prepare("UPDATE outbox_entries SET delivery_state='sending' WHERE outbox_id=?").run(id);
      }
      return receipt;
    })();
  }

  /** Repeated stages are idempotent; a conflicting result never replaces retained evidence. */
  updateRunner(nodeId: string, runId: string, id: string, sequence: number, stage: RunnerReceipt["stage"],
    evidence: Pick<RunnerReceipt, "acceptedTurnId" | "nativeTurnId" | "result"> = {}): RunnerReceipt {
    return this.db.transaction(() => {
      const receipt = this.runnerReceipt(id);
      if (!receipt || receipt.requestId !== id || receipt.nodeId !== nodeId || receipt.runId !== runId || receipt.sequence !== sequence)
        throw new OutboxHandlerError("runner_request_mismatch", "Unknown request or run/sequence mismatch.");
      if (receipt.erasedAt) throw new OutboxHandlerError("runner_receipt_erased", "This native receipt was erased; no result recorded.");
      if (receipt.reconciliation) throw new OutboxHandlerError("runner_state_lost", "Native custody or execution ownership is uncertain; effect remains indeterminate.");
      for (const key of ["acceptedTurnId", "nativeTurnId", "result"] as const) {
        if (receipt[key] !== undefined && evidence[key] !== undefined && stable(receipt[key]) !== stable(evidence[key])
          && !(key === "result" && receipt.kind === "cancel" && receipt.stage !== "completed" && receipt.result?.outcome === "requested"
            && ["requested", "cancelled"].includes(String(evidence.result?.outcome))))
          throw new OutboxHandlerError("runner_result_conflict", "A different native result is already retained.");
      }
      const stages = ["pending", "offered", "accepted", "submitted", "completed"];
      if (receipt.stage === "rejected" || receipt.stage === "completed") {
        if (stage !== receipt.stage && (stage === "completed" || stage === "rejected"))
          throw new OutboxHandlerError("runner_result_conflict", "A different terminal result is retained.");
        return receipt;
      }
      if (stage !== "rejected" && stages.indexOf(stage) <= stages.indexOf(receipt.stage)) return receipt;
      const unknownSubmission = stage === "completed" && receipt.stage === "accepted" && evidence.result?.submissionUnknown === true
        && evidence.result?.completion === "unknown";
      const noCancelEffect = receipt.kind === "cancel" && receipt.stage === "accepted" && stage === "completed"
        && ["not-this-turn", "not-supported"].includes(String(evidence.result?.outcome));
      if (stage !== "rejected" && !unknownSubmission && !noCancelEffect && stages.indexOf(stage) !== stages.indexOf(receipt.stage) + 1)
        throw new OutboxHandlerError("runner_stage_conflict", "Native receipt skipped a required custody stage.");
      if (stage === "rejected" && ["submitted", "completed"].includes(receipt.stage))
        throw new OutboxHandlerError("runner_stage_conflict", "Submitted effects cannot become pre-effect rejection.");
      const unknownCancellation = receipt.kind === "cancel" && evidence.result?.outcome === "requested" && evidence.result.operationAccepted !== true;
      const at = new Date().toISOString();
      const updated: RunnerReceipt = { ...receipt, ...evidence, stage,
        ...(evidence.result?.ownershipUnknown === true ? { reconciliation: "native_ownership_unknown" as const } : {}),
        ...(stage === "accepted" ? { acceptedAt: at } : stage === "submitted" ? { submittedAt: at }
          : stage === "completed" || stage === "rejected" ? { completedAt: at } : {}) };
      this.writeRunner(updated);
      if (stage === "submitted" || stage === "completed" || stage === "rejected") for (const memberId of receipt.memberIds ?? [id])
        this.db.prepare("UPDATE outbox_entries SET delivery_state=?,delivered_at=? WHERE outbox_id=?")
          .run(unknownSubmission || unknownCancellation || updated.reconciliation ? "indeterminate" : stage === "rejected" ? "failed" : "delivered", unknownSubmission || unknownCancellation || updated.reconciliation || stage === "rejected" ? null : at, memberId);
      return updated;
    })();
  }

  /** Called only at a committed Core run cutover, never from an uncertain liveness read. */
  replaceRunnerRun(nodeId: string, currentRunId: string): void {
    if (!this.hasGuardDeliveryColumn) return;
    this.db.transaction(() => {
      const runs = this.db.prepare(`SELECT DISTINCT json_extract(guard_delivery,'$.runner.runId') AS runId
        FROM outbox_entries WHERE json_extract(guard_delivery,'$.runner.nodeId')=?
        AND json_extract(guard_delivery,'$.runner.runId')<>?`).all(nodeId, currentRunId) as { runId: string }[];
      for (const { runId } of runs) for (const receipt of this.runnerReceipts(nodeId, runId)) {
        if (receipt.erasedAt || ["completed", "rejected"].includes(receipt.stage)
          || receipt.stage === "submitted" && receipt.kind === "input") continue;
        const pending = receipt.stage === "pending";
        this.writeRunner(pending ? { ...receipt, stage: "rejected", completedAt: new Date().toISOString(),
          result: { kind: receipt.kind, accepted: false, error: "not offered: its run ended" } }
          : { ...receipt, reconciliation: "receiver_state_lost" });
        for (const id of receipt.memberIds ?? [receipt.requestId])
          this.db.prepare("UPDATE outbox_entries SET delivery_state=?,delivered_at=NULL WHERE outbox_id=?")
            .run(pending ? "failed" : "indeterminate", id);
      }
    })();
  }

  recordRunnerWithdrawal(nodeId: string, runId: string, id: string, sequence: number,
    evidence: { confirmed: boolean; pendingSubmissions: number; withdrawn: number }): RunnerReceipt {
    const receipt = this.runnerReceipt(id);
    if (!receipt || receipt.kind !== "cancel" || receipt.nodeId !== nodeId || receipt.runId !== runId || receipt.sequence !== sequence
      || receipt.erasedAt || receipt.reconciliation || receipt.stage !== "accepted")
      throw new OutboxHandlerError("runner_request_mismatch", "Cancellation preparation does not match retained accepted custody.");
    const at = new Date().toISOString();
    const withdrawal: NonNullable<RunnerReceipt["withdrawal"]> = { stage: evidence.confirmed ? "confirmed" : "pending",
      startedAt: receipt.withdrawal?.startedAt ?? at, ...(evidence.confirmed ? { confirmedAt: receipt.withdrawal?.confirmedAt ?? at } : {}),
      pendingSubmissions: evidence.pendingSubmissions, withdrawn: evidence.withdrawn };
    if (receipt.withdrawal?.stage === "confirmed" && !evidence.confirmed) throw new OutboxHandlerError("runner_result_conflict", "Withdrawal confirmation cannot regress.");
    const updated = { ...receipt, withdrawal }; this.writeRunner(updated); return updated;
  }

  forgetRunnerMap(nodeId: string, runId: string): void {
    this.db.transaction(() => {
      for (const receipt of this.runnerReceipts(nodeId, runId)) {
        if (["pending", "completed", "rejected"].includes(receipt.stage)) continue;
        this.writeRunner({ ...receipt, reconciliation: "receiver_state_lost" });
        for (const id of receipt.memberIds ?? [receipt.requestId])
          this.db.prepare("UPDATE outbox_entries SET delivery_state='indeterminate' WHERE outbox_id=? AND delivery_state='sending'").run(id);
      }
    })();
  }

  /** Content erasure keeps native custody tombstones: deleting them would permit ID/sequence reuse and blind replay.
   * The existing erasure transaction calls this before its ordinary body/delete effects. Other members' bodies stay
   * under the existing erasure scope, while the composed native payload/result for the whole group disappears. */
  eraseRunner(id: string, at: string): boolean {
    const primary = this.runnerPrimary(id) ?? (this.inputRoute(id) === "native" ? id : null);
    if (!primary) return false;
    const receipt = this.runnerReceipt(id);
    const source = this.getById(id)!;
    const row = this.db.prepare("SELECT guard_delivery FROM outbox_entries WHERE outbox_id=?").get(id) as { guard_delivery: string | null };
    const retained = row.guard_delivery ? JSON.parse(row.guard_delivery) : {};
    const target = receipt?.kind === "cancel" ? receipt.payload.target as { runId?: unknown; nativeTurnId?: unknown } | undefined : undefined;
    const cancellationTarget = target && typeof target.runId === "string" && typeof target.nativeTurnId === "string"
      ? { runId: target.runId, nativeTurnId: target.nativeTurnId } : null;
    const tombstone: RunnerReceipt | null = receipt ? { version: 1, requestId: receipt.requestId, nodeId: receipt.nodeId, runId: receipt.runId,
      sequence: receipt.sequence, kind: receipt.kind, inputRoute: "native", stage: receipt.stage, payload: cancellationTarget ? { target: cancellationTarget } : {},
      ...(cancellationTarget && receipt.withdrawal ? { withdrawal: { stage: receipt.withdrawal.stage, startedAt: receipt.withdrawal.startedAt,
        ...(receipt.withdrawal.confirmedAt ? { confirmedAt: receipt.withdrawal.confirmedAt } : {}), pendingSubmissions: receipt.withdrawal.pendingSubmissions, withdrawn: receipt.withdrawal.withdrawn } } : {}),
      ...(cancellationTarget && receipt.result ? { result: { kind: "cancel", outcome: receipt.result.outcome, confirmed: receipt.result.confirmed,
        ...(typeof receipt.result.operationAccepted === "boolean" ? { operationAccepted: receipt.result.operationAccepted } : {}) } } : {}),
      ...(receipt.memberIds ? { memberIds: receipt.memberIds } : {}), ...(receipt.reconciliation ? { reconciliation: receipt.reconciliation } : {}),
      bindingHash: receipt.bindingHash, erasedAt: receipt.erasedAt ?? at } : null;
    this.db.transaction(() => {
      // Every erasure entry point removes this selected source's content/endpoints. Other group source histories
      // stay governed by their own scope; the composed native payload/result is always sanitized for the whole group.
      this.db.prepare("UPDATE outbox_entries SET body='',tags=NULL,sender_session='',destination_session='',guard_binding=NULL,audit_pointer=NULL,retirement_reason=NULL,retired_by=NULL WHERE outbox_id=?").run(id);
      if (!receipt || !tombstone) {
        // A native request held before run admission has no run or sequence to invent. Keep its opaque erased-route
        // identity; the same unavailable shape also fences a surviving pointer whose primary evidence is missing.
        const erased = { ids: retained.ids ?? [id], inputRoute: "native", nativeRequestId: primary,
          erasedAt: retained.erasedAt ?? at, bindingHash: retained.bindingHash ?? createHash("sha256")
            .update(stable({ id, sender: source.senderSession, destination: source.destinationSession, body: source.body, inputRoute: "native" })).digest("hex") };
        this.db.prepare("UPDATE outbox_entries SET guard_delivery=?,delivery_state='indeterminate' WHERE outbox_id=?").run(JSON.stringify(erased), id);
        return;
      }
      for (const member of receipt.memberIds ?? [primary]) {
        const saved = member === primary ? { ids: receipt.memberIds ?? [primary], inputRoute: "native", runner: tombstone }
          : { ids: receipt.memberIds, inputRoute: "native", nativeRequestId: primary, erasedAt: tombstone.erasedAt };
        this.db.prepare("UPDATE outbox_entries SET guard_delivery=?,delivery_state='indeterminate' WHERE outbox_id=?").run(JSON.stringify(saved), member);
      }
    })();
    return true;
  }

  private writeRunner(receipt: RunnerReceipt): void {
    const row = this.db.prepare("SELECT guard_delivery FROM outbox_entries WHERE outbox_id=?").get(receipt.requestId) as { guard_delivery: string | null };
    const previous = row.guard_delivery ? JSON.parse(row.guard_delivery) : { ids: [receipt.requestId] };
    this.db.prepare("UPDATE outbox_entries SET guard_delivery=? WHERE outbox_id=?")
      .run(JSON.stringify({ ...previous, runner: receipt }), receipt.requestId);
  }

  record(input: OutboxRecordInput): OutboxEntry {
    const id = input.outboxId ?? newOutboxId();
    const existing = this.getByIdRaw(id);
    if (existing) return this.rowToEntry(existing);

    const ts = new Date().toISOString();
    const tags = input.tags ? JSON.stringify(input.tags) : null;
    const urgency = input.urgency ?? "routine";

    if (this.hasIdentityProvenanceColumn) {
      // A principal is kept only beside principal:v1; a schema without the column records today's stamp instead.
      const principal = input.identityProvenance === "principal:v1" && this.hasIdentityPrincipalColumn ? input.identityPrincipal ?? null : null;
      const provenance = input.identityProvenance === "principal:v1" && !principal ? "transport:v1" : input.identityProvenance ?? null;
      this.db
        .prepare(
          `INSERT INTO outbox_entries (
            outbox_id, sender_session, destination_session, body, tags, urgency, ts_dispatched, audit_pointer, identity_provenance${principal ? ", identity_principal" : ""}
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?${principal ? ", ?" : ""})`
        )
        .run(
          id,
          input.senderSession,
          input.destinationSession,
          input.body,
          tags,
          urgency,
          ts,
          input.auditPointer ?? null,
          provenance,
          ...(principal ? [principal] : []),
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO outbox_entries (
            outbox_id, sender_session, destination_session, body, tags, urgency, ts_dispatched, audit_pointer
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.senderSession,
          input.destinationSession,
          input.body,
          tags,
          urgency,
          ts,
          input.auditPointer ?? null
        );
    }

    return this.getByIdOrThrow(id);
  }

  /** Retention shares the existing outbox ID. Committed wakes preserve each member,
   * even if guard activation happened after staging and quota is now exhausted. */
  retain(input: OutboxRecordInput & { outboxId: string }, binding: NonNullable<OutboxEntry["guardBinding"]>, precommitted = false,
    opts: { sameSend?: readonly string[]; coalesce?: boolean } = {}): OutboxEntry {
    return this.db.transaction(() => {
      const existing = this.getById(input.outboxId);
      if (existing) {
        if (existing.senderSession !== input.senderSession || existing.destinationSession !== input.destinationSession || existing.body !== input.body ||
            (existing.guardBinding && JSON.stringify(existing.guardBinding) !== JSON.stringify(binding))) {
          throw new OutboxHandlerError("delivery_identity_conflict", "The delivery ID already names different content or target identity.");
        }
        if (existing.deliveryState === "retained" || existing.deliveryState === "retired") return existing;
        if (existing.deliveryState !== "pending" && existing.deliveryState !== "sending") {
          throw new OutboxHandlerError("delivery_already_attempted", "This delivery already has a terminal outcome; it cannot be retained or retried.");
        }
      } else if (precommitted) {
        throw new OutboxHandlerError("outbox_not_found", "Precommitted delivery is missing; no replacement custody is created.");
      }
      // One held reminder per watchdog job: a newer reminder retires the one held before it, so a held seat's quota isn't
      // filled by repeats of one job (#2430).
      if (!existing && !precommitted && input.senderSession === WATCHDOG_SENDER && input.auditPointer) {
        this.db.prepare(`UPDATE outbox_entries SET delivery_state='retired', retired_at=?, retired_by=?, retirement_reason=?
          WHERE delivery_state='retained' AND sender_session=? AND audit_pointer=? AND json_extract(guard_binding,'$.nodeId')=?`)
          .run(new Date().toISOString(), WATCHDOG_SENDER, "superseded by a newer reminder from the same watchdog job",
            WATCHDOG_SENDER, input.auditPointer, binding.nodeId);
      }
      // One held message per sender at a seat (#2430): the sender's newest held message there retires its earlier ones
      // into itself, so one sender can't fill the quota and drop everyone else's messages. The sender's own held messages
      // count as room (assertRetentionCapacity). Held messages are never replayed; a coalesced one stays readable by ID
      // and the newest names it (heldForNode's `coalesced`). Not coalesced: the other parts of this same send, a
      // watchdog's reminders (one per job, above), an unattributed sender, and a draft-aware attempt (coalesce: false),
      // which moves on to sending and coalesces only if it settles as held (coalesceSettled), so a message that's then
      // delivered never absorbs held ones.
      const sameSend = opts.sameSend ?? [];
      if (!precommitted) this.assertRetentionCapacity(binding.nodeId, input.body, input.senderSession, [input.outboxId, ...sameSend]);
      if (!existing) this.record(input);
      this.db.prepare(`UPDATE outbox_entries SET delivery_state='retained', guard_binding=?, delivered_at=NULL
        WHERE outbox_id=? AND delivery_state IN ('pending','sending')`)
        .run(JSON.stringify(binding), input.outboxId);
      if (opts.coalesce !== false && coalescibleSender(input.senderSession)) {
        this.coalesceSender(input.senderSession, binding.nodeId, [input.outboxId, ...sameSend]);
      }
      return this.getByIdOrThrow(input.outboxId);
    })();
  }

  /** #2430: a draft-aware attempt that settled as held takes its sender's place, as any other held message does. */
  coalesceSettled(outboxId: string, sameSend: readonly string[] = []): void {
    const entry = this.getById(outboxId);
    if (entry?.deliveryState !== "retained" || !entry.guardBinding || !coalescibleSender(entry.senderSession)) return;
    this.coalesceSender(entry.senderSession, entry.guardBinding.nodeId, [outboxId, ...sameSend]);
  }

  /** #2430: retire the sender's held messages at this seat into the newest one, oldest first by dispatch time, so a
   *  message that settles as held late (a delayed committed wake, a draft-aware attempt) never hides a newer one. The
   *  parts of one send (`group`) stay together when that send is the newest. When `group` settles late, behind a newer
   *  held message, only its own members fold into the newest: the newer send's other parts stay held, since nothing
   *  replaced that send. The ones already coalesced are repointed, so the newest names every message it stands for.
   *  An urgent message's marking carries forward to the newest. Links are keyed on the mechanism (retired by
   *  outbox@system, same sender, same seat), so a hand retirement whose reason reads the same is never touched. */
  private coalesceSender(senderSession: string, nodeId: string, group: readonly string[]): void {
    const held = this.heldFrom(senderSession, nodeId);
    if (held.length < 2) return;
    const newestId = held[held.length - 1]!;
    const older = group.includes(newestId)
      ? held.filter(id => !group.includes(id))
      : held.filter(id => id !== newestId && group.includes(id));
    if (older.length === 0) return;
    const now = new Date().toISOString();
    const reason = `${COALESCED_INTO}${newestId}`;
    const retire = this.db.prepare(`UPDATE outbox_entries SET delivery_state='retired', retired_at=?, retired_by=?, retirement_reason=?
      WHERE outbox_id=? AND delivery_state='retained'`);
    const repoint = this.db.prepare(`UPDATE outbox_entries SET retirement_reason=?
      WHERE delivery_state='retired' AND retired_by=? AND sender_session=? AND json_extract(guard_binding,'$.nodeId')=? AND retirement_reason=?`);
    const urgent = this.db.prepare(`SELECT 1 FROM outbox_entries WHERE urgency='urgent' AND outbox_id IN (${older.map(() => "?").join(",")})`)
      .get(...older) !== undefined;
    for (const id of older) {
      retire.run(now, COALESCE_ACTOR, reason, id);
      repoint.run(reason, COALESCE_ACTOR, senderSession, nodeId, `${COALESCED_INTO}${id}`);
    }
    if (urgent) this.db.prepare(`UPDATE outbox_entries SET urgency='urgent' WHERE outbox_id=?`).run(newestId);
  }

  /** The sender's held messages at this seat, oldest first. */
  private heldFrom(senderSession: string, nodeId: string): string[] {
    return (this.db.prepare(`SELECT outbox_id FROM outbox_entries
      WHERE delivery_state='retained' AND sender_session=? AND json_extract(guard_binding,'$.nodeId')=? ORDER BY ts_dispatched,rowid`)
      .all(senderSession, nodeId) as Array<{ outbox_id: string }>).map(row => row.outbox_id);
  }

  /** #2430: the held messages coalesced into this one, oldest first. */
  coalescedInto(outboxId: string): string[] {
    const entry = this.getById(outboxId);
    return entry ? this.coalescedFor(entry) : [];
  }

  private coalescedFor(entry: OutboxEntry): string[] {
    if (!entry.guardBinding) return [];
    return (this.db.prepare(`SELECT outbox_id FROM outbox_entries WHERE delivery_state='retired' AND retired_by=? AND sender_session=?
      AND json_extract(guard_binding,'$.nodeId')=? AND retirement_reason=? ORDER BY ts_dispatched,rowid`)
      .all(COALESCE_ACTOR, entry.senderSession, entry.guardBinding.nodeId, `${COALESCED_INTO}${entry.outboxId}`) as Array<{ outbox_id: string }>)
      .map(row => row.outbox_id);
  }

  /** Refuses a held message that doesn't fit the seat's active quota. With `senderSession`, the sender's own earlier
   *  held messages there (other than `keep`) count as room, since this message coalesces them (#2430). */
  assertRetentionCapacity(nodeId: string, body: string, senderSession?: string, keep: readonly string[] = []): void {
    // Provisional bounded defaults. Historical/retired rows and already committed
    // overflow are deliberately not evicted to make these active quotas fit.
    const usage = this.retentionUsage(nodeId);
    if (senderSession && coalescibleSender(senderSession)) {
      const skip = new Set(keep);
      const own = this.heldFrom(senderSession, nodeId).filter(id => !skip.has(id));
      if (own.length > 0) {
        const freed = this.db.prepare(`SELECT coalesce(sum(length(CAST(body AS BLOB))),0) AS bytes FROM outbox_entries
          WHERE outbox_id IN (${own.map(() => "?").join(",")})`).get(...own) as { bytes: number };
        usage.count -= own.length;
        usage.bytes -= freed.bytes;
      }
    }
    const size = Buffer.byteLength(body, "utf8");
    if (size > 1024 * 1024 || usage.count >= 100 || usage.bytes + size > 8 * 1024 * 1024) {
      throw new OutboxHandlerError("retained_quota_full", "Held-message quota is full. Retire a specific held message to release active quota; no input was written.");
    }
  }

  /** Current active quota inputs; reading them neither retires nor retries retained custody. */
  retentionUsage(nodeId: string): { count: number; bytes: number } {
    return this.db.prepare(`SELECT count(*) AS count, coalesce(sum(length(CAST(body AS BLOB))),0) AS bytes
      FROM outbox_entries WHERE delivery_state='retained' AND json_extract(guard_binding,'$.nodeId')=?`)
      .get(nodeId) as { count: number; bytes: number };
  }

  retire(outboxId: string, actor: string, reason: string): OutboxEntry {
    if (!actor.trim() || !reason.trim()) throw new OutboxHandlerError("retirement_reason_required", "Actor and reason are required.");
    const entry = this.getByIdOrThrow(outboxId);
    if (entry.deliveryState === "retired") return entry;
    if (entry.deliveryState !== "retained") throw new OutboxHandlerError("delivery_not_retained", "Only retained messages can be retired.");
    this.db.prepare(`UPDATE outbox_entries SET delivery_state='retired', retired_at=?, retired_by=?, retirement_reason=?
      WHERE outbox_id=? AND delivery_state='retained'`).run(new Date().toISOString(), actor, reason, outboxId);
    return this.getByIdOrThrow(outboxId);
  }

  /** How many messages the seat holds; a status count, without reading or naming them. */
  heldCount(nodeId: string): number {
    return (this.db.prepare(`SELECT count(*) AS n FROM outbox_entries
      WHERE delivery_state='retained' AND json_extract(guard_binding,'$.nodeId')=?`).get(nodeId) as { n: number }).n;
  }

  heldForNode(nodeId: string, limit = 100, offset = 0) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(offset) || offset < 0) {
      throw new OutboxHandlerError("invalid_pagination", "Use limit 1–1000 and a nonnegative offset.");
    }
    const total = this.heldCount(nodeId);
    const rows = this.db.prepare(`SELECT * FROM outbox_entries
      WHERE delivery_state='retained' AND json_extract(guard_binding,'$.nodeId')=? ORDER BY ts_dispatched,outbox_id LIMIT ? OFFSET ?`)
      .all(nodeId, limit, offset) as OutboxEntryRow[];
    return { items: rows.map(r => {
      const entry = this.rowToEntry(r);
      const coalesced = this.coalescedFor(entry);
      return coalesced.length > 0 ? { ...entry, coalesced: { count: coalesced.length, outboxIds: coalesced } } : entry;
    }), total, limit, offset, truncated: offset + rows.length < total };
  }

  markDelivered(outboxId: string): OutboxEntry {
    const ts = new Date().toISOString();
    const result = this.db
      .prepare(
        `UPDATE outbox_entries
           SET delivery_state = 'delivered', delivered_at = ?
         WHERE outbox_id = ? AND delivery_state = 'pending'`
      )
      .run(ts, outboxId);
    if (result.changes === 0) {
      const entry = this.getById(outboxId);
      if (!entry) throw new OutboxHandlerError("outbox_not_found", `outbox ${outboxId} not found`);
      return entry;
    }
    return this.getByIdOrThrow(outboxId);
  }

  markFailed(outboxId: string): OutboxEntry {
    const result = this.db
      .prepare(
        `UPDATE outbox_entries
           SET delivery_state = 'failed'
         WHERE outbox_id = ? AND delivery_state = 'pending'`
      )
      .run(outboxId);
    if (result.changes === 0) {
      const entry = this.getById(outboxId);
      if (!entry) throw new OutboxHandlerError("outbox_not_found", `outbox ${outboxId} not found`);
      return entry;
    }
    return this.getByIdOrThrow(outboxId);
  }

  /**
   * W1 (transactional closure): record an AMBIGUOUS delivery outcome — the send
   * landed but its render could not be confirmed (transport res.ok && !verified).
   * Same compare-and-set shape as markFailed/markDelivered (guards on 'pending'),
   * so it is idempotent and NEVER clobbers a row that already resolved. An
   * indeterminate row is terminal-by-CAS: it is never silently promoted to
   * delivered nor demoted to failed by the drain.
   */
  markIndeterminate(outboxId: string): OutboxEntry {
    const result = this.db
      .prepare(
        `UPDATE outbox_entries
           SET delivery_state = 'indeterminate'
         WHERE outbox_id = ? AND delivery_state = 'pending'`
      )
      .run(outboxId);
    if (result.changes === 0) {
      const entry = this.getById(outboxId);
      if (!entry) throw new OutboxHandlerError("outbox_not_found", `outbox ${outboxId} not found`);
      return entry;
    }
    return this.getByIdOrThrow(outboxId);
  }

  /**
   * Atomically claim a fresh or previously unsuccessful notification attempt.
   * Live sending claims, known delivery and deliberately held/retired work stay untouched.
   */
  claimForDelivery(outboxId: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE outbox_entries SET delivery_state = 'sending'
          WHERE outbox_id = ? AND delivery_state IN ('pending','failed','indeterminate')${this.hasGuardDeliveryColumn ? " AND json_extract(guard_delivery,'$.runner') IS NULL AND json_extract(guard_delivery,'$.nativeRequestId') IS NULL" : ""}`
      )
      .run(outboxId);
    return result.changes === 1;
  }

  /**
   * MF3: finalize a CLAIMED wake intent (sending→delivered|indeterminate|failed)
   * after its external send resolved. CAS-guarded on `sending` so it only ever
   * finalizes a row this drainer claimed. `delivered_at` is stamped only for a
   * confirmed delivery.
   */
  finalizeDelivery(outboxId: string, state: "delivered" | "indeterminate" | "failed" | "retained"): OutboxEntry {
    // Generic wake accounting cannot settle native custody or turn an accepted effect into a typed retry.
    if (this.runnerPrimary(outboxId)) return this.getByIdOrThrow(outboxId);
    const deliveredAt = state === "delivered" ? new Date().toISOString() : null;
    const result = this.db
      .prepare(
        `UPDATE outbox_entries SET delivery_state = ?, delivered_at = ?
          WHERE outbox_id = ? AND delivery_state = 'sending'`
      )
      .run(state, deliveredAt, outboxId);
    if (result.changes === 0) {
      const entry = this.getById(outboxId);
      if (!entry) throw new OutboxHandlerError("outbox_not_found", `outbox ${outboxId} not found`);
      return entry;
    }
    return this.getByIdOrThrow(outboxId);
  }

  getById(outboxId: string): OutboxEntry | null {
    const row = this.getByIdRaw(outboxId);
    return row ? this.rowToEntry(row) : null;
  }

  listForSender(senderSession: string, limit = 100, addresses = [senderSession]): OutboxEntry[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM outbox_entries WHERE sender_session IN (${addresses.map(() => "?").join(",")}) ORDER BY ts_dispatched DESC, rowid DESC LIMIT ?`
      )
      .all(...addresses, limit) as OutboxEntryRow[];
    return rows.map((r) => this.rowToEntry(r));
  }

  /** Messages a rig's seats sent or were sent, newest first: sender or destination `<member>@<rig>`. */
  listForRig(rig: string, limit = 100): OutboxEntry[] {
    const pattern = `%@${rig.replace(/[\\%_]/g, (ch) => `\\${ch}`)}`;
    const rows = this.db
      .prepare(
        `SELECT * FROM outbox_entries WHERE sender_session LIKE ? ESCAPE '\\' OR destination_session LIKE ? ESCAPE '\\'
         ORDER BY ts_dispatched DESC, rowid DESC LIMIT ?`
      )
      .all(pattern, pattern, limit) as OutboxEntryRow[];
    return rows.map((r) => this.rowToEntry(r));
  }

  /**
   * W1 (transactional closure): list still-`pending` rows whose outbox_id begins
   * with `idPrefix`, oldest first. The drain uses this to recover intents a crash
   * left committed-but-undelivered. `idPrefix` is a trusted compile-time constant
   * (e.g. "wake-intent-") with no LIKE wildcards. Oldest-first + bounded `limit`
   * so a caller can page and terminate on a served short batch (never a silent cap).
   */
  listPending(idPrefix: string, limit = 200): OutboxEntry[] {
    // EXACT-CASE prefix match. SQLite `LIKE` is case-insensitive by default, so a
    // `LIKE 'wake-intent-%'` selector would also execute `WAKE-INTENT-…` variants.
    // `substr(...) = ?` uses the binary collation (case-sensitive), so exactly one
    // spelling is executable. With the route-side prefix refusal unbuilt, this
    // narrowness is the ONLY thing keeping a recorded case variant out of the
    // executable drain — widen it and variants become executable.
    const rows = this.db
      .prepare(
        `SELECT * FROM outbox_entries
          WHERE delivery_state = 'pending' AND substr(outbox_id, 1, ?) = ?
          ORDER BY ts_dispatched ASC, rowid ASC LIMIT ?`
      )
      .all(idPrefix.length, idPrefix, limit) as OutboxEntryRow[];
    return rows.map((r) => this.rowToEntry(r));
  }

  /**
   * BLOCKING 1 (guard re-seal): at a process/recovery boundary, atomically
   * reconcile ABANDONED claims — rows a crashed process left in the transient
   * `sending` state — to `indeterminate` WITHOUT re-sending. A `sending` row is
   * ambiguous (the external send may or may not have landed after the claim), so
   * it records `indeterminate`, never a forever-transient claim and never a blind
   * re-send. EXACT-CASE prefix, matching the executable selector. Returns the
   * count reconciled. A row the seat's hook bridge (slice 13) still owns stays as it is: one only queued is delivered or
   * typed by the bridge's sweep, and one its waiter claimed is named uncertain by the bridge, never resent. Every other
   * receipt, including none, an ordinary one and one that isn't JSON, is reconciled as before.
   */
  reconcileAbandonedSending(idPrefix: string): number {
    // A CASE, not NOT(...): a receipt without these fields reads NULL there, and NOT NULL would skip the row.
    const result = this.db
      .prepare(
        `UPDATE outbox_entries SET delivery_state = 'indeterminate'
          WHERE delivery_state = 'sending' AND substr(outbox_id, 1, ?) = ?
            AND CASE WHEN guard_delivery IS NOT NULL AND json_valid(guard_delivery)
              THEN COALESCE(json_extract(guard_delivery, '$.channel') = 'hook-bridge' AND json_extract(guard_delivery, '$.state') IN ('queued', 'claimed'), 0)
              ELSE 0 END = 0`
      )
      .run(idPrefix.length, idPrefix);
    return result.changes;
  }

  private getByIdRaw(outboxId: string): OutboxEntryRow | undefined {
    return this.db
      .prepare("SELECT * FROM outbox_entries WHERE outbox_id = ?")
      .get(outboxId) as OutboxEntryRow | undefined;
  }

  private getByIdOrThrow(outboxId: string): OutboxEntry {
    const entry = this.getById(outboxId);
    if (!entry) throw new OutboxHandlerError("outbox_not_found", `outbox ${outboxId} not found after write`);
    return entry;
  }

  private rowToEntry(row: OutboxEntryRow): OutboxEntry {
    return {
      outboxId: row.outbox_id,
      senderSession: row.sender_session,
      destinationSession: row.destination_session,
      body: row.body,
      tags: row.tags ? (JSON.parse(row.tags) as string[]) : null,
      urgency: row.urgency,
      tsDispatched: row.ts_dispatched,
      deliveryState: parseDeliveryState(row.delivery_state),
      deliveredAt: row.delivered_at,
      auditPointer: row.audit_pointer,
      ...(row.guard_binding !== undefined ? {
        guardBinding: row.guard_binding ? JSON.parse(row.guard_binding) : null,
        retiredAt: row.retired_at ?? null,
        retiredBy: row.retired_by ?? null,
        retirementReason: row.retirement_reason ?? null,
      } : {}),
    };
  }
}

/** The line a seat's new occupant is told when its seat holds messages (#2431): a started seat, a handover successor and a
 *  runtime-switch successor alike. Held messages are never replayed; null when there are none or no held-message store. */
export function heldMessagesNotice(db: Database.Database, nodeId: string, seat: string): string | null {
  let count = 0;
  try { count = new OutboxHandler(db).retentionUsage(nodeId).count; } catch { /* no held-message store: nothing to tell */ }
  return count ? `${count} held message${count === 1 ? " was" : "s were"} kept for this seat and not delivered: read ${count === 1 ? "it" : "them"} with rig seat held-messages ${seat}.` : null;
}
