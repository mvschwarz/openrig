// PL-005 Phase A: Mission Control write-contract — atomic 7-verb actions.
//
// LOAD-BEARING. Per PRD § Acceptance Criteria + slice IMPL § Guard
// Checkpoint Focus item 2: each of 7 verbs is one atomic transaction.
// The 4-step `handoff` shape (source-update + destination-create +
// opt-in best-effort notify + audit-record append) is the canonical
// proof case; other 6 verbs follow the same atomic-update + audit
// shape with verb-specific metadata.
//
// Composition (one db.transaction per verb call):
//   1. Verify the target qitem exists and isn't already terminal.
//   2. Compute the verb-specific queue mutation via Phase D's
//      QueueRepository.updateWithinTransaction (preserves Phase A
//      hot-potato closure validation; emits queue.updated event).
//   3. For handoff: also call QueueRepository.createWithinTransaction
//      to make the destination packet (the same outer txn).
//   4. Append the mission_control_actions audit record with before +
//      after state snapshots.
//   5. Persist the mission_control.action_executed event.
//
// Post-commit (outside the transaction): the event envelope drains to
// subscribers, then opt-in best-effort transport notify runs. Notify failure
// does NOT roll back durable mutations (PRD invariant: "notify failure does
// NOT roll back durable mutations").
//
// Verb mappings:
//   approve   → state="done",        closure_reason="no-follow-on"
//   deny      → state="done",        closure_reason="denied"
//   route     → state="done",        closure_reason="handed_off_to",
//                closure_target+handed_off_to=<route target>;
//                creates new qitem at the route target (1-hop)
//   annotate  → no queue mutation; audit record only (annotation field
//                attached to mission_control_actions)
//   hold      → state="blocked",     closure_reason="blocked_on",
//                closure_target+blocked_on=<reason text>
//   drop      → state="done",        closure_reason="canceled",
//                closure_target=<reason>
//   handoff   → state="handed-off",  closure_reason="handed_off_to",
//                closure_target+handed_off_to=<destination>;
//                creates new qitem at destination (4-step canonical)

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { EventBus } from "../event-bus.js";
import { isTypedGateBlocker, mcOperationTag, UNATTRIBUTED_ACTOR, type QueueRepository, type QueueItem } from "../queue-repository.js";
import type { PersistedEvent } from "../types.js";
import {
  MissionControlActionLog,
  MissionControlActionLogError,
  type MissionControlVerb,
} from "./mission-control-action-log.js";
import { isHumanSeatSessionRef } from "../session-name.js";
import { humanAnswerText, formatHumanAnswers, unansweredQuestions, type HumanAnswers } from "../human-questions.js";
import { runnerPermissionOrigin } from "../runner-permissions.js";

/** The terminal's act, which names no responder: the generic human seat the web UI also records, read as explicitly
 *  unattributed, never a person. */
export const UNNAMED_PRIMARY_USER = UNATTRIBUTED_ACTOR;
/** Verbs that settle what a person was asked. */
const SETTLING_VERBS = new Set<MissionControlVerb>(["approve", "deny", "resolve", "answer"]);

export class MissionControlWriteContractError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "MissionControlWriteContractError";
  }
}

export interface MissionControlActionInput {
  verb: MissionControlVerb;
  qitemId: string;
  actorSession: string;
  /** P21 era-stamp: how actorSession was established. The route passes `transport:v1` (derived from
   *  the transport chokepoint); omitted/null ⇒ claimed-era, never re-labeled. Recorded on the audit row. */
  identityProvenance?: string | null;
  /** Required for `route` and `handoff`. */
  destinationSession?: string;
  /** Body for the new packet on `route`/`handoff`; defaults to source body. */
  body?: string;
  /** Required for `annotate`. */
  annotation?: string;
  /** Required for `hold` and `drop`; optional advisory text otherwise. */
  reason?: string;
  /** OPR.0.4.4.19 FR-7 — required for `resolve`: the human's non-empty
   *  decision text. Lands durably in queue_transitions.transition_note. */
  decision?: string;
  /** For `resolve` of a decision parked on the person it asked, from Slack: their typed words, also stored as its answer in
   *  the same transaction as the resume. Set in process only; the route never passes it. */
  answerText?: string;
  /** For `answer`: the question and option the person chose. Without them, `decision` is their typed answer. */
  questionId?: string;
  optionId?: string;
  /** Operator-supplied audit context. */
  auditNotes?: Record<string, unknown>;
  /** `primary-user`: the person at the terminal acts (the TUI), whoever was asked. The terminal's claimed actor is the
   *  Feed's recipient-derived value, not who typed, so the act is recorded as human@host, explicitly unattributed, never
   *  the default person or the claim; the audit notes say whose ask it was. Only a request with no transport identity
   *  carries it. A surface that knows its person sends them without it. */
  authority?: "primary-user";
  /** #2446, opt-in: the `decisionRevision` the caller read. A settling act then runs only on that decision; omitted, the
   *  act and its result are exactly as before. An `operationId` in `auditNotes` lets a retry be answered from the record. */
  expectedRevision?: string;
  /**
   * For handoff: opt-in best-effort wake. Default true (PL-004 Phase A R1
   * pattern: durable + waking by default; operators opt out for cold queues).
   * notify failure does NOT roll back durable state.
   */
  notify?: boolean;
}

