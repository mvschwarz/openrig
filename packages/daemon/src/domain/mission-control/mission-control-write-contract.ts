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
// Post-commit (outside the transaction): notifySubscribers + opt-in
// best-effort transport notify. Notify failure does NOT roll back
// durable mutations (PRD invariant: "notify failure does NOT roll
// back durable mutations").
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
  /** Required for `route` and `handoff`. */
  destinationSession?: string;
  /** Body for the new packet on `route`/`handoff`; defaults to source body. */
  body?: string;
  /** Required for `annotate`. */
  annotation?: string;
  /** Required for `hold` and `drop`; optional advisory text otherwise. */
  reason?: string;
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

    const source = this.queueRepo.getById(input.qitemId);
    if (!source) {
      throw new MissionControlWriteContractError(
        "qitem_not_found",
        `qitem ${input.qitemId} not found`,
        { qitemId: input.qitemId },
      );
    }
    if (source.state === "done" || source.state === "handed-off") {
      throw new MissionControlWriteContractError(
        "qitem_already_terminal",
        `qitem ${input.qitemId} is already terminal (state=${source.state}); Mission Control cannot mutate terminal items`,
        { qitemId: input.qitemId, state: source.state },
      );
    }

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
    const persistedEvents: PersistedEvent[] = [];

    const txn = this.db.transaction(() => {
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
      persistedEvents.push(closeResult.persistedEvent);

      // 2. For route/handoff: create the destination packet in same txn.
      if ((input.verb === "route" || input.verb === "handoff") && input.destinationSession) {
        const created = this.queueRepo.createWithinTransaction({
          sourceSession: input.actorSession,
          destinationSession: input.destinationSession,
          body: input.body ?? source.body,
          priority: source.priority,
          tier: source.tier ?? undefined,
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
        persistedEvents.push(created.persistedEvent);
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
      });

      // 4. Persist the mission_control.action_executed event in same txn.
      persistedEvents.push(
        this.eventBus.persistWithinTransaction({
          type: "mission_control.action_executed",
          actionId: actionEntry.actionId,
          actionVerb: input.verb,
          qitemId: input.qitemId,
          actorSession: input.actorSession,
        }),
      );
    });

    try {
      txn();
    } catch (err) {
      if (err instanceof MissionControlActionLogError) {
        throw new MissionControlWriteContractError(err.code, err.message, err.details);
      }
      throw err;
    }

    // Post-commit: fan out events.
    for (const e of persistedEvents) this.eventBus.notifySubscribers(e);

    // Post-commit best-effort notify on handoff/route. Default true per
    // PL-004 R1 pattern; failure does NOT roll back durable mutations.
    let notifyAttempted = false;
    let notifyResult: string | null = null;
    if (createdQitemId && createdDestination && (input.verb === "route" || input.verb === "handoff")) {
      try {
        await this.queueRepo.maybeNudge(createdQitemId, createdDestination, createdNudge);
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
    const evaluatedAt = this.now().toISOString();
    let actionEntry: ReturnType<MissionControlActionLog["record"]> | null = null;
    const persistedEvents: PersistedEvent[] = [];

    const txn = this.db.transaction(() => {
      actionEntry = this.actionLog.record({
        actionVerb: "annotate",
        qitemId: input.qitemId,
        actorSession: input.actorSession,
        actedAt: evaluatedAt,
        annotation: input.annotation!,
        auditNotes: input.auditNotes ?? null,
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
