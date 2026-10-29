import { OutboxHandlerError } from "./outbox-handler.js";
import { DeliveryGuardError } from "./seat-delivery-guard.js";
import { PARKED_OWNER_COMPACTION_PENDING, PARKED_OWNER_POLICY_NAME } from "./policies/parked-owner-consumer.js";
import type { SessionTransport } from "./session-transport.js";
import {
  formatWatchdogDeliveryMessage,
  type DeliveryFn,
  type DeliveryRequest,
} from "./watchdog-policy-engine.js";

/** Current reminders get an input attempt. Job accounting may be interrupted after input, so a later attempt can repeat. */
export function makeWatchdogDeliver(deps: {
  sessionTransport: Pick<SessionTransport, "send">;
  hasPendingPostCompactStage?: (sessionName: string) => boolean;
  isTerminalSeat?: (sessionName: string) => boolean;
  createContinuityAction?: (action: NonNullable<DeliveryRequest["continuityAction"]>) => Promise<void>;
}): DeliveryFn {
  return async ({ targetSession, message, continuityAction }, source) => {
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
      const payload = formatWatchdogDeliveryMessage(source,
        `Delivery may repeat after an unconfirmed attempt.\n${message}`);
      // SessionTransport still owns recipient, approval and draft protection. A historical delivery ID must not
      // substitute an earlier result for this current request, including when several reminders share one message.
      const beforeWrite = source.policy === PARKED_OWNER_POLICY_NAME && (deps.hasPendingPostCompactStage || deps.isTerminalSeat) ? () => {
        checkTerminal();
        if (deps.hasPendingPostCompactStage?.(targetSession)) throw new DeliveryGuardError("managed_compaction_pending", PARKED_OWNER_COMPACTION_PENDING);
      } : undefined;
      const result = await deps.sessionTransport.send(targetSession, payload,
        { actorSession: "watchdog@system", openrigNotice: true, auditPointer: source.jobId, ...(beforeWrite ? { beforeWrite } : {}) });
      if (result.outcome === "retained") return { status: "retained", outboxIds: result.outboxIds, continuityActionCompleted };
      return result.ok
        ? { status: "ok", continuityActionCompleted }
        : { status: "failed", error: result.error, ...(result.inputPhase ? { inputPhase: result.inputPhase } : {}),
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
}
