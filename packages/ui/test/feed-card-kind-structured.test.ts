// OPR.0.4.4.19 FR-3 — card-kind promotion reads STRUCTURED signals only.
// The body-text ("approval requested") / tag-guess ("approval", "ratify") /
// state-substring heuristics are retired; tier + strict human-seat
// destination are the only promotion inputs.

import { describe, it, expect } from "vitest";
import { hydratedCardKind } from "../src/components/for-you/Feed.js";
import type { FeedCard } from "../src/lib/feed-classifier.js";
import type { QueueItemDetail } from "../src/hooks/useSlices.js";

function card(kind: FeedCard["kind"] = "progress"): FeedCard {
  return {
    id: "queue.created-1",
    kind,
    title: "t",
    receivedAt: 1000,
    createdAt: new Date(1000).toISOString(),
    source: { seq: 1, type: "queue.created", payload: {}, createdAt: new Date(1000).toISOString(), receivedAt: 1000 },
  };
}

function item(overrides: Partial<QueueItemDetail> = {}): QueueItemDetail {
  return {
    qitemId: "qitem-x",
    tsCreated: "2026-07-04T00:00:00Z",
    tsUpdated: "2026-07-04T00:00:00Z",
    sourceSession: "a@rig",
    destinationSession: "b@rig",
    state: "pending",
    priority: "routine",
    tier: null,
    tags: null,
    body: "ordinary body",
    summary: null,
    ...overrides,
  } as QueueItemDetail;
}

describe("hydratedCardKind — FR-3 structured signals only", () => {
  it("tier=human-gate → approval", () => {
    expect(hydratedCardKind(card(), item({ tier: "human-gate" }), undefined)).toBe("approval");
  });

  it("body 'approval requested' on a NON-human-routed item is NOT promoted (heuristic retired)", () => {
    const k = hydratedCardKind(
      card(),
      item({ body: "approval requested for the widget refactor" }),
      undefined,
    );
    expect(k).toBe("progress");
  });

  it("tags 'approval'/'ratify' on a NON-human-routed item are NOT promoted (heuristic retired)", () => {
    const k = hydratedCardKind(
      card(),
      item({ tags: ["approval", "ratify"] }),
      undefined,
    );
    expect(k).toBe("progress");
  });

  it("strict human-seat destination → action-required; sloppy prefix match retired", () => {
    expect(hydratedCardKind(card(), item({ destinationSession: "human-review@kernel" }), undefined)).toBe("action-required");
    // Previously destination.startsWith("human-") promoted this non-seat:
    expect(hydratedCardKind(card(), item({ destinationSession: "human-ish@other-rig" }), undefined)).toBe("progress");
  });

  it("terminal states still map to shipped", () => {
    expect(hydratedCardKind(card(), item({ state: "done" }), undefined)).toBe("shipped");
  });

  it("done queue-derived card without questions maps to shipped", () => {
    const queueDerived: FeedCard = {
      ...card("action-required"),
      id: "queue-attention-qitem-x",
      source: { seq: -1, type: "queue.attention.synthetic", payload: { qitemId: "qitem-x" }, createdAt: new Date(1000).toISOString(), receivedAt: 1000 },
    };
    expect(hydratedCardKind(queueDerived, item({ state: "done", destinationSession: "human@host", humanQuestions: null }), undefined)).toBe("shipped");
  });

  it("done queue-derived card with questions keeps its kind", () => {
    const queueDerived: FeedCard = {
      ...card("action-required"),
      id: "queue-attention-qitem-x",
      source: { seq: -1, type: "queue.attention.synthetic", payload: { qitemId: "qitem-x" }, createdAt: new Date(1000).toISOString(), receivedAt: 1000 },
    };
    const questions = [{ id: "q1", question: "Pick one?", options: [{ id: "a", label: "A" }] }];
    expect(hydratedCardKind(queueDerived, item({ state: "done", destinationSession: "human@host", humanQuestions: questions }), undefined)).toBe("action-required");
  });
});
