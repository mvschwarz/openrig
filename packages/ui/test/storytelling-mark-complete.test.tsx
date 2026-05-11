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
}
interface SliceRow {
  name: string;
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
});
