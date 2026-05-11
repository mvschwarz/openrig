// 0.3.1 slice 06 forward-fix #2 — pure-logic test for the Feed.tsx
// adapter that converts daemon-driven mission + slice rows into
// FeedCardItem[]. Proves ProgressCard is routed for missions
// (closing the prior "ProgressCard never mounted in production"
// finding) and that slice status routing dispatches to the right
// card type without mounting Feed.tsx itself.

import { describe, it, expect } from "vitest";
import { buildStorytellingFeedItems } from "../src/components/feed/cards/storytelling-cards.js";

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
});
