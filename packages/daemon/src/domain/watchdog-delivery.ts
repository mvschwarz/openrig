import { OutboxHandlerError, type OutboxHandler } from "./outbox-handler.js";
import { queueOnlyRowId, withWatchdogReceipts } from "./watchdog-delivery-receipts.js";
import { DeliveryGuardError } from "./seat-delivery-guard.js";
import { PARKED_OWNER_COMPACTION_PENDING, PARKED_OWNER_POLICY_NAME } from "./policies/parked-owner-consumer.js";
import { writtenFact, type SessionTransport } from "./session-transport.js";
import { readSendOutcome } from "./connection-contract.js";
import { cutReminderForNote, parkedRowNote, sliceWholeChars } from "./park-wake-text.js";
import type { QueuePriority } from "./queue-repository.js";
import { NOTED_ON_PARKED_ROW, NOTED_ON_QUEUED_ROW, QUEUED_AS_ROW } from "./watchdog-history-log.js";
import type { WatchdogUsageLimitState } from "./watchdog-usage-limit.js";
import {
  formatWatchdogDeliveryMessage,
  type DeliveryFn,
  type DeliveryOutcome,
  type DeliveryRequest,
  type WatchdogDeliverySource,
} from "./watchdog-policy-engine.js";

/** A reminder's cold row at a queue-only seat: no nudge, created by OpenRig, its id fixed by the occurrence. */
export interface QueueOnlyReminderRow {
  qitemId: string;
  destinationSession: string;
  body: string;
  summary: string;
  tags: string[];
  /** The row's priority, so a reminder's urgency stays visible in the queue. No watchdog reminder is urgent today, and
   *  without one the row is routine. */
  priority?: QueuePriority;
}

/** The most ids one occurrence tries past a closed row of its own before giving up with no input. */
const QUEUE_ONLY_ROW_ID_TRIES = 100;
const OPEN_ROW_STATES = new Set(["pending", "in-progress", "blocked"]);

