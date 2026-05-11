import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { createTestRouter } from "./helpers/test-router.js";
import {
  ProgressCard,
  buildStorytellingFeedItems,
  type ProgressCardSource,
} from "../src/components/feed/cards/storytelling-cards.js";

interface MissionRow {
  name: string;
  path: string;
  status?: string | null;
}
interface SliceRow {
  name: string;
  missionId?: string | null;
  displayName?: string;
  status?: string;
  lastActivityAt?: string;
}

afterEach(() => {
  cleanup();
});

const baseSource: ProgressCardSource = {
  missionId: "getting-started",
  title: "Getting Started",
  oneLiner: "First mission.",
  percent: 0,
};

function renderProgressCard(props: Parameters<typeof ProgressCard>[0]) {
  // ProgressCard uses no router primitives directly; render plain.
  return render(<ProgressCard {...props} />);
}

describe("ProgressCard — Mark complete action (slice 18 Checkpoint E)", () => {
  it("does NOT render Mark complete button when onMarkComplete is omitted", () => {
    renderProgressCard({ source: baseSource });
    expect(screen.queryByTestId("progress-card-mark-complete")).toBeNull();
  });

  it("renders Mark complete button when onMarkComplete is provided", () => {
    renderProgressCard({ source: baseSource, onMarkComplete: () => {} });
    expect(screen.getByTestId("progress-card-mark-complete")).toBeTruthy();
  });

  it("clicking Mark complete calls onMarkComplete with the missionId", () => {
    const onMarkComplete = vi.fn();
    renderProgressCard({ source: baseSource, onMarkComplete });
    fireEvent.click(screen.getByTestId("progress-card-mark-complete"));
    expect(onMarkComplete).toHaveBeenCalledWith("getting-started");
  });
});

describe("buildStorytellingFeedItems — filter completed missions (slice 18 Checkpoint E)", () => {
  const missions: MissionRow[] = [
    { name: "getting-started", path: "/missions/getting-started" },
    { name: "release-0-3-1", path: "/missions/release-0-3-1" },
  ];
  const slices: SliceRow[] = [];

  it("returns progress items for missions when no completed set is provided (back-compat)", () => {
    const items = buildStorytellingFeedItems(missions, slices);
    const progressItems = items.filter((i) => i.kind === "progress");
    expect(progressItems).toHaveLength(2);
  });

  it("filters out missions whose ids are in the completed set", () => {
    const completed = new Set(["getting-started"]);
    const items = buildStorytellingFeedItems(missions, slices, completed);
    const progressItems = items.filter((i) => i.kind === "progress");
    expect(progressItems).toHaveLength(1);
    expect((progressItems[0] as { source: ProgressCardSource }).source.missionId).toBe(
      "release-0-3-1",
    );
  });

  it("returns zero progress items when ALL missions are completed", () => {
    const completed = new Set(["getting-started", "release-0-3-1"]);
    const items = buildStorytellingFeedItems(missions, slices, completed);
    expect(items.filter((i) => i.kind === "progress")).toHaveLength(0);
  });

  it("empty completed set behaves identically to no completed set", () => {
    const items = buildStorytellingFeedItems(missions, slices, new Set());
    expect(items.filter((i) => i.kind === "progress")).toHaveLength(2);
  });

  // velocity-guard 18.E BLOCKING-CONCERN repair (Blocker 2):
  // PRD T8 requires status: complete frontmatter to hide the mission
  // durably (survives localStorage reset). buildStorytellingFeedItems
  // now filters on m.status === "complete" in addition to the local set.
  describe("durable status-backed filter (slice 18.E repair)", () => {
    it("filters out missions with status === 'complete' even when localStorage is empty", () => {
      const withStatus: MissionRow[] = [
        { name: "getting-started", path: "/m/getting-started", status: "complete" },
        { name: "release-0-3-1", path: "/m/release-0-3-1", status: "active" },
      ];
      const items = buildStorytellingFeedItems(withStatus, slices);
      const progressItems = items.filter((i) => i.kind === "progress");
      expect(progressItems).toHaveLength(1);
      expect(
        (progressItems[0] as { source: { missionId: string } }).source.missionId,
      ).toBe("release-0-3-1");
    });

    it("missions with status: 'active' / 'draft' / null / undefined ARE NOT filtered", () => {
      const mixed: MissionRow[] = [
        { name: "active-mission", path: "/m/active", status: "active" },
        { name: "draft-mission", path: "/m/draft", status: "draft" },
      ];
      const items = buildStorytellingFeedItems(mixed, slices);
      expect(items.filter((i) => i.kind === "progress")).toHaveLength(2);
    });

    it("status === 'complete' filter applies even when missionId is NOT in the local completedMissionIds set", () => {
      // Survives localStorage clear: status: complete alone is enough to hide.
      const withStatus: MissionRow[] = [
        { name: "getting-started", path: "/m/getting-started", status: "complete" },
      ];
      const items = buildStorytellingFeedItems(withStatus, slices, new Set());
      expect(items.filter((i) => i.kind === "progress")).toHaveLength(0);
    });

    it("BOTH filters (status: complete AND localStorage set) compose correctly", () => {
      const missions3: MissionRow[] = [
        { name: "m1", path: "/m/1", status: "complete" },
        { name: "m2", path: "/m/2", status: "active" },
        { name: "m3", path: "/m/3", status: "active" },
      ];
      const localCompleted = new Set(["m2"]);
      const items = buildStorytellingFeedItems(missions3, slices, localCompleted);
      const progressItems = items.filter((i) => i.kind === "progress");
      expect(progressItems).toHaveLength(1);
      expect(
        (progressItems[0] as { source: { missionId: string } }).source.missionId,
      ).toBe("m3");
    });

    it("filters slice-derived cards from missions with status === 'complete'", () => {
      const withStatus: MissionRow[] = [
        { name: "getting-started", path: "/m/getting-started", status: "complete" },
        { name: "release-0-3-1", path: "/m/release-0-3-1", status: "active" },
      ];
      const slicesWithMissions: SliceRow[] = [
        {
          name: "first-conveyor-run",
          missionId: "getting-started",
          displayName: "First Conveyor Run",
          status: "blocked",
        },
        {
          name: "slice-16-typography",
          missionId: "release-0-3-1",
          displayName: "Slice 16 Typography",
          status: "done",
        },
      ];

      const items = buildStorytellingFeedItems(withStatus, slicesWithMissions);

      expect(items).not.toContainEqual(
        expect.objectContaining({
          source: expect.objectContaining({ sliceId: "first-conveyor-run" }),
        }),
      );
      expect(items).toContainEqual(
        expect.objectContaining({
          source: expect.objectContaining({ sliceId: "slice-16-typography" }),
        }),
      );
    });

    it("filters slice-derived cards from locally completed missions before durable status loads", () => {
      const activeMissions: MissionRow[] = [
        { name: "getting-started", path: "/m/getting-started", status: "active" },
        { name: "release-0-3-1", path: "/m/release-0-3-1", status: "active" },
      ];
      const slicesWithMissions: SliceRow[] = [
        { name: "intro", missionId: "getting-started", status: "active" },
        { name: "ship", missionId: "release-0-3-1", status: "shipped" },
      ];

      const items = buildStorytellingFeedItems(
        activeMissions,
        slicesWithMissions,
        new Set(["getting-started"]),
      );

      expect(items).not.toContainEqual(
        expect.objectContaining({
          source: expect.objectContaining({ sliceId: "intro" }),
        }),
      );
      expect(items).toContainEqual(
        expect.objectContaining({
          source: expect.objectContaining({ sliceId: "ship" }),
        }),
      );
    });
  });
});
