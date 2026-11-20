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
import {
  isCardKindSubscribed,
  type FeedSubscriptionState,
} from "../src/hooks/useFeedSubscriptions.js";

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

  it("routes closed and closed-<reason> non-delivery slices into ClosedCard rather than ShippedCard or IncidentCard", () => {
    const items = buildStorytellingFeedItems(
      [],
      [
        { name: "01-deferred", displayName: "Deferred slice", status: "closed" },
        { name: "02-wontfix", status: "closed-wontfix" },
      ],
    );
    expect(items).toEqual([
      {
        kind: "closed",
        source: {
          sliceId: "01-deferred",
          title: "Deferred slice",
          oneLiner: "Slice in closed state",
        },
      },
      {
        kind: "closed",
        source: {
          sliceId: "02-wontfix",
          title: "02-wontfix",
          oneLiner: "Slice in closed-wontfix state",
        },
      },
    ]);
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

  // OPR.0.3.2.17 — ConceptCard data source (replacing the 0.3.1 deferred
  // pin; HG-6 fail-first discriminator).
  //
  // Source: shaped backlog candidates — SliceListEntry rows where
  //   rawStatus === "candidate" (case-insensitive).
  // Mapping: sliceId ← name; title ← displayName (or name); oneLiner ←
  //   frontmatter description (passed through as the adapter row's
  //   `description` field).
  // Graceful-empty (HG-2): no candidate rows → no concept items, no
  //   error; other kinds unaffected.

  it("HG-1: rawStatus='candidate' slice emits a ConceptCard via the adapter (fail-first; passes only when concept branch is wired)", () => {
    const items = buildStorytellingFeedItems(
      [],
      [
        {
          name: "concept-restore-packet",
          missionId: "backlog",
          displayName: "Restore packet primitive",
          status: "draft",
          rawStatus: "candidate",
          description: "First-class restore packet so seats survive compaction.",
        },
      ],
    );
    const concepts = items.filter((i) => i.kind === "concept");
    expect(concepts).toHaveLength(1);
    if (concepts[0]!.kind === "concept") {
      expect(concepts[0]!.source.sliceId).toBe("concept-restore-packet");
      expect(concepts[0]!.source.title).toBe("Restore packet primitive");
      expect(concepts[0]!.source.oneLiner).toBe("First-class restore packet so seats survive compaction.");
    }
  });

  it("HG-1: rawStatus='Candidate' (mixed case) still emits ConceptCard", () => {
    const items = buildStorytellingFeedItems(
      [],
      [{ name: "c1", missionId: "backlog", displayName: "c1", status: "draft", rawStatus: "Candidate", description: "d" }],
    );
    expect(items.filter((i) => i.kind === "concept")).toHaveLength(1);
  });

  it("HG-2 graceful-empty: zero candidate rows → no concept items, no error, other kinds still render", () => {
    const items = buildStorytellingFeedItems(
      [{ name: "m1", path: "missions/m1" }],
      [
        { name: "s-shipped", status: "shipped" },
        { name: "s-blocked", status: "blocked" },
        // no rawStatus='candidate' row anywhere
      ],
      undefined,
      [makeApprovalFeedCard({ qitemId: "q1" })],
    );
    expect(items.filter((i) => i.kind === "concept")).toHaveLength(0);
    expect(items.filter((i) => i.kind === "progress")).toHaveLength(1);
    expect(items.filter((i) => i.kind === "shipped")).toHaveLength(1);
    expect(items.filter((i) => i.kind === "incident")).toHaveLength(1);
    expect(items.filter((i) => i.kind === "approval")).toHaveLength(1);
  });

  it("HG-4 cap: ConceptCard items capped at 2 per the curated-band rule", () => {
    const slices = Array.from({ length: 5 }).map((_, i) => ({
      name: `cand-${i}`,
      missionId: "backlog",
      displayName: `Candidate ${i}`,
      status: "draft" as const,
      rawStatus: "candidate",
      description: `desc-${i}`,
    }));
    const items = buildStorytellingFeedItems([], slices);
    expect(items.filter((i) => i.kind === "concept")).toHaveLength(2);
  });

  it("HG-5 no regression: candidate slices do NOT also emit shipped/incident items (concept routing is exclusive)", () => {
    const items = buildStorytellingFeedItems(
      [],
      [{ name: "c1", missionId: "backlog", displayName: "c1", status: "draft", rawStatus: "candidate", description: "d" }],
    );
    // Concept-routed rows must not double-count into shipped/incident.
    expect(items).toHaveLength(1);
    expect(items[0]!.kind).toBe("concept");
  });

  it("ConceptCardSource oneLiner falls back to a stable placeholder when description is missing (defense; PRD allows graceful)", () => {
    const items = buildStorytellingFeedItems(
      [],
      [{ name: "c1", missionId: "backlog", displayName: "c1", status: "draft", rawStatus: "candidate" }],
    );
    expect(items).toHaveLength(1);
    if (items[0]!.kind === "concept") {
      expect(typeof items[0]!.source.oneLiner).toBe("string");
      expect(items[0]!.source.oneLiner.length).toBeGreaterThan(0);
    }
  });

  // Guard BLOCKER qitem-20260518093643 — PRD Option A scopes the
  // ConceptCard source narrowly: missions/backlog/slices/<slug> with
  // `status: candidate`. A `status: candidate` row under any other
  // mission (or with missionId === null) must NOT emit a concept item;
  // it routes through the normal status-bucket path instead.
  it("BLOCKER fix: candidate slice under a NON-backlog mission emits zero ConceptCards (PRD Option A — backlog-only)", () => {
    const items = buildStorytellingFeedItems(
      [],
      [
        { name: "non-backlog-candidate", missionId: "release-0.3.2", displayName: "Non-backlog", status: "draft", rawStatus: "candidate", description: "shaped under release lane" },
      ],
    );
    expect(items.filter((i) => i.kind === "concept")).toHaveLength(0);
    // Falls through to status-bucket path; status="draft" routes to incident-info.
    expect(items.filter((i) => i.kind === "incident")).toHaveLength(1);
  });

  it("BLOCKER fix: candidate slice with missionId=null emits zero ConceptCards", () => {
    const items = buildStorytellingFeedItems(
      [],
      [
        { name: "orphan-candidate", missionId: null, displayName: "Orphan", status: "draft", rawStatus: "candidate", description: "shaped without mission" },
      ],
    );
    expect(items.filter((i) => i.kind === "concept")).toHaveLength(0);
  });

  it("BLOCKER fix: backlog candidate STILL emits exactly one ConceptCard (positive case preserved)", () => {
    const items = buildStorytellingFeedItems(
      [],
      [
        { name: "backlog-candidate", missionId: "backlog", displayName: "Backlog", status: "draft", rawStatus: "candidate", description: "shaped backlog item" },
      ],
    );
    expect(items.filter((i) => i.kind === "concept")).toHaveLength(1);
  });

  it("BLOCKER fix: mixed input — 2 backlog candidates + 2 non-backlog candidates → 2 ConceptCards (only backlog), non-backlog as incidents", () => {
    const items = buildStorytellingFeedItems(
      [],
      [
        { name: "b1", missionId: "backlog", displayName: "B1", status: "draft", rawStatus: "candidate", description: "d" },
        { name: "b2", missionId: "backlog", displayName: "B2", status: "draft", rawStatus: "candidate", description: "d" },
        { name: "x1", missionId: "release-0.3.2", displayName: "X1", status: "draft", rawStatus: "candidate", description: "d" },
        { name: "x2", missionId: null, displayName: "X2", status: "draft", rawStatus: "candidate", description: "d" },
      ],
    );
    expect(items.filter((i) => i.kind === "concept")).toHaveLength(2);
    // Non-backlog candidates fall through to incident (status: draft → info).
    expect(items.filter((i) => i.kind === "incident")).toHaveLength(2);
  });

  // Pure-helper unit test — the predicate is exported separately for
  // discrete pinning.
  it("isBacklogCandidateSlice predicate: backlog+candidate=true; everything else=false", async () => {
    const { isBacklogCandidateSlice } = await import("../src/components/feed/cards/storytelling-cards.js");
    expect(isBacklogCandidateSlice({ name: "x", missionId: "backlog", rawStatus: "candidate" })).toBe(true);
    expect(isBacklogCandidateSlice({ name: "x", missionId: "backlog", rawStatus: "Candidate" })).toBe(true);
    expect(isBacklogCandidateSlice({ name: "x", missionId: "release-0.3.2", rawStatus: "candidate" })).toBe(false);
    expect(isBacklogCandidateSlice({ name: "x", missionId: null, rawStatus: "candidate" })).toBe(false);
    expect(isBacklogCandidateSlice({ name: "x", missionId: "backlog", rawStatus: "shipped" })).toBe(false);
    expect(isBacklogCandidateSlice({ name: "x", missionId: "backlog", rawStatus: null })).toBe(false);
    expect(isBacklogCandidateSlice({ name: "x", missionId: "backlog" })).toBe(false);
  });

  it("falls back to FeedCard.id when payload has no qitemId/qitem_id key", () => {
    const card = makeApprovalFeedCard({ id: "queue.created-42" });
    const items = buildStorytellingFeedItems([], [], undefined, [card]);
    expect(items).toHaveLength(1);
    if (items[0]!.kind === "approval") {
      expect(items[0]!.source.qitemId).toBe("queue.created-42");
    }
  });

  // OPR.0.4.1.27 qa forward-fix — the preview band must reflect the
  // SUBSCRIPTION-FILTERED set, not the raw feed. The adapter renders an
  // approval preview iff its caller includes an approval card, so the caller
  // (Feed.tsx) MUST pass the level-filtered `cards`, not `rawCards`. These pin
  // both the bug and the fix at the caller-contract level.
  describe("preview follows the subscription-filtered set (level honesty)", () => {
    const needsYou: FeedSubscriptionState = {
      actionRequired: true,
      approvals: false,
      shipped: false,
      progress: false,
      auditLog: false,
    };
    const actionCard: FeedCard = {
      ...makeApprovalFeedCard({ qitemId: "act-1", title: "Your turn" }),
      kind: "action-required",
      id: "action-1",
    };
    const approvalCard = makeApprovalFeedCard({ qitemId: "ap-1", title: "Needs approval" });

    it("Needs-you (approvals OFF): the filtered set excludes approval, so the preview emits NO approval item; action-required survives", () => {
      const raw: FeedCard[] = [actionCard, approvalCard];
      // What Feed must pass to the adapter: the subscription-filtered set.
      const visible = raw.filter((c) => isCardKindSubscribed(c.kind, needsYou));
      expect(visible.some((c) => c.kind === "action-required")).toBe(true); // floor survives
      expect(visible.some((c) => c.kind === "approval")).toBe(false); // approval filtered out
      const items = buildStorytellingFeedItems([], [], undefined, visible);
      expect(items.some((i) => i.kind === "approval")).toBe(false);
    });

    it("documents the BUG: passing the RAW (unfiltered) set surfaces approval at Needs-you — the pre-fix wiring", () => {
      const raw: FeedCard[] = [actionCard, approvalCard];
      const items = buildStorytellingFeedItems([], [], undefined, raw);
      expect(items.some((i) => i.kind === "approval")).toBe(true);
    });
  });
});
