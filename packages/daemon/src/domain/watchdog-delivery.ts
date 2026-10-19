import type { OutboxHandler } from "./outbox-handler.js";
import type { SessionTransport } from "./session-transport.js";
import {
  formatWatchdogDeliveryMessage,
  type DeliveryFn,
  type DeliveryOutcome,
  type DeliveryRequest,
  type WatchdogDeliverySource,
} from "./watchdog-policy-engine.js";

/** Marks the outbox entries that bind a digest's members to its one attempt. */
export const WATCHDOG_DIGEST_TAG = "watchdog:digest";

/** The outbox id a watchdog occurrence is delivered under, alone or inside a digest. */
export function watchdogDeliveryId(occurrenceId: string): string {
  return `guard-watchdog-${occurrenceId}`;
}

/**
 * The outcome of an earlier digest attempt that included this occurrence, read from its member entry, or null
 * when no digest attempted it. An attempt whose outcome never came back reads as failed, not as permission to send
 * again.
 */
/** Whether this occurrence already has a delivery record of any kind: a lone send's or a digest member's. */
export function occurrenceAttempted(outbox: Pick<OutboxHandler, "getById">, occurrenceId: string): boolean {
  return outbox.getById(watchdogDeliveryId(occurrenceId)) !== null;
}

export function priorDigestAttempt(outbox: Pick<OutboxHandler, "getById">, occurrenceId: string): DeliveryOutcome | null {
  const entry = outbox.getById(watchdogDeliveryId(occurrenceId));
  if (!entry || !entry.tags?.includes(WATCHDOG_DIGEST_TAG)) return null;
  switch (entry.deliveryState) {
    case "delivered": return { status: "ok" };
    case "retained":
    case "retired": return { status: "retained", outboxIds: [entry.outboxId] };
    case "failed": return { status: "failed", error: "an earlier digest attempt failed; not sent again" };
    default: return { status: "failed", error: `an earlier digest attempt's outcome is unknown (${entry.deliveryState}); not sent again` };
  }
}

/**
 * The daemon's watchdog delivery through the session transport. A lone wake goes under its occurrence's own id. A
 * digest first commits and claims one outbox entry per member, under each member's own id, in one transaction, then
 * sends once with those ids, so an interrupted attempt is never sent again under another identity.
 */
export function makeWatchdogDeliver(deps: {
  sessionTransport: Pick<SessionTransport, "send">;
  outbox: OutboxHandler;
  db: { transaction<T>(fn: () => T): () => T };
  createContinuityAction?: (action: NonNullable<DeliveryRequest["continuityAction"]>) => Promise<void>;
}): DeliveryFn {
  const { sessionTransport, outbox } = deps;
  return async ({ targetSession, message, continuityAction }, source: WatchdogDeliverySource) => {
    let continuityActionCompleted = false;
    try {
      if (continuityAction) {
        await deps.createContinuityAction?.(continuityAction);
        continuityActionCompleted = true;
      }
      if (source.members) return await sendDigest(deps, targetSession, message, source, bindDigest(deps, targetSession, message, source));
      const prior = priorDigestAttempt(outbox, source.occurrenceId ?? source.jobId);
      if (prior) return prior;
      const deliveryId = watchdogDeliveryId(source.occurrenceId ?? source.jobId);
      const previous = outbox.getById(deliveryId);
      const payload = previous?.guardBinding ? previous.body : formatWatchdogDeliveryMessage(source, message);
      const result = await sessionTransport.send(targetSession, payload,
        { deliveryId, actorSession: "watchdog@system", auditPointer: source.jobId });
      if (result.outcome === "retained") return { status: "retained", outboxIds: result.outboxIds, continuityActionCompleted };
      return result.ok
        ? { status: "ok", continuityActionCompleted }
        : { status: "failed", error: result.error, continuityActionCompleted };
    } catch (err) {
      if (err instanceof DigestBindingRefused) throw err;
      return {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        continuityActionCompleted,
      };
    }
  };
}

/** Bind every member to this attempt before any input: one claimed outbox entry each, in one transaction. A member
 *  that already has a delivery record refuses the whole digest here, before any input, and the refusal is thrown to the
 *  caller rather than reported as a failed attempt, so no member is accounted as attempted. */
class DigestBindingRefused extends Error {}

function bindDigest(deps: Parameters<typeof makeWatchdogDeliver>[0], targetSession: string, message: string, source: WatchdogDeliverySource): string[] {
  const { outbox } = deps;
  const payload = formatWatchdogDeliveryMessage(source, message);
  const ids = source.members!.map((member) => watchdogDeliveryId(member.occurrenceId));
  deps.db.transaction(() => {
    source.members!.forEach((member, i) => {
      if (outbox.getById(ids[i]!)) throw new DigestBindingRefused(`watchdog occurrence ${member.occurrenceId} already has a delivery record; the digest is not sent`);
      outbox.record({
        outboxId: ids[i]!, senderSession: "watchdog@system", destinationSession: targetSession, body: payload,
        tags: [WATCHDOG_DIGEST_TAG, `${WATCHDOG_DIGEST_TAG}:${source.occurrenceId}`], auditPointer: member.jobId,
      });
      if (!outbox.claimForDelivery(ids[i]!)) throw new DigestBindingRefused(`watchdog occurrence ${member.occurrenceId} could not be claimed`);
    });
  })();
  return ids;
}

async function sendDigest(
  deps: Parameters<typeof makeWatchdogDeliver>[0],
  targetSession: string,
  message: string,
  source: WatchdogDeliverySource,
  ids: string[],
): Promise<DeliveryOutcome> {
  const { sessionTransport, outbox } = deps;
  const payload = formatWatchdogDeliveryMessage(source, message);
  let outcome: DeliveryOutcome;
  let state: "delivered" | "failed" | "indeterminate";
  try {
    const result = await sessionTransport.send(targetSession, payload,
      { committedOutboxIds: ids, actorSession: "watchdog@system", auditPointer: source.jobId });
    if (result.outcome === "retained") return { status: "retained", outboxIds: result.outboxIds ?? ids };
    outcome = result.ok ? { status: "ok" } : { status: "failed", error: result.error };
    state = result.ok ? "delivered" : result.sent === false ? "failed" : "indeterminate";
  } catch (err) {
    outcome = { status: "failed", error: err instanceof Error ? err.message : String(err) };
    state = "indeterminate";
  }
  // A guarded send has already finalized its entries; this settles the ones an unguarded send left claimed.
  deps.db.transaction(() => { for (const id of ids) outbox.finalizeDelivery(id, state); })();
  return outcome;
}
