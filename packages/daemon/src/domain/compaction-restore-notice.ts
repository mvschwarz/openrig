import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { type CompactionDebtEnded, type PreparationFailure, type RestoreDeliveryFailure, type RestoreUptakeUnknown } from "./claude-compaction-enforcer.js";
import type { EventBus } from "./event-bus.js";
import type { QueueItem, QueueRepository } from "./queue-repository.js";
import { defaultResolveOrchestrator } from "./queue-owner.js";
import { describeDefaultReceiver, resolveDefaultReceiver } from "./default-receiver.js";
import { workflowHumanDestination } from "./workflow-human-destination.js";
import { physicalSessionName } from "./session-registry.js";
import { resolveRegisteredHumanAddress } from "./gateway/human-registry.js";
import { shellQuote } from "../adapters/shell-quote.js";

/** An eligible parent owns recovery; otherwise notify the person, or the receiver if person resolution fails. */
function recoveryRecipient(db: Database.Database, queue: QueueRepository, session: string): { session: string; kind: "agent" | "human"; note: string } {
  const unusable = (candidate: string): string | null => {
    if (candidate === session || physicalSessionName(db, candidate) === physicalSessionName(db, session))
      return `${candidate}, the receiving address, is the seat this notice is about`;
    const humans = queue.humanRegistry();
    if (humans.ok && resolveRegisteredHumanAddress(candidate, humans.entities))
      return `${candidate}, the receiving address, resolves to a registered person rather than an independent agent`;
    if (!queue.acceptsDestination(candidate)) return `${candidate} cannot hold this notice in its destination rig`;
    return null;
  };
  const reasons: string[] = [];
  const parent = defaultResolveOrchestrator(db, session);
  if (parent) {
    const reason = unusable(parent);
    if (!reason) {
      const receiver = resolveDefaultReceiver(db, () => parent);
      return { session: parent, kind: "agent", note: `Recovery owner: delegating parent ${parent}; recorded state ${receiver.state}${receiver.recorded && receiver.recorded !== receiver.state ? ` (${receiver.recorded})` : ""}. Notices may wait; ownership does not establish delivery or pickup.` };
    }
    reasons.push(reason);
  }
  let person: string;
  try { person = workflowHumanDestination(); }
  catch (error) {
    reasons.push(`The registered person could not be resolved: ${error instanceof Error ? error.message : String(error)}`);
    let receiver = resolveDefaultReceiver(db);
    if (receiver.session) {
      const reason = unusable(receiver.session);
      if (reason) {
        reasons.push(reason);
        receiver = resolveDefaultReceiver(db, () => ({ session: null, problem: reason }));
      }
    }
    if (receiver.session) {
      const reason = unusable(receiver.session);
      if (!reason) return { session: receiver.session, kind: "agent",
        note: `${reasons.join("; ")}. Recovery owner: ${describeDefaultReceiver(receiver)} This is a receiver fallback, not the person's selection. This records ownership, not delivery or pickup.` };
    }
    throw error;
  }
  return { session: person, kind: "human",
    note: `${reasons.length ? `${reasons.join("; ")}. ` : ""}No eligible independent delegating parent could be resolved, so this notice goes to the registered person.` };
}

