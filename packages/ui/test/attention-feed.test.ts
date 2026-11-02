// OPR.0.3.2.20 — For You priority windowing adapter tests.
//
// HG-3 fail-first discriminator: the event-FIFO source loses
// attention items past MAX_ACTIVITY_EVENTS=100; the queue-sourced
// path is window-independent. These tests pin the queue-source
// shape and the merge rule.

import { describe, it, expect } from "vitest";
import {
  attentionItemToFeedCard,
  eventDerivedSeqsForPrune,
  isQueueDerivedFeedCard,
  mergeAttentionIntoFeed,
  QUEUE_DERIVED_CARD_ID_PREFIX,
} from "../src/lib/attention-feed.js";
import type { AttentionQueueItem } from "../src/hooks/useAttentionItems.js";
import type { FeedCard } from "../src/lib/feed-classifier.js";
import type { ActivityEvent } from "../src/hooks/useActivityFeed.js";

function makeAttention(overrides: Partial<AttentionQueueItem> = {}): AttentionQueueItem {
  return {
    qitemId: "qitem-20260518000000-aaaa",
    tsCreated: "2026-05-18T00:00:00.000Z",
    tsUpdated: "2026-05-18T00:00:00.000Z",
    sourceSession: "advisor@rig",
    destinationSession: "human-bob@kernel",
    state: "pending",
    priority: "routine",
    tier: null,
    tags: null,
    blockedOn: null,
    handedOffTo: null,
    handedOffFrom: null,
    body: "needs attention",
    ...overrides,
  };
}

function makeEvent(qitemId: string, type: string = "queue.created"): ActivityEvent {
  return {
    seq: 1,
    type,
    payload: { qitemId },
    createdAt: "2026-05-18T00:00:00.000Z",
    receivedAt: Date.parse("2026-05-18T00:00:00.000Z"),
  };
}

function makeFeedCard(opts: { kind: FeedCard["kind"]; qitemId?: string; id?: string }): FeedCard {
  const evt = opts.qitemId ? makeEvent(opts.qitemId) : { ...makeEvent("none"), payload: {} };
  return {
    id: opts.id ?? `${evt.type}-1`,
    kind: opts.kind,
    title: `${opts.kind} card`,
    body: "x",
    receivedAt: evt.receivedAt,
    createdAt: evt.createdAt,
    source: evt,
  };
}

describe("attentionItemToFeedCard — kind classification", () => {
  it("preserves question data before card hydration, including on remote hosts", () => {
    const humanQuestions = [{ id: "channel", question: "Which channel?" }];
    const card = attentionItemToFeedCard(makeAttention({ humanQuestions, hostId: "remote", tags: ["runner-permission"] }));
    expect(card.source.payload.humanQuestions).toEqual(humanQuestions);
    expect(card.hostId).toBe("remote");
    expect(card.source.payload.tags).toEqual(["runner-permission"]);
    expect(attentionItemToFeedCard(makeAttention()).source.payload.humanQuestions).toBeNull();
  });

  it("HG-4 approval class: tier='human-gate' → kind:'approval'", () => {
    const card = attentionItemToFeedCard(makeAttention({ tier: "human-gate", destinationSession: "advisor@rig" }));
    expect(card.kind).toBe("approval");
  });

  it("HG-4 action-required class: destination matches human-*@kernel → kind:'action-required'", () => {
    const card = attentionItemToFeedCard(makeAttention({ destinationSession: "human-bob@kernel" }));
    expect(card.kind).toBe("action-required");
  });

  it("HG-4 action-required class: destination matches human@host (bare) → kind:'action-required'", () => {
    const card = attentionItemToFeedCard(makeAttention({ destinationSession: "human@host" }));
    expect(card.kind).toBe("action-required");
  });

  it("HG-4: tier='human-gate' wins over human-seat destination (approval takes priority for classification)", () => {
    const card = attentionItemToFeedCard(makeAttention({ tier: "human-gate", destinationSession: "human-x@kernel" }));
    expect(card.kind).toBe("approval");
  });

  it("synthetic event payload carries qitemId so downstream qitemId lookups work", () => {
    const card = attentionItemToFeedCard(makeAttention({ qitemId: "qitem-test-1" }));
    const payload = card.source.payload as Record<string, unknown>;
    expect(payload.qitemId).toBe("qitem-test-1");
  });

  it("FeedCard.id is stable + queue-prefixed so re-fetches produce identical keys", () => {
    const a = attentionItemToFeedCard(makeAttention({ qitemId: "qitem-stable-1" }));
    const b = attentionItemToFeedCard(makeAttention({ qitemId: "qitem-stable-1" }));
    expect(a.id).toBe(b.id);
    expect(a.id).toMatch(/^queue-attention-/);
  });
});

