import { OutboxHandler } from "./outbox-handler.js";
import { QueueWakeRepository } from "./queue-wake-repository.js";
import { resolveWakeRetryCap, resolveWakeRetryIntervalSeconds } from "./queue-wake-ladder.js";
import type { DeliveryFn, DeliveryOutcome, WatchdogDeliverySource } from "./watchdog-policy-engine.js";

const PREFIX = "watchdog-occurrence-";
type Receipt = { attempts: number; retryAt?: string; message: string; nextAction?: string; terminalReason?: string; ended?: boolean; error?: string; heldIds?: string[] };

/** Occurrence custody uses the existing outbox. The watchdog's own loop is its only retry driver.
 * Condition policies keep their existing receipts; this is for scheduled periodic reminders, including digests. */
export function withWatchdogReceipts(send: DeliveryFn, deps: {
  outbox: OutboxHandler; now?: () => Date; retryIntervalSeconds?: number; retryCap?: number;
}): DeliveryFn {
  const { outbox } = deps;
  const wakes = new QueueWakeRepository(outbox.db);
  const now = deps.now ?? (() => new Date());
  const interval = deps.retryIntervalSeconds ?? resolveWakeRetryIntervalSeconds();
  const cap = deps.retryCap ?? resolveWakeRetryCap();
  const members = (source: WatchdogDeliverySource) => source.policy !== "periodic-reminder" || !source.occurrenceId ? []
    : (source.members ?? [{ jobId: source.jobId, occurrenceId: source.occurrenceId }])
      .map(member => ({ ...member, id: PREFIX + member.occurrenceId }));
  const read = (id: string): Receipt | undefined => {
    const row = outbox.db.prepare("SELECT guard_delivery FROM outbox_entries WHERE outbox_id=?").get(id) as { guard_delivery: string | null };
    return row.guard_delivery ? JSON.parse(row.guard_delivery).watchdog : undefined;
  };
  const save = (id: string, receipt: Receipt) => outbox.db.prepare(
    "UPDATE outbox_entries SET guard_delivery=json_set(COALESCE(guard_delivery,'{}'),'$.watchdog',json(?),'$.ids',json(?)) WHERE outbox_id=?",
  ).run(JSON.stringify(receipt), JSON.stringify([id]), id);
  const reconcile = (source: WatchdogDeliverySource): DeliveryOutcome | null => {
    const selected = members(source);
    if (!selected.length) return null;
    const entries = selected.map(m => outbox.getById(m.id));
    if (entries.every(e => e?.deliveryState === "delivered")) {
      return { status: "ok", occurrenceTracked: true, reconciled: true, outboxIds: selected.map(m => m.id), sentMessage: read(selected[0]!.id)?.message };
    }
    if (entries.every(e => e?.deliveryState === "retained" || e?.deliveryState === "retired")) {
      return { status: "retained", occurrenceTracked: true, reconciled: true,
        outboxIds: [...new Set(selected.flatMap(m => [m.id, ...(read(m.id)?.heldIds ?? [])]))] };
    }
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry) continue;
      const receipt = read(selected[i]!.id);
      if (receipt?.ended || receipt?.terminalReason) return selected.length > 1 ? { status: "failed", occurrenceTracked: true, deferred: true }
        : { status: "failed", occurrenceTracked: true, outboxIds: [entry.outboxId],
          error: receipt.error ?? receipt.terminalReason, occurrenceComplete: true, terminalReason: receipt.terminalReason, nextAction: receipt.nextAction };
      if (entry.deliveryState === "sending" || entry.deliveryState === "indeterminate") {
        if (selected.length > 1) return { status: "failed", occurrenceTracked: true, deferred: true };
        return { status: "failed", occurrenceTracked: true, occurrenceComplete: true,
          inputPhase: "attempted", error: "Prior scheduled input is unconfirmed; no replay was attempted.",
          outboxIds: selected.map(m => m.id),
          nextAction: `Inspect outbox ${entry.outboxId} and the recipient before any manual replay; input is unconfirmed. This occurrence ends; the next regular cycle is a new occurrence.` };
      }
      if (entry.deliveryState === "delivered" || entry.deliveryState === "retained" || entry.deliveryState === "retired"
        || (receipt?.retryAt && Date.parse(receipt.retryAt) > now().getTime())) {
        // A pass can have collected new jobs before another member's receipt landed. Re-group next pass.
        return { status: "failed", occurrenceTracked: true, deferred: true, retryAt: receipt?.retryAt };
      }
    }
    return null;
  };

  const deliver: DeliveryFn = async (request, source) => {
    const selected = members(source);
    if (!selected.length) return send(request, source);
    const prior = reconcile(source);
    if (prior) return prior;
    const claimed = outbox.db.transaction(() => {
      for (const member of selected) {
        if (!outbox.getById(member.id)) {
          outbox.record({ outboxId: member.id, senderSession: "watchdog@system", destinationSession: request.targetSession,
            body: request.message, auditPointer: member.jobId });
          save(member.id, { attempts: 0, message: request.message });
        }
      }
      // Synchronous transaction: no other drainer can claim a subset between the check and these writes.
      if (selected.some(m => !["pending", "failed"].includes(outbox.getById(m.id)!.deliveryState))) return false;
      for (const member of selected) {
        outbox.claimForDelivery(member.id);
        const receipt = read(member.id)!;
        save(member.id, { attempts: (receipt?.attempts ?? 0) + 1, message: request.message });
      }
      return true;
    })();
    if (!claimed) return { status: "failed", occurrenceTracked: true, deferred: true };
    let result: DeliveryOutcome;
    try { result = await send(request, source); }
    catch (error) { result = { status: "failed", error: (error as Error).message }; }
    const noInput = result.sent === false || result.inputPhase === "not_reached";
    const permanent = result.transportReason === "transport_unavailable" || result.code === "terminal_seat"
      || result.code === "retained_quota_full";
    const memberOutcomes: Record<string, DeliveryOutcome> = {};
    outbox.db.transaction(() => {
      for (const member of selected) {
        const receipt = read(member.id)!;
        let retryAt: string | undefined, nextAction: string | undefined, terminalReason: string | undefined;
        // No input reached the seat: keep this park's same occurrence owed until delivery or the park ends.
        const owedParkWake = noInput && wakes.hasOwedOneShotParkWake(member.jobId);
        const exhausted = receipt.attempts > cap && !owedParkWake;
        const unavailable = permanent && !owedParkWake;
        const state = result.status === "ok" ? "delivered" : result.status === "retained" ? "retained"
          : noInput ? "failed" : "indeterminate";
        if (result.status === "retained") {
          nextAction = `Retained by existing input protection; inspect held messages ${(result.outboxIds ?? []).join(", ")}. Nothing was delivered.`;
        }
        if (result.status === "failed") {
          if (noInput && unavailable) {
            terminalReason = "watchdog_delivery_unavailable";
            nextAction = `Inspect outbox ${member.id}: ${result.error ?? result.transportReason ?? "delivery failed"}. Fix the destination and register a replacement reminder.`;
          } else if (noInput && exhausted) {
            nextAction = `Inspect outbox ${member.id}: retry budget exhausted. This occurrence ends; the next regular cycle is a new occurrence. A one-shot timer records its failed wake and ends.`;
          } else if (noInput) {
            retryAt = new Date(now().getTime() + interval * 1000).toISOString();
            nextAction = `Occurrence remains owed; retry at ${retryAt}. Inspect outbox ${member.id}.`;
          } else {
            nextAction = `Inspect outbox ${member.id} and the recipient before any manual replay; input is unconfirmed. This occurrence ends; the next regular cycle is a new occurrence.`;
          }
        }
        const ended = result.status === "failed" && (!noInput || unavailable || exhausted);
        outbox.finalizeDelivery(member.id, state);
        save(member.id, { ...receipt, ...(ended ? { ended: true, error: result.error } : {}), ...(result.status === "retained" ? { heldIds: result.outboxIds ?? [] } : {}),
          ...(retryAt ? { retryAt } : {}), ...(nextAction ? { nextAction } : {}),
          ...(terminalReason ? { terminalReason } : {}) });
        memberOutcomes[member.jobId] = { ...result, occurrenceTracked: true, ...(ended ? { occurrenceComplete: true } : {}),
          outboxIds: [...new Set([member.id, ...(result.outboxIds ?? [])])], ...(retryAt ? { retryAt } : {}),
          ...(nextAction ? { nextAction } : {}), ...(terminalReason ? { terminalReason } : {}) };
      }
    })();
    return { ...memberOutcomes[selected[0]!.jobId]!, memberOutcomes };
  };
  deliver.reconcile = reconcile;
  return deliver;
}
