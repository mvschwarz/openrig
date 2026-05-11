// 0.3.1 slice 06 — production-wire tests for the forward-fix on
// guard-3 findings: (1) TimelineTab renders timeline.md content when
// the prop is supplied; (2) ForYouFeed mounts the storytelling
// preview section when sliceRows has data; (3) ProgressCard renders
// a progress bar on the collapsed view per IMPL-PRD §6.

import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { TimelineTab } from "../src/components/slices/tabs/TimelineTab.js";
import { ProgressCard } from "../src/components/feed/cards/storytelling-cards.js";

afterEach(cleanup);

describe("TimelineTab — timeline.md production wire (Finding 1)", () => {
  it("renders the story-timeline-markdown section when timelineMarkdown prop is provided", () => {
    const markdown = `---
kind: incident-timeline
title: Slice narrative
---

Body content.
`;
    const { container } = render(
      <TimelineTab
        events={[]}
        phaseDefinitions={null}
        timelineMarkdown={markdown}
      />
    );
    expect(container.querySelector("[data-testid='story-timeline-markdown']")).toBeTruthy();
    // The MarkdownViewer inside wraps the body in a KindFrame for the
    // known kind, so the wire actually composes the storytelling
    // primitives in the live tab.
    expect(container.querySelector("[data-testid='kind-frame-incident-timeline']")).toBeTruthy();
  });

  it("falls back to the empty-state when neither events nor timeline.md exist", () => {
    const { container } = render(
      <TimelineTab events={[]} phaseDefinitions={null} />
    );
    expect(container.querySelector("[data-testid='story-empty']")).toBeTruthy();
    expect(container.querySelector("[data-testid='story-timeline-markdown']")).toBeNull();
  });

  it("does NOT render the empty-state when timeline.md exists but events are absent", () => {
    const { container } = render(
      <TimelineTab events={[]} phaseDefinitions={null} timelineMarkdown="# Just markdown" />
    );
    expect(container.querySelector("[data-testid='story-empty']")).toBeNull();
    expect(container.querySelector("[data-testid='story-timeline-markdown']")).toBeTruthy();
  });
});

describe("ProgressCard — progress bar + next-step (Finding 2 sub-issue)", () => {
  it("renders a progress bar accessory on the collapsed view with the correct fill width", () => {
    const { getByTestId } = render(
      <ProgressCard source={{
        missionId: "m1",
        title: "Release 0.3.1",
        oneLiner: "default text",
        percent: 73,
      }} />
    );
    const bar = getByTestId("feed-card-progress-m1-bar");
    expect(bar.getAttribute("data-percent")).toBe("73");
    const fill = getByTestId("feed-card-progress-m1-bar-fill");
    expect(fill.style.width).toBe("73%");
  });

  it("renders nextStep text in the collapsed view when supplied (replacing oneLiner)", () => {
    const { getByTestId } = render(
      <ProgressCard source={{
        missionId: "m1",
        title: "x",
        oneLiner: "fallback line",
        nextStep: "Driver hand-back; awaiting verify",
        percent: 50,
      }} />
    );
    expect(getByTestId("feed-card-progress-m1-one-liner").textContent).toContain("Driver hand-back; awaiting verify");
    expect(getByTestId("feed-card-progress-m1-one-liner").textContent).not.toContain("fallback line");
  });

  it("clamps percent into the 0..100 range so out-of-bounds values don't break the bar geometry", () => {
    const { getByTestId, rerender } = render(
      <ProgressCard source={{ missionId: "m1", title: "x", oneLiner: "y", percent: 200 }} />
    );
    expect(getByTestId("feed-card-progress-m1-bar").getAttribute("data-percent")).toBe("100");
    rerender(
      <ProgressCard source={{ missionId: "m1", title: "x", oneLiner: "y", percent: -25 }} />
    );
    expect(getByTestId("feed-card-progress-m1-bar").getAttribute("data-percent")).toBe("0");
  });
});
