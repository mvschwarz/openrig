// OPR.0.5.6.1 (R2/R1 BLOCKING repair) — the PRODUCTION operator delivery port
// and the deferral-fire payload builder. Both reviews proved the live paths
// unreachable: the fire dispatched an unadvertised op, and the real wake-ladder
// composition never received the engine port the tests injected. This module is
// the one production implementation of both seams, testable through the REAL
// dispatcher and the REAL tick.

import type { QueueItem, QueueRepository } from "../queue-repository.js";
import type { LoadResult } from "./human-registry.js";
import { loadHumanRegistry } from "./human-registry.js";
import { loadConfig } from "./slack/config.js";
import { OUTBOUND_OP } from "./slack/outbound-driver.js";
import {
  decideDelivery,
  resolveAvailability,
  type DeliveryDecision,
} from "./delivery-rules-engine.js";

export interface OperatorDeliveryEngine {
  dispatchEscalation: (
    row: QueueItem,
    reason: string,
  ) => Promise<{ decision: string; resolved: boolean; notificationKey?: string }>;
}

/** The T+30 fire payload: the ADVERTISED op's shape, the EPISODE key carried
 *  through so the Slice 14 receipt lands current-episode-exact, and the
 *  consult bypass so the already-made decision can never re-defer (AM-F3). */
export function buildDeferralFirePayload(row: QueueItem, notificationKey: string): Record<string, unknown> {
  return {
    qitemId: row.qitemId,
    notificationKey,
    summary: row.summary ?? null,
    body: row.body ?? null,
    destinationSession: row.destinationSession ?? null,
    sourceSession: row.sourceSession ?? null,
    ownerNotificationLevel: "ALERT",
    ownerNotificationKind: "human-required",
    tags: [...new Set([...(row.tags ?? []), "escalation"])],
    deliveryDeferralFire: true,
  };
}

function describeDecision(d: DeliveryDecision): string {
  return d.deferMinutes !== undefined ? `${d.outcome}-deferred-${d.deferMinutes}m` : d.outcome;
}

/** The production port for the operator rung (A1.2: this engine IS the rung's
 *  delivery leg). It decides via the one engine, dispatches the escalation
 *  through the REAL gateway on the advertised op, and returns resolved=false so
 *  the ladder exhausts only on the episode's own receipt/termination evidence
 *  (the AM-F3 resolution pass). A dispatch refusal returns resolved=true with
 *  the refusal named — the honest exhaust, equivalent to the pre-engine floor's
 *  visibility, never a silent wait. */
export function makeOperatorDeliveryEngine(deps: {
  home: string;
  queueRepo: QueueRepository;
  dispatch: (op: string, entityBindingRef: string, payload: unknown) => { ok: boolean; error?: string };
  registry?: { loadHumanRegistry: () => LoadResult };
}): OperatorDeliveryEngine {
  return {
    async dispatchEscalation(row: QueueItem, _reason: string) {
      const reg = deps.registry ? deps.registry.loadHumanRegistry() : loadHumanRegistry(deps.home);
      const human = reg.ok ? reg.entities[0] : undefined;
      if (!human) {
        // No registered human: the single-human floor has nobody to deliver to —
        // exhaust honestly (same visibility as the pre-engine floor).
        return { decision: "undeliverable:no-registered-human", resolved: true };
      }
      const cfg = loadConfig(deps.home);
      const decision = decideDelivery({
        level: "ALERT",
        escalation: true,
        human: {
          entityId: human.entityId,
          deliveryClass: human.prefs.deliveryClass,
          availability: resolveAvailability(human.prefs),
        },
        dials: {
          minimumLevelThatPosts: cfg.minimumLevelThatPosts,
          minimumLevelThatInterrupts: cfg.minimumLevelThatInterrupts,
        },
      });
      // The episode identity the receipt must carry (Slice 14's ledger accepts
      // only the current qitemId:transitionId key; a baton row with no owner
      // transition gets the stable synthetic operator-rung episode).
      const owner = deps.queueRepo.transitionLog.latestOwnerNotificationForQitem(row.qitemId);
      const notificationKey = owner ? `${row.qitemId}:${owner.transitionId}` : `${row.qitemId}:operator-rung`;

      const payload = {
        qitemId: row.qitemId,
        notificationKey,
        summary: row.summary ?? `wake-ladder escalation: ${row.qitemId}`,
        body: row.body ?? null,
        destinationSession: human.address,
        sourceSession: row.sourceSession ?? null,
        ownerNotificationLevel: "ALERT",
        ownerNotificationKind: "human-required",
        tags: [...new Set([...(row.tags ?? []), "escalation"])],
      };
      const res = deps.dispatch(OUTBOUND_OP, human.address, payload);
      if (!res.ok) {
        return { decision: `dispatch-refused:${res.error ?? "unknown"}`, resolved: true, notificationKey };
      }
      return { decision: describeDecision(decision), resolved: false, notificationKey };
    },
  };
}
