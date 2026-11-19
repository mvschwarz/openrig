import { OutboxHandler } from "./outbox-handler.js";
import { QueueWakeRepository } from "./queue-wake-repository.js";
import { resolveWakeRetryCap, resolveWakeRetryIntervalSeconds } from "./queue-wake-ladder.js";
import type { DeliveryFn, DeliveryOutcome, WatchdogDeliverySource } from "./watchdog-policy-engine.js";
import { isQueueOnlyDeliveryCode, QUEUED_AS_ROW, type QueueOnlyDeliveryCode } from "./watchdog-history-log.js";
import type { WatchdogUsageLimitState } from "./watchdog-usage-limit.js";

const PREFIX = "watchdog-occurrence-";

/** The id of the cold row a reminder occurrence becomes at a queue-only seat: a retried occurrence (or digest) finds the
 *  same row. */
export function queueOnlyRowId(occurrenceId: string): string {
  return `qitem-watchdog-${occurrenceId.replace(/[^A-Za-z0-9-]/g, "-")}`;
}
type Receipt = { attempts: number; retryAt?: string; message: string; nextAction?: string; terminalReason?: string; ended?: boolean; error?: string; heldIds?: string[];
  usageLimit?: { identity: string; asOf: string; resetsAt: string; ordinaryRetryAt: string };
  /** A changed account/occupant or positive activity invalidated this old limit for this occurrence. */
  ignoreLimitThrough?: string;
  /** At a queue-only seat (#3076), what the occurrence became; its outbox `delivered` is custody, not typed input. */
  queueOnly?: { code: QueueOnlyDeliveryCode; qitemId?: string };
  /** The attempt was to a queue-only seat: it writes a queue row or note, never terminal input. */
  queueOnlyTarget?: boolean };

/** Occurrence custody uses the existing outbox. The watchdog's own loop is its only retry driver.
 * Condition policies keep their existing receipts; this is for scheduled periodic reminders, including digests. */
