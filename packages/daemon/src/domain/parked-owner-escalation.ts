import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { QueueRepository } from "./queue-repository.js";
import { resolveSessionNodeId } from "./queue-owner.js";
import { resolveEscalationOwner } from "./escalation-owner.js";
import { resolveDefaultReceiver } from "./default-receiver.js";
import { workflowHumanDestination } from "./workflow-human-destination.js";
import { physicalSessionName } from "./session-registry.js";
import { shellQuote } from "../adapters/shell-quote.js";

export const PARKED_UNCLAIMED_TAG = "parked-owner-escalation";

/** Who hears that a delivered reminder's row is still unclaimed: the row's creator when that is a local seat, else the
 *  parked seat's escalation owner, else the default receiver, else the registered person. Never the parked seat itself,
 *  under any of its addresses (its physical session or its derived sender address). */
export function unclaimedReminderRecipient(db: Database.Database, queue: QueueRepository, seat: string, creator: string | null): string {
  const usable = (candidate: string | null | undefined): candidate is string => !!candidate && candidate !== seat
    && physicalSessionName(db, candidate) !== physicalSessionName(db, seat) && queue.acceptsDestination(candidate);
  if (usable(creator) && resolveSessionNodeId(db, creator)) return creator;
  const owner = resolveEscalationOwner(db, seat, (destination) => queue.acceptsDestination(destination)).owner;
  if (usable(owner)) return owner;
  const receiver = resolveDefaultReceiver(db).session;
  if (usable(receiver)) return receiver;
  return workflowHumanDestination();
}

/** One informational row per recipient for a delivered reminder whose rows stayed unclaimed. Its id comes from the
 *  episode and the recipient, so a retry finds the same row. It holds and refuses nothing. */
export async function escalateUnclaimedReminder(db: Database.Database, queue: QueueRepository,
  input: { seat: string; qitemIds: string[]; deliveredAt: string; episodeKey: string }): Promise<string[]> {
  const byRecipient = new Map<string, string[]>();
  for (const qitemId of input.qitemIds) {
    const row = queue.getById(qitemId);
    // A notice like this one is never escalated in turn, so two idle seats can't pass notices back and forth.
    if (row?.tags?.includes(PARKED_UNCLAIMED_TAG)) continue;
    const recipient = unclaimedReminderRecipient(db, queue, input.seat, row?.sourceSession ?? null);
    byRecipient.set(recipient, [...(byRecipient.get(recipient) ?? []), qitemId]);
  }
  const seat = shellQuote(input.seat);
  for (const [recipient, ids] of byRecipient) {
    const qitemId = `qitem-parked-unclaimed-${createHash("sha256").update(`${input.episodeKey}\n${recipient}`).digest("hex").slice(0, 20)}`;
    if (queue.getById(qitemId)) continue;
    const rows = ids.join(", ");
    const one = ids.length === 1;
    await queue.create({
      qitemId, sourceSession: input.seat, destinationSession: recipient, wakeTrigger: "openrig",
      tags: [PARKED_UNCLAIMED_TAG],
      summary: `${input.seat} was reminded of ${rows} at ${input.deliveredAt}; ${one ? "it is" : "they are"} still unclaimed`,
      body: `${rows} ${one ? "was" : "were"} named in a parked-owner reminder delivered to ${input.seat} at ${input.deliveredAt}, and ${one ? "is" : "are"} still pending and unclaimed. The seat reads idle with nothing changed since, so the reminder won't repeat. Check the seat (rig capture ${seat}) and the ${one ? "row" : "rows"} (rig queue show <id>), then pick the work up, reassign it, or close it. This notice holds and refuses nothing, and it isn't sent again for this reminder.`,
    });
  }
  return [...byRecipient.keys()];
}