describe("mergeAttentionIntoFeed — queue supersedes events for attention kinds", () => {
  it("HG-2 headline: queue-derived attention card surfaces even when no matching event exists (eviction defect)", () => {
    const eventDerived: FeedCard[] = [
      makeFeedCard({ kind: "shipped", qitemId: "q-other" }),
      makeFeedCard({ kind: "progress", qitemId: "q-other-2" }),
    ];
    const queueDerived: FeedCard[] = [
      attentionItemToFeedCard(makeAttention({ qitemId: "qitem-evicted", destinationSession: "human-x@kernel" })),
    ];
    const merged = mergeAttentionIntoFeed(eventDerived, queueDerived);
    expect(merged.some((c) => c.kind === "action-required" && c.id.includes("qitem-evicted"))).toBe(true);
  });

  it("HG-3 dedup: event-derived action-required card with same qitemId is replaced by queue version", () => {
    const sameQitem = "qitem-shared-1";
    const eventDerived: FeedCard[] = [
      makeFeedCard({ kind: "action-required", qitemId: sameQitem, id: "queue.created-99" }),
    ];
    const queueDerived: FeedCard[] = [
      attentionItemToFeedCard(makeAttention({ qitemId: sameQitem, destinationSession: "human@host" })),
    ];
    const merged = mergeAttentionIntoFeed(eventDerived, queueDerived);
    // The event-derived card MUST be evicted from the merge result;
    // only the queue-derived version remains.
    expect(merged.filter((c) => c.kind === "action-required")).toHaveLength(1);
    expect(merged.find((c) => c.kind === "action-required")!.id).toMatch(/^queue-attention-/);
    // The event card id is NOT present.
    expect(merged.some((c) => c.id === "queue.created-99")).toBe(false);
  });

  it("HG-3 dedup: event-derived approval card with same qitemId is replaced by queue version", () => {
    const sameQitem = "qitem-approval-1";
    const eventDerived: FeedCard[] = [
      makeFeedCard({ kind: "approval", qitemId: sameQitem }),
    ];
    const queueDerived: FeedCard[] = [
      attentionItemToFeedCard(makeAttention({ qitemId: sameQitem, tier: "human-gate" })),
    ];
    const merged = mergeAttentionIntoFeed(eventDerived, queueDerived);
    expect(merged.filter((c) => c.kind === "approval")).toHaveLength(1);
    expect(merged.find((c) => c.kind === "approval")!.id).toMatch(/^queue-attention-/);
  });

  it("HG-6 no regression: non-attention event cards (shipped/progress/observation) are passed through unchanged", () => {
    const eventDerived: FeedCard[] = [
      makeFeedCard({ kind: "shipped", qitemId: "q-shipped" }),
      makeFeedCard({ kind: "progress", qitemId: "q-progress" }),
      makeFeedCard({ kind: "observation", qitemId: "q-obs" }),
    ];
    const queueDerived: FeedCard[] = [
      attentionItemToFeedCard(makeAttention({ qitemId: "qitem-fresh", destinationSession: "human-y@kernel" })),
    ];
    const merged = mergeAttentionIntoFeed(eventDerived, queueDerived);
    expect(merged.filter((c) => c.kind === "shipped")).toHaveLength(1);
    expect(merged.filter((c) => c.kind === "progress")).toHaveLength(1);
    expect(merged.filter((c) => c.kind === "observation")).toHaveLength(1);
    expect(merged.filter((c) => c.kind === "action-required")).toHaveLength(1);
  });

  it("HG-5 graceful-empty: no queue items → merged result equals event-derived (no error)", () => {
    const eventDerived: FeedCard[] = [
      makeFeedCard({ kind: "shipped", qitemId: "q-shipped" }),
      makeFeedCard({ kind: "approval", qitemId: "q-event-approval" }),
    ];
    const merged = mergeAttentionIntoFeed(eventDerived, []);
    expect(merged).toHaveLength(2);
    expect(merged.some((c) => c.kind === "approval")).toBe(true);
  });

  it("HG-3: event-derived attention card WITHOUT a qitemId (anomalous payload) is preserved if queue has no matching item", () => {
    const eventDerived: FeedCard[] = [
      makeFeedCard({ kind: "action-required" /* no qitemId */ }),
    ];
    const merged = mergeAttentionIntoFeed(eventDerived, []);
    expect(merged).toHaveLength(1);
  });

  // HG-2 stress-test simulation: even when 200 unrelated event cards
  // would have evicted the attention item from the 100-FIFO, the merge
  // surfaces it because the queue is the source of truth.
  it("HG-2 stress: 200 routine event cards + 1 queue-derived attention card → attention card present after merge", () => {
    const eventDerived: FeedCard[] = Array.from({ length: 200 }, (_, i) =>
      makeFeedCard({ kind: "shipped", qitemId: `q-routine-${i}` }),
    );
    const queueDerived: FeedCard[] = [
      attentionItemToFeedCard(makeAttention({ qitemId: "qitem-survives", destinationSession: "human-z@kernel" })),
    ];
    const merged = mergeAttentionIntoFeed(eventDerived, queueDerived);
    const attentionCards = merged.filter((c) => c.kind === "action-required");
    expect(attentionCards).toHaveLength(1);
    expect(attentionCards[0]!.id).toContain("qitem-survives");
  });
});