export interface MissionControlActionResult {
  actionId: string;
  verb: MissionControlVerb;
  qitemId: string;
  closedQitem: QueueItem | null;
  createdQitemId: string | null;
  notifyAttempted: boolean;
  notifyResult: string | null;
  auditedAt: string;
  /** For `answer`: recorded with questions still open, or answered (returned to the asker, and the ask closed). */
  answer?: { outcome: "recorded" | "answered"; unanswered: string[]; message?: string };
  /** With expectedRevision only: the decision's revision as saved. */
  decisionRevision?: string;
  /** With expectedRevision only: this retry is the caller's own committed operation, answered from its record. */
  reconciled?: true;
  /** With expectedRevision on a verb that doesn't settle a decision: it wasn't checked, and the act ran as without it. */
  revisionNote?: string;
}

interface WriteContractDeps {
  db: Database.Database;
  eventBus: EventBus;
  queueRepo: QueueRepository;
  actionLog: MissionControlActionLog;
  now?: () => Date;
}

export class MissionControlWriteContract {
  private readonly db: Database.Database;
  private readonly eventBus: EventBus;
  private readonly queueRepo: QueueRepository;
  private readonly actionLog: MissionControlActionLog;
  private readonly now: () => Date;

  constructor(deps: WriteContractDeps) {
    this.db = deps.db;
    this.eventBus = deps.eventBus;
    this.queueRepo = deps.queueRepo;
    this.actionLog = deps.actionLog;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Execute one verb. Atomic at the durable layer: queue mutation +
   * audit record + event persistence in one transaction. Post-commit:
   * notify subscribers + opt-in transport wake (handoff only).
   */
  async act(input: MissionControlActionInput): Promise<MissionControlActionResult> {
    if (input.expectedRevision === undefined) return this.actOn(input);
    // Only the settling verbs compare it. Another verb acts as today, and says the revision wasn't checked.
    if (!SETTLING_VERBS.has(input.verb)) {
      return { ...await this.actOn(input), revisionNote: `expectedRevision isn't checked for ${input.verb}; only answer, resolve, approve and deny compare it.` };
    }
    // #2446: the act runs only on the decision its caller read. No await separates this check from the act's first
    // write, so no other request in this daemon changes the decision in between. The one path whose first write follows
    // an await, a typed answer to a runner's permission ask, compares again before it (answerAsk).
    const operation = typeof input.auditNotes?.operationId === "string" ? operationFingerprint(input) : null;
    const item = this.queueRepo.getById(input.qitemId);
    const current = item ? this.queueRepo.decisionRevision(item) : null;
    if (item && current !== input.expectedRevision) {
      const last = this.actionLog.listForQitem(input.qitemId, 1)[0];
      // The caller's own committed operation retried after an uncertain result: answered from its record, nothing written.
      if (operation && last?.auditNotes?.operation === operation) {
        return { actionId: last.actionId, verb: input.verb, qitemId: input.qitemId, closedQitem: item, createdQitemId: null,
          notifyAttempted: false, notifyResult: null, auditedAt: last.actedAt, reconciled: true, decisionRevision: current! };
      }
      const withoutOwnReply =
        operation && input.verb === "answer"
          ? this.queueRepo.decisionRevision(item, { excludeOperationReply: operation })
          : current;
      if (withoutOwnReply !== input.expectedRevision) {
        throw this.revisionChanged(item, current!);
      }
    }
    const result = await this.actOn(operation ? { ...input, auditNotes: { ...input.auditNotes, operation } } : input);
    const saved = this.queueRepo.getById(input.qitemId);
    return saved ? { ...result, decisionRevision: this.queueRepo.decisionRevision(saved) } : result;
  }

  /** A guarded act's decision changed since its revision was read: nothing was written, and the caller gets what's saved. */
  private revisionChanged(item: QueueItem, current: string): MissionControlWriteContractError {
    const last = this.actionLog.listForQitem(item.qitemId, 1)[0];
    return new MissionControlWriteContractError("decision_revision_changed",
      `qitem ${item.qitemId} changed since this revision was read, so nothing was written. Read it again for the current decision.`,
      { qitemId: item.qitemId, currentRevision: current, state: item.state, humanAnswers: item.humanAnswers ?? null,
        lastAction: last ? { actionId: last.actionId, verb: last.actionVerb, actorSession: last.actorSession, actedAt: last.actedAt, auditNotes: last.auditNotes } : null });
  }

  private async actOn(input: MissionControlActionInput): Promise<MissionControlActionResult> {
    if (input.verb === "annotate") {
      return this.annotateOnly(input);
    }
    if (input.verb === "resolve") {
      return this.resolveParked(input);
    }
    if (input.verb === "answer") {
      return this.answerAsk(input);
    }

    const source = this.requireMutableQitem(input.qitemId);
    // Whose ask this settles: the person a row is parked on, else a person it's addressed to.
    const parkedOn = source.state === "blocked" && source.blockedOn && isHumanSeatSessionRef(source.blockedOn) ? source.blockedOn : null;
    const asked = parkedOn ?? (this.queueRepo.isPersonAddress(source.destinationSession) ? source.destinationSession : null);
    const acting = this.asActor(input, runnerPermissionOrigin(source) && this.queueRepo.answersAsk(source, input.actorSession) ? null : asked);
    input = acting.input;

    if ((input.verb === "route" || input.verb === "handoff") && !input.destinationSession) {
      throw new MissionControlWriteContractError(
        "destination_required",
        `verb=${input.verb} requires destinationSession`,
        { verb: input.verb },
      );
    }

    const evaluatedAt = this.now().toISOString();
    const closure = verbToClosure(input);
    const beforeSnapshot = snapshotQitem(source);
    let createdQitemId: string | null = null;
    let createdDestination: string | undefined;
    let createdNudge: boolean | undefined;
    let actionEntry: ReturnType<MissionControlActionLog["record"]> | null = null;
    try {
      this.eventBus.withNotifyEnvelope((register) => {
        // 1. Close/transition the source via Phase A's queue closure primitive.
        const closeResult = this.queueRepo.updateWithinTransaction({
          qitemId: input.qitemId,
          actorSession: input.actorSession,
          state: closure.state,
          closureReason: closure.closureReason,
          closureTarget: closure.closureTarget ?? undefined,
          handedOffTo: closure.handedOffTo,
          blockedOn: closure.blockedOn,
          transitionNote: `mission-control:${input.verb}${input.reason ? ` (${input.reason})` : ""}${acting.note}`,
        });
        register(closeResult.persistedEvent);

        // 2. For route/handoff: create the destination packet in same txn.
        if ((input.verb === "route" || input.verb === "handoff") && input.destinationSession) {
          // A runner's permission ask passed to a colleague: the colleague decides, so a person gets the agent's options
          // (found back along the handoffs when it came through an agent seat), and the row records what it was handed
          // from, as the queue's own handoff does, so the request follows it exactly.
          const permission = runnerPermissionOrigin(source) !== null;
          const questions = permission && this.queueRepo.isPersonAddress(input.destinationSession) ? this.queueRepo.permissionQuestionsFor(source) : null;
          const created = this.queueRepo.createWithinTransaction({
            sourceSession: input.actorSession,
            destinationSession: input.destinationSession,
            body: input.body ?? source.body,
            priority: source.priority,
            tier: source.tier ?? undefined,
            summary: source.summary,
            evidenceRef: source.evidenceRef,
            tags: source.tags
              ? [...source.tags, `mission-control:${input.verb}`]
              : [`mission-control:${input.verb}`],
            chainOfRecord: [...(source.chainOfRecord ?? []), input.qitemId],
            ...(permission ? { handedOffFrom: input.qitemId } : {}),
            ...(questions ? { humanIntent: "decision" as const, humanAlert: true, humanQuestions: questions } : {}),
            // Default nudge handled post-commit per Phase D pattern.
            nudge: input.notify,
          });
          createdQitemId = created.qitemId;
          createdDestination = created.destinationSession;
          createdNudge = created.nudge;
          register(created.persistedEvent);
          // P34: stage the successor's WAKE INTENT inside this transaction, so the
          // close and the durable wake commit as ONE act or NONE. The pane write
          // itself stays post-commit (reversed-never).
          this.queueRepo.stageHandoffWake(
            created.qitemId,
            input.actorSession,
            created.destinationSession,
            input.identityProvenance ?? null,
            created.nudge,
          );
        }

        // 3. Append the audit record. Snapshot the closed qitem state.
        const closedQitem = this.queueRepo.getById(input.qitemId);
        const afterSnapshot = closedQitem ? snapshotQitem(closedQitem) : null;
        actionEntry = this.actionLog.record({
          actionVerb: input.verb,
          qitemId: input.qitemId,
          actorSession: input.actorSession,
          actedAt: evaluatedAt,
          beforeState: beforeSnapshot,
          afterState: afterSnapshot,
          reason: input.reason ?? null,
          annotation: input.annotation ?? null,
          notifyAttempted: false,
          notifyResult: null,
          auditNotes: input.auditNotes ?? null,
          identityProvenance: input.identityProvenance ?? null, // P21 era-stamp on the audit row
        });

        // 4. Persist the mission_control.action_executed event in same txn.
        register(
          this.eventBus.persistWithinTransaction({
            type: "mission_control.action_executed",
            actionId: actionEntry.actionId,
            actionVerb: input.verb,
            qitemId: input.qitemId,
            actorSession: input.actorSession,
          }),
        );

        // P34: the W1 seam, run as the LAST statement of this transaction. If this
        // act terminally closed the source AND created a successor, the successor's
        // wake intent must be durable in the SAME transaction — otherwise the whole
        // act rolls back here rather than committing an executed-but-unwoken item.
        // A non-terminal transition (the `hold` park) returns early inside the
        // primitive itself (queue-repository.ts, isTerminalState), so park callers
        // are untouched by construction; a terminal close with NO successor has
        // nothing to wake and is not paired here.
        if (createdQitemId && createdDestination) {
          this.queueRepo.assertTerminalClosureHasIntent(input.qitemId, createdQitemId, createdNudge);
        }
      });
    } catch (err) {
      if (err instanceof MissionControlActionLogError) {
        throw new MissionControlWriteContractError(err.code, err.message, err.details);
      }
      throw err;
    }

    // Post-commit best-effort notify on handoff/route. Default true per
    // PL-004 R1 pattern; failure does NOT roll back durable mutations.
    let notifyAttempted = false;
    let notifyResult: string | null = null;
    if (createdQitemId && createdDestination && (input.verb === "route" || input.verb === "handoff")) {
      try {
        // V0.3.1 slice 23: thread actorSession as the source so the
        // nudge envelope shows where the route/handoff came from.
        // P34: deliver through the SHARED staged-intent path, not maybeNudge —
        // it claims and finalizes the intent row this txn staged, so the startup
        // recovery sweep cannot send the same wake a second time. With no intent
        // store attached it falls back to the pre-W1 best-effort nudge.
        await this.queueRepo.deliverWakeForSuccessor(
          createdQitemId,
          createdDestination,
          createdNudge,
          input.actorSession,
        );
        notifyAttempted = createdNudge !== false;
        notifyResult = notifyAttempted ? "attempted-best-effort" : "skipped";
      } catch (err) {
        notifyAttempted = true;
        notifyResult = `failed:${err instanceof Error ? err.message : String(err)}`;
      }
    }

    return {
      actionId: actionEntry!.actionId,
      verb: input.verb,
      qitemId: input.qitemId,
      closedQitem: this.queueRepo.getById(input.qitemId),
      createdQitemId,
      notifyAttempted,
      notifyResult,
      auditedAt: evaluatedAt,
    };
  }

  /**
   * Annotate has no queue mutation — only an audit record + event.
   * Still wrapped in a transaction so the audit + event are atomic.
   */
  private async annotateOnly(input: MissionControlActionInput): Promise<MissionControlActionResult> {
    if (!input.annotation) {
      throw new MissionControlWriteContractError(
        "annotation_required",
        `verb=annotate requires annotation`,
        { verb: input.verb },
      );
    }
    const source = this.requireMutableQitem(input.qitemId);
    // The same actor rule as every other verb: a channel never annotates, and the terminal's authority names the primary
    // user. An annotation settles no ask.
    input = this.asActor(input, null).input;
    const snapshot = snapshotQitem(source);
    const evaluatedAt = this.now().toISOString();
    let actionEntry: ReturnType<MissionControlActionLog["record"]> | null = null;
    const persistedEvents: PersistedEvent[] = [];

    const txn = this.db.transaction(() => {
      actionEntry = this.actionLog.record({
        actionVerb: "annotate",
        qitemId: input.qitemId,
        actorSession: input.actorSession,
        actedAt: evaluatedAt,
        beforeState: snapshot,
        afterState: snapshot,
        annotation: input.annotation!,
        auditNotes: input.auditNotes ?? null,
        identityProvenance: input.identityProvenance ?? null, // P21 era-stamp on the audit row
      });
      persistedEvents.push(
        this.eventBus.persistWithinTransaction({
          type: "mission_control.action_executed",
          actionId: actionEntry.actionId,
          actionVerb: "annotate",
          qitemId: input.qitemId,
          actorSession: input.actorSession,
        }),
      );
    });
    txn();
    for (const e of persistedEvents) this.eventBus.notifySubscribers(e);

    return {
      actionId: actionEntry!.actionId,
      verb: "annotate",
      qitemId: input.qitemId,
      closedQitem: this.queueRepo.getById(input.qitemId),
      createdQitemId: null,
      notifyAttempted: false,
      notifyResult: null,
      auditedAt: evaluatedAt,
    };
  }

  /**
   * OPR.0.4.4.19 FR-7 — resolve + unpark (all six arch rails encoded):
   *
   *   1. A verb in the mission-control family (this method), NOT an overload
   *      of annotate/route.
   *   2. The decision text lands durably + queryably in
   *      queue_transitions.transition_note with actor_session = the
   *      resolving session (the composer reads it there forever).
   *   3. Unpark = blocked → in-progress via the Phase-A enum-validated
   *      update (no state-machine change) + the existing nudge machinery.
   *   4. Resolution routes BACK to the parked owner — the qitem keeps its
   *      destination; no new potato owner is ever created here.
   *   5. Human parks required summary + evidence_ref; human and typed-gate
   *      resolution requires NON-EMPTY decision/evidence text, daemon-enforced.
   *   6. The human acts on the surface/feed card; this is the ONE write
   *      path (POST /api/mission-control/action verb=resolve) — the CLI
   *      wrapper is a thin client of the same endpoint.
   *
   * NON-CLOSURE by contract: verbToClosure has NO resolve mapping — a
   * resolved qitem is state=in-progress with closure_reason still null.
   * One transaction: transition + decision note + audit row + events.
   * The owner nudge (carrying the decision text) is post-commit
   * best-effort — the unpark is never lost to a transport failure (BR-8).
   */
  private async resolveParked(input: MissionControlActionInput): Promise<MissionControlActionResult> {
    const decision = input.decision?.trim();
    if (!decision) {
      throw new MissionControlWriteContractError(
        "decision_required",
        "verb=resolve requires non-empty decision text — a park without a recorded decision is exactly what this primitive exists to kill",
        { verb: input.verb },
      );
    }
    const source = this.queueRepo.getById(input.qitemId);
    if (!source) {
      throw new MissionControlWriteContractError(
        "qitem_not_found",
        `qitem ${input.qitemId} not found`,
        { qitemId: input.qitemId },
      );
    }
    const humanPark = source.blockedOn !== null && this.queueRepo.isPersonAddress(source.blockedOn);
    if (source.state !== "blocked" || (!humanPark && !isTypedGateBlocker(source.blockedOn))) {
      throw new MissionControlWriteContractError(
        "qitem_not_leg1_parked",
        `verb=resolve requires state=blocked on a human seat or a well-formed external:, fold: or auth: gate; ` +
          `qitem ${input.qitemId} is state=${source.state}, blocked_on=${source.blockedOn ?? "null"}. ` +
          `Re-resolving an already-resolved item is a no-op error, not a double transition.`,
        { qitemId: input.qitemId, state: source.state, blockedOn: source.blockedOn },
      );
    }
    // Only a person was asked; a typed gate has no asked person. Another registered person settles it as themselves, and
    // the record names the person asked.
    const acting = this.asActor(input, humanPark ? source.blockedOn : null);
    input = acting.input;

    const evaluatedAt = this.now().toISOString();
    const beforeSnapshot = snapshotQitem(source);
    let actionEntry: ReturnType<MissionControlActionLog["record"]> | null = null;
    try {
      this.eventBus.withNotifyEnvelope((register) => {
        // Rail 2+3: blocked → in-progress; decision text = transition_note;
        // actor_session = the resolving session. Only a human park records a
        // human-decision ceremony; typed gates record satisfaction evidence. Emits
        // queue.updated (the P2 refresh-after-action contract). The repository
        // clears blocked_on on exit; the audit's beforeState retains the park.
        // A typed answer commits with the resume, so neither can land without the other.
        if (humanPark && input.answerText !== undefined) this.queueRepo.recordParkedTypedReply(input.qitemId, input.answerText);
        const updateResult = this.queueRepo.updateWithinTransaction({
          qitemId: input.qitemId,
          actorSession: input.actorSession,
          state: "in-progress",
          transitionNote: humanPark ? `${decision}${acting.note}` : `Blocker ${source.blockedOn} resolved: ${decision}`,
          ownerNotificationKind: humanPark ? "human-decision-resolved" : undefined,
        });
        register(updateResult.persistedEvent);

        const resolvedQitem = this.queueRepo.getById(input.qitemId);
        actionEntry = this.actionLog.record({
          actionVerb: "resolve",
          qitemId: input.qitemId,
          actorSession: input.actorSession,
          actedAt: evaluatedAt,
          beforeState: beforeSnapshot,
          afterState: resolvedQitem ? snapshotQitem(resolvedQitem) : null,
          reason: decision,
          auditNotes: input.auditNotes ?? null,
          identityProvenance: input.identityProvenance ?? null, // P21 era-stamp on the audit row
        });

        register(
          this.eventBus.persistWithinTransaction({
            type: "mission_control.action_executed",
            actionId: actionEntry.actionId,
            actionVerb: "resolve",
            qitemId: input.qitemId,
            actorSession: input.actorSession,
          }),
        );
      });
    } catch (err) {
      if (err instanceof MissionControlActionLogError) {
        throw new MissionControlWriteContractError(err.code, err.message, err.details);
      }
      throw err;
    }

    // Rail 3 + BR-8: best-effort nudge to the PARKED OWNER carrying the
    // decision text, after the commit — nudge outcome recorded via the
    // existing last_nudge_* mechanics; a failed nudge never unwinds the
    // unpark.
    let notifyAttempted = false;
    let notifyResult: string | null = null;
    if (input.notify !== false) {
      try {
        await this.queueRepo.maybeNudge(
          input.qitemId,
          source.destinationSession,
          input.notify,
          input.actorSession,
          `${humanPark ? "Decision" : "Blocker"} resolved on ${input.qitemId}: ${decision} — unparked (blocked → in-progress); you still own it.${humanPark ? " Read the recorded decision before continuing: a response is not approval. Resolve records attribution, not consent or authority; a denial, question, condition, changed decision or authorized override keeps its meaning." : ""} Check your queue.`,
        );
        notifyAttempted = true;
        notifyResult = "attempted-best-effort";
      } catch (err) {
        notifyAttempted = true;
        notifyResult = `failed:${err instanceof Error ? err.message : String(err)}`;
      }
    }

    return {
      actionId: actionEntry!.actionId,
      verb: "resolve",
      qitemId: input.qitemId,
      closedQitem: this.queueRepo.getById(input.qitemId),
      createdQitemId: null,
      notifyAttempted,
      notifyResult,
      auditedAt: evaluatedAt,
    };
  }

  /**
   * The person's answer to an ask addressed to them, with the meaning Slack's answers have: a choice (`questionId` +
   * `optionId`) through recordHumanAnswer, which keeps a partial set pending and a complete one final, or their words
   * (`decision`) through resolveDirectHumanReply, placed under the first unanswered question. Once it's answered, the
   * asking seat gets one reply row and then the ask closes once, the order of Slack's own continuation, so a retry never
   * leaves an ask closed with its answer not returned; the reply row's id comes from the ask, so a retry finds the same
   * row, including a return from Slack before the shared ID existed. A committed return wins over a later attempt's
   * words: finish its close and tell the person where their original answer went. No second reply or wake is created.
   */
  private async answerAsk(input: MissionControlActionInput): Promise<MissionControlActionResult> {
    const ask = this.queueRepo.getById(input.qitemId);
    if (!ask) {
      throw new MissionControlWriteContractError("qitem_not_found", `qitem ${input.qitemId} not found`, { qitemId: input.qitemId });
    }
    const primaryUser = input.authority === "primary-user";
    // Any registered person answers any ask, recorded as themselves; a runner's request keeps its own notes.
    input = this.asActor(input, runnerPermissionOrigin(ask) && this.queueRepo.answersAsk(ask, input.actorSession) ? null : ask.destinationSession).input;
    // The asked person or another registered person answers, or the person at the terminal does on anyone's ask.
    if ((!this.queueRepo.answersAsk(ask, input.actorSession) && !primaryUser) || ask.humanIntent === "update" || !this.queueRepo.isPersonAddress(ask.destinationSession)) {
      throw new MissionControlWriteContractError("answer_not_recorded",
        `qitem ${input.qitemId} isn't an ask to ${input.actorSession}, so ${input.actorSession} can't answer it.`, { qitemId: input.qitemId });
    }
    const before = snapshotQitem(ask);
    const questions = ask.humanQuestions ?? [];
    const existing = this.queueRepo.getHumanAnswer(input.qitemId, input.actorSession, { primaryUser });
    if (existing && (ask.state === "pending" || ask.state === "done")) {
      const decision = questions.length && unansweredQuestions(questions, ask.humanAnswers ?? {}).length === 0
        ? formatHumanAnswers(questions, ask.humanAnswers ?? {}).join("; ") : humanAnswerText(existing.body);
      return this.recordAnswer(
        input,
        before,
        decision,
        {
          outcome: "answered",
          unanswered: [],
          message: `Already answered; the original answer went to ${existing.destinationSession} as ${existing.qitemId}. No new reply was sent.`,
        },
        existing.qitemId,
        ask.state === "pending"
          ? {
              primaryUser,
              allowAlreadyDone: false,
              onUnclosed: () =>
                new MissionControlWriteContractError(
                  "answer_not_closed",
                  `The answer is already in ${existing.qitemId}, but ${input.qitemId} didn't close.`,
                  { qitemId: input.qitemId },
                ),
            }
          : undefined,
      );
    }
    // One answer per ask: another person's committed return is the answer. Before anything of this person's is recorded,
    // finish settling the ask with it and say who answered; nothing of theirs is recorded or sent.
    const other = this.queueRepo.committedAnswerFromAnother(input.qitemId, input.actorSession);
    if (other) this.answeredByAnother(input, other, primaryUser);
    if (ask.state !== "pending") {
      throw new MissionControlWriteContractError("qitem_already_terminal",
        `qitem ${input.qitemId} is ${ask.state}, not waiting on an answer (it may already be answered), so nothing was recorded or sent.`,
        { qitemId: input.qitemId, state: ask.state });
    }
    const chose = input.questionId !== undefined || input.optionId !== undefined;
    const words = input.decision?.trim() ?? "";
    // A complete set whose return didn't finish (it failed, or the process stopped): sending again returns exactly those
    // recorded answers, never a bare close.
    const resume = !chose && !words && questions.length > 0 && unansweredQuestions(questions, ask.humanAnswers ?? {}).length === 0;
    const answersReply = (answers: HumanAnswers) => `${formatHumanAnswers(questions, answers).join("\n")}\n\n---\nAnswers (question id → option id): ${JSON.stringify(answers)}\nIn reply to: ${input.qitemId} (its humanAnswers field holds the same)`;
    let reply: string;
    let wrote = false; // whether this call changed the ask before the return below awaits
    if (chose) {
      const recorded = this.queueRepo.recordHumanAnswer({ qitemId: input.qitemId, actorSession: input.actorSession,
        questionId: input.questionId ?? "", optionId: input.optionId ?? "", primaryUser });
      if (recorded.status !== "recorded") {
        throw new MissionControlWriteContractError("answer_not_recorded", `The answer wasn't recorded: ${recorded.reason}.`,
          { qitemId: input.qitemId, reason: recorded.reason });
      }
      // An already-complete set (an interrupted return) comes back without a write.
      wrote = JSON.stringify(recorded.answers) !== JSON.stringify(ask.humanAnswers ?? {});
      const [just] = formatHumanAnswers(recorded.questions.filter((q) => q.id === input.questionId), recorded.answers);
      if (!recorded.complete) {
        return this.recordAnswer(input, before, just ?? `answered ${input.questionId}`, {
          outcome: "recorded", unanswered: unansweredQuestions(recorded.questions, recorded.answers).map((q) => q.question) });
      }
      reply = answersReply(recorded.answers);
    } else if (resume) {
      reply = answersReply(ask.humanAnswers ?? {});
    } else {
      if (!words) {
        throw new MissionControlWriteContractError("decision_required",
          "verb=answer needs a choice (questionId and optionId) or the person's words (decision)", { verb: input.verb });
      }
      const earlier = formatHumanAnswers(questions, ask.humanAnswers ?? {});
      reply = `${words}\n\n---\n${earlier.length ? `Earlier answers: ${earlier.join("; ")}\n` : ""}In reply to: ${input.qitemId}${questions.length ? " (its humanAnswers field holds these words under its first unanswered question)" : ""}`;
    }
    // The asker reads who answered, and whose ask it was: never the asked person when someone else answered.
    const forAsked = ask.destinationSession !== input.actorSession ? ask.destinationSession : null;
    const unattributed = primaryUser && input.actorSession === UNNAMED_PRIMARY_USER;
    const answeredBy = !forAsked ? `Answered by ${input.actorSession}`
      : unattributed ? `Answered at the terminal by someone OpenRig can't name (${UNNAMED_PRIMARY_USER}), unattributed, on ${forAsked}'s ask`
      : `Answered by ${input.actorSession}, ${primaryUser ? "the primary user at the terminal" : "a registered person"}, on ${forAsked}'s ask`;
    const operation =
      typeof input.auditNotes?.operation === "string" && input.auditNotes.operation.length > 0
        ? input.auditNotes.operation
        : null;
    let returned: QueueItem;
    try {
      returned = await this.queueRepo.createHumanAnswer({
        sourceSession: input.actorSession, destinationSession: ask.sourceSession,
        body: `${reply}\n${answeredBy} in OpenRig.`,
        summary: `${forAsked && unattributed ? `Unattributed (${UNNAMED_PRIMARY_USER})` : input.actorSession} answered${forAsked ? ` ${forAsked}'s ask` : ""}: ${ask.summary ?? input.qitemId}`,
        tags: [
          "human-answer",
          ...(ask.tags ?? []).filter((t) => /^(project|mission|slice):/.test(t)),
          ...(operation ? [mcOperationTag(operation)] : []),
        ],
        inboundReplyTo: input.qitemId, ...(input.notify === false ? { nudge: false } : {}),
      });
    } catch (error) {
      throw new MissionControlWriteContractError("answer_not_closed",
        `Returning the answer to ${ask.sourceSession} failed (${(error as Error).message}), so ${input.qitemId} wasn't closed. `
        + (chose || resume ? "Its recorded answers stay on the row; open it again to send them." : "Nothing was recorded; answer again once that's fixed."),
        { qitemId: input.qitemId });
    }
    const replyId = returned.qitemId;
    // Two people answering at once: one answer returns, and the other is told whose it was.
    if (replyId !== input.qitemId && returned.sourceSession !== input.actorSession) this.answeredByAnother(input, returned, primaryUser);
    // A runner's permission ask is its own answer record (no reply row comes back), so typed words are the person's own.
    const decision = chose || resume
      ? formatHumanAnswers(questions, this.queueRepo.getById(input.qitemId)?.humanAnswers ?? {}).join("; ")
      : returned.qitemId === input.qitemId ? words : humanAnswerText(returned.body);
    // #2446: on a runner's permission ask (no reply row), a call that changed nothing before the await above (typed words,
    // or a choice whose set was already complete) still has its first write ahead, and the await let other requests in, so
    // a guarded answer compares its revision again here, with no await before the close. A call that wrote was compared
    // before that write.
    if (input.expectedRevision !== undefined && replyId === input.qitemId && !wrote) {
      const now = this.queueRepo.getById(input.qitemId);
      const revision = now ? this.queueRepo.decisionRevision(now) : null;
      if (now && revision !== input.expectedRevision) throw this.revisionChanged(now, revision!);
    }
    return this.recordAnswer(
      input,
      before,
      decision,
      { outcome: "answered", unanswered: [] },
      replyId,
      {
        primaryUser,
        allowAlreadyDone: true,
        onUnclosed: () =>
          new MissionControlWriteContractError(
            "answer_not_closed",
            `The answer went back to ${ask.sourceSession} as ${replyId}, but qitem ${input.qitemId} didn't close: it changed meanwhile.`,
            { qitemId: input.qitemId, replyQitemId: replyId },
          ),
      },
    );
  }

  /** Another person's committed return already answers the ask: settle the ask with it if it's still pending (the
   *  repository closes it as theirs), then tell this person who answered and where it went. */
  private answeredByAnother(input: MissionControlActionInput, other: QueueItem, primaryUser: boolean): never {
    const ask = this.queueRepo.getById(input.qitemId);
    if (ask?.state === "pending") this.queueRepo.resolveDirectHumanReply({ qitemId: input.qitemId, actorSession: input.actorSession, decision: "", primaryUser });
    throw new MissionControlWriteContractError("qitem_already_terminal",
      `${other.sourceSession} already answered qitem ${input.qitemId}; their answer went to ${other.destinationSession} as ${other.qitemId}. ${input.actorSession}'s answer wasn't recorded or sent.`,
      { qitemId: input.qitemId, answeredBy: other.sourceSession, replyQitemId: other.qitemId });
  }

  /** Close a pending ask (when requested) and record its audit row and event in one atomic transaction. */
  private recordAnswer(
    input: MissionControlActionInput,
    before: Record<string, unknown>,
    reason: string,
    answer: NonNullable<MissionControlActionResult["answer"]>,
    createdQitemId: string | null = null,
    closePending?: {
      primaryUser: boolean;
      allowAlreadyDone: boolean;
      onUnclosed: () => MissionControlWriteContractError;
    },
  ): MissionControlActionResult {
    const evaluatedAt = this.now().toISOString();
    let after: QueueItem | null = null;
    let actionEntry: ReturnType<MissionControlActionLog["record"]> | null = null;
    try {
      this.eventBus.withNotifyEnvelope((register) => {
        if (closePending) {
          const closed = this.queueRepo.resolveDirectHumanReply({
            qitemId: input.qitemId,
            actorSession: input.actorSession,
            decision: reason,
            primaryUser: closePending.primaryUser,
          });
          if (!closed && (!closePending.allowAlreadyDone || this.queueRepo.getById(input.qitemId)?.state !== "done")) {
            throw closePending.onUnclosed();
          }
        }
        after = this.queueRepo.getById(input.qitemId);
        actionEntry = this.actionLog.record({
          actionVerb: "answer",
          qitemId: input.qitemId,
          actorSession: input.actorSession,
          actedAt: evaluatedAt,
          beforeState: before,
          afterState: after ? snapshotQitem(after) : null,
          reason,
          auditNotes: input.auditNotes ?? null,
          identityProvenance: input.identityProvenance ?? null,
        });
        register(
          this.eventBus.persistWithinTransaction({
            type: "mission_control.action_executed",
            actionId: actionEntry.actionId,
            actionVerb: "answer",
            qitemId: input.qitemId,
            actorSession: input.actorSession,
          }),
        );
      });
    } catch (err) {
      if (err instanceof MissionControlActionLogError) {
        throw new MissionControlWriteContractError(err.code, err.message, err.details);
      }
      throw err;
    }
    return {
      actionId: actionEntry!.actionId,
      verb: "answer",
      qitemId: input.qitemId,
      closedQitem: after,
      createdQitemId,
      notifyAttempted: false,
      notifyResult: null,
      auditedAt: evaluatedAt,
      answer,
    };
  }

  /**
   * Who acts, and on whose ask. One trusted workspace, equal authority: any registered person settles an ask that went to
   * another, recorded as themselves, and the transition and audit notes name the person asked. With primary-user
   * authority the terminal names no responder (its claimed actor is the Feed's recipient-derived value), so the act is
   * human@host, explicitly unattributed, never the default person or the claim, whether or not anyone is registered. A
   * shared channel never acts on a row, for any verb: its
   * messages are correspondence, so the asking seat or the person at the terminal acts on a channel's row.
   */
  private asActor(input: MissionControlActionInput, asked: string | null): { input: MissionControlActionInput; note: string } {
    const channel = this.queueRepo.isSharedChannel(input.actorSession);
    if (input.authority !== "primary-user") {
      if (channel) {
        throw new MissionControlWriteContractError("answer_not_recorded",
          `${input.actorSession} is a shared channel, and a channel never acts on a row: its messages are correspondence. Nothing was recorded on qitem ${input.qitemId}; the asking seat or the person at the terminal acts on it.`,
          { qitemId: input.qitemId, channel: input.actorSession });
      }
      const someoneElse = SETTLING_VERBS.has(input.verb) ? this.queueRepo.askedSomeoneElse(input.actorSession, asked) : null;
      if (!someoneElse) return { input, note: "" };
      return { input: { ...input, auditNotes: { ...input.auditNotes, asked: someoneElse } },
        note: `; by ${input.actorSession}, a registered person, on ${someoneElse}'s ask` };
    }
    // The terminal names no responder, whatever it claims and whoever is registered: the act is unattributed.
    const actor = UNNAMED_PRIMARY_USER;
    const auditNotes = { ...input.auditNotes, authority: "primary-user", asked };
    const note = !asked || asked === actor ? ""
      : actor === UNNAMED_PRIMARY_USER ? `; by someone at the terminal OpenRig can't name (${UNNAMED_PRIMARY_USER}), unattributed, on ${asked}'s ask`
      : `; by ${actor}, the primary user at the terminal, on ${asked}'s ask`;
    return { input: { ...input, actorSession: actor, auditNotes }, note };
  }

  private requireMutableQitem(qitemId: string): QueueItem {
    const source = this.queueRepo.getById(qitemId);
    if (!source) {
      throw new MissionControlWriteContractError(
        "qitem_not_found",
        `qitem ${qitemId} not found`,
        { qitemId },
      );
    }
    if (source.state === "done" || source.state === "handed-off") {
      throw new MissionControlWriteContractError(
        "qitem_already_terminal",
        `qitem ${qitemId} is already terminal (state=${source.state}); Mission Control cannot mutate terminal items`,
        { qitemId, state: source.state },
      );
    }
    return source;
  }
}

interface ClosureMapping {
  state: "handed-off" | "blocked" | "done";
  closureReason: string;
  closureTarget: string | null;
  handedOffTo?: string;
  blockedOn?: string;
}

/** One logical operation (#2446): the caller's operationId with the verb, who sent it and what it carries, so a retry
 *  matches only itself, never another verb or payload sent under the same ID. */
function operationFingerprint(input: MissionControlActionInput): string {
  const sent = [input.auditNotes?.operationId, input.verb, input.actorSession, input.authority ?? null, input.questionId ?? null,
    input.optionId ?? null, input.decision ?? null, input.reason ?? null, input.destinationSession ?? null, input.body ?? null, input.annotation ?? null];
  return createHash("sha256").update(JSON.stringify(sent)).digest("hex").slice(0, 24);
}

function verbToClosure(input: MissionControlActionInput): ClosureMapping {
  switch (input.verb) {
    case "approve":
      return {
        state: "done",
        closureReason: "no-follow-on",
        closureTarget: input.reason ?? null,
      };
    case "deny":
      return {
        state: "done",
        closureReason: "denied",
        closureTarget: input.reason ?? "operator denied",
      };
    case "route":
      return {
        state: "handed-off",
        closureReason: "handed_off_to",
        closureTarget: input.destinationSession!,
        handedOffTo: input.destinationSession!,
      };
    case "hold":
      return {
        state: "blocked",
        closureReason: "blocked_on",
        closureTarget: input.reason!,
        blockedOn: input.reason!,
      };
    case "drop":
      return {
        state: "done",
        closureReason: "canceled",
        closureTarget: input.reason!,
      };
    case "handoff":
      return {
        state: "handed-off",
        closureReason: "handed_off_to",
        closureTarget: input.destinationSession!,
        handedOffTo: input.destinationSession!,
      };
    case "annotate":
      // Should never reach here — annotate is handled by annotateOnly().
      throw new MissionControlWriteContractError(
        "internal_invariant",
        "annotate verb should have been routed to annotateOnly",
      );
    case "resolve":
      // OPR.0.4.4.19 FR-7 — resolve deliberately has NO closure mapping
      // (a resolved qitem is state=in-progress, closure_reason null).
      // Handled by resolveParked(); reaching here is a contract violation.
      throw new MissionControlWriteContractError(
        "internal_invariant",
        "resolve verb is non-closure and should have been routed to resolveParked",
      );
    case "answer":
      throw new MissionControlWriteContractError(
        "internal_invariant",
        "answer verb should have been routed to answerAsk",
      );
  }
}

function snapshotQitem(q: QueueItem): Record<string, unknown> {
  return {
    qitemId: q.qitemId,
    state: q.state,
    sourceSession: q.sourceSession,
    destinationSession: q.destinationSession,
    priority: q.priority,
    tier: q.tier,
    closureReason: q.closureReason,
    closureTarget: q.closureTarget,
    handedOffTo: q.handedOffTo,
    blockedOn: q.blockedOn,
    tsUpdated: q.tsUpdated,
  };
}
