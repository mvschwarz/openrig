// OPR.0.5.6.1 (R2/R1 BLOCKING repair) — the PRODUCTION operator delivery port
// and the deferral-fire payload builder. Both reviews proved the live paths
// unreachable: the fire dispatched an unadvertised op, and the real wake-ladder
// composition never received the engine port the tests injected. This module is
// the one production implementation of both seams, testable through the REAL
// dispatcher and the REAL tick.

import type { QueueItem, QueueRepository } from "../queue-repository.js";
import { DispatchBuffer } from "./dispatch-buffer.js";
import { lastMeaningfulTransition } from "../queue-waiting.js";
import type { DispatchResult } from "./dispatcher.js";
import type { HumanFragment, LoadResult } from "./human-registry.js";
import { loadHumanRegistry } from "./human-registry.js";
import { resolveDefaultPerson } from "./participants.js";
import { loadConfig } from "./slack/config.js";
import { resolveSecret } from "./slack/secrets.js";
import { resolveHumanDeliveryReadiness } from "./human-readiness.js";
import { quietHoldFor } from "./human-quiet-windows.js";
import { OUTBOUND_OP } from "./slack/outbound-driver.js";
import {
  decideDelivery,
  resolveAvailability,
  type DeliveryDecision,
} from "./delivery-rules-engine.js";

export interface OperatorDeliveryEngine {
  /** Read durable pre-marker custody without dispatching or rechecking readiness. */
  hasAcceptedEscalation?: (row: QueueItem) => boolean;
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
  gatewayState?: () => string;
  readiness?: (human: HumanFragment) => Promise<{ ready: boolean; reason: string }>;
}): OperatorDeliveryEngine {
  const notificationKeyFor = (row: QueueItem): string => {
    const owner = deps.queueRepo.transitionLog.latestOwnerNotificationForQitem(row.qitemId);
    if (owner) return `${row.qitemId}:${owner.transitionId}`;
    const legacy = `${row.qitemId}:operator-rung`;
    // Aggregates have one episode; keep any current legacy custody across an upgrade too.
    if (row.tags?.includes("wake-prompt-refusal") || resolvedFor(row, legacy)
      || new DispatchBuffer(deps.home).pending().some(d => d.decisionId === `operator:${legacy}`)) return legacy;
    const episode = lastMeaningfulTransition(deps.queueRepo.db, row.qitemId)?.id ?? 0;
    return `${legacy}:${episode}`;
  };
  const resolvedFor = (row: QueueItem, key: string): string | null => {
    const transitions = deps.queueRepo.listTransitions(row.qitemId);
    // Prompt aggregates keep one episode across claims. Ordinary fixed-key rows can progress into another.
    const after = transitions.length && key === `${row.qitemId}:operator-rung` && !row.tags?.includes("wake-prompt-refusal")
      ? lastMeaningfulTransition(deps.queueRepo.db, row.qitemId)?.id ?? 0 : 0;
    let resolved: string | null = null;
    for (const t of transitions) {
      if (t.transitionId <= after) continue;
      const note = t.transitionNote ?? "";
      // Match the ladder: a receipt before the latest dispatch cannot resolve that dispatch.
      if (note.startsWith("escalation-rung: operator dispatched-to-engine")) resolved = null;
      if (note.split(/\s+/).includes(`notification_key=${key}`)) {
        if (note.startsWith("slack-owner-notification-posted ")) resolved = "posted";
        if (note.startsWith("delivery-termination:")) resolved = "terminated";
      }
    }
    return resolved;
  };
  return {
    hasAcceptedEscalation: row => {
      const key = notificationKeyFor(row);
      return resolvedFor(row, key) !== null || new DispatchBuffer(deps.home).pending()
        .some(d => d.decisionId === `operator:${key}`);
    },
    async dispatchEscalation(row: QueueItem, _reason: string) {
      // The episode identity the receipt must carry (Slice 14's ledger accepts
      // the current qitemId:transitionId key; an ordinary row without an owner
      // transition uses its meaningful-progress episode in the synthetic key).
      const notificationKey = notificationKeyFor(row);

      const decisionId = `operator:${notificationKey}`;
      const accepted = () => new DispatchBuffer(deps.home).pending().some(d => d.decisionId === decisionId);
      const resolved = resolvedFor(row, notificationKey);
      if (resolved) return { decision: resolved, resolved: true, dispatched: true, notificationKey, decisionId };
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
      // The escalation goes to the default person, never simply the first file: with several people and none chosen,
      // it's undeliverable and says so.
      const human = resolveDefaultPerson(reg.entities, deps.home).person;
      if (!human) {
        return { decision: reg.entities.length ? "undeliverable:no-default-person" : "undeliverable:no-registered-human", resolved: false, dispatched: false };
      }
      const cfg = loadConfig(deps.home);
      // A local carrier remains visible; no new gateway decision belongs to a channel that cannot post.
      // Already-accepted decisions returned above retain gateway custody, even if readiness later changes.
      try {
        const readiness = await (deps.readiness?.(human) ?? resolveHumanDeliveryReadiness({
          human, config: cfg, gatewayState: deps.gatewayState?.() ?? "unavailable",
          botToken: resolveSecret("SLACK_BOT_TOKEN", { envFile: cfg.secretsEnvFile ?? undefined }),
        }));
        if (!readiness.ready) return { decision: `unavailable:human-delivery:${readiness.reason}`, resolved: false, dispatched: false };
      } catch {
        return { decision: "unavailable:human-delivery:readiness-unavailable", resolved: false, dispatched: false };
      }
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
        // An escalation is never held, so quiet can't change this rung's decision: a failed quiet read is ignored here
        // rather than blocking the escalation.
        quiet: (() => { try { return quietHoldFor(deps.queueRepo.db, human.entityId, new Date()); } catch { return null; } })(),
      });

      const payload = {
        qitemId: row.qitemId,
        notificationKey,
        // The person sees which seat the work is waiting on. The sender stays the row's own, so a reply in the thread
        // still goes where the row's posts go.
        summary: `Waiting on ${row.destinationSession}: ${row.summary ?? `wake-ladder escalation: ${row.qitemId}`}`,
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
