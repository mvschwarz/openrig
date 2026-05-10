// 0.3.1 slice 06 — For You storytelling card primitives test surface.
// Covers IMPL-PRD HG-6 (5 card primitives ship), HG-7 (drill-in
// routing), HG-8 (mobile-first; ≥44px touch targets). Visual proof
// per phone-viewport is the design-reviewer's gate; this suite gates
// the structural shape (testid surface, collapsed-vs-expanded
// behavior, drill-in href shape, touch-target sizing).

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/react";
import {
  ShippedCard,
  IncidentCard,
  ProgressCard,
  ApprovalCard,
  ConceptCard,
  StorytellingFeed,
  type FeedCardItem,
} from "../src/components/feed/cards/storytelling-cards.js";

afterEach(cleanup);

describe("HG-6 — 5 card primitives ship", () => {
  it("ShippedCard renders collapsed; tap toggles inline-expanded preview", () => {
    const { container, getByTestId } = render(
      <ShippedCard source={{
        sliceId: "s1",
        title: "Plugin primitive shipped",
        oneLiner: "Plugin support landed across G-Stack and Obra Superpowers.",
        sections: [
          { number: 1, heading: "DESIGN landed", summary: "DESIGN.md authored" },
          { number: 2, heading: "Forensic research", summary: "Codex plugin confirmation" },
          { number: 3, heading: "Implementation", summary: "Plugin tree authored" },
        ],
      }} />
    );
    expect(getByTestId("feed-card-shipped-s1-title").textContent).toContain("Plugin primitive shipped");
    expect(container.querySelector("[data-testid='feed-card-shipped-s1-expanded']")).toBeNull();
    fireEvent.click(getByTestId("feed-card-shipped-s1-toggle"));
    expect(getByTestId("feed-card-shipped-s1-expanded")).toBeTruthy();
    expect(getByTestId("feed-card-shipped-s1-section-1").textContent).toContain("DESIGN landed");
  });

  it("IncidentCard exposes a status dot + recent timeline entries when inline-expanded", () => {
    const { getByTestId } = render(
      <IncidentCard source={{
        sliceId: "s2",
        title: "Plugin primitive narrative",
        oneLiner: "Mission narrative in flight",
        status: "warning",
        recentEntries: [
          { time: "14:02", title: "DESIGN landed", status: "success" },
          { time: "16:30", title: "Hooks pivot", status: "warning" },
        ],
      }} />
    );
    expect(getByTestId("feed-card-incident-s2-dot")).toBeTruthy();
    fireEvent.click(getByTestId("feed-card-incident-s2-toggle"));
    expect(getByTestId("feed-card-incident-s2-entry-0").textContent).toContain("DESIGN landed");
    expect(getByTestId("feed-card-incident-s2-entry-1").textContent).toContain("Hooks pivot");
  });

  it("ProgressCard exposes an active-slice preview when inline-expanded", () => {
    const { getByTestId } = render(
      <ProgressCard source={{
        missionId: "m1",
        title: "Release 0.3.1",
        oneLiner: "10 slices in flight",
        percent: 60,
        activeSlice: { id: "06", label: "06-storytelling-primitives", status: "in-flight" },
      }} />
    );
    fireEvent.click(getByTestId("feed-card-progress-m1-toggle"));
    expect(getByTestId("feed-card-progress-m1-active-slice").textContent).toContain("06-storytelling-primitives");
  });

  it("ApprovalCard surfaces approve/deny inline actions on the collapsed view", () => {
    const onApprove = vi.fn();
    const onDeny = vi.fn();
    const { getByTestId } = render(
      <ApprovalCard source={{
        qitemId: "q1",
        title: "Approve plugin pack install?",
        oneLiner: "G-Stack pack requested by user",
        bodyPreview: "Body preview content here",
        onApprove,
        onDeny,
        drillInHref: "/queue/q1",
      }} />
    );
    fireEvent.click(getByTestId("feed-card-approval-q1-approve"));
    fireEvent.click(getByTestId("feed-card-approval-q1-deny"));
    expect(onApprove).toHaveBeenCalledOnce();
    expect(onDeny).toHaveBeenCalledOnce();
  });

  it("ConceptCard surfaces a compare-preview table when inline-expanded", () => {
    const { getByTestId } = render(
      <ConceptCard source={{
        sliceId: "s3",
        title: "Storytelling primitives",
        oneLiner: "Markdown-first rich rendering",
        comparePreview: [
          { label: "Editability", valueOld: "HTML editor", valueNew: "Any text editor" },
          { label: "Diffability", valueOld: "Hard", valueNew: "Trivial" },
        ],
      }} />
    );
    fireEvent.click(getByTestId("feed-card-concept-s3-toggle"));
    expect(getByTestId("feed-card-concept-s3-expanded").textContent).toContain("Editability");
    expect(getByTestId("feed-card-concept-s3-expanded").textContent).toContain("Trivial");
  });
});

