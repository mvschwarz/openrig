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

import type Database from "better-sqlite3";
import type { EventBus } from "../event-bus.js";
import type { QueueRepository, QueueItem } from "../queue-repository.js";
import type { PersistedEvent } from "../types.js";
import {
  MissionControlActionLog,
  MissionControlActionLogError,
  type MissionControlVerb,
} from "./mission-control-action-log.js";
import { isHumanSeatSession } from "../human-route-enforcer.js";

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
  /** Operator-supplied audit context. */
  auditNotes?: Record<string, unknown>;
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
    if (input.verb === "annotate") {
      return this.annotateOnly(input);
    }
    if (input.verb === "resolve") {
      return this.resolveParked(input);
    }

    const source = this.requireMutableQitem(input.qitemId);

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
          transitionNote: `mission-control:${input.verb}${input.reason ? ` (${input.reason})` : ""}`,
        });
        register(closeResult.persistedEvent);

        // 2. For route/handoff: create the destination packet in same txn.
        if ((input.verb === "route" || input.verb === "handoff") && input.destinationSession) {
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
          this.queueRepo.stageWakeIntent(
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
   *   5. Enforcement symmetry: park required summary + evidence_ref;
   *      resolve requires NON-EMPTY decision text, daemon-enforced.
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
    if (source.state !== "blocked" || !isHumanSeatSession(source.blockedOn)) {
      throw new MissionControlWriteContractError(
        "qitem_not_leg1_parked",
        `verb=resolve requires a leg-1 parked qitem (state=blocked with a human-seat blocked_on); ` +
          `qitem ${input.qitemId} is state=${source.state}, blocked_on=${source.blockedOn ?? "null"}. ` +
          `Re-resolving an already-resolved item is a no-op error, not a double transition.`,
        { qitemId: input.qitemId, state: source.state, blockedOn: source.blockedOn },
      );
    }

    const evaluatedAt = this.now().toISOString();
    const beforeSnapshot = snapshotQitem(source);
    let actionEntry: ReturnType<MissionControlActionLog["record"]> | null = null;
    try {
      this.eventBus.withNotifyEnvelope((register) => {
        // Rail 2+3: blocked → in-progress; decision text = transition_note;
        // actor_session = the resolving human/relay session. Emits
        // queue.updated (the P2 refresh-after-action contract). blocked_on is
        // deliberately retained as provenance of whom it was parked on — the
        // attention query keys on state='blocked', so the resolved item drops
        // out of attention regardless.
        const updateResult = this.queueRepo.updateWithinTransaction({
          qitemId: input.qitemId,
          actorSession: input.actorSession,
          state: "in-progress",
          transitionNote: decision,
          ownerNotificationKind: "human-decision-resolved",
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
          `Decision resolved on ${input.qitemId}: ${decision} — unparked (blocked → in-progress); you still own it. Check your queue.`,
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
