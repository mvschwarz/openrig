// 0.3.1 slice 06 forward-fix #2 — pure-logic test for the Feed.tsx
// adapter that converts daemon-driven mission + slice rows into
// FeedCardItem[]. Proves ProgressCard is routed for missions
// (closing the prior "ProgressCard never mounted in production"
// finding) and that slice status routing dispatches to the right
// card type without mounting Feed.tsx itself.

import { describe, it, expect } from "vitest";
import { buildStorytellingFeedItems } from "../src/components/feed/cards/storytelling-cards.js";
import type { FeedCard } from "../src/lib/feed-classifier.js";
import type { ActivityEvent } from "../src/hooks/useActivityFeed.js";

function makeApprovalFeedCard(opts: {
  qitemId?: string;
  altKey?: "qitem_id";
  title?: string;
  body?: string;
  authorSession?: string;
  id?: string;
}): FeedCard {
  const payload: Record<string, unknown> = {};
  if (opts.qitemId !== undefined) {
    if (opts.altKey === "qitem_id") payload.qitem_id = opts.qitemId;
    else payload.qitemId = opts.qitemId;
  }
  const evt: ActivityEvent = {
    seq: 1,
    type: "queue.created",
    payload,
    createdAt: "2026-05-15T00:00:00.000Z",
    receivedAt: 1_700_000_000_000,
  };
  return {
    id: opts.id ?? "queue.created-1",
    kind: "approval",
    title: opts.title ?? "Approval needed",
    body: opts.body,
    authorSession: opts.authorSession,
    receivedAt: evt.receivedAt,
    createdAt: evt.createdAt,
    source: evt,
  };
}

