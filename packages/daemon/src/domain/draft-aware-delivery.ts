import type Database from "better-sqlite3";
import { DRAFT_HELD_BEHIND_EARLIER, DRAFT_HELD_ELIGIBLE_TAG, DRAFT_HELD_PER_SENDER, DRAFT_HELD_REASONS, HELD_QUOTA_BYTES, HELD_QUOTA_COUNT, HELD_RETRY_NOT_ADMITTED, OutboxHandler, OutboxHandlerError, type OutboxEntry } from "./outbox-handler.js";
import { isOpenRigSender } from "../lib/pane-envelope.js";
import { HOOK_BRIDGE_CHANNEL } from "./hook-bridge.js";

/** OpenRig's own senders, which have their own schedules: the daemon and its subsystem actors (`isOpenRigSender`), and the
 *  `…@system` machinery (a watchdog, the wake ladder), as the stuck sweep reads them. */
const openRigOwnSender = (sender: string): boolean => isOpenRigSender(sender) || sender.endsWith("@system");
/** A plain message from an agent or a person: not a queue wake (it has its own retry) and not OpenRig's own notice or
 *  sender (the daemon, a watchdog, a notice), which keep their own schedules. */
const plainMessage = (opts: SendOpts): opts is SendOpts & { actorSession: string } => !opts.queueWake && !opts.openrigNotice && !!opts.actorSession && !openRigOwnSender(opts.actorSession);
/** Whether the seat's draft-aware delivery is on (requested or in effect), as the draft-held pass itself reads it. */
const draftAwareOn = (guard: SeatDeliveryGuard, nodeId: string): boolean => {
  const policy = guard.configuration(nodeId);
  return policy.desired.mode === "draft-aware" || policy.effective.mode === "draft-aware";
};
import { DeliveryGuardError, type GuardTarget, type SeatDeliveryGuard } from "./seat-delivery-guard.js";
import type { SendOpts, SendResult } from "./session-transport.js";

export interface GuardedDeliverySummary {
  id: string;
  state: "sending" | "held" | "complete" | "failed" | "indeterminate";
  reason: string;
  /** A message held before any paste although its composer read as empty (such as a Codex message that wouldn't stay
   *  visible in its viewport, #2242): the input read's own status and reason, and the guard's explanation, so the
   *  summary doesn't read as an unknown composer or a draft. */
  inputRead?: { status: "empty"; reason: string; message: string };
}

/** Historical attempts contain outcomes, never executable options or callbacks. */
interface Receipt { inputRoute?: "typed"; ids: string[]; result?: SendResult; expectedIdentity?: import("./expected-conversation.js").ExpectedConversation;
  watchdog?: { nextAction?: string } }
type Deliver = (session: string, text: string, opts: SendOpts) => Promise<SendResult>;
/** Applicability needs the intended queue row and recipient, not a saved delivery receipt. */
export type QueueWakeFacts = Pick<OutboxEntry, "outboxId" | "auditPointer" | "destinationSession">;

export class DraftAwareDelivery {
  private readonly outbox: OutboxHandler;
  private readonly sends = new Set<Promise<SendResult>>();
  private wakeApplicable?: (entries: readonly QueueWakeFacts[]) => boolean;

  constructor(private readonly db: Database.Database, private readonly guard: SeatDeliveryGuard, private readonly deliver: Deliver) {
    this.outbox = new OutboxHandler(db);
  }

  configureWakes(applicable: (entries: readonly QueueWakeFacts[]) => boolean): void { this.wakeApplicable = applicable; }

  /** Read-only history for the held-messages surface. It is not consulted by send. */
  lookup(id: string): GuardedDeliverySummary | null {
    const row = this.db.prepare("SELECT guard_delivery FROM outbox_entries WHERE outbox_id=?").get(id) as { guard_delivery: string | null } | undefined;
    if (!row?.guard_delivery) return null;
    const receipt = JSON.parse(row.guard_delivery) as Receipt;
    const entry = this.outbox.getById(id)!;
    // Route/identity retention alone is not an attempt. A held attempt has a result;
    // unfinished attempts keep their sending/indeterminate phase, including native custody.
    if (!receipt.result && !receipt.watchdog?.nextAction && ["pending", "retained", "retired"].includes(entry.deliveryState)) return null;
    const state = entry.deliveryState === "retained" || entry.deliveryState === "retired" ? "held"
      : entry.deliveryState === "delivered" ? "complete" : entry.deliveryState === "sending" ? "sending" : entry.deliveryState === "failed" ? "failed" : "indeterminate";
    const reason = entry.deliveryState === "retired" ? "message_retired" : receipt.result?.reason ?? receipt.watchdog?.nextAction
      ?? (state === "sending" ? "delivery_in_progress" : state === "complete" ? "delivered" : "interrupted_write");
    // The receipt already holds the distinction; carry it for a retained message whose composer read as empty.
    const read = receipt.result?.inputReadFailure;
    const inputRead = entry.deliveryState === "retained" && read?.status === "empty" && typeof receipt.result?.error === "string"
      ? { status: "empty" as const, reason: read.reason, message: receipt.result.error } : undefined;
    return { id: receipt.ids[0]!, state, reason, ...(inputRead ? { inputRead } : {}) };
  }

