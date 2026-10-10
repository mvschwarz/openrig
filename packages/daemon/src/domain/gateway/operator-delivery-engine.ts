// OPR.0.5.6.1 (R2/R1 BLOCKING repair) — the PRODUCTION operator delivery port
// and the deferral-fire payload builder. Both reviews proved the live paths
// unreachable: the fire dispatched an unadvertised op, and the real wake-ladder
// composition never received the engine port the tests injected. This module is
// the one production implementation of both seams, testable through the REAL
// dispatcher and the REAL tick.

import type { QueueItem, QueueRepository } from "../queue-repository.js";
import { DispatchBuffer } from "./dispatch-buffer.js";
import type { DispatchResult } from "./dispatcher.js";
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
  ) => Promise<{ decision: string; resolved: boolean; notificationKey?: string; dispatched?: boolean; decisionId?: string }>;
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
 *  (the AM-F3 resolution pass). Before acceptance, missing/unavailable routing
 *  remains unresolved. The ladder may re-resolve it; accepted delivery stays
 *  with the gateway until its receipt or explicit termination. */
export function makeOperatorDeliveryEngine(deps: {
  home: string;
  queueRepo: QueueRepository;
  dispatch: (op: string, entityBindingRef: string, payload: unknown, opts?: { decisionId?: string }) => DispatchResult;
  registry?: { loadHumanRegistry: () => LoadResult };
}): OperatorDeliveryEngine {
  return {
    async dispatchEscalation(row: QueueItem, _reason: string) {
      // The episode identity the receipt must carry (Slice 14's ledger accepts
      // only the current qitemId:transitionId key; a baton row with no owner
      // transition gets the stable synthetic operator-rung episode).
      const owner = deps.queueRepo.transitionLog.latestOwnerNotificationForQitem(row.qitemId);
      const notificationKey = owner ? `${row.qitemId}:${owner.transitionId}` : `${row.qitemId}:operator-rung`;

      const decisionId = `operator:${notificationKey}`;
      const accepted = () => new DispatchBuffer(deps.home).pending().some(d => d.decisionId === decisionId);
      // An accepted decision belongs to the gateway even if registry access or
      // routing changes before the ladder records its dispatch marker.
      if (accepted()) return { decision: "accepted-pending", resolved: false, dispatched: true, notificationKey, decisionId };
      let reg: LoadResult;
      try {
        reg = deps.registry ? deps.registry.loadHumanRegistry() : loadHumanRegistry(deps.home);
      } catch {
        return { decision: "unavailable:human-registry", resolved: false, dispatched: false };
      }
      if (!reg.ok) return { decision: "unavailable:human-registry", resolved: false, dispatched: false };
      const human = reg.entities[0];
      if (!human) {
        return { decision: "undeliverable:no-registered-human", resolved: false, dispatched: false };
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
      let res: DispatchResult;
      try {
        res = deps.dispatch(OUTBOUND_OP, human.address, payload, { decisionId });
      } catch (error) {
        // A transport throw after durable enqueue is not a routing refusal.
        if (accepted()) return { decision: "accepted-pending", resolved: false, dispatched: true, notificationKey, decisionId };
        throw error;
      }
      if (!res.ok) {
        return { decision: `dispatch-refused:${res.error ?? "unknown"}`, resolved: false, dispatched: false, notificationKey };
      }
      return { decision: describeDecision(decision), resolved: false, dispatched: true, notificationKey, decisionId: res.decisionId };
    },
  };
}
