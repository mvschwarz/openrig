import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type Database from "better-sqlite3";
import { COMPACTION_RECORD_FILE, type ClaudeCompactionEnforcer, type CompactionDebtEnded, type PreparationFailure, type PreparationNoticeUnaddressed, type RestoreDeliveryFailure, type RestoreUptakeUnknown } from "./claude-compaction-enforcer.js";
import type { EventBus } from "./event-bus.js";
import type { QueueItem, QueueRepository } from "./queue-repository.js";
import { defaultResolveOrchestrator } from "./queue-owner.js";
import { describeDefaultReceiver, resolveDefaultReceiver } from "./default-receiver.js";
import { WorkflowHumanDestinationError, workflowHumanDestination } from "./workflow-human-destination.js";
import { physicalSessionName } from "./session-registry.js";
import { resolveRegisteredHumanAddress } from "./gateway/human-registry.js";
import { shellQuote } from "../adapters/shell-quote.js";

/** Positive evidence that an agent can't act on a recovery notice now, or null when OpenRig holds none: unknown capacity,
 *  silence and ordinary activity are not inability. The daemon passes the compaction enforcer's `recoveryInability`. */
export type RecoveryInability = (session: string) => string | null;

/** Recipient selection can precede its first context poll after restart. Read the same retained record the state route
 *  would read, from the actual seat's launch workspace/policy roots, before deciding that no inability is recorded. */
export function recordedRecoveryInability(db: Database.Database,
  enforcer: Pick<ClaudeCompactionEnforcer, "recoverSeat" | "recoveryInability">, session: string): string | null {
  const physical = physicalSessionName(db, session);
  const seat = db.prepare(`SELECT n.runtime, n.cwd FROM sessions s JOIN nodes n ON n.id = s.node_id
    WHERE s.session_name = ? ORDER BY s.id DESC LIMIT 1`).get(physical) as { runtime: string | null; cwd: string | null } | undefined;
  if (seat) enforcer.recoverSeat({ sessionName: physical, ...seat });
  return enforcer.recoveryInability(physical);
}

interface RecoveryRecipient {
  session: string;
  kind: "agent" | "human";
  note: string;
  /** No capable recipient could be established: the first agent the route reached keeps the notice, which says so. */
  unresolved?: true;
}

const NO_CAPABLE_RECIPIENT = "; no capable recovery recipient";

/** An eligible parent owns recovery; otherwise notify the person, or the receiver if person resolution fails. An agent
 *  OpenRig holds positive evidence can't act now is passed over with that evidence named, in the same order. When no
 *  capable recipient resolves, the first agent the route reached keeps the notice and the note says so; with none at
 *  all, it throws as before. */