  /** The existing per-seat lease serializes requests. Each current request gets an attempt, not an old result. */
  async send(session: string, text: string, opts: SendOpts, ids: string[]): Promise<SendResult> {
    if (!ids.length || new Set(ids).size !== ids.length) throw new DeliveryGuardError("invalid_delivery_ids", "Distinct delivery IDs are required.");
    const pending = this.attempt(session, text, opts, { ids, inputRoute: "typed", ...(opts.expectedIdentity ? { expectedIdentity: opts.expectedIdentity } : {}) });
    this.sends.add(pending);
    try { return await pending; }
    finally { this.sends.delete(pending); }
  }

  private async attempt(session: string, text: string, opts: SendOpts, receipt: Receipt): Promise<SendResult> {
    let result: SendResult;
    let inputWritten = false;
    const target = this.guard.target(session);
    const entries: QueueWakeFacts[] = !opts.queueWake ? [] : opts.committedOutboxIds
      ? receipt.ids.map(id => this.outbox.getById(id)!)
      : [{ outboxId: receipt.ids[0]!, auditPointer: opts.auditPointer ?? null, destinationSession: session }];
    let recorded = false;
    let quotaFull = false;
    try {
      this.db.transaction(() => {
        for (const id of receipt.ids) {
          const entry = opts.committedOutboxIds ? this.outbox.getById(id) : null;
          this.outbox.retain(entry ? { ...entry, tags: entry.tags ?? undefined, auditPointer: entry.auditPointer ?? undefined }
            : { outboxId: id, senderSession: opts.actorSession ?? "unknown", destinationSession: session, body: text,
              auditPointer: opts.auditPointer, identityProvenance: opts.identityProvenance, identityPrincipal: opts.identityPrincipal, ...(opts.urgent ? { urgency: "urgent" } : {}) },
            target, !!opts.committedOutboxIds, { coalesce: false, sameSend: receipt.ids });
          this.db.prepare("UPDATE outbox_entries SET delivery_state='sending',guard_delivery=? WHERE outbox_id=?")
            .run(JSON.stringify(receipt), id);
        }
      })();
      recorded = true;
    } catch (error) {
      if (opts.expectedIdentity) throw error; // A conditional send cannot lose its durable constraint and still type.
      /* Legacy bookkeeping cannot veto input; report its absence with the actual result. */
      quotaFull = error instanceof OutboxHandlerError && error.code === "retained_quota_full";
    }
    try {
      // Same-sender order: while this sender's earlier plain message is still held for the draft, a later one goes behind
      // it instead of being typed first (a stale request would then follow its correction). It's held, with its own
      // outcome, and typed after the earlier one; nothing is refused. Only a saved message with room in the quota waits,
      // and only while draft-aware delivery is on, the one mode in which the earlier message is typed once the input clears.
      if (recorded && this.holdsBehindEarlier(target, text, opts, receipt.ids)) {
        throw new DeliveryGuardError(DRAFT_HELD_BEHIND_EARLIER, "An earlier message from this sender is held for this seat's draft. This one is held behind it and typed after it, in order; nothing was pasted.");
      }
      // A paste the guard left unsubmitted (#2429) is recognized here, to be submitted ahead of this delivery, unless the
      // delivery needs an idle seat: submitting it starts a turn, so that delivery is held as before.
      await this.guard.beforeInput(session, false, undefined, opts.waitForIdleMs === undefined && !opts.preserveInput ? "recognize" : undefined);
      result = await this.deliver(session, text, { ...opts,
        onInputEffect: (phase, written) => { inputWritten = true; opts.onInputEffect?.(phase, written); },
        beforeWrite: () => {
          if (opts.queueWake && !this.wakeApplicable?.(entries)) throw new DeliveryGuardError("draft_wake_superseded", "The queue wake is no longer applicable; no further input was written.");
          opts.beforeWrite?.();
        },
      });
    } catch (error) {
      const guardError = error instanceof DeliveryGuardError;
      const effect = (error ?? {}) as { inputWritten?: boolean; inputAttempted?: boolean; enterAttempted?: boolean };
      inputWritten ||= effect.inputWritten === true;
      const inputPhase = inputWritten ? "written" : effect.inputAttempted ? "attempted" : guardError ? "not_reached" : undefined;
      const detail = inputWritten
        ? `Text was written to '${session}' but ${effect.enterAttempted ? "the Enter outcome is unconfirmed" : "Enter was not sent"}: ${error instanceof Error ? error.message : String(error)}`
        : guardError ? error.message : "The delivery attempt ended without a reliable write result. Repeating the request may duplicate input.";
      result = { ok: false, sessionName: session, outcome: "failed", inputPhase,
        ...(inputWritten || inputPhase === "not_reached" ? { sent: inputWritten } : {}),
        reason: guardError ? error.code : "delivery_indeterminate", error: detail,
        ...(guardError && error.inputReadFailure ? { inputReadFailure: error.inputReadFailure } : {}) };
    }
    if (inputWritten) result = { ...result, sent: true };
    const preInputRefusal = ["draft_input_busy", "draft_input_unknown", "draft_input_changed", "draft_wake_superseded", DRAFT_HELD_BEHIND_EARLIER, HELD_RETRY_NOT_ADMITTED,
      "target_needs_input", "wait_for_idle_timeout", "target_activity_unknown", "target_runtime_unverified", "target_runtime_not_running", "target_runtime_conflict",
      "invalid_wait_for_idle", "invalid_dangerously_interact", "dangerously_interact_requires_reason", "prompt_override_audit_unavailable",
      "transport_unavailable", "session_missing", "tmux_unavailable"].includes(result.reason ?? "");
    const noWrite = !result.ok && !inputWritten && preInputRefusal;
    // A plain message from an agent or a person, held only for a draft in the input, is typed once the input is clear. A
    // queue wake has its own retry, and OpenRig's own senders (the daemon, a watchdog, a notice) their own schedules, so
    // neither is. It keeps its own outcome while the seat's held quota has room; at a full quota it takes its sender's
    // place as any held message does (#2430). Past DRAFT_HELD_PER_SENDER from one sender, that sender's oldest is
    // coalesced into its newest (supersedeDraftHeld), so one sender can't fill the quota.
    // A refusal about the message itself (tabs or control characters, a long Codex paste, a viewport too small for it)
    // asks the sender to send it differently: typing it later would only meet the same refusal, so it's held as before.
    // A refusal of this message's own paste: it can't be typed as it is, so a held one stops being owed to the draft.
    const ownPasteRefused = noWrite && !!result.inputReadFailure?.reason.startsWith("paste_");
    const draftHeld = noWrite && plainMessage(opts) && DRAFT_HELD_REASONS.has(result.reason ?? "")
      && !result.inputReadFailure?.reason.startsWith("paste_")
      && !!target.nodeId && this.outbox.fitsWithoutCoalescing(target.nodeId, text);
    if (noWrite) result = { ...result, ok: true, sent: false, verified: false, outcome: "retained",
      warning: ownPasteRefused
        ? "Held, not delivered: this message can't be typed as it is (the error says why). Send it again changed; this one won't be typed later."
        : draftHeld && result.reason === DRAFT_HELD_BEHIND_EARLIER
        ? "Held, not delivered yet: an earlier message of yours is held for this seat's draft. This one is typed right after it once the input is clear, while draft-aware delivery stays on; nothing else is replayed."
        : draftHeld
        ? "Held, not delivered yet: the input shows a draft. It's typed once the input is clear while draft-aware delivery stays on, after any earlier held message; nothing else is replayed."
        : "Held, not delivered. Retry the current request when the input is free; no saved callback or message is replayed automatically." };
    else if (!inputWritten && result.sent === false && result.inputPhase !== "not_reached") {
      // A wait-path failure can follow a dispatched native write. Only a positive pre-input result proves no write.
      const { sent: _sent, ...uncertain } = result; result = uncertain;
    }
    // Whatever became of this delivery's own text, its record says it submitted OpenRig's earlier paste.
    if (this.guard.submittedOwnLeftover(session)) result = { ...result, ownPasteSubmitted: true,
      warning: [result.warning, "OpenRig first submitted its own earlier paste, left unsubmitted in this seat's input."].filter(Boolean).join(" ") };
    if (opts.deliveryId && !opts.committedOutboxIds) result = { ...result,
      warning: [result.warning, "Delivery IDs do not deduplicate requests; this is a new input attempt."].filter(Boolean).join(" ") };
    const state = noWrite ? "retained" : result.sent === false ? "failed" : result.ok && (result.verified || !opts.verify) ? "delivered" : "indeterminate";
    const superseded: string[] = [];
    if (recorded) {
      try {
        this.db.transaction(() => {
          superseded.length = 0;
          for (const id of receipt.ids) {
            this.outbox.finalizeDelivery(id, state);
            if (ownPasteRefused) this.outbox.withdrawDraftHeld(id);
            if (draftHeld) {
              this.db.prepare(`UPDATE outbox_entries SET tags=json_insert(COALESCE(tags,'[]'),'$[#]',?)
                WHERE outbox_id=? AND NOT EXISTS (SELECT 1 FROM json_each(COALESCE(outbox_entries.tags,'[]')) WHERE value=?)`)
                .run(DRAFT_HELD_ELIGIBLE_TAG, id, DRAFT_HELD_ELIGIBLE_TAG);
              superseded.push(...this.outbox.supersedeDraftHeld(id));
            }
            this.db.prepare("UPDATE outbox_entries SET guard_delivery=? WHERE outbox_id=?").run(JSON.stringify({ ...receipt, result }), id);
          }
          // Settled as held: only now does it take its sender's place (#2430); a delivered attempt never absorbs held ones.
          if (state === "retained") for (const id of receipt.ids) this.outbox.coalesceSettled(id, receipt.ids);
        })();
      } catch { recorded = false; }
    }
    if (!recorded) {
      const quota = `This seat's held-message quota is full (${HELD_QUOTA_COUNT} messages or ${HELD_QUOTA_BYTES / (1024 * 1024)} MB)`;
      // "Retry" only when the guard held it and nothing was typed; otherwise repeating it may duplicate input.
      const warning = quotaFull
        ? noWrite
          ? `${quota}, so this message wasn't saved or delivered. Read or retire what's held (rig seat held-messages ${session}), then retry.`
          : `${quota}, so no receipt was saved for this message, which ${result.sent === true ? "was" : "may have been"} typed. Repeating it may duplicate input.`
        : "Delivery bookkeeping is unavailable; this result describes the input attempt, not a saved receipt. Repeating the request may duplicate input.";
      // The input was protected, but failed bookkeeping cannot claim durable custody of its message. Nothing then holds
      // it for the draft, so its promise to type it later isn't repeated.
      if (noWrite) result = { ...result, ok: false, outcome: "failed" };
      return { ...result, warning: [draftHeld ? undefined : result.warning, warning].filter(Boolean).join(" ") };
    }
    // Past the per-sender bound, the sender learns which of its held messages this one superseded.
    if (superseded.length) result = { ...result, warning: [result.warning, `This supersedes your earlier held message${superseded.length === 1 ? "" : "s"} ${superseded.join(", ")} here (past ${DRAFT_HELD_PER_SENDER} from one sender); ${superseded.length === 1 ? "it stays" : "they stay"} readable by ID and won't be typed.`].filter(Boolean).join(" ") };
    return { ...result, outboxIds: receipt.ids };
  }

