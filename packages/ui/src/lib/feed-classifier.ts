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

function classifyEvent(evt: ActivityEvent): FeedCard | null {
  const payload = (evt.payload ?? {}) as Record<string, unknown>;
  const author =
    asString(payload.actor_session) ??
    asString(payload.source_session) ??
    asString(payload.sender);
  const rigId = asString(payload.rig_id) ?? asString(payload.rigId);
  const summary =
    asString(payload.summary) ??
    asString(payload.body) ??
    asString(payload.title);
  const base = {
    id: `${evt.type}-${evt.seq}`,
    title: summary ?? evt.type,
    body: undefined as string | undefined,
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
  if (evt.type === "queue.item.created" || evt.type === "queue.item.updated") {
    const state = asString(payload.state);
    if (state === "human-gate" || state === "pending-approval") {
      return { ...base, kind: "action-required" };
    }
    if (state === "closeout-pending-ratify") {
      return { ...base, kind: "approval" };
    }
    return { ...base, kind: "progress" };
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
