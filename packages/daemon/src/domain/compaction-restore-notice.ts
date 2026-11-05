import type Database from "better-sqlite3";
import { UNREADABLE_POLLS_BEFORE_DELIVERY, type RestoreDeliveryFailure } from "./claude-compaction-enforcer.js";
import type { QueueRepository } from "./queue-repository.js";
import { defaultResolveOrchestrator } from "./queue-owner.js";
import { workflowHumanDestination } from "./workflow-human-destination.js";
import { shellQuote } from "../adapters/shell-quote.js";

/** One existing diagnostic queue item per compaction attempt, also across restarts. */
export async function reportRestoreDeliveryFailure(db: Database.Database, queue: QueueRepository, failure: RestoreDeliveryFailure): Promise<void> {
  const { sessionName, attemptId, lastDelivery } = failure;
  const qitemId = `qitem-compaction-restore-${attemptId}`;
  const reason = [lastDelivery.reason, lastDelivery.activity?.reason, lastDelivery.errorClass].filter(Boolean).join("; ");
  const summary = `Managed restore for ${sessionName}: ${lastDelivery.stage} undeliverable (${reason})`;
  const existing = queue.getById(qitemId);
  if (existing) {
    // An owner's closed disposition stands. Changed evidence updates the same row without another wake.
    if (["pending", "in-progress", "blocked"].includes(existing.state) && existing.summary !== summary) {
      queue.update({ qitemId, actorSession: "system:compaction", summary, transitionNote: summary });
    }
    return;
  }
  await queue.create({
    qitemId, sourceSession: sessionName,
    destinationSession: defaultResolveOrchestrator(db, sessionName) ?? workflowHumanDestination(),
    summary, wakeTrigger: "openrig",
    tags: ["compaction", "restore-delivery", `attempt:${attemptId}`],
    evidenceRef: failure.mapPath,
    body: `${summary}. OpenRig still owes this stage after repeated delivery failures. Please inspect the seat and decide whether intervention is needed. This does not prove native compaction finished. The existing poll retries with its delivery checks. Inspect rig compact ${shellQuote(sessionName)} --state --json and rig seat status ${shellQuote(sessionName)} before acting. Do not issue another /compact. Restore map: ${failure.mapPath}. The latest reason is in this item's summary and transition notes. When the seat's input box can't be read but doesn't read typed, OpenRig sends the step itself after ${UNREADABLE_POLLS_BEFORE_DELIVERY} idle polls, recorded as over an unreadable box. That doesn't apply after a /compact whose result was lost, where each step waits for an empty box, or on a seat whose draft-aware delivery or typing guard holds OpenRig's input: those keep holding, draft-aware delivery until the seat's mode is set to off and a typing guard until its level admits OpenRig's input. To restore the seat yourself instead: first run rig compact ${shellQuote(sessionName)} --cancel, so OpenRig stops owing the remaining steps (a step it is already pasting at that moment can still land), then send the seat a restore request naming the restore map${failure.markerPath ? `, its restore-pending marker ${failure.markerPath}` : ""} and the packet the marker names.`,
  });
}
