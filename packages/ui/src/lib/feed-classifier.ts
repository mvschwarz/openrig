// V1 attempt-3 Phase 3 — For You feed classifier per for-you-feed.md L106–L107 + SC-17.
//
// **Client-side synthesis from existing daemon events.** No new daemon
// `lifecycle.shipped` event type at V1 — daemon boundary stays clean
// (SC-29). SHIPPED cards built from queue.close + git events.

import type { ActivityEvent } from "../hooks/useActivityFeed.js";

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

function queueKind(type: string, state: string | undefined): FeedCardKind {
  if (type.startsWith("queue.") && type.endsWith(".closed")) {
    return "shipped";
  }
  if (type === "qitem.closure_overdue" || type === "inbox.denied") {
    return "action-required";
  }
  if (state === "human-gate" || state === "pending-approval") {
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

function isHumanSeat(session: string | undefined): boolean {
  return /^human(?:-[A-Za-z0-9._-]+)?@(kernel|host)$/.test(session ?? "");
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
    const classifiedKind = queueKind(evt.type, state);
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