describe("buildStorytellingFeedItems — production adapter", () => {
  it("routes missions into ProgressCard items (Finding 2 fix: ProgressCard now wired)", () => {
    const items = buildStorytellingFeedItems(
      [
        { name: "release-0.3.1", path: "missions/release-0.3.1" },
        { name: "demo-video-rig-v0", path: "missions/demo-video-rig-v0" },
      ],
      [],
    );
    const progressItems = items.filter((i) => i.kind === "progress");
    expect(progressItems).toHaveLength(2);
    expect(progressItems[0]!.kind).toBe("progress");
    if (progressItems[0]!.kind === "progress") {
      expect(progressItems[0]!.source.missionId).toBe("release-0.3.1");
      expect(progressItems[0]!.source.nextStep).toMatch(/Open mission/);
    }
  });

  it("caps missions at 2 to keep the preview band tight", () => {
    const items = buildStorytellingFeedItems(
      [
        { name: "m1", path: "missions/m1" },
        { name: "m2", path: "missions/m2" },
        { name: "m3", path: "missions/m3" },
        { name: "m4", path: "missions/m4" },
      ],
      [],
    );
    expect(items.filter((i) => i.kind === "progress")).toHaveLength(2);
  });

  it("routes shipped/complete/done slices into ShippedCard", () => {
    const items = buildStorytellingFeedItems(
      [],
      [
        { name: "a", status: "shipped" },
        { name: "b", status: "complete" },
        { name: "c", status: "done" },
      ],
    );
    expect(items.every((i) => i.kind === "shipped")).toBe(true);
    expect(items).toHaveLength(3);
  });

  it("routes blocked slices into IncidentCard with status=warning", () => {
    const items = buildStorytellingFeedItems([], [{ name: "x", status: "blocked" }]);
    expect(items[0]!.kind).toBe("incident");
    if (items[0]!.kind === "incident") {
      expect(items[0]!.source.status).toBe("warning");
    }
  });

  it("routes failed/danger slices into IncidentCard with status=danger", () => {
    const failed = buildStorytellingFeedItems([], [{ name: "x", status: "failed" }]);
    expect(failed[0]!.kind).toBe("incident");
    if (failed[0]!.kind === "incident") expect(failed[0]!.source.status).toBe("danger");
  });

  it("routes everything else into IncidentCard with status=info", () => {
    const items = buildStorytellingFeedItems(
      [],
      [
        { name: "a", status: "in-flight" },
        { name: "b", status: null },
        { name: "c" },
      ],
    );
    expect(items.every((i) => i.kind === "incident")).toBe(true);
    items.forEach((i) => {
      if (i.kind === "incident") expect(i.source.status).toBe("info");
    });
  });

  it("composes missions + slices into a single ordered list (missions first, slices after)", () => {
    const items = buildStorytellingFeedItems(
      [{ name: "m1", path: "missions/m1" }],
      [{ name: "s1", status: "shipped" }],
    );
    expect(items).toHaveLength(2);
    expect(items[0]!.kind).toBe("progress");
    expect(items[1]!.kind).toBe("shipped");
  });

  it("returns an empty list when both inputs are empty (no spurious cards)", () => {
    expect(buildStorytellingFeedItems([], [])).toEqual([]);
  });

  it("tolerates null/undefined inputs without throwing", () => {
    // @ts-expect-error — intentional shape mismatch to verify defensive
    // guards against runtime data drift (daemon could return null).
    expect(buildStorytellingFeedItems(null, undefined)).toEqual([]);
  });

  it("routes approval-kind FeedCards into ApprovalCard items with qitemId extracted from payload", () => {
    const items = buildStorytellingFeedItems(
      [],
      [],
      undefined,
      [
        makeApprovalFeedCard({ qitemId: "qitem-abc", title: "Approve this", body: "body text", authorSession: "advisor@rig" }),
        makeApprovalFeedCard({ qitemId: "qitem-def", altKey: "qitem_id", title: "Approve that" }),
      ],
    );
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.kind === "approval")).toBe(true);
    if (items[0]!.kind === "approval") {
      expect(items[0]!.source.qitemId).toBe("qitem-abc");
      expect(items[0]!.source.title).toBe("Approve this");
      expect(items[0]!.source.oneLiner).toContain("advisor@rig");
      expect(items[0]!.source.bodyPreview).toBe("body text");
      expect(items[0]!.source.drillInHref).toBe("/for-you");
    }
    if (items[1]!.kind === "approval") {
      // Snake-case payload key also resolves.
      expect(items[1]!.source.qitemId).toBe("qitem-def");
    }
  });

  it("caps approvals at 2 to keep the preview band tight", () => {
    const items = buildStorytellingFeedItems(
      [],
      [],
      undefined,
      [
        makeApprovalFeedCard({ qitemId: "q1" }),
        makeApprovalFeedCard({ qitemId: "q2" }),
        makeApprovalFeedCard({ qitemId: "q3" }),
        makeApprovalFeedCard({ qitemId: "q4" }),
      ],
    );
    expect(items.filter((i) => i.kind === "approval")).toHaveLength(2);
  });

  it("ignores non-approval FeedCards (Shipped / Progress / Incident come from missions+slices, not from feedCards)", () => {
    const nonApproval: FeedCard[] = [
      { ...makeApprovalFeedCard({ qitemId: "x1" }), kind: "shipped" },
      { ...makeApprovalFeedCard({ qitemId: "x2" }), kind: "progress" },
      { ...makeApprovalFeedCard({ qitemId: "x3" }), kind: "action-required" },
      { ...makeApprovalFeedCard({ qitemId: "x4" }), kind: "observation" },
    ];
    const items = buildStorytellingFeedItems([], [], undefined, nonApproval);
    // No approval inputs ⇒ no approval outputs. Non-approval FeedCards
    // are NOT routed through this adapter (mission/slice rows are the
    // source for those kinds).
    expect(items).toEqual([]);
  });

  it("never emits concept-kind items — ConceptCard is deferred to a 0.3.2 slice", () => {
    const items = buildStorytellingFeedItems(
      [{ name: "m1", path: "missions/m1" }],
      [{ name: "s1", status: "shipped" }, { name: "s2", status: "blocked" }],
      undefined,
      [makeApprovalFeedCard({ qitemId: "q1" })],
    );
    expect(items.some((i) => i.kind === "concept")).toBe(false);
  });

  it("falls back to FeedCard.id when payload has no qitemId/qitem_id key", () => {
    const card = makeApprovalFeedCard({ id: "queue.created-42" });
    const items = buildStorytellingFeedItems([], [], undefined, [card]);
    expect(items).toHaveLength(1);
    if (items[0]!.kind === "approval") {
      expect(items[0]!.source.qitemId).toBe("queue.created-42");
    }
  });
});