export function withWatchdogReceipts(send: DeliveryFn, deps: {
  outbox: OutboxHandler; now?: () => Date; retryIntervalSeconds?: number; retryCap?: number;
  isQueueOnlySeat?: (sessionName: string) => boolean;
  readUsageLimitState?: (sessionName: string) => WatchdogUsageLimitState | null;
}): DeliveryFn {
  const { outbox } = deps;
  const wakes = new QueueWakeRepository(outbox.db);
  const now = deps.now ?? (() => new Date());
  const interval = deps.retryIntervalSeconds ?? resolveWakeRetryIntervalSeconds();
  const cap = deps.retryCap ?? resolveWakeRetryCap();
  const readLimit = (session: string) => {
    try { return deps.readUsageLimitState?.(session) ?? null; } catch { return null; }
  };
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
      const first = read(selected[0]!.id);
      return { status: "ok", occurrenceTracked: true, reconciled: true, outboxIds: selected.map(m => m.id), sentMessage: first?.message,
        ...(first?.queueOnly ? { code: first.queueOnly.code, ...(first.queueOnly.qitemId ? { queuedQitemId: first.queueOnly.qitemId } : {}) } : {}) };
    }
    if (entries.every(e => e?.deliveryState === "retained" || e?.deliveryState === "retired")) {
      return { status: "retained", occurrenceTracked: true, reconciled: true,
        outboxIds: [...new Set(selected.flatMap(m => [m.id, ...(read(m.id)?.heldIds ?? [])]))] };
    }
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry) continue;
      let receipt = read(selected[i]!.id);
      if (entry.deliveryState === "failed" && receipt?.usageLimit) {
        const held = receipt.usageLimit, current = readLimit(entry.destinationSession);
        const recovered = current && (current.identity !== held.identity || Date.parse(current.clearedAt ?? "") > Date.parse(held.asOf));
        const stillLimited = current?.identity === held.identity && current.limit?.asOf === held.asOf
          && current.limit.resetsAt === held.resetsAt;
        if (recovered) {
          receipt = { ...receipt, usageLimit: undefined, retryAt: undefined, ignoreLimitThrough: held.asOf };
          save(entry.outboxId, receipt);
        } else if (!stillLimited && receipt.retryAt !== held.ordinaryRetryAt) {
          // Keep the old comparison key until the next attempt: a move after this unreadable tick still wakes early.
          receipt = { ...receipt, retryAt: held.ordinaryRetryAt };
          save(entry.outboxId, receipt);
        }
      }
      if (receipt?.ended || receipt?.terminalReason) return selected.length > 1 ? { status: "failed", occurrenceTracked: true, deferred: true }
        : { status: "failed", occurrenceTracked: true, outboxIds: [entry.outboxId],
          error: receipt.error ?? receipt.terminalReason, occurrenceComplete: true, terminalReason: receipt.terminalReason, nextAction: receipt.nextAction };
      if (entry.deliveryState === "sending" || entry.deliveryState === "indeterminate") {
        if (selected.length > 1) return { status: "failed", occurrenceTracked: true, deferred: true };
        // At a queue-only seat the interrupted write was a queue row or note: nothing could have been typed, so the
        // occurrence isn't ended. Its own open row is its delivery; without one it's owed again, under the same id (the
        // row is created idempotently by that id), so a park's one-shot wake isn't spent without a row or note.
        if (receipt?.queueOnlyTarget) {
          const qitemId = queueOnlyRowId(selected[0]!.occurrenceId);
          // One transaction, as a normal completion's finalize and receipt are: a stop between them can't leave the entry
          // delivered without its queue receipt (the row pointer).
          const queued = outbox.db.transaction(() => {
            const row = outbox.db.prepare("SELECT state FROM queue_items WHERE qitem_id=?").get(qitemId) as { state: string } | undefined;
            const open = !!row && ["pending", "in-progress", "blocked"].includes(row.state);
            if (entry.deliveryState === "indeterminate") outbox.claimForDelivery(entry.outboxId);
            outbox.finalizeDelivery(entry.outboxId, open ? "delivered" : "failed");
            if (open) save(entry.outboxId, { ...receipt, queueOnly: { code: QUEUED_AS_ROW, qitemId } });
            return open;
          })();
          if (!queued) return null;
          return { status: "ok", occurrenceTracked: true, reconciled: true, outboxIds: [entry.outboxId], sentMessage: receipt.message,
            code: QUEUED_AS_ROW, queuedQitemId: qitemId };
        }
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
      const queueOnlyTarget = deps.isQueueOnlySeat?.(request.targetSession) === true;
      for (const member of selected) {
        outbox.claimForDelivery(member.id);
        const receipt = read(member.id)!;
        save(member.id, { attempts: (receipt?.attempts ?? 0) + 1, message: request.message,
          ...(receipt.ignoreLimitThrough ? { ignoreLimitThrough: receipt.ignoreLimitThrough } : {}), ...(queueOnlyTarget ? { queueOnlyTarget } : {}) });
      }
      return true;
    })();
    if (!claimed) return { status: "failed", occurrenceTracked: true, deferred: true };
    const beforeLimit = selected.some(m => wakes.hasOwedOneShotParkWake(m.jobId)) ? readLimit(request.targetSession) : null;
    let result: DeliveryOutcome;
    try { result = await send(request, source); }
    catch (error) { result = { status: "failed", error: (error as Error).message }; }
    const noInput = result.sent === false || result.inputPhase === "not_reached";
    const permanent = result.transportReason === "transport_unavailable" || result.code === "terminal_seat"
      || result.code === "retained_quota_full";
    const afterLimit = noInput && result.transportReason === "target_needs_input" && beforeLimit ? readLimit(request.targetSession) : null;
    const memberOutcomes: Record<string, DeliveryOutcome> = {};
    outbox.db.transaction(() => {
      for (const member of selected) {
        const receipt = read(member.id)!;
        let retryAt: string | undefined, nextAction: string | undefined, terminalReason: string | undefined;
        let usageLimit: Receipt["usageLimit"], error = result.error;
        // An account/occupant move during the await must also invalidate the old hook on subsequent retries.
        if (beforeLimit?.limit && afterLimit && (beforeLimit.identity !== afterLimit.identity
          || Date.parse(afterLimit.clearedAt ?? "") > Date.parse(beforeLimit.limit.asOf))) {
          if (!(Date.parse(receipt.ignoreLimitThrough ?? "") >= Date.parse(beforeLimit.limit.asOf))) {
            receipt.ignoreLimitThrough = beforeLimit.limit.asOf;
          }
        }
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
            const limit = afterLimit?.limit;
            if (owedParkWake && afterLimit && limit && beforeLimit?.identity === afterLimit.identity
              && Date.parse(limit.resetsAt) > now().getTime()
              && !(Date.parse(afterLimit.clearedAt ?? "") > Date.parse(limit.asOf))
              && !(Date.parse(receipt.ignoreLimitThrough ?? "") >= Date.parse(limit.asOf))) {
              usageLimit = { identity: afterLimit.identity, ...limit, ordinaryRetryAt: retryAt };
              retryAt = limit.resetsAt;
              error = `${result.error ?? "Wake refused"}; usage limit until ${retryAt}`;
            }
            nextAction = `Occurrence remains owed; retry at ${retryAt}. Inspect outbox ${member.id}.`;
          } else {
            nextAction = `Inspect outbox ${member.id} and the recipient before any manual replay; input is unconfirmed. This occurrence ends; the next regular cycle is a new occurrence.`;
          }
        }
        const ended = result.status === "failed" && (!noInput || unavailable || exhausted);
        outbox.finalizeDelivery(member.id, state);
        save(member.id, { ...receipt, ...(usageLimit ? { usageLimit, error } : {}), ...(ended ? { ended: true, error } : {}), ...(result.status === "retained" ? { heldIds: result.outboxIds ?? [] } : {}),
          ...(result.status === "ok" && isQueueOnlyDeliveryCode(result.code)
            ? { queueOnly: { code: result.code, ...(result.queuedQitemId ? { qitemId: result.queuedQitemId } : {}) } } : {}),
          ...(retryAt ? { retryAt } : {}), ...(nextAction ? { nextAction } : {}),
          ...(terminalReason ? { terminalReason } : {}) });
        memberOutcomes[member.jobId] = { ...result, ...(usageLimit ? { error } : {}), occurrenceTracked: true, ...(ended ? { occurrenceComplete: true } : {}),
          outboxIds: [...new Set([member.id, ...(result.outboxIds ?? [])])], ...(retryAt ? { retryAt } : {}),
          ...(nextAction ? { nextAction } : {}), ...(terminalReason ? { terminalReason } : {}) };
      }
    })();
    return { ...memberOutcomes[selected[0]!.jobId]!, memberOutcomes };
  };
  deliver.reconcile = reconcile;
  return deliver;
}
