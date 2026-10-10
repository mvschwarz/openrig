import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { OutboxHandler, type OutboxEntry } from "./outbox-handler.js";
import { DeliveryGuardError, type SeatDeliveryGuard } from "./seat-delivery-guard.js";
import type { SendOpts, SendResult } from "./session-transport.js";

export interface GuardedDeliverySummary {
  id: string;
  state: "sending" | "held" | "complete" | "indeterminate";
  reason: string;
}

/** Only receipt identity and the observed outcome live beside each original row.
 * No executable options, timer, deadline or request queue survive a send. */
interface Receipt { ids: string[]; textHash: string; result?: SendResult }
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
type Deliver = (session: string, text: string, opts: SendOpts) => Promise<SendResult>;

export class DraftAwareDelivery {
  private readonly outbox: OutboxHandler;
  private readonly sends = new Set<Promise<SendResult>>();
  private wakeApplicable?: (entries: readonly OutboxEntry[]) => boolean;

  constructor(private readonly db: Database.Database, private readonly guard: SeatDeliveryGuard, private readonly deliver: Deliver) {
    this.outbox = new OutboxHandler(db);
  }

  configureWakes(applicable: (entries: readonly OutboxEntry[]) => boolean): void { this.wakeApplicable = applicable; }

  private receipt(id: string): Receipt | null {
    const row = this.db.prepare("SELECT guard_delivery FROM outbox_entries WHERE outbox_id=?").get(id) as { guard_delivery: string | null } | undefined;
    return row?.guard_delivery ? JSON.parse(row.guard_delivery) as Receipt : null;
  }

  lookup(id: string): GuardedDeliverySummary | null {
    const receipt = this.receipt(id);
    if (!receipt) return null;
    const entry = this.outbox.getById(id)!;
    const state = entry.deliveryState === "retained" || entry.deliveryState === "retired" ? "held"
      : entry.deliveryState === "delivered" ? "complete" : entry.deliveryState === "sending" ? "sending" : "indeterminate";
    const reason = entry.deliveryState === "retired" ? "message_retired" : receipt.result?.reason
      ?? (state === "sending" ? "delivery_in_progress" : state === "complete" ? "delivered" : "interrupted_write");
    return { id: receipt.ids[0]!, state, reason };
  }

  private result(id: string, receipt: Receipt): SendResult {
    const entry = this.outbox.getById(id)!;
    const delivery = this.lookup(id)!;
    if (receipt.result && entry.deliveryState !== "retired") return { ...receipt.result, outboxIds: receipt.ids, delivery };
    if (delivery.state === "held") return { ok: true, sessionName: entry.destinationSession, sent: false, verified: false,
      outcome: "retained", reason: delivery.reason, outboxIds: receipt.ids, delivery };
    return { ok: false, sessionName: entry.destinationSession, outcome: "failed", outboxIds: receipt.ids, delivery,
      reason: delivery.state === "sending" ? "delivery_in_progress" : "delivery_indeterminate",
      error: "This delivery has an unresolved write attempt. Inspect its existing ID; it is not replayed." };
  }

  existing(session: string, text: string, opts: SendOpts, ids: string[]): SendResult | null {
    const receipt = this.receipt(ids[0]!);
    if (!receipt) return null;
    const entry = this.outbox.getById(ids[0]!)!;
    if (receipt.textHash !== hash(text) || JSON.stringify(receipt.ids) !== JSON.stringify(ids)
      || entry.destinationSession !== session || entry.senderSession !== (opts.actorSession ?? "unknown")) {
      throw new DeliveryGuardError("delivery_identity_conflict", "This delivery ID already names different content or identity.");
    }
    return this.result(ids[0]!, receipt);
  }

  /** Called inside SessionTransport's existing per-seat lease. Try exactly once. */
  async send(session: string, text: string, opts: SendOpts, ids: string[]): Promise<SendResult> {
    const prior = this.existing(session, text, opts, ids);
    if (prior) return prior;
    if (!ids.length || new Set(ids).size !== ids.length) throw new DeliveryGuardError("invalid_delivery_ids", "Distinct delivery IDs are required.");
    const target = this.guard.target(session);
    const receipt: Receipt = { ids, textHash: hash(text) };
    this.db.transaction(() => {
      for (const id of ids) {
        const entry = opts.committedOutboxIds ? this.outbox.getById(id) : null;
        if (opts.committedOutboxIds && !entry) throw new DeliveryGuardError("outbox_not_found", "A committed wake is missing; no replacement message was created.");
        this.outbox.retain(entry ? { ...entry, tags: entry.tags ?? undefined, auditPointer: entry.auditPointer ?? undefined }
          : { outboxId: id, senderSession: opts.actorSession ?? "unknown", destinationSession: session, body: text,
            auditPointer: opts.auditPointer, identityProvenance: opts.identityProvenance }, target, !!opts.committedOutboxIds);
        const claimed = this.db.prepare("UPDATE outbox_entries SET delivery_state='sending',guard_delivery=? WHERE outbox_id=? AND delivery_state='retained' AND guard_delivery IS NULL")
          .run(JSON.stringify(receipt), id);
        if (claimed.changes !== 1) throw new DeliveryGuardError("delivery_already_attempted", "This original delivery cannot be attempted again.");
      }
    })();
    const pending = this.attempt(session, text, opts, receipt);
    this.sends.add(pending);
    try { return await pending; }
    finally { this.sends.delete(pending); }
  }

