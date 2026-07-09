// V1 attempt-3 Phase 3 — For You feed classifier per for-you-feed.md L106–L107 + SC-17.
//
// **Client-side synthesis from existing daemon events.** No new daemon
// `lifecycle.shipped` event type at V1 — daemon boundary stays clean
// (SC-29). SHIPPED cards built from queue.close + git events.

import type { ActivityEvent } from "../hooks/useActivityFeed.js";
import { isHumanSeatSessionRef } from "./session-name.js";

export type FeedCardKind =
  | "action-required"
  | "approval"
  | "shipped"
  | "progress"
  | "observation";

export interface FeedCard {
  id: string;
  kind: FeedCardKind;
  title: string;
  body?: string;
  authorSession?: string;
  rigId?: string;
  receivedAt: number;
  createdAt: string;
  // Original event for click-through to scope.
  source: ActivityEvent;
  /** OPR.0.4.4.20 FR-9 win #2: the evidence_ref judge-this link, visible on
   *  the card itself (rendering only; carried from the attention read path). */
  evidenceRef?: string | null;
  /** OPR.0.4.4.20 FR-9 win #1: living-notes deep link — the slice Review tab
   *  anchored at this card's NEEDS-YOU item. Absent on non-living-notes cards
   *  (their existing drill behavior is unchanged — additive routing). */
  reviewSlice?: string | null;
  reviewAnchor?: string | null;
  /** OPR.0.4.4.15: origin host id on aggregated multi-host items ('local'
   *  or a registered host id). Absent = local (zero-config unchanged). */
  hostId?: string;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function pickString(
  payload: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = asString(payload[key]);
    if (value) return value;
  }
  return undefined;
}

function shortQitemId(qitemId: string | undefined): string | undefined {
  if (!qitemId) return undefined;
  if (qitemId.length <= 28) return qitemId;
  return `${qitemId.slice(0, 18)}...${qitemId.slice(-6)}`;
}

function queueEventLabel(type: string): string {
  switch (type) {
    case "queue.created":
    case "queue.item.created":
      return "Queue item created";
    case "queue.updated":
    case "queue.item.updated":
      return "Queue item updated";
    case "queue.handed_off":
      return "Queue item handed off";
    case "queue.claimed":
      return "Queue item claimed";
    case "queue.unclaimed":
      return "Queue item unclaimed";
    case "qitem.fallback_routed":
      return "Queue item fallback routed";
    case "qitem.closure_overdue":
      return "Queue item closure overdue";
    case "inbox.absorbed":
      return "Inbox item absorbed";
    case "inbox.denied":
      return "Inbox item denied";
    default:
      return type;
  }
}

function isQueueVisibilityEvent(type: string): boolean {
  return (
    type === "queue.created" ||
    type === "queue.updated" ||
    type === "queue.claimed" ||
    type === "queue.unclaimed" ||
    type === "queue.handed_off" ||
    type === "queue.item.created" ||
    type === "queue.item.updated" ||
    type === "qitem.fallback_routed" ||
    type === "qitem.closure_overdue" ||
    type === "inbox.absorbed" ||
    type === "inbox.denied"
  );
}

function queueKind(type: string, state: string | undefined, tier: string | undefined): FeedCardKind {
  if (type.startsWith("queue.") && type.endsWith(".closed")) {
    return "shipped";
  }
  if (type === "qitem.closure_overdue" || type === "inbox.denied") {
    return "action-required";
  }
  // OPR.0.4.4.19 FR-3: human-gate is a TIER value, never a state — the prior
  // `state === "human-gate"` branch was dead (the state enum never contains
  // it). The fixed branch classifies on tier, as an approval card (mirrors
  // attention-feed.ts attentionKindFor + the mission-control read layer).
  if (tier === "human-gate") {
    return "approval";
  }
  if (state === "pending-approval") {
    return "action-required";
  }
  if (state === "closeout-pending-ratify") {
    return "approval";
  }
  if (state === "done" || state === "closed" || state === "completed" || state === "shipped") {
    return "shipped";
  }
  return "progress";
}

function queueBody(payload: Record<string, unknown>): string | undefined {
  const source = pickString(payload, "sourceSession", "source_session", "fromSession");
  const destination = pickString(
    payload,
    "destinationSession",
    "destination_session",
    "toSession",
    "destination",
  );
  const route =
    source && destination
      ? `${source} -> ${destination}`
      : source
        ? `Source: ${source}`
        : destination
          ? `Destination: ${destination}`
          : undefined;
  const meta = [
    pickString(payload, "priority") ? `priority=${pickString(payload, "priority")}` : undefined,
    pickString(payload, "tier") ? `tier=${pickString(payload, "tier")}` : undefined,
    pickString(payload, "state", "toState") ? `state=${pickString(payload, "state", "toState")}` : undefined,
    pickString(payload, "closureReason") ? `closure=${pickString(payload, "closureReason")}` : undefined,
  ].filter((item): item is string => Boolean(item));

  return [route, meta.length > 0 ? meta.join(" / ") : undefined]
    .filter((item): item is string => Boolean(item))
    .join("\n") || undefined;
}

