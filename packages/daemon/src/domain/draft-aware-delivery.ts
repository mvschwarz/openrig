import type Database from "better-sqlite3";
import { OutboxHandler, type OutboxEntry } from "./outbox-handler.js";
import { DeliveryGuardError, type SeatDeliveryGuard } from "./seat-delivery-guard.js";
import type { SendOpts, SendResult } from "./session-transport.js";

export interface GuardedDeliverySummary {
  id: string;
  state: "sending" | "held" | "complete" | "failed" | "indeterminate";
  reason: string;
}

/** Historical attempts contain outcomes, never executable options or callbacks. */
interface Receipt { ids: string[]; result?: SendResult }
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
    const state = entry.deliveryState === "retained" || entry.deliveryState === "retired" ? "held"
      : entry.deliveryState === "delivered" ? "complete" : entry.deliveryState === "sending" ? "sending" : entry.deliveryState === "failed" ? "failed" : "indeterminate";
    const reason = entry.deliveryState === "retired" ? "message_retired" : receipt.result?.reason
      ?? (state === "sending" ? "delivery_in_progress" : state === "complete" ? "delivered" : "interrupted_write");
    return { id: receipt.ids[0]!, state, reason };
  }

  /** The existing per-seat lease serializes requests. Each current request gets an attempt, not an old result. */
  async send(session: string, text: string, opts: SendOpts, ids: string[]): Promise<SendResult> {
    if (!ids.length || new Set(ids).size !== ids.length) throw new DeliveryGuardError("invalid_delivery_ids", "Distinct delivery IDs are required.");
    const pending = this.attempt(session, text, opts, { ids });
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
    try {
      this.db.transaction(() => {
        for (const id of receipt.ids) {
          const entry = opts.committedOutboxIds ? this.outbox.getById(id) : null;
          this.outbox.retain(entry ? { ...entry, tags: entry.tags ?? undefined, auditPointer: entry.auditPointer ?? undefined }
            : { outboxId: id, senderSession: opts.actorSession ?? "unknown", destinationSession: session, body: text,
              auditPointer: opts.auditPointer, identityProvenance: opts.identityProvenance, ...(opts.urgent ? { urgency: "urgent" } : {}) },
            target, !!opts.committedOutboxIds);
          this.db.prepare("UPDATE outbox_entries SET delivery_state='sending',guard_delivery=? WHERE outbox_id=?")
            .run(JSON.stringify(receipt), id);
        }
      })();
      recorded = true;
    } catch { /* Bookkeeping cannot veto input; report its absence with the actual result. */ }
    try {
      await this.guard.beforeInput(session);
      result = await this.deliver(session, text, { ...opts,
        onInputEffect: phase => { inputWritten = true; opts.onInputEffect?.(phase); },
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
        reason: guardError ? error.code : "delivery_indeterminate", error: detail };
    }
    if (inputWritten) result = { ...result, sent: true };
    const preInputRefusal = ["draft_input_busy", "draft_input_unknown", "draft_input_changed", "draft_wake_superseded",
      "target_needs_input", "wait_for_idle_timeout", "target_activity_unknown", "target_runtime_unverified", "target_runtime_not_running", "target_runtime_conflict",
      "invalid_wait_for_idle", "invalid_dangerously_interact", "dangerously_interact_requires_reason", "prompt_override_audit_unavailable",
      "transport_unavailable", "session_missing", "tmux_unavailable"].includes(result.reason ?? "");
    const noWrite = !result.ok && !inputWritten && preInputRefusal;
    if (noWrite) result = { ...result, ok: true, sent: false, verified: false, outcome: "retained",
      warning: "Held, not delivered. Retry the current request when the input is free; no saved callback or message is replayed automatically." };
    else if (!inputWritten && result.sent === false && result.inputPhase !== "not_reached") {
      // A wait-path failure can follow a dispatched native write. Only a positive pre-input result proves no write.
      const { sent: _sent, ...uncertain } = result; result = uncertain;
    }
    if (opts.deliveryId && !opts.committedOutboxIds) result = { ...result,
      warning: [result.warning, "Delivery IDs do not deduplicate requests; this is a new input attempt."].filter(Boolean).join(" ") };
    const state = noWrite ? "retained" : result.sent === false ? "failed" : result.ok && (result.verified || !opts.verify) ? "delivered" : "indeterminate";
    if (recorded) {
      try {
        this.db.transaction(() => {
          for (const id of receipt.ids) {
            this.outbox.finalizeDelivery(id, state);
            this.db.prepare("UPDATE outbox_entries SET guard_delivery=? WHERE outbox_id=?").run(JSON.stringify({ ...receipt, result }), id);
          }
        })();
      } catch { recorded = false; }
    }
    if (!recorded) {
      const warning = "Delivery bookkeeping is unavailable; this result describes the input attempt, not a saved receipt. Repeating the request may duplicate input.";
      // The input was protected, but failed bookkeeping cannot claim durable custody of its message.
      if (noWrite) result = { ...result, ok: false, outcome: "failed" };
      return { ...result, warning: [result.warning, warning].filter(Boolean).join(" ") };
    }
    return { ...result, outboxIds: receipt.ids };
  }

  /** Preserve uncertainty in old history without scheduling a replay. */
  recover(): void {
    this.db.prepare("UPDATE outbox_entries SET delivery_state='indeterminate' WHERE guard_delivery IS NOT NULL AND delivery_state='sending'").run();
  }

  async stop(): Promise<void> { await Promise.allSettled([...this.sends]); }
}