  /** Same-sender order, one rule for the typed path and for the transport before a hook bridge can take a send: while
   *  this sender's earlier plain message is still owed to the draft (held, or claimed by its retry) at this exact
   *  occupant, this one waits behind it. Only a plain message, with room in the seat's held quota, while draft-aware
   *  delivery is on. A read that fails lets the message go as before. */
  holdsBehindEarlier(target: GuardTarget, text: string, opts: SendOpts, ids: readonly string[]): boolean {
    if (!plainMessage(opts) || !target.nodeId) return false;
    try {
      return draftAwareOn(this.guard, target.nodeId) && this.outbox.fitsWithoutCoalescing(target.nodeId, text)
        && this.outbox.hasEarlierDraftHeld(opts.actorSession, target, ids);
    } catch { return false; }
  }

  /** At daemon start, before anything in this process can take a claim (startup runs it before the hook bridge's sweep
   *  starts): preserve uncertainty in old history without scheduling a replay. A message the hook bridge queued that no
   *  waiter took was never handed to anyone, so it stays queued for the bridge to deliver, once, by its own rules. */
  recover(): void {
    this.db.prepare(`UPDATE outbox_entries SET delivery_state='indeterminate' WHERE guard_delivery IS NOT NULL AND delivery_state='sending'
      AND NOT (CASE WHEN json_valid(guard_delivery) THEN json_extract(guard_delivery,'$.channel') IS ?
        AND json_extract(guard_delivery,'$.state') IS 'queued' ELSE 0 END)`).run(HOOK_BRIDGE_CHANNEL);
    // `IS`, not `=`: a receipt with no channel or state reads NULL there, and `NOT NULL` would skip the row.
    // A draft-held message claimed with no receipt yet, such as one the hook bridge handed back for typing
    // (HookBridge.releaseForTyping) before the typed send wrote its own: whether it was typed is unknown, and it would
    // otherwise hold its sender's later messages behind it for good.
    this.db.prepare(`UPDATE outbox_entries SET delivery_state='indeterminate' WHERE guard_delivery IS NULL AND delivery_state='sending'
      AND EXISTS (SELECT 1 FROM json_each(COALESCE(outbox_entries.tags,'[]')) WHERE value=?)`).run(DRAFT_HELD_ELIGIBLE_TAG);
  }

  async stop(): Promise<void> { await Promise.allSettled([...this.sends]); }
}
