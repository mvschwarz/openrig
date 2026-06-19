// OPR.0.3.2.20 — adapter: open attention-class queue items → FeedCard[].
//
// The For You Action-required + Approval lenses previously sourced
// from a flat client-side FIFO (useActivityFeed.MAX_ACTIVITY_EVENTS=100)
// that routine queue churn evicts. This adapter projects the daemon's
// durable open-attention set (GET /api/queue/list?attention=1) into
// the same FeedCard shape the feed already renders.
//
// Merge rule:
//   - For action-required + approval kinds, queue-derived cards
//     SUPERSEDE event-derived cards keyed by the same qitemId.
//   - When the queue has an attention item NOT seen in the events
//     (the eviction defect case), it still surfaces because the queue
//     is the source of truth.
//   - Other kinds (shipped, progress, observation) are unaffected;
//     they continue to come from useActivityFeed/classifyFeed.

import type { FeedCard } from "./feed-classifier.js";
import type { ActivityEvent } from "../hooks/useActivityFeed.js";
import type { AttentionQueueItem } from "../hooks/useAttentionItems.js";

const HUMAN_SEAT_PATTERN = /^human(?:-[A-Za-z0-9._-]+)?@(kernel|host)$/;

/**
 * Classify a queue item's attention kind. Mirrors the mission-control
 * read layer + the classifier's queueKind logic so the For You lenses
 * and the mission-control human-gate view agree.
 *
 *   - approval         → tier === "human-gate"
 *   - action-required  → destinationSession matches the human-seat regex
 *
 * NOT exported as a generic predicate to avoid drift with the daemon
 * isAttentionItem; this adapter narrows the daemon's combined
 * attention set into the two UI-visible kinds.
 */
function attentionKindFor(item: AttentionQueueItem): "approval" | "action-required" {
  if (item.tier === "human-gate") return "approval";
  if (HUMAN_SEAT_PATTERN.test(item.destinationSession ?? "")) return "action-required";
  // Fallback — daemon guarantees one of the two for items it returns
  // with attention=1; defensive default keeps the type union tight.
  return "action-required";
}

/**
 * Project an attention queue item into a synthetic FeedCard. The
 * synthetic `source` ActivityEvent carries the qitemId so downstream
 * code (qitemIdForCard, action handlers) keeps working uniformly.
 */
export function attentionItemToFeedCard(item: AttentionQueueItem): FeedCard {
  const kind = attentionKindFor(item);
  // Deterministic FeedCard.id — events use `${evt.type}-${seq}`. The
  // queue-derived card uses a stable prefix so consumers can detect
  // queue-sourced cards if needed and so the React key is stable
  // across re-fetches.
  const id = `queue-attention-${item.qitemId}`;
  const receivedAt = Date.parse(item.tsUpdated) || Date.now();
  const createdAt = item.tsUpdated || item.tsCreated || new Date().toISOString();
  const syntheticEvent: ActivityEvent = {
    seq: -1,
    type: "queue.attention.synthetic",
    payload: {
      qitemId: item.qitemId,
      destinationSession: item.destinationSession,
      sourceSession: item.sourceSession,
      tier: item.tier,
      state: item.state,
      body: item.body,
    },
    createdAt,
    receivedAt,
  };
  const title =
    kind === "approval"
      ? `Approval needed: ${item.qitemId.slice(0, 24)}`
      : `Action required: ${item.qitemId.slice(0, 24)}`;
  return {
    id,
    kind,
    title,
    body: item.body,
    authorSession: item.sourceSession,
    receivedAt,
    createdAt,
    source: syntheticEvent,
  };
}

/**
 * Merge queue-derived attention cards into the event-derived feed.
 * - Removes any event-derived card with kind ∈ {action-required, approval}
 *   whose qitemId matches a queue-derived card (queue wins; eviction
 *   defect fix).
 * - Appends all queue-derived cards.
 * - Non-attention kinds are passed through unchanged (HG-6 no
 *   regression).
 *
 * Caller is expected to sort/dedupe-by-id downstream as usual.
 */
export function mergeAttentionIntoFeed(
  eventDerived: FeedCard[],
  queueDerived: FeedCard[],
): FeedCard[] {
  const queueQitemIds = new Set<string>();
  for (const card of queueDerived) {
    const qitemId = qitemIdFromCard(card);
    if (qitemId) queueQitemIds.add(qitemId);
  }
  const filtered = eventDerived.filter((c) => {
    if (c.kind !== "action-required" && c.kind !== "approval") return true;
    const qitemId = qitemIdFromCard(c);
    if (!qitemId) return true;
    return !queueQitemIds.has(qitemId);
  });
  return [...queueDerived, ...filtered];
}

/**
 * OPR.0.3.2.20 — queue-derived card identifier prefix. Used by
 * Feed.tsx to route dismissal (queue → string-keyed dismissedIds;
 * event → numeric dismissedSeqs) AND to filter queue-derived cards
 * out of the seq-prune input (queue cards have synthetic seq=-1
 * and would otherwise pin min-seq at -1, breaking the
 * useDismissedSeqs auto-prune for event-derived dismissals — guard
 * re-verify-2 qitem-20260518192210 CLEANUP-1).
 */
export const QUEUE_DERIVED_CARD_ID_PREFIX = "queue-attention-";
export const ACTIVITY_NEEDS_INPUT_CARD_ID_PREFIX = "activity-needs-input-";

export function isSyntheticFeedCard(card: FeedCard): boolean {
  return card.id.startsWith(QUEUE_DERIVED_CARD_ID_PREFIX)
    || card.id.startsWith(ACTIVITY_NEEDS_INPUT_CARD_ID_PREFIX);
}

export function isQueueDerivedFeedCard(card: FeedCard): boolean {
  return card.id.startsWith(QUEUE_DERIVED_CARD_ID_PREFIX);
}

export function eventDerivedSeqsForPrune(rawCards: FeedCard[]): number[] {
  return rawCards.filter((c) => !isSyntheticFeedCard(c)).map((c) => c.source.seq);
}

function qitemIdFromCard(card: FeedCard): string | null {
  const payload = (card.source.payload ?? {}) as Record<string, unknown>;
  const fromPayload =
    (typeof payload.qitemId === "string" && payload.qitemId.length > 0)
      ? payload.qitemId
      : (typeof payload.qitem_id === "string" && payload.qitem_id.length > 0)
        ? (payload.qitem_id as string)
        : null;
  return fromPayload;
}

export interface NeedsInputSeat {
  logicalId: string;
  sessionName?: string | null;
  source: "hook" | "pane_heuristic" | string;
  eventAt?: string | null;
  sampledAt?: string;
  rigId?: string;
}

export function needsInputSeatToFeedCard(seat: NeedsInputSeat): FeedCard {
  const id = `activity-needs-input-${seat.rigId ?? "unknown"}-${seat.logicalId}`;
  const createdAt = seat.eventAt ?? seat.sampledAt ?? new Date().toISOString();
  const receivedAt = Date.parse(createdAt) || Date.now();
  const syntheticEvent: ActivityEvent = {
    seq: -1,
    type: "activity.needs_input.synthetic",
    payload: {
      logicalId: seat.logicalId,
      sessionName: seat.sessionName,
      source: seat.source,
      rigId: seat.rigId,
    },
    createdAt,
    receivedAt,
  };
  return {
    id,
    kind: "action-required",
    title: `${seat.logicalId} needs input${seat.source !== "hook" ? " (activity-grade)" : ""}`,
    body: seat.sessionName ?? undefined,
    rigId: seat.rigId,
    source: syntheticEvent,
    receivedAt,
    createdAt,
  };
}
