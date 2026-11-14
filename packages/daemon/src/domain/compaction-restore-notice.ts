import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { type PreparationFailure, type RestoreDeliveryFailure } from "./claude-compaction-enforcer.js";
import type { QueueRepository } from "./queue-repository.js";
import { defaultResolveOrchestrator } from "./queue-owner.js";
import { describeDefaultReceiver, resolveDefaultReceiver } from "./default-receiver.js";
import { workflowHumanDestination } from "./workflow-human-destination.js";
import { shellQuote } from "../adapters/shell-quote.js";

/** Recovery needs an independent agent, even when its recorded seat is missing or stopped. */
function recoveryRecipient(db: Database.Database, session: string): { session: string; kind: "agent" | "human"; note: string } {
  const parent = defaultResolveOrchestrator(db, session);
  if (parent && parent !== session) {
    const receiver = resolveDefaultReceiver(db, () => parent);
    return { session: parent, kind: "agent", note: `Recovery owner: delegating parent ${parent}; recorded state ${receiver.state}${receiver.recorded ? ` (${receiver.recorded})` : ""}. Notices may wait; ownership does not establish delivery or pickup.` };
  }
  let receiver = resolveDefaultReceiver(db);
  // As with permission decisions, the failed seat cannot be its own recovery receiver. Unlike a permission
  // decider, an explicitly configured but missing seat stays the owner; ordinary queue recovery handles delivery.
  if (receiver.session === session) receiver = resolveDefaultReceiver(db, () => null);
  if (receiver.session && receiver.session !== session) return {
    session: receiver.session, kind: "agent",
    note: `Recovery owner: ${describeDefaultReceiver(receiver)} This records ownership, not delivery or pickup.`,
  };
  return { session: workflowHumanDestination(), kind: "human", note: "No independent recovery agent could be resolved, so this notice goes to the registered person." };
}

/** One existing diagnostic queue item per compaction attempt, also across restarts. */
export async function reportRestoreDeliveryFailure(db: Database.Database, queue: QueueRepository, failure: RestoreDeliveryFailure): Promise<void> {
  const { sessionName, attemptId, lastDelivery } = failure;
  const qitemId = `qitem-compaction-restore-${attemptId}`;
  const reason = [lastDelivery.reason, lastDelivery.activity?.reason, lastDelivery.errorClass].filter(Boolean).join("; ");
  const summary = `Managed restore for ${sessionName}: ${lastDelivery.stage} ${lastDelivery.ok ? "delivered over an unreadable pane" : `undeliverable (${reason})`}`;
  const possibleWriteHold = lastDelivery.reason === "input_box_not_empty"
    ? "This step waits because this attempt's /compact may be waiting unsubmitted in the input box, where Enter could submit it; inspect the pane and clear or submit that text so the next poll can retry this restore step. If the box can't be read, cancel and restore by hand using the route below. "
    : "";
  const existing = queue.getById(qitemId);
  if (existing) {
    // An owner's closed disposition stands. Changed evidence updates the same row without another wake.
    if (["pending", "in-progress", "blocked"].includes(existing.state) && existing.summary !== summary) {
      queue.update({ qitemId, actorSession: "system:compaction", summary, transitionNote: `${summary}. ${possibleWriteHold}`.trim() });
    }
    return;
  }
  // A successful fallback updates an existing diagnostic; it never starts a new owner wake.
  if (lastDelivery.ok) return;
  const recipient = recoveryRecipient(db, sessionName);
  const seat = shellQuote(sessionName);
  await queue.create({
    qitemId, sourceSession: sessionName,
    destinationSession: recipient.session,
    summary, wakeTrigger: "openrig",
    tags: ["compaction", "restore-delivery", `attempt:${attemptId}`],
    evidenceRef: recipient.kind === "agent" ? failure.mapPath : null,
    body: recipient.kind === "human"
      ? `${summary}. ${recipient.note} OpenRig still owes this stage after repeated delivery failures, and its existing poll keeps retrying. This does not prove the compaction finished. On the OpenRig host, rig compact ${seat} --state shows the stage, why it waits and, when this compaction has one, its restore map. rig seat status ${seat} shows the seat. Do not issue another /compact. ${possibleWriteHold}To restore the seat yourself instead: read rig compact ${seat} --state first, then run rig compact ${seat} --cancel so OpenRig stops owing the remaining steps (a step it is already pasting at that moment can still land). Then send the seat a restore request naming the restore map --state showed. If it showed none, because this compaction skipped its map, ask the seat to restore from its restore-pending marker, or from its own transcript if the marker is missing.`
      : `${summary}. ${recipient.note} OpenRig still owes this stage after repeated delivery failures. Please inspect the seat and decide whether intervention is needed. This does not prove native compaction finished. The existing poll retries with its delivery checks. Inspect rig compact ${shellQuote(sessionName)} --state --json and rig seat status ${shellQuote(sessionName)} before acting. Do not issue another /compact. Restore map: ${failure.mapPath}. The latest reason is in this item's summary and transition notes. Restore input follows ordinary delivery defaults: a draft can receive and submit the restore text unless the operator enabled draft protection. The seat's draft-aware mode and transport.draft_delivery=refuse keep their existing protections. A lost /compact result is not replayed. ${possibleWriteHold}To restore the seat yourself instead: first run rig compact ${shellQuote(sessionName)} --cancel, so OpenRig stops owing the remaining steps (a step it is already pasting at that moment can still land), then send the seat a restore request naming the restore map${failure.markerPath ? `, its restore-pending marker ${failure.markerPath}` : ""} and the packet the marker names.`,
  });
}

/** One diagnostic per seat/occupant: an owner's disposition stands across automatic attempt IDs and restarts. */
export async function reportPreparationFailure(db: Database.Database, queue: QueueRepository, failure: PreparationFailure): Promise<void> {
  const key = createHash("sha256").update(`${failure.sessionName}\0${failure.occupantGeneration}`).digest("hex").slice(0, 24);
  const qitemId = `qitem-compaction-preparation-${key}`;
  const summary = `Managed preparation for ${failure.sessionName}: ${failure.endedAttempts} ended unsent attempts (${failure.reason})`;
  const evidence = `Attempt ${failure.attemptId}; reason ${failure.reason}; input box ${failure.inputBox ? JSON.stringify(failure.inputBox) : "reading unavailable"}`;
  const existing = queue.getById(qitemId);
  if (existing) {
    if (["pending", "in-progress", "blocked"].includes(existing.state) && existing.summary !== summary) {
      const humans = queue.humanRegistry();
      const toPerson = !humans.ok || humans.entities.some(human => human.address === existing.destinationSession);
      queue.update({ qitemId, actorSession: "system:compaction", summary, transitionNote: toPerson ? summary : `${summary}. ${evidence}` });
    }
    return;
  }
  const recipient = recoveryRecipient(db, failure.sessionName);
  await queue.create({ qitemId, sourceSession: failure.sessionName,
    destinationSession: recipient.session,
    summary, wakeTrigger: "openrig", tags: ["compaction", "preparation-delivery", `occupant:${failure.occupantGeneration}`],
    evidenceRef: recipient.kind === "agent" ? failure.statePath : null,
    body: `${summary}. ${recipient.note} ${recipient.kind === "agent" ? `${evidence}. ` : ""}These are ended automatic attempts while usage remained above the threshold, not repeated sends in one attempt. Inspect rig compact ${shellQuote(failure.sessionName)} --state --json and the seat before choosing an existing supported recovery route. This finding does not force input, skip a map, reset the seat, or change its account or model. No input is authorized by this notice.`,
  });
}