  private async attempt(session: string, text: string, opts: SendOpts, receipt: Receipt): Promise<SendResult> {
    let result: SendResult;
    let inputWritten = false;
    const entries = receipt.ids.map(id => this.outbox.getById(id)!);
    try {
      // Draft-aware is an immediate decision, including when a caller requested wait-for-idle.
      await this.guard.beforeInput(session);
      result = await this.deliver(session, text, { ...opts,
        onInputEffect: phase => { inputWritten = true; opts.onInputEffect?.(phase); },
        beforeWrite: () => {
          if (opts.queueWake && !this.wakeApplicable?.(entries)) throw new DeliveryGuardError("draft_wake_superseded", "The queue wake is no longer applicable; no further input was written.");
          opts.beforeWrite?.();
        },
      });
    } catch (error) {
      const refusal = error instanceof DeliveryGuardError && error.code.startsWith("draft_");
      result = { ok: false, sessionName: session, outcome: "failed",
        ...(refusal || inputWritten ? { sent: inputWritten } : {}), reason: refusal ? error.code : "delivery_indeterminate",
        error: refusal ? error.message : "The delivery attempt ended without a reliable write result. It is not replayed." };
    }
    if (inputWritten) result = { ...result, sent: true };
    const preInputRefusal = ["draft_input_busy", "draft_input_unknown", "draft_input_changed", "draft_wake_superseded",
      "target_needs_input", "wait_for_idle_timeout", "target_activity_unknown", "target_runtime_unverified", "target_runtime_not_running", "target_runtime_conflict",
      "invalid_wait_for_idle", "invalid_dangerously_interact", "dangerously_interact_requires_reason", "prompt_override_audit_unavailable",
      "transport_unavailable", "session_missing", "tmux_unavailable"].includes(result.reason ?? "");
    const noWrite = !result.ok && !inputWritten && preInputRefusal;
    if (noWrite) result = { ...result, ok: true, sent: false, verified: false, outcome: "retained",
      warning: "Held, not delivered. No automatic retry is scheduled. Inspect the original ID with rig seat held-messages." };
    else if (!inputWritten && result.sent === false) { const { sent: _sent, ...uncertain } = result; result = uncertain; }
    const state = noWrite ? "retained" : result.ok && (result.verified || !opts.verify) ? "delivered" : "indeterminate";
    try {
      this.db.transaction(() => {
        for (const id of receipt.ids) {
          this.outbox.finalizeDelivery(id, state);
          this.db.prepare("UPDATE outbox_entries SET guard_delivery=? WHERE outbox_id=?").run(JSON.stringify({ ...receipt, result }), id);
        }
      })();
    } catch {
      // Never turn a lost ledger acknowledgement into permission to replay a write.
      try { this.db.transaction(() => receipt.ids.forEach(id => this.outbox.finalizeDelivery(id, "indeterminate")))(); } catch { /* Startup recovery owns abandoned claims. */ }
    }
    try { return this.result(receipt.ids[0]!, this.receipt(receipt.ids[0]!)!); }
    catch {
      return { ok: false, sessionName: session, outcome: "failed", reason: "delivery_indeterminate", outboxIds: receipt.ids,
        delivery: { id: receipt.ids[0]!, state: "indeterminate", reason: "receipt_unavailable" },
        error: "The final delivery receipt could not be read. Inspect the original IDs; no replay is authorized." };
    }
  }

  /** Startup reconciles uncertain writes only; held messages stay held. */
  recover(): void {
    this.db.prepare("UPDATE outbox_entries SET delivery_state='indeterminate' WHERE guard_delivery IS NOT NULL AND delivery_state='sending'").run();
  }

  async stop(): Promise<void> { await Promise.allSettled([...this.sends]); }
}
