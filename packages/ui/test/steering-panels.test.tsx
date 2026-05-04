// Operator Surface Reconciliation v0 — steering panel render tests.
//
// Pins the load-bearing per-panel rendering for items 1A (priority
// stack) + 1B (roadmap rail) + 1D (lane rails). Items 1C (in-motion)
// + 1E (loop state) + 1F (health gates) are tested via the broader
// SteeringWorkspace surface test which mocks /api/* fetches.

import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { PriorityStackPanel } from "../src/components/steering/PriorityStackPanel.js";
import { RoadmapRailPanel } from "../src/components/steering/RoadmapRailPanel.js";
import { LaneRailsPanel } from "../src/components/steering/LaneRailsPanel.js";
import type { LaneRailPayload, PriorityStackPayload, RoadmapRailPayload } from "../src/hooks/useSteering.js";

afterEach(() => cleanup());

describe("OSR v0 — PriorityStackPanel", () => {
  it("renders STEERING.md content + last-modified timestamp", () => {
    const stack: PriorityStackPayload = {
      content: "# Priority Stack\n- Do X first\n- Avoid Y for now",
      absolutePath: "/abs/STEERING.md",
      mtime: "2026-05-04T12:00:00.000Z",
      byteCount: 100,
    };
    render(<PriorityStackPanel priorityStack={stack} />);
    expect(screen.getByTestId("steering-priority-stack")).toBeDefined();
    expect(screen.getByTestId("steering-priority-stack-mtime").textContent).toContain("2026-05-04");
    // MarkdownViewer renders the content. Since hideRawToggle is set,
    // toggle buttons are absent and the rendered block is visible.
    expect(screen.queryByTestId("markdown-viewer-mode-toggle")).toBeNull();
  });

  it("renders empty-state hint when priority stack is null", () => {
    render(<PriorityStackPanel priorityStack={null} />);
    expect(screen.getByTestId("steering-priority-stack-empty")).toBeDefined();
  });
});

describe("OSR v0 — RoadmapRailPanel", () => {
  it("renders empty-state hint when roadmap rail is null", () => {
    render(<RoadmapRailPanel roadmapRail={null} />);
    expect(screen.getByTestId("steering-roadmap-rail-empty")).toBeDefined();
  });

  it("renders rows with rail codes + done glyphs + next-pull marker on first unchecked", () => {
    const rail: RoadmapRailPayload = {
      absolutePath: "/abs/roadmap/PROGRESS.md",
      mtime: "2026-05-04T12:00:00.000Z",
      items: [
        { line: 1, text: "PL-005 Phase A done", done: true, railItemCode: "PL-005", isNextUnchecked: false },
        { line: 2, text: "PL-019 done", done: true, railItemCode: "PL-019", isNextUnchecked: false },
        { line: 3, text: "PL-022 next pull", done: false, railItemCode: "PL-022", isNextUnchecked: true },
        { line: 4, text: "PL-030 later", done: false, railItemCode: "PL-030", isNextUnchecked: false },
      ],
      counts: { total: 4, done: 2, nextUncheckedLine: 3 },
    };
    render(<RoadmapRailPanel roadmapRail={rail} />);
    expect(screen.getByTestId("steering-roadmap-item-1").getAttribute("data-rail-code")).toBe("PL-005");
    expect(screen.getByTestId("steering-roadmap-item-3").getAttribute("data-is-next-unchecked")).toBe("true");
    expect(screen.getByTestId("steering-roadmap-next-marker-3")).toBeDefined();
    // No marker on item 4 (later, not next).
    expect(screen.queryByTestId("steering-roadmap-next-marker-4")).toBeNull();
    expect(screen.getByTestId("steering-roadmap-rail-counts").textContent).toContain("2 / 4 done");
  });

  it("renders 'No checkbox rows' when roadmap is empty", () => {
    const empty: RoadmapRailPayload = {
      absolutePath: "/abs/roadmap/PROGRESS.md",
      mtime: "2026-05-04T12:00:00.000Z",
      items: [],
      counts: { total: 0, done: 0, nextUncheckedLine: null },
    };
    render(<RoadmapRailPanel roadmapRail={empty} />);
    expect(screen.getByTestId("steering-roadmap-rail")).toBeDefined();
    expect(screen.getByText(/No checkbox rows/i)).toBeDefined();
  });
});

describe("OSR v0 — LaneRailsPanel", () => {
  it("renders empty-state hint when laneRails is empty", () => {
    render(<LaneRailsPanel laneRails={[]} />);
    expect(screen.getByTestId("steering-lane-rails-empty")).toBeDefined();
  });

  it("renders one section per lane with health badges + top items + next-pull marker", () => {
    const lanes: LaneRailPayload[] = [
      {
        laneId: "mode-2",
        absolutePath: "/abs/delivery-ready/mode-2/PROGRESS.md",
        mtime: "2026-05-04T12:00:00.000Z",
        topItems: [
          { line: 5, text: "blocked one", status: "blocked", isNextPull: false },
          { line: 6, text: "the next pull", status: "active", isNextPull: true },
          { line: 7, text: "later one", status: "active", isNextPull: false },
        ],
        healthBadges: { active: 2, blocked: 1, done: 5, total: 8 },
        nextPullLine: 6,
      },
      {
        laneId: "mode-3",
        absolutePath: "/abs/delivery-ready/mode-3/PROGRESS.md",
        mtime: "2026-05-04T12:00:00.000Z",
        topItems: [],
        healthBadges: { active: 0, blocked: 0, done: 4, total: 4 },
        nextPullLine: null,
      },
    ];
    render(<LaneRailsPanel laneRails={lanes} />);
    expect(screen.getByTestId("steering-lane-mode-2")).toBeDefined();
    expect(screen.getByTestId("steering-lane-mode-3")).toBeDefined();
    expect(screen.getByTestId("steering-lane-row-6-next-pull")).toBeDefined();
    expect(screen.queryByTestId("steering-lane-row-5-next-pull")).toBeNull();
    expect(screen.getByText(/No checkbox rows/i)).toBeDefined();
  });

  it("health badges render the count + variant class for each (active/blocked/done)", () => {
    const lanes: LaneRailPayload[] = [{
      laneId: "mode-2",
      absolutePath: "/abs/x",
      mtime: "2026-05-04T12:00:00.000Z",
      topItems: [],
      healthBadges: { active: 3, blocked: 1, done: 5, total: 9 },
      nextPullLine: null,
    }];
    render(<LaneRailsPanel laneRails={lanes} />);
    const badges = screen.getAllByTestId(/^steering-lane-badge-/);
    const labels = badges.map((b) => b.textContent ?? "");
    expect(labels.some((t) => t.includes("active") && t.includes("3"))).toBe(true);
    expect(labels.some((t) => t.includes("blocked") && t.includes("1"))).toBe(true);
    expect(labels.some((t) => t.includes("done") && t.includes("5"))).toBe(true);
  });
});
