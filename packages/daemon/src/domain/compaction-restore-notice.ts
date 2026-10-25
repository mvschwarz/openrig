import type Database from "better-sqlite3";
import type { RestoreDeliveryFailure } from "./claude-compaction-enforcer.js";
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
    body: `${summary}. OpenRig still owes this stage after repeated delivery failures. Please inspect the seat and decide whether intervention is needed. This does not prove native compaction finished. The existing poll retries with all delivery checks intact. Inspect rig compact ${shellQuote(sessionName)} --state --json and rig seat status ${shellQuote(sessionName)} before acting. Do not issue another /compact. Restore map: ${failure.mapPath}. The latest reason is in this item's summary and transition notes.`,
  });
}