/** The input adapter; scheduled occurrence custody is reconciled outside the actual transport call. */
export function makeWatchdogDeliver(deps: {
  sessionTransport: Pick<SessionTransport, "send">;
  outbox?: OutboxHandler;
  now?: () => Date;
  retryIntervalSeconds?: number;
  retryCap?: number;
  readUsageLimitState?: (sessionName: string) => WatchdogUsageLimitState | null;
  hasPendingPostCompactStage?: (sessionName: string) => boolean;
  isTerminalSeat?: (sessionName: string) => boolean;
  createContinuityAction?: (action: NonNullable<DeliveryRequest["continuityAction"]>) => Promise<void>;
  /** The seat's typing guard is at queue-only (#3076): a person types in its terminal, so OpenRig's reminders are never
   *  typed there. */
  isQueueOnlySeat?: (sessionName: string) => boolean;
  /** Creates a reminder's cold row in the seat's queue, with no nudge, and returns the stored row: an existing id is
   *  that row, as it is now. */
  createQueueRow?: (row: QueueOnlyReminderRow) => Promise<{ qitemId: string; state: string }>;
  /** The live parked rows of the target whose current park this job wakes: at a queue-only seat the reminder is noted
   *  on them, not made into another row. */
  resolveParkedRows?: (input: { jobId: string; targetSession: string }) => string[];
  /** Writes each note on its parked row, in one transaction, while the row is still `owner`'s and its current park is
   *  still the job's; returns the rows noted. */
  noteParkedRows?: (input: { owner: string; notes: Array<{ qitemId: string; jobId: string; note: string }> }) => string[];
  /** Notes a later occurrence on the job's earlier cold row at the seat while that row is open (claimed or not), and
   *  returns its id; null when there is none. */
  noteQueuedRow?: (input: { jobId: string; destinationSession: string; note: string }) => string | null;
  /** Tells the queue's no-receiver path (cold start) that a seat is missing. Called only for a timer that wakes a live
   *  parked row of that seat: that's queued work coming due, so a seat on standby may be started for it. A reminder about
   *  no row starts nothing. */
  noteNoReceiver?: (targetSession: string) => void;
}): DeliveryFn {
  /** At a queue-only seat the reminder is never typed. About a parked row of the seat, it's noted on that row, here,
   *  before the delivery says so; a later occurrence of a job whose cold row is still open is noted on that row;
   *  anything else becomes one cold row. A row or note that can't be written leaves the occurrence owed, with no input. */
  const queueOnly = async (targetSession: string, message: string, continuity: boolean, source: WatchdogDeliverySource): Promise<DeliveryOutcome> => {
    // The parked-owner reminder is about rows already in the seat's queue, which are the reminder: its policy skips a
    // queue-only seat. A seat that turned queue-only after the policy decided holds it, never as a row or a note.
    if (source.policy === PARKED_OWNER_POLICY_NAME) return { status: "retained", sent: false, inputPhase: "not_reached", outboxIds: [] };
    const failed = (error: string): DeliveryOutcome => ({ status: "failed", sent: false, inputPhase: "not_reached", error });
    try {
      // A digest's members are default wakes, one per row; a lone reminder carries its own text onto its rows.
      const parked = source.parkedRows?.map(row => ({ ...row, note: parkedRowNote(row.jobId) }))
        ?? (source.members || continuity ? []
          : (deps.resolveParkedRows?.({ jobId: source.jobId, targetSession }) ?? [])
            .map(qitemId => ({ qitemId, jobId: source.jobId, note: parkedRowNote(source.jobId, message) })));
      if (parked.length) {
        const noted = deps.noteParkedRows?.({ owner: targetSession, notes: parked }) ?? [];
        if (!noted.length) return failed("The parked row the reminder is about could not be noted (it left its park); nothing was typed.");
        return { status: "ok", code: NOTED_ON_PARKED_ROW, sentMessage: message };
      }
      if (!source.members) {
        const noted = deps.noteQueuedRow?.({ jobId: source.jobId, destinationSession: targetSession,
          note: `watchdog reminder again: watchdog ${source.jobId}; delivery=${NOTED_ON_QUEUED_ROW}; nothing typed\nreminder: ${cutReminderForNote(message.trim(), source.jobId)}` }) ?? null;
        if (noted) return { status: "ok", code: NOTED_ON_QUEUED_ROW, queuedQitemId: noted, sentMessage: message };
      }
      if (!source.occurrenceId) return failed("The reminder has no occurrence to name its queue row; nothing was created or typed.");
      const firstLine = message.split("\n").find(line => line.trim())?.trim() ?? source.policy;
      const row = { destinationSession: targetSession, body: formatWatchdogDeliveryMessage(source, message),
        summary: `Watchdog (${source.policy}): ${sliceWholeChars(firstLine, 160)}`,
        tags: ["watchdog", "queue-only", `watchdog-job:${source.jobId}`, `policy:${source.policy}`] };
      // The occurrence's row, or, once that row is closed (the same occurrence due again), the first free derived id:
      // a closed row is never the reminder.
      const base = queueOnlyRowId(source.occurrenceId);
      for (let n = 1; n <= QUEUE_ONLY_ROW_ID_TRIES; n++) {
        const stored = await deps.createQueueRow!({ ...row, qitemId: n === 1 ? base : `${base}-${n}` });
        if (OPEN_ROW_STATES.has(stored.state)) return { status: "ok", code: QUEUED_AS_ROW, queuedQitemId: stored.qitemId, sentMessage: message };
      }
      return failed(`Every queue row id for this occurrence up to ${base}-${QUEUE_ONLY_ROW_ID_TRIES} is a closed row; nothing was created or typed.`);
    } catch (err) {
      return failed(err instanceof Error ? err.message : String(err));
    }
  };

  const deliver: DeliveryFn = async ({ targetSession, message, continuityAction }, source) => {
    let continuityActionCompleted = false;
    try {
      const checkTerminal = () => {
        if (source.policy === PARKED_OWNER_POLICY_NAME && deps.isTerminalSeat?.(targetSession))
          throw new DeliveryGuardError("terminal_seat", "A terminal seat cannot consume an automated parked-owner reminder; route its obligation to an agent seat. No input was written.");
      };
      checkTerminal();
      if (continuityAction) {
        await deps.createContinuityAction?.(continuityAction);
        continuityActionCompleted = true;
      }
      if (deps.isQueueOnlySeat?.(targetSession) && deps.createQueueRow) {
        return { ...await queueOnly(targetSession, message, continuityAction !== undefined, source), continuityActionCompleted };
      }
      const warning = deps.outbox && source.policy === "periodic-reminder" ? "" : "Delivery may repeat after an unconfirmed attempt.\n";
      const payload = formatWatchdogDeliveryMessage(source, warning + message);
      // SessionTransport still owns recipient, approval and draft protection. Only an occurrence admitted by the
      // outer receipt check reaches this current input request, including when several reminders share it.
      const beforeWrite = source.policy === PARKED_OWNER_POLICY_NAME && (deps.hasPendingPostCompactStage || deps.isTerminalSeat) ? () => {
        checkTerminal();
        if (deps.hasPendingPostCompactStage?.(targetSession)) throw new DeliveryGuardError("managed_compaction_pending", PARKED_OWNER_COMPACTION_PENDING);
      } : undefined;
      const result = await deps.sessionTransport.send(targetSession, payload,
        // Typed, never queued for a seat's hook bridge: the watchdog's receipts and accounting read only a typed outcome,
        // so a queued reminder would read delivered before anything took it (#3270).
        { actorSession: "watchdog@system", openrigNotice: true, auditPointer: source.jobId, noHookBridge: true, ...(beforeWrite ? { beforeWrite } : {}) });
      // A park timer that finds its seat missing is the parked row's work coming due: the cold start decides whether a seat
      // on standby starts for it. The reminder's own outcome stands, and its retry types it once the seat is up.
      if ("reason" in result && result.reason === "session_missing" && deps.noteNoReceiver
        && (source.parkedRows?.length ?? (source.members ? 0 : (deps.resolveParkedRows?.({ jobId: source.jobId, targetSession }) ?? []).length)) > 0) {
        try { deps.noteNoReceiver(targetSession); } catch { /* telling cold start never changes the reminder's outcome */ }
      }
      const fact = readSendOutcome(result, writtenFact(result));
      if (result.outcome === "retained") return { status: "retained", outboxIds: result.outboxIds, continuityActionCompleted, fact };
      return result.ok
        ? { status: "ok", continuityActionCompleted, fact }
        : { status: "failed", fact, error: result.error, sent: result.sent, ...(result.reason ? { transportReason: result.reason } : {}),
          ...(result.inputPhase ? { inputPhase: result.inputPhase } : {}),
          ...(result.sent === false && result.inputPhase === "not_reached" && result.noInputCode ? { code: result.noInputCode } : {}), continuityActionCompleted };
    } catch (err) {
      // Only these typed refusals establish the input boundary. Matching error text never does.
      const code = err instanceof OutboxHandlerError && err.code === "retained_quota_full" ? "retained_quota_full"
        : err instanceof DeliveryGuardError && err.code === "terminal_seat" ? "terminal_seat" : undefined;
      return {
        status: "failed",
        ...(code ? { code, inputPhase: "not_reached" as const } : {}),
        error: err instanceof Error ? err.message : String(err),
        continuityActionCompleted,
      };
    }
  };
  return deps.outbox ? withWatchdogReceipts(deliver, { ...deps, outbox: deps.outbox }) : deliver;
}