describe("HG-7 — card drill-in routes correctly", () => {
  it("ShippedCard drill-in points at /project/slice/<id>", () => {
    const { getByTestId } = render(
      <ShippedCard source={{ sliceId: "abc", title: "x", oneLiner: "y" }} />
    );
    fireEvent.click(getByTestId("feed-card-shipped-abc-toggle"));
    expect(getByTestId("feed-card-shipped-abc-drill-in").getAttribute("href")).toBe("/project/slice/abc");
  });

  it("ProgressCard drill-in points at /project/mission/<id>", () => {
    const { getByTestId } = render(
      <ProgressCard source={{ missionId: "release-0.3.1", title: "x", oneLiner: "y", percent: 50 }} />
    );
    fireEvent.click(getByTestId("feed-card-progress-release-0.3.1-toggle"));
    expect(getByTestId("feed-card-progress-release-0.3.1-drill-in").getAttribute("href")).toBe("/project/mission/release-0.3.1");
  });

  it("ApprovalCard drill-in honors the source-provided href (queue detail or slice)", () => {
    const { getByTestId } = render(
      <ApprovalCard source={{ qitemId: "q9", title: "x", oneLiner: "y", drillInHref: "/queue/q9" }} />
    );
    fireEvent.click(getByTestId("feed-card-approval-q9-toggle"));
    expect(getByTestId("feed-card-approval-q9-drill-in").getAttribute("href")).toBe("/queue/q9");
  });
});

describe("HG-8 — mobile-first touch targets", () => {
  it("inline action buttons (approve/deny) carry min-h-[44px] for ≥44px tap targets", () => {
    const { getByTestId } = render(
      <ApprovalCard source={{ qitemId: "q1", title: "x", oneLiner: "y", onApprove: () => {}, onDeny: () => {} }} />
    );
    expect(getByTestId("feed-card-approval-q1-approve").className).toMatch(/min-h-\[44px\]/);
    expect(getByTestId("feed-card-approval-q1-deny").className).toMatch(/min-h-\[44px\]/);
  });

  it("drill-in CTA carries min-h-[44px] for ≥44px tap target", () => {
    const { getByTestId } = render(
      <ShippedCard source={{ sliceId: "s", title: "x", oneLiner: "y" }} />
    );
    fireEvent.click(getByTestId("feed-card-shipped-s-toggle"));
    expect(getByTestId("feed-card-shipped-s-drill-in").className).toMatch(/min-h-\[44px\]/);
  });

  it("collapsed card surface carries min-h-[80px] for the IMPL-PRD §6 ~80px height target", () => {
    const { getByTestId } = render(
      <ShippedCard source={{ sliceId: "s", title: "x", oneLiner: "y" }} />
    );
    expect(getByTestId("feed-card-shipped-s-toggle").className).toMatch(/min-h-\[80px\]/);
  });
});

describe("StorytellingFeed — composition", () => {
  it("composes a vertical stack of cards from a mixed-kind item list", () => {
    const items: FeedCardItem[] = [
      { kind: "shipped",  source: { sliceId: "a", title: "A", oneLiner: "x" } },
      { kind: "incident", source: { sliceId: "b", title: "B", oneLiner: "x", status: "info" } },
      { kind: "progress", source: { missionId: "m", title: "M", oneLiner: "x", percent: 50 } },
    ];
    const { getByTestId, container } = render(<StorytellingFeed items={items} />);
    expect(getByTestId("storytelling-feed")).toBeTruthy();
    expect(container.querySelectorAll("[data-testid^='feed-card-']").length).toBeGreaterThanOrEqual(3);
  });

  it("renders an empty-state when there are no items", () => {
    const { getByTestId } = render(<StorytellingFeed items={[]} />);
    expect(getByTestId("storytelling-feed-empty").textContent).toContain("No items");
  });
});