/** One existing diagnostic queue item per compaction attempt, also across restarts. */
export async function reportRestoreDeliveryFailure(db: Database.Database, queue: QueueRepository, failure: RestoreDeliveryFailure, options?: { completed: boolean }): Promise<void> {
  const { sessionName, attemptId, lastDelivery } = failure;
  const qitemId = `qitem-compaction-restore-${attemptId}`;
  const reason = [lastDelivery.reason, lastDelivery.activity?.reason, lastDelivery.errorClass].filter(Boolean).join("; ");
  const summary = `Managed restore for ${sessionName}: ${lastDelivery.stage} ${lastDelivery.ok ? "delivered over an unreadable pane" : `undeliverable (${reason})`}`;
  const possibleWriteHold = lastDelivery.reason === "input_box_not_empty"
    ? "This step waits because this attempt's /compact may be waiting unsubmitted in the input box, where Enter could submit it; inspect the pane and clear or submit that text so the next poll can retry this restore step. If the box can't be read, cancel and restore by hand using the route below. "
    : "";
  const existing = queue.getById(qitemId);
  if (existing) {
    // A system completion settles the current sequence; a late compaction report may owe it again.
    // Preserve owner dispositions, using the actual closing transition rather than a later receipt/note.
    if (!["pending", "in-progress", "blocked"].includes(existing.state)) {
      if (!lastDelivery.ok && existing.state === "done" && existing.closureReason === "no-follow-on"
        && queue.closingTransition(qitemId, existing.state)?.actorSession === "system:compaction") {
        queue.update({ qitemId, actorSession: "system:compaction", state: "pending", reopen: true, summary,
          transitionNote: `${summary}. A re-owed sequence failed after this attempt's automatic completion; its earlier completion remains in the history.` });
      }
      return;
    }
    if (options?.completed && lastDelivery.ok && lastDelivery.stage === "compliance_prompt") {
      const caveat = lastDelivery.reason === "delivered_over_unreadable_pane" ? " over an unreadable pane"
        : lastDelivery.reason === "delivered_over_unreadable_input_box" ? " over an unreadable input box" : "";
      const completed = `Managed restore for ${sessionName}: ${lastDelivery.stage} delivered at ${lastDelivery.at}${caveat}; current restore sequence delivered`;
      const note = `${completed}. This records delivery, not proof the seat read it. A late compaction report can owe another sequence for this attempt. Previous notice: ${existing.summary ?? "restore delivery was owed"}`;
      queue.update({ qitemId, actorSession: "system:compaction", state: "done", closureReason: "no-follow-on",
        summary: completed, resolution: note, transitionNote: note });
      return;
    }
    // Changed evidence updates the same row without another wake.
    if (existing.summary !== summary) {
      queue.update({ qitemId, actorSession: "system:compaction", summary, transitionNote: `${summary}. ${possibleWriteHold}`.trim() });
    }
    return;
  }
  // A successful fallback updates an existing diagnostic; it never starts a new owner wake.
  if (lastDelivery.ok) return;
  const recipient = recoveryRecipient(db, queue, sessionName);
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

/** One notice per attempt, also across restarts: its restore was delivered, but the seat's RESTORED note never appeared. */
export async function reportRestoreUptakeUnknown(db: Database.Database, queue: QueueRepository, unknown: RestoreUptakeUnknown): Promise<void> {
  const { sessionName, attemptId, mapPath, doneAt, waitedMinutes } = unknown;
  const qitemId = `qitem-compaction-uptake-${attemptId}`;
  if (queue.getById(qitemId)) return;
  const recipient = recoveryRecipient(db, queue, sessionName);
  const seat = shellQuote(sessionName);
  const summary = `Managed restore for ${sessionName}: uptake unknown (no restore note ${waitedMinutes} minutes after the audit was sent)`;
  const what = `OpenRig delivered this compaction's restore request and post-restore audit, the last at ${doneAt}. The audit asks the seat to write a RESTORED note beside its restore map, and none appeared within ${waitedMinutes} minutes. So whether the seat took up the restore is unknown: it may still be at the post-compaction boundary, or it may have restored without writing the note. Nothing failed that OpenRig can see, and OpenRig resends nothing.`;
  await queue.create({
    qitemId, sourceSession: sessionName,
    destinationSession: recipient.session,
    summary, wakeTrigger: "openrig",
    tags: ["compaction", "restore-delivery", "restore-uptake", `attempt:${attemptId}`],
    evidenceRef: recipient.kind === "agent" ? mapPath : null,
    body: recipient.kind === "human"
      ? `${summary}. ${recipient.note} ${what} Check the seat with rig seat status ${seat} and rig capture ${seat} on the OpenRig host. If it's still at the boundary, ask it to restore from its newest restore map.`
      : `${summary}. ${recipient.note} ${what} Check the seat with rig seat status ${seat} and rig capture ${seat}. If it's still at the boundary, send it a restore request naming this map: ${mapPath}.`,
  });
}

/** One diagnostic per seat/occupant: an owner's disposition stands across automatic attempt IDs and restarts. */
export async function reportPreparationFailure(db: Database.Database, queue: QueueRepository, failure: PreparationFailure): Promise<void> {
  const qitemId = preparationNoticeId(failure.sessionName, failure.occupantGeneration);
  const summary = `Managed preparation for ${failure.sessionName}: ${failure.endedAttempts} ended unsent attempts (${failure.reason})`;
  const evidence = `Attempt ${failure.attemptId}; reason ${failure.reason}; input box ${failure.inputBox ? JSON.stringify(failure.inputBox) : "reading unavailable"}`;
  const existing = queue.getById(qitemId);
  if (existing) {
    if (["pending", "in-progress", "blocked"].includes(existing.state) && existing.summary !== summary) {
      const humans = queue.humanRegistry();
      const toPerson = !humans.ok || resolveRegisteredHumanAddress(existing.destinationSession, humans.entities) !== null;
      queue.update({ qitemId, actorSession: "system:compaction", summary, transitionNote: toPerson ? summary : `${summary}. ${evidence}` });
    }
    return;
  }
  const recipient = recoveryRecipient(db, queue, failure.sessionName);
  await queue.create({ qitemId, sourceSession: failure.sessionName,
    destinationSession: recipient.session,
    summary, wakeTrigger: "openrig", tags: ["compaction", "preparation-delivery", `occupant:${failure.occupantGeneration}`],
    evidenceRef: recipient.kind === "agent" ? failure.statePath : null,
    body: `${summary}. ${recipient.note} ${recipient.kind === "agent" ? `${evidence}. ` : ""}These are ended automatic attempts while usage remained above the threshold, not repeated sends in one attempt. Inspect rig compact ${shellQuote(failure.sessionName)} --state --json and the seat before choosing an existing supported recovery route. This finding does not force input, skip a map, reset the seat, or change its account or model. No input is authorized by this notice.`,
  });
}

function preparationNoticeId(sessionName: string, occupantGeneration: string): string {
  return `qitem-compaction-preparation-${createHash("sha256").update(`${sessionName}\0${occupantGeneration}`).digest("hex").slice(0, 24)}`;
}

const OPEN_NOTICE_STATES: QueueItem["state"][] = ["pending", "in-progress", "blocked"];
const NOTICE_KINDS = [
  { prefix: "qitem-compaction-restore-", kind: "restore", label: "Managed restore" },
  { prefix: "qitem-compaction-uptake-", kind: "uptake", label: "Restore uptake check" },
  { prefix: "qitem-compaction-preparation-", kind: "preparation", label: "Managed preparation" },
] as const;

function noticeKind(item: QueueItem): (typeof NOTICE_KINDS)[number] | null {
  return NOTICE_KINDS.find((k) => item.qitemId.startsWith(k.prefix)) ?? null;
}

const OPEN_NOTICE_LIMIT = 1000;

function openNotices(queue: QueueRepository, sourceSession?: string): QueueItem[] {
  const rows = queue.list({ tag: "compaction", state: OPEN_NOTICE_STATES, limit: OPEN_NOTICE_LIMIT, ...(sourceSession ? { sourceSession } : {}) });
  if (rows.length >= OPEN_NOTICE_LIMIT) {
    // Each settle reads the same newest rows, so an older notice isn't reached while those stay open.
    console.warn("[compaction] open notices reached the settle limit; older notices aren't checked by this settle, or by a later one while the newer ones stay open", { limit: OPEN_NOTICE_LIMIT });
  }
  return rows.filter((item) => noticeKind(item) !== null);
}

/** Close an open notice the debt no longer backs, as #3415 closes it after delivery. `canceled` and `superseded`
 *  closures stay out of #3415's reopen branch, which only reopens its own `no-follow-on` close. A row the owner moved
 *  meanwhile keeps the owner's disposition. */
function closeNotice(queue: QueueRepository, item: QueueItem, closureReason: "canceled" | "superseded", why: string): void {
  const note = `${noticeKind(item)!.label} for ${item.sourceSession}: no longer owed: ${why}`;
  try {
    queue.update({ qitemId: item.qitemId, actorSession: "system:compaction", expectState: item.state, state: "done",
      closureReason, resolution: note, transitionNote: note });
  } catch (error) {
    if ((error as { code?: unknown }).code !== "qitem_state_changed") throw error;
  }
}

/** Where OpenRig can't tell whether the debt ended, the open notice says so once and stays open. */
function noteOwedUnknown(queue: QueueRepository, item: QueueItem, why: string): void {
  const note = `${noticeKind(item)!.label} for ${item.sourceSession}: OpenRig can't tell whether this is still owed: ${why}`;
  if (queue.listTransitions(item.qitemId).some((t) => t.actorSession === "system:compaction" && t.transitionNote === note)) return;
  try {
    queue.update({ qitemId: item.qitemId, actorSession: "system:compaction", expectState: item.state, transitionNote: note });
  } catch (error) {
    if ((error as { code?: unknown }).code !== "qitem_state_changed") throw error;
  }
}

/** #3688: settle the notices a seat's compaction opened once their debt ends without a delivery. */
export function settleCompactionNotices(queue: QueueRepository, ended: CompactionDebtEnded): void {
  const { sessionName } = ended;
  for (const item of openNotices(queue, sessionName)) {
    const kind = noticeKind(item)!;
    const attemptId = kind.kind === "preparation" ? null : item.qitemId.slice(kind.prefix.length);
    switch (ended.reason) {
      case "compaction_cancelled":
        // Only the attempt the cancel ended. The seat and its occupant stay: a preparation notice counts their ended
        // attempts and is left as it is.
        if (attemptId !== null && attemptId === ended.attemptId) closeNotice(queue, item, "canceled", "the compaction was cancelled (rig compact --cancel), so OpenRig stopped owing its remaining steps and its uptake check. This records the cancel, not that the seat restored.");
        break;
      case "attempt_superseded":
        if (attemptId !== null && ended.attemptId && attemptId !== ended.attemptId) {
          closeNotice(queue, item, "superseded", `attempt ${ended.attemptId} replaced attempt ${attemptId} on this seat, so OpenRig no longer owes the earlier attempt's steps or its uptake check.`);
        }
        break;
      case "occupant_replaced": {
        // Say what OpenRig saw. An invalidation also precedes a handover or runtime-switch rollback, and a reboot that
        // adopts the same conversation mints a new generation, so neither alone means the occupant changed.
        const generation = ended.occupantGeneration ?? null;
        const observed = ended.observedGeneration;
        const seen = observed
          ? `OpenRig found ${observed.when === "restart" ? "after a restart" : "on a poll"} that the seat's occupant generation changed${generation ? ` from ${generation}` : ""} to ${observed.live}, and dropped this compaction with it. That happens when the occupant is replaced, and also on a reboot that adopts the same conversation`
          : `OpenRig invalidated the seat's occupant state${generation ? ` (retiring generation ${generation})` : ""} and dropped this compaction with it. That happens when the occupant is replaced, and also before a handover or runtime-switch rollback`;
        const replaced = `${seen}, so it doesn't by itself mean the occupant changed. A next occupant doesn't inherit this compaction. If the seat resumed the same conversation, check whether it still needs the restore.`;
        if (attemptId !== null) closeNotice(queue, item, "canceled", replaced);
        else if (generation === null) {
          noteOwedUnknown(queue, item, "OpenRig invalidated the seat's occupant state, but the retiring occupant's generation wasn't recorded, so OpenRig can't tell whether this notice was that occupant's. Close it if it was.");
        } else if (item.qitemId === preparationNoticeId(sessionName, generation)) closeNotice(queue, item, "canceled", replaced);
        break;
      }
      case "owed_unknown":
        if (attemptId !== null && attemptId === ended.attemptId && kind.kind === "restore") {
          noteOwedUnknown(queue, item, "after a restart OpenRig found this compaction's record older than its recovery window, so it no longer retries these steps, and it can't tell whether the seat still needs them.");
        } else if (attemptId === null && ended.attemptId === undefined && ended.occupantGeneration
          && item.qitemId === preparationNoticeId(sessionName, ended.occupantGeneration)) {
          noteOwedUnknown(queue, item, "a preparation stopped because the seat's live occupant generation couldn't be read, so OpenRig can't tell whether the occupant this notice is about is still in the seat. It stays open.");
        }
        break;
    }
  }
}

/** A seat is removed when no node carries its name any more, in any rig. An unclaim keeps the node, and an archived rig
 *  keeps its nodes (it can be restored, and a seat still running in it is still monitored). */
export function seatNameCarried(db: Database.Database): (sessionName: string) => boolean {
  const carried = db.prepare(`SELECT 1 FROM nodes n WHERE
    EXISTS (SELECT 1 FROM sessions s WHERE s.node_id = n.id AND s.session_name = ?)
    OR EXISTS (SELECT 1 FROM bindings b WHERE b.node_id = n.id AND (b.tmux_session = ? OR b.external_session_name = ?)) LIMIT 1`);
  return (sessionName) => !!carried.get(sessionName, sessionName, sessionName);
}

/** #3688: a removed seat's open notices close, since nothing is left to deliver to or take up their steps. */
export function closeNoticesOfRemovedSeats(queue: QueueRepository, carriesSessionName: (sessionName: string) => boolean): void {
  const gone = new Map<string, boolean>();
  for (const item of openNotices(queue)) {
    if (!gone.has(item.sourceSession)) gone.set(item.sourceSession, !carriesSessionName(item.sourceSession));
    if (gone.get(item.sourceSession)) {
      closeNotice(queue, item, "canceled", `${item.sourceSession} no longer exists on this host, so nothing can deliver or take up this step.`);
    }
  }
}

/** Settles once at startup, for seats removed while no daemon ran, and again after each removal event commits. A failure
 *  leaves a safe diagnostic and never fails the startup or the removal. */
export function wireCompactionNoticeSeatRemoval(eventBus: Pick<EventBus, "subscribe">, queue: QueueRepository,
  carriesSessionName: (sessionName: string) => boolean): () => void {
  const settle = (cause: string) => {
    void Promise.resolve().then(() => closeNoticesOfRemovedSeats(queue, carriesSessionName)).catch((error) => {
      console.warn("[compaction] removed-seat notice settle failed", { cause, errorClass: error instanceof Error ? error.name : typeof error });
    });
  };
  settle("startup");
  return eventBus.subscribe((event) => {
    if (event.type === "session.detached" || event.type === "node.removed" || event.type === "rig.deleted") settle(event.type);
  });
}