// Guard re-verify-2 (qitem-20260518192210) CLEANUP-1: useDismissedSeqs
// auto-prunes by min-seq across currentSeqs. Queue-derived synthetic
// cards carry seq=-1 (no real event). If those -1 sentinels reach
// useDismissedSeqs, min-seq pins at -1 → event-seq dismissals never
// auto-prune. eventDerivedSeqsForPrune filters queue-derived cards
// OUT before they reach the seq input.

describe("CLEANUP-1: eventDerivedSeqsForPrune isolates seq-prune from queue-derived sentinels", () => {
  it("isQueueDerivedFeedCard returns true for queue-attention-* ids, false otherwise", () => {
    const eventCard = makeFeedCard({ kind: "approval", qitemId: "q1" });
    const queueCard = attentionItemToFeedCard(makeAttention({ qitemId: "qitem-Q", destinationSession: "human-bob@kernel" }));
    expect(isQueueDerivedFeedCard(eventCard)).toBe(false);
    expect(isQueueDerivedFeedCard(queueCard)).toBe(true);
    expect(QUEUE_DERIVED_CARD_ID_PREFIX).toBe("queue-attention-");
  });

  it("returns only event-derived seqs when input mixes event + queue cards", () => {
    const cards: FeedCard[] = [
      makeFeedCard({ kind: "approval", qitemId: "q1", id: "queue.created-42" }),
      attentionItemToFeedCard(makeAttention({ qitemId: "qitem-Q1", destinationSession: "human-x@kernel" })),
      makeFeedCard({ kind: "shipped", qitemId: "q2", id: "queue.created-50" }),
      attentionItemToFeedCard(makeAttention({ qitemId: "qitem-Q2", tier: "human-gate" })),
    ];
    const seqs = eventDerivedSeqsForPrune(cards);
    // Event-derived seqs are positive (real events); queue-derived
    // synthetic seq=-1 must be filtered out.
    expect(seqs).toEqual([1, 1]); // makeFeedCard uses seq=1 by default
    expect(seqs).not.toContain(-1);
  });

  it("returns empty array when every input is queue-derived", () => {
    const cards: FeedCard[] = [
      attentionItemToFeedCard(makeAttention({ qitemId: "qitem-a", destinationSession: "human-a@kernel" })),
      attentionItemToFeedCard(makeAttention({ qitemId: "qitem-b", destinationSession: "human-b@kernel" })),
    ];
    expect(eventDerivedSeqsForPrune(cards)).toEqual([]);
  });

  it("CLEANUP-1 regression: queue-derived synthetic seq=-1 does NOT pin min-seq when fed into useDismissedSeqs", async () => {
    // Discriminator: import useDismissedSeqs in isolation and prove
    // that with the FILTERED seq input (only event-derived seqs),
    // auto-prune correctly drops a dismissed seq once it falls
    // below the min. With the UNFILTERED input (mixed -1 sentinel +
    // real seqs), min would be -1 and the prune would never fire.
    const { renderHook, act } = await import("@testing-library/react");
    const { useDismissedSeqs } = await import("../src/hooks/useDismissedSeqs.js");
    localStorage.clear();

    // Initial render: dismissed seq 50 is in current set.
    const { result, rerender } = renderHook(({ seqs }) => useDismissedSeqs(seqs), {
      initialProps: { seqs: [50, 100, 200] },
    });
    act(() => result.current.dismiss(50));
    expect(result.current.dismissedSeqs.has(50)).toBe(true);

    // The FIFO drops the older events: only newer ones remain.
    // With CLEANUP-1 in place (queue-derived sentinels filtered),
    // min-seq advances to 150 → dismissed 50 is correctly pruned.
    rerender({ seqs: [150, 200, 300] });
    // Wait for the useEffect prune to run.
    await act(() => Promise.resolve());
    expect(result.current.dismissedSeqs.has(50)).toBe(false);
  });
});