function recoveryRecipient(db: Database.Database, queue: QueueRepository, session: string, unable?: RecoveryInability): RecoveryRecipient {
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
  let unableAgent: string | null = null;
  // Usable but unable: remembered, so a notice nobody capable can take still has an address that says so.
  const capable = (candidate: string): boolean => {
    const reason = unusable(candidate);
    const evidence = reason ? null : unable?.(candidate) ?? null;
    if (!reason && !evidence) return true;
    const why = reason ?? `${candidate} can't act on it now: ${evidence}`;
    if (!reasons.includes(why)) reasons.push(why);
    if (evidence) unableAgent ??= candidate;
    return false;
  };
  const parent = defaultResolveOrchestrator(db, session);
  // A parent passed over for evidence that it can't act exists: the notes say so rather than "no parent".
  const parentUnable = (): boolean => parent !== null && unableAgent === parent;
  if (parent && capable(parent)) {
    const receiver = resolveDefaultReceiver(db, () => parent);
    return { session: parent, kind: "agent", note: `Recovery owner: delegating parent ${parent}; recorded state ${receiver.state}${receiver.recorded && receiver.recorded !== receiver.state ? ` (${receiver.recorded})` : ""}. Notices may wait; ownership does not establish delivery or pickup.` };
  }
  let person: string;
  try { person = workflowHumanDestination(); }
  catch (error) {
    reasons.push(`The registered person could not be resolved: ${error instanceof Error ? error.message : String(error)}`);
    let receiver = resolveDefaultReceiver(db);
    if (receiver.session && !capable(receiver.session)) {
      const first = receiver.session;
      const problem = unusable(first) ?? `${first} can't act on it now: ${unable?.(first)}`;
      receiver = resolveDefaultReceiver(db, () => ({ session: null, problem }));
    }
    if (receiver.session && capable(receiver.session)) return { session: receiver.session, kind: "agent",
      note: `${reasons.join("; ")}. Recovery owner: ${describeDefaultReceiver(receiver)} This is a receiver fallback${parentUnable() ? `, since the delegating parent ${parent} can't act now and the registered person couldn't be resolved; it isn't` : ", not"} the person's selection. This records ownership, not delivery or pickup.` };
    if (unableAgent) return { session: unableAgent, kind: "agent", unresolved: true,
      note: `No capable recovery recipient could be established: ${reasons.join("; ")}. This notice stays addressed to ${unableAgent} only so it remains visible. That is not acceptance: nobody able to act on it has been reached.` };
    throw error;
  }
  return { session: person, kind: "human",
    note: `${reasons.length ? `${reasons.join("; ")}. ` : ""}${parentUnable() ? `The delegating parent ${parent} can't act now` : "No eligible independent delegating parent could be resolved"}, so this notice goes to the registered person.` };
}

/** The newest restore map under the seat's preparation folder that ends with its own attempt's completion marker (from
 *  the COMPACTION-STATE.json beside it), with its attempt and time; null when none reads complete. A map that only names
 *  a session, or a folder the daemon can't read, is skipped. */
export function newestCompleteMap(attemptMapPath: string, sessionName: string): { mapPath: string; attemptId: string; writtenAt: string } | null {
  const seatFolder = path.dirname(path.dirname(attemptMapPath));
  let newest: { mapPath: string; attemptId: string; writtenAt: string; mtimeMs: number } | null = null;
  let folders: string[];
  try { folders = fs.readdirSync(seatFolder); } catch { return null; }
  for (const folder of folders) {
    const mapPath = path.join(seatFolder, folder, "RESTORE-MAP.md");
    try {
      const state = JSON.parse(fs.readFileSync(path.join(seatFolder, folder, COMPACTION_RECORD_FILE), "utf8")) as { attemptId?: unknown; session?: unknown; marker?: unknown };
      if (state.attemptId !== folder || state.session !== sessionName || typeof state.marker !== "string" || !state.marker) continue;
      if (!fs.readFileSync(mapPath, "utf8").trimEnd().endsWith(state.marker)) continue;
      const { mtimeMs, mtime } = fs.statSync(mapPath);
      if (!newest || mtimeMs > newest.mtimeMs) newest = { mapPath, attemptId: folder, writtenAt: mtime.toISOString(), mtimeMs };
    } catch { /* Unreadable or incomplete: not a retained map. */ }
  }
  return newest && { mapPath: newest.mapPath, attemptId: newest.attemptId, writtenAt: newest.writtenAt };
}

/** One existing diagnostic queue item per compaction attempt, also across restarts. */
export async function reportRestoreDeliveryFailure(db: Database.Database, queue: QueueRepository, failure: RestoreDeliveryFailure, options?: { completed?: boolean; unable?: RecoveryInability }): Promise<void> {
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
    const kept = existing.summary?.endsWith(NO_CAPABLE_RECIPIENT) ? `${summary}${NO_CAPABLE_RECIPIENT}` : summary;
    if (existing.summary !== kept) {
      queue.update({ qitemId, actorSession: "system:compaction", summary: kept, transitionNote: `${kept}. ${possibleWriteHold}`.trim() });
    }
    return;
  }
  // A successful fallback updates an existing diagnostic; it never starts a new owner wake.
  if (lastDelivery.ok) return;
  const recipient = recoveryRecipient(db, queue, sessionName, options?.unable);
  const seat = shellQuote(sessionName);
  await queue.create({
    qitemId, sourceSession: sessionName,
    destinationSession: recipient.session,
    summary: recipient.unresolved ? `${summary}${NO_CAPABLE_RECIPIENT}` : summary, wakeTrigger: "openrig",
    tags: ["compaction", "restore-delivery", `attempt:${attemptId}`],
    evidenceRef: recipient.kind === "agent" ? failure.mapPath : null,
    body: recipient.kind === "human"
      ? `${summary}. ${recipient.note} OpenRig still owes this stage after repeated delivery failures, and its existing poll keeps retrying. This does not prove the compaction finished. On the OpenRig host, rig compact ${seat} --state shows the stage, why it waits and, when this compaction has one, its restore map. rig seat status ${seat} shows the seat. Do not issue another /compact. ${possibleWriteHold}To restore the seat yourself instead: read rig compact ${seat} --state first, then run rig compact ${seat} --cancel so OpenRig stops owing the remaining steps (a step it is already pasting at that moment can still land). Then send the seat a restore request naming the restore map --state showed. If it showed none, because this compaction skipped its map, ask the seat to restore from its restore-pending marker, or from its own transcript if the marker is missing.`
      : `${summary}. ${recipient.note} OpenRig still owes this stage after repeated delivery failures. Please inspect the seat and decide whether intervention is needed. This does not prove native compaction finished. The existing poll retries with its delivery checks. Inspect rig compact ${shellQuote(sessionName)} --state --json and rig seat status ${shellQuote(sessionName)} before acting. Do not issue another /compact. Restore map: ${failure.mapPath}. The latest reason is in this item's summary and transition notes. Restore input follows ordinary delivery defaults: a draft can receive and submit the restore text unless the operator enabled draft protection. The seat's draft-aware mode and transport.draft_delivery=refuse keep their existing protections. A lost /compact result is not replayed. ${possibleWriteHold}To restore the seat yourself instead: first run rig compact ${shellQuote(sessionName)} --cancel, so OpenRig stops owing the remaining steps (a step it is already pasting at that moment can still land), then send the seat a restore request naming the restore map${failure.markerPath ? `, its restore-pending marker ${failure.markerPath}` : ""} and the packet the marker names.`,
  });
}

/** One notice per attempt, also across restarts: its restore was delivered, but the seat's RESTORED note never appeared. */
export async function reportRestoreUptakeUnknown(db: Database.Database, queue: QueueRepository, unknown: RestoreUptakeUnknown, unable?: RecoveryInability): Promise<void> {
  const { sessionName, attemptId, mapPath, doneAt, waitedMinutes } = unknown;
  const qitemId = `qitem-compaction-uptake-${attemptId}`;
  if (queue.getById(qitemId)) return;
  const recipient = recoveryRecipient(db, queue, sessionName, unable);
  const seat = shellQuote(sessionName);
  const summary = `Managed restore for ${sessionName}: uptake unknown (no restore note ${waitedMinutes} minutes after the audit was sent)`;
  const what = `OpenRig delivered this compaction's restore request and post-restore audit, the last at ${doneAt}. The audit asks the seat to write a RESTORED note beside its restore map, and none appeared within ${waitedMinutes} minutes. So whether the seat took up the restore is unknown: it may still be at the post-compaction boundary, or it may have restored without writing the note. Nothing failed that OpenRig can see, and OpenRig resends nothing.`;
  await queue.create({
    qitemId, sourceSession: sessionName,
    destinationSession: recipient.session,
    summary: recipient.unresolved ? `${summary}${NO_CAPABLE_RECIPIENT}` : summary, wakeTrigger: "openrig",
    tags: ["compaction", "restore-delivery", "restore-uptake", `attempt:${attemptId}`],
    evidenceRef: recipient.kind === "agent" ? mapPath : null,
    body: recipient.kind === "human"
      ? `${summary}. ${recipient.note} ${what} Check the seat with rig seat status ${seat} and rig capture ${seat} on the OpenRig host. If it's still at the boundary, ask it to restore from its newest restore map.`
      : `${summary}. ${recipient.note} ${what} Check the seat with rig seat status ${seat} and rig capture ${seat}. If it's still at the boundary, send it a restore request naming this map: ${mapPath}.`,
  });
}

/** One diagnostic per seat/occupant: an owner's disposition stands across automatic attempt IDs and restarts. It carries
 *  what a recipient needs to choose a recovery: the attempt, the observed context, the newest complete restore map and
 *  the existing choices. Once it opens, the seat can't act on other seats' notices, so those move on (D3), as they do when
 *  nobody at all can receive its own notice: then none is created or invented, and the result says why, for the seat's
 *  compaction record (`rig compact --state`); later polls try again. */
export async function reportPreparationFailure(db: Database.Database, queue: QueueRepository, failure: PreparationFailure, unable?: RecoveryInability): Promise<void | PreparationNoticeUnaddressed> {
  const qitemId = preparationNoticeId(failure.sessionName, failure.occupantGeneration);
  const summary = failure.delivered
    ? `Managed preparation for ${failure.sessionName}: ${failure.endedAttempts} ended attempts without /compact (the latest delivered, ${failure.reason})`
    : `Managed preparation for ${failure.sessionName}: ${failure.endedAttempts} ended unsent attempts (${failure.reason})`;
  const evidence = `Attempt ${failure.attemptId}; reason ${failure.reason}; input box ${failure.inputBox ? JSON.stringify(failure.inputBox) : "reading unavailable"}`;
  const existing = queue.getById(qitemId);
  if (existing) {
    const kept = existing.summary?.endsWith(NO_CAPABLE_RECIPIENT) ? `${summary}${NO_CAPABLE_RECIPIENT}` : summary;
    if (["pending", "in-progress", "blocked"].includes(existing.state) && existing.summary !== kept) {
      const humans = queue.humanRegistry();
      const toPerson = !humans.ok || resolveRegisteredHumanAddress(existing.destinationSession, humans.entities) !== null;
      queue.update({ qitemId, actorSession: "system:compaction", summary: kept, transitionNote: toPerson ? kept : `${kept}. ${evidence}` });
    }
    if (unable) moveNoticesFromUnableRecipient(db, queue, failure.sessionName, unable);
    return;
  }
  let recipient: RecoveryRecipient;
  try { recipient = recoveryRecipient(db, queue, failure.sessionName, unable); }
  catch (error) {
    if (!(error instanceof WorkflowHumanDestinationError)) throw error;
    if (unable) moveNoticesFromUnableRecipient(db, queue, failure.sessionName, unable);
    return { unaddressed: `No recovery recipient could be resolved, so no notice was created: no eligible independent delegating parent, no capable receiving agent (rig config set agents.operator_session <seat> chooses one), and the registered person couldn't be resolved: ${error.message} OpenRig invents no recipient and tries again on later polls.` };
  }
  const seat = shellQuote(failure.sessionName);
  const used = failure.context?.usedPercentage;
  const context = typeof used === "number"
    ? `Latest context sample: ${used}% used of the context window Claude Code reports${failure.context?.sampledAt ? `, sampled ${failure.context.sampledAt}` : ", sample time unknown"}.`
    : "Latest context sample: unknown.";
  // A person's notice names no local path, as the other notices to a person don't.
  const map = newestCompleteMap(failure.mapPath, failure.sessionName);
  const retained = recipient.kind === "human"
    ? map ? `The seat's newest complete restore map, from attempt ${map.attemptId} (written ${map.writtenAt}), is kept in its preparation folder on the OpenRig host.`
      : "No complete restore map reads in the seat's preparation folder on the OpenRig host."
    : map ? `Newest complete restore map: ${map.mapPath} (attempt ${map.attemptId}, written ${map.writtenAt}).`
      : `No complete restore map reads under ${path.dirname(path.dirname(failure.mapPath))}.`;
  const choices = `Existing recovery choices, for the recipient to decide: wait for the next automatic attempt, though waiting has already failed ${failure.endedAttempts} times: an automatic attempt always needs a complete map, so it helps only if the seat can still write one; or, after rig compact ${seat} --cancel if a preparation is still active, run rig compact ${seat} --skip-map once, a manual request that sends /compact without a map, keeps the target, idle and permission checks, and is followed by OpenRig's restore request asking the seat for its newest restore map.`;
  await queue.create({ qitemId, sourceSession: failure.sessionName,
    destinationSession: recipient.session,
    summary: recipient.unresolved ? `${summary}${NO_CAPABLE_RECIPIENT}` : summary,
    wakeTrigger: "openrig", tags: ["compaction", "preparation-delivery", `occupant:${failure.occupantGeneration}`],
    evidenceRef: recipient.kind === "agent" ? failure.statePath : null,
    body: `${summary}. ${recipient.note} ${recipient.kind === "agent" ? `${evidence}. ` : ""}These are ended automatic attempts while usage remained above the threshold, not repeated sends in one attempt.${failure.delivered ? " The latest attempt's preparation request was delivered, and no complete restore map followed within its window. OpenRig doesn't see why." : ""} ${context} ${retained} Inspect rig compact ${seat} --state --json and the seat before choosing an existing supported recovery route. ${choices} This finding does not force input, skip a map, reset the seat, or change its account or model. No input is authorized by this notice.`,
  });
  if (unable) moveNoticesFromUnableRecipient(db, queue, failure.sessionName, unable);
}

/** D3: a seat OpenRig holds positive evidence can't act moves the compaction notices addressed to it, as the same rows
 *  with their history, to the next capable recipient on the existing route: a pending row with a wake, a claimed one
 *  without (a claim held by a seat that can't act would read as handled). With no capable recipient, the row stays and
 *  says so once. */
export function moveNoticesFromUnableRecipient(db: Database.Database, queue: QueueRepository, session: string, unable: RecoveryInability): void {
  const evidence = unable(session);
  if (!evidence) return;
  const seat = physicalSessionName(db, session);
  for (const item of openNotices(queue)) {
    if (physicalSessionName(db, item.destinationSession) !== seat) continue;
    const label = `${noticeKind(item)!.label} for ${item.sourceSession}`;
    let recipient: RecoveryRecipient;
    try { recipient = recoveryRecipient(db, queue, item.sourceSession, unable); }
    catch (error) {
      noteOnce(queue, item, `${label}: ${session} can't act on it now: ${evidence}. No other recovery recipient could be resolved: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (recipient.unresolved || physicalSessionName(db, recipient.session) === seat) {
      noteOnce(queue, item, `${label}: ${recipient.note}`);
      // Its face says so too, as a notice created with no capable recipient does (a summary change is recorded with its own note).
      if (recipient.unresolved && item.summary && !item.summary.endsWith(NO_CAPABLE_RECIPIENT)) {
        try {
          queue.update({ qitemId: item.qitemId, actorSession: "system:compaction", expectState: item.state,
            summary: `${item.summary}${NO_CAPABLE_RECIPIENT}`, transitionNote: `${label}: marked as having no capable recovery recipient` });
        } catch (error) {
          if ((error as { code?: unknown }).code !== "qitem_state_changed") throw error;
        }
      }
      continue;
    }
    // The recipient's note names the evidence once when the route passed over this seat, as it normally did.
    const named = [session, item.destinationSession].some((name) => recipient.note.includes(`${name} can't act on it now: `));
    try {
      queue.routeToFallback(item.qitemId, recipient.session, named ? recipient.note : `${session} can't act on this recovery notice now: ${evidence}. ${recipient.note}`,
        { expectState: item.state, expectDestination: item.destinationSession, wake: item.state === "pending" });
      if (item.summary?.endsWith(NO_CAPABLE_RECIPIENT)) {
        queue.update({ qitemId: item.qitemId, actorSession: "system:compaction", summary: item.summary.slice(0, -NO_CAPABLE_RECIPIENT.length),
          transitionNote: `${label}: now addressed to ${recipient.session}, a capable recipient.` });
      }
    } catch (error) {
      // Claimed, moved or closed since it was read: its current owner's state stands.
      const code = (error as { code?: unknown }).code;
      if (code !== "fallback_state_mismatch" && code !== "fallback_destination_mismatch" && code !== "qitem_state_changed") throw error;
    }
  }
}

/** The enforcer's poll re-checks the notices a seat holds: while OpenRig records that it can't act they move on as above,
 *  to a capable recipient chosen since; once it can act again, the ones it kept lose their "no capable recovery recipient"
 *  mark, since a capable agent now holds them. */
export function recheckHeldNotices(db: Database.Database, queue: QueueRepository, session: string, unable: RecoveryInability): void {
  if (unable(session)) { moveNoticesFromUnableRecipient(db, queue, session, unable); return; }
  const seat = physicalSessionName(db, session);
  for (const item of openNotices(queue)) {
    if (!item.summary?.endsWith(NO_CAPABLE_RECIPIENT) || physicalSessionName(db, item.destinationSession) !== seat) continue;
    try {
      queue.update({ qitemId: item.qitemId, actorSession: "system:compaction", expectState: item.state,
        summary: item.summary.slice(0, -NO_CAPABLE_RECIPIENT.length),
        transitionNote: `${noticeKind(item)!.label} for ${item.sourceSession}: ${item.destinationSession} can act on it again: OpenRig no longer records its own managed compaction as failing.` });
    } catch (error) {
      if ((error as { code?: unknown }).code !== "qitem_state_changed") throw error;
    }
  }
}

/** A system note, once per text, on an open notice. */
function noteOnce(queue: QueueRepository, item: QueueItem, note: string): void {
  if (queue.listTransitions(item.qitemId).some((t) => t.actorSession === "system:compaction" && t.transitionNote === note)) return;
  try {
    queue.update({ qitemId: item.qitemId, actorSession: "system:compaction", expectState: item.state, transitionNote: note });
  } catch (error) {
    if ((error as { code?: unknown }).code !== "qitem_state_changed") throw error;
  }
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
  noteOnce(queue, item, `${noticeKind(item)!.label} for ${item.sourceSession}: OpenRig can't tell whether this is still owed: ${why}`);
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
