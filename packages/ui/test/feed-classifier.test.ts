// V1 attempt-3 Phase 3 — feed-classifier tests (SC-15 + SC-17).
//
// SC-17 LOAD-BEARING: SHIPPED cards are synthesized client-side from
// existing daemon events (queue close + git events). NO new daemon
// event types (SC-29).

import { describe, it, expect } from "vitest";
import { classifyFeed } from "../src/lib/feed-classifier.js";
import type { ActivityEvent } from "../src/hooks/useActivityFeed.js";

function evt(type: string, payload: Record<string, unknown> = {}, seq = 1): ActivityEvent {
  return {
    seq,
    type,
    payload,
    createdAt: new Date(seq * 1000).toISOString(),
    receivedAt: seq * 1000,
  };
}

describe("classifyFeed — SC-15 5 card types", () => {
  it("queue.item.created with state=human-gate → action-required", () => {
    const cards = classifyFeed([evt("queue.item.created", { state: "human-gate" })]);
    expect(cards[0]?.kind).toBe("action-required");
  });

  it("queue.item.created with state=closeout-pending-ratify → approval", () => {
    const cards = classifyFeed([
      evt("queue.item.created", { state: "closeout-pending-ratify" }),
    ]);
    expect(cards[0]?.kind).toBe("approval");
  });

  it("queue.item.shipped.closed → SHIPPED (client-synthesize per SC-17)", () => {
    const cards = classifyFeed([evt("queue.item.shipped.closed", {})]);
    expect(cards[0]?.kind).toBe("shipped");
  });

  it("workflow.* event → progress", () => {
    const cards = classifyFeed([evt("workflow.step.completed", {})]);
    expect(cards[0]?.kind).toBe("progress");
  });

  it("stream.* event → observation", () => {
    const cards = classifyFeed([evt("stream.item.emitted", {})]);
    expect(cards[0]?.kind).toBe("observation");
  });

  it("watchdog.* event → observation", () => {
    const cards = classifyFeed([evt("watchdog.alert", {})]);
    expect(cards[0]?.kind).toBe("observation");
  });

  it("git.* event → SHIPPED (client-synthesize per SC-17)", () => {
    const cards = classifyFeed([evt("git.tag.created", {})]);
    expect(cards[0]?.kind).toBe("shipped");
  });

  it("default unknown event → observation (nothing silently dropped)", () => {
    const cards = classifyFeed([evt("totally.unknown.event", {})]);
    expect(cards[0]?.kind).toBe("observation");
  });

  it("sorts cards newest-first by receivedAt", () => {
    const cards = classifyFeed([
      evt("workflow.step.a", {}, 1),
      evt("workflow.step.b", {}, 5),
      evt("workflow.step.c", {}, 3),
    ]);
    expect(cards.map((c) => c.source.seq)).toEqual([5, 3, 1]);
  });

  it("extracts authorSession from actor_session payload", () => {
    const cards = classifyFeed([
      evt("queue.item.updated", { actor_session: "driver@vel" }),
    ]);
    expect(cards[0]?.authorSession).toBe("driver@vel");
  });
});