// OPR.0.4.4.19 FR-3: exported so Feed.tsx's card-kind hydration uses the same
// strict human-seat predicate instead of a prefix guess.
export function isHumanSeat(session: string | undefined): boolean {
  // OPR.0.4.6.MH1 FR-8: delegates to the shared session-name contract
  // (was a local regex copy — the drift this comment always feared).
  return isHumanSeatSessionRef(session ?? "");
}

function classifyEvent(evt: ActivityEvent): FeedCard | null {
  const payload = (evt.payload ?? {}) as Record<string, unknown>;
  const author = pickString(
    payload,
    "actor_session",
    "actorSession",
    "source_session",
    "sourceSession",
    "fromSession",
    "sender",
  );
  const rigId = pickString(payload, "rig_id", "rigId");
  const summary = pickString(payload, "summary", "body", "title");
  const base = {
    id: `${evt.type}-${evt.seq}`,
    title: summary ?? evt.type,
    body: asString(payload.body),
    authorSession: author,
    rigId,
    receivedAt: evt.receivedAt,
    createdAt: evt.createdAt,
    source: evt,
  };

  // Type-based mapping. Keep tight; expand as feedback rolls in.
  if (evt.type.startsWith("queue.") && evt.type.endsWith(".closed")) {
    return { ...base, kind: "shipped" };
  }
  if (isQueueVisibilityEvent(evt.type)) {
    const qitemId = pickString(payload, "qitemId", "qitem_id");
    const destination = pickString(
      payload,
      "destinationSession",
      "destination_session",
      "toSession",
      "destination",
    );
    const state = pickString(payload, "state", "toState");
    const tier = pickString(payload, "tier");
    const classifiedKind = queueKind(evt.type, state, tier);
    const kind =
      classifiedKind === "approval"
        ? "approval"
        : isHumanSeat(destination)
          ? "action-required"
          : classifiedKind;
    const explicitTitle = pickString(payload, "summary", "title");
    const label =
      kind === "shipped" && evt.type === "queue.updated"
        ? "Queue item shipped"
        : queueEventLabel(evt.type);
    const title =
      explicitTitle ??
      [label, shortQitemId(qitemId)]
        .filter((item): item is string => Boolean(item))
        .join(": ");
    return {
      ...base,
      title,
      body: asString(payload.body) ?? queueBody(payload),
      kind,
    };
  }
  if (evt.type.startsWith("workflow.")) {
    return { ...base, kind: "progress" };
  }
  if (evt.type.startsWith("stream.") || evt.type.startsWith("watchdog.")) {
    return { ...base, kind: "observation" };
  }
  if (evt.type.startsWith("lifecycle.") || evt.type.startsWith("git.")) {
    return { ...base, kind: "shipped" };
  }
  // Default: every event surfaces as observation so nothing is silently dropped.
  return { ...base, kind: "observation" };
}

export function classifyFeed(events: ActivityEvent[]): FeedCard[] {
  const cards = events.map(classifyEvent).filter((c): c is FeedCard => c !== null);
  return cards.sort((a, b) => b.receivedAt - a.receivedAt);
}

// OPR.0.3.3.20 — manage-by-exception ordering. The kinds that need a human
// decision; everything else is non-decision noise relative to them.
const DECISION_KINDS: ReadonlySet<FeedCardKind> = new Set(["action-required", "approval"]);

/**
 * OPR.0.3.3.20 — targeted decision-band sort over the classified/merged feed.
 * Lifts ALL action-required/approval cards (including event-only ones, which
 * the newest-first sort alone leaves buried under newer progress noise) above
 * progress/observation/shipped, preserving newest-first WITHIN each band.
 * A two-band stable partition + the existing recency comparator — deliberately
 * NOT a priority-ranking engine (no scores, no per-kind weights, no new fields
 * on the cards).
 */
export function sortFeedByDecisionBand(cards: FeedCard[]): FeedCard[] {
  const newestFirst = (a: FeedCard, b: FeedCard) => b.receivedAt - a.receivedAt;
  const decision = cards.filter((c) => DECISION_KINDS.has(c.kind)).sort(newestFirst);
  const rest = cards.filter((c) => !DECISION_KINDS.has(c.kind)).sort(newestFirst);
  return [...decision, ...rest];
}
