// @vitest-environment jsdom

// Flagship attempt-0003 — four presentation defects observed firsthand on
// the compliant real-scale control. These tests deliberately exercise the
// real Review components; only network/router/terminal boundaries are stubbed.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentRow, ComposedMissionReview, ComposedSliceReview } from "../src/hooks/useReview.js";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...rest }: { children?: React.ReactNode; to?: string }) => (
    <a href={to ?? "#"} {...(rest as Record<string, unknown>)}>{children}</a>
  ),
}));
vi.mock("../src/components/terminal/ProgressiveTerminal.js", () => ({ ProgressiveTerminal: () => null }));
vi.mock("../src/components/review/TranscriptDrillPanel.js", () => ({ TranscriptDrillPanel: () => null }));

const sliceState: { data: ComposedSliceReview | null } = { data: null };
const missionState: { data: ComposedMissionReview | null } = { data: null };
vi.mock("../src/hooks/useReview.js", () => ({
  useSliceReview: () => ({ isLoading: false, isError: false, data: sliceState.data, error: null }),
  useMissionReview: () => ({ isLoading: false, isError: false, data: missionState.data, error: null }),
  useInvalidateReview: () => () => {},
}));
vi.mock("../src/hooks/useScopeMarkdown.js", () => ({
  useScopeMarkdown: () => ({ resolved: null, isLoading: false }),
}));

import { MissionReviewTab } from "../src/components/review/MissionReviewTab.js";
import { SliceReviewTab } from "../src/components/review/SliceReviewTab.js";

afterEach(() => {
  cleanup();
  sliceState.data = null;
  missionState.data = null;
});

function withQuery(node: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

function agents(count: number): AgentRow[] {
  return Array.from({ length: count }, (_, i) => ({
    agentName: `Agent ${i + 1}`,
    runtime: "codex",
    stateGlyph: "unknown",
    doing: `owns item ${i + 1}`,
    holdsCount: 1,
    lastTransitionIso: null,
    exception: null,
    sessionName: `agent-${i + 1}@rig`,
    slices: ["04-review-tab-observability"],
  }));
}

function missionReview(over: Partial<ComposedMissionReview> = {}): ComposedMissionReview {
  return {
    mission: "release-0.4.7",
    missionId: "OPR.0.4.7",
    title: "Release 0.4.7",
    intent: "Ship a professional Review surface.",
    briefSpine: {
      building: "BUILDING machine dump",
      progress: "PROGRESS machine dump",
      proven: "PROVEN machine dump",
      needsYou: "NEEDS YOU machine dump",
    },
    board: [],
    ledger: [],
    cutComplete: false,
    cutCompleteBasis: "not complete",
    needsYou: { items: [], provenance: "none" },
    agents: { scope: "mission:release-0.4.7", rows: [], provenance: "queue scoped", coordinationHealth: null },
    composedAt: "2026-07-22T07:00:00.000Z",
    ...over,
  } as ComposedMissionReview;
}

function sliceReview(over: Partial<ComposedSliceReview> = {}): ComposedSliceReview {
  return {
    slice: "04-review-tab-observability",
    sliceId: "OPR.0.4.7.4",
    title: "Review tab observability",
    missionId: "OPR.0.4.7",
    phase: "locked",
    laneLabel: "LOCKED",
    intent: { text: "Intent", media: [], ssotPath: null, degrade: null },
    plan: { concise: { text: "1. Plan", media: [] }, lockedArtifacts: [], lock: null, ssotPath: null },
    delivered: { items: [], extraProof: [], lock: null, proofDirPath: null },
    needsYou: { items: [], provenance: "none" },
    agents: { scope: "slice:04-review-tab-observability", rows: [], provenance: "none", coordinationHealth: null },
    lineage: { candidateSha: "e103d470", mergeSha: null, mainTip: "e103d470", freshness: "fresh", staleBehind: 0, gateCells: [] },
    defects: [],
    composedAt: "2026-07-22T07:00:00.000Z",
    ...over,
  } as ComposedSliceReview;
}

describe("flagship attempt-0003 Review polish", () => {
  it("R1 removes the duplicate generated Brief Spine while preserving the structured board and ledger", () => {
    missionState.data = missionReview();
    render(withQuery(<MissionReviewTab missionId="release-0.4.7" />));

    expect(screen.queryByTestId("brief-spine")).toBeNull();
    expect(screen.getByTestId("mission-board")).toBeTruthy();
    expect(screen.getByTestId("mission-ledger")).toBeTruthy();
  });

  it("R2 removes the orphan lane/composed debug line while lock and status truth remain in their designed regions", () => {
    sliceState.data = sliceReview();
    render(withQuery(<SliceReviewTab sliceName="04-review-tab-observability" slicePath={null} />));

    expect(screen.queryByText("lane LOCKED · composed 2026-07-22T07:00:00.000Z")).toBeNull();
  });

  it("R3 renders honest artifact-only evidence for a verified item instead of contradicting it", () => {
    sliceState.data = sliceReview({
      delivered: {
        items: [{
          promised: { text: "The six accepted outcomes are recorded." },
          proof: [],
          verified: "verified",
          note: "qa-PASS-attempt-0002.md records the comparison.",
        }],
        extraProof: [],
        lock: null,
        proofDirPath: null,
      },
    });
    render(withQuery(<SliceReviewTab sliceName="04-review-tab-observability" slicePath={null} />));
    fireEvent.click(screen.getByTestId("delivered-item-0"));
    const open = screen.getByTestId("delivered-item-open-0");

    expect(within(open).getByText(/verified by artifact; no media attached/i)).toBeTruthy();
    expect(open.textContent).toContain("qa-PASS-attempt-0002.md records the comparison.");
    expect(open.textContent).not.toMatch(/nothing delivered/i);
  });

  // slice-04 REV6 (qitem-20260722121455-3f43040c) — render honesty. Per
  // composeDelivered, `unverified` = covering.length>0 with NO PASSING recorded
  // comparison, so an artifact was DELIVERED even when proof=[] and note is absent.
  // The expanded fallback must read "artifact recorded / no media", NEVER "nothing
  // delivered" (only `missing` keeps that phrase); and the unverified BADGE must say
  // "no PASSING QA comparison", not "no recorded QA comparison" (a non-passing
  // comparison may exist and produce the note).
  const deliveredUnverified = (note?: string) => ({
    delivered: {
      items: [{ promised: { text: "Blocked outcome" }, proof: [], verified: "unverified" as const, ...(note ? { note } : {}) }],
      extraProof: [], lock: null, proofDirPath: null,
    },
  });

  it("REV6 RED: unverified + real non-passing note renders artifact-recorded/no-media (never 'nothing delivered'), keeps the note, badge says no PASSING comparison", () => {
    sliceState.data = sliceReview(deliveredUnverified("The comparison was kicked back; remediation is required."));
    render(withQuery(<SliceReviewTab sliceName="04-review-tab-observability" slicePath={null} />));
    fireEvent.click(screen.getByTestId("delivered-item-0"));
    const open = screen.getByTestId("delivered-item-open-0");
    expect(open.textContent).toMatch(/artifact recorded/i);
    expect(open.textContent).toMatch(/no media/i);
    expect(open.textContent).not.toMatch(/nothing delivered/i);
    expect(open.textContent).toContain("The comparison was kicked back; remediation is required.");
    const badge = screen.getByTestId("delivered-item-0").textContent ?? "";
    expect(badge).toMatch(/no passing QA comparison/i);
    expect(badge).not.toMatch(/no recorded QA comparison/i);
  });

  it("REV6 RED: unverified with NO note still renders artifact-recorded/no-media, never 'nothing delivered'", () => {
    sliceState.data = sliceReview(deliveredUnverified());
    render(withQuery(<SliceReviewTab sliceName="04-review-tab-observability" slicePath={null} />));
    fireEvent.click(screen.getByTestId("delivered-item-0"));
    const open = screen.getByTestId("delivered-item-open-0");
    expect(open.textContent).toMatch(/artifact recorded/i);
    expect(open.textContent).toMatch(/no media/i);
    expect(open.textContent).not.toMatch(/nothing delivered/i);
  });

  it("REV6 pin (GREEN): `missing` proof=[] is the ONLY 'nothing delivered' branch (not artifact-recorded)", () => {
    sliceState.data = sliceReview({
      delivered: { items: [{ promised: { text: "Promised but absent" }, proof: [], verified: "missing" as const }], extraProof: [], lock: null, proofDirPath: null },
    });
    render(withQuery(<SliceReviewTab sliceName="04-review-tab-observability" slicePath={null} />));
    fireEvent.click(screen.getByTestId("delivered-item-0"));
    const open = screen.getByTestId("delivered-item-open-0");
    expect(open.textContent).toMatch(/nothing delivered/i);
    expect(open.textContent).not.toMatch(/artifact recorded/i);
  });

  it("R4 keeps six owners visible and owns the all-agents action inside the shared footer", () => {
    missionState.data = missionReview({
      agents: {
        scope: "mission:release-0.4.7",
        rows: agents(18),
        provenance: "18 queue-scoped agents",
        coordinationHealth: null,
      },
    });
    render(withQuery(<MissionReviewTab missionId="release-0.4.7" />));
    const band = screen.getByTestId("agents-band");
    const visible = within(band).getByTestId("agents-visible");
    const overflow = within(band).getByTestId("agents-overflow");

    expect(within(visible).getAllByTestId(/^agent-drill-/)).toHaveLength(6);
    expect(within(overflow).getAllByTestId(/^agent-drill-/)).toHaveLength(12);
    expect(within(overflow).getByText("+12 more queue-scoped agents")).toBeTruthy();
    expect(overflow.hasAttribute("open")).toBe(false);
    const footer = within(band).getByTestId("agents-footer");
    expect(footer.textContent).toContain("18 queue-scoped agents");
    expect(within(footer).getByRole("link", { name: /all agents/i }).getAttribute("href")).toBe("/agents");
    expect(screen.getByTestId("mission-agents-preview").lastElementChild).toBe(band);
  });

  it("R5 composes nonempty phase lanes as vellum cards and compresses all empty lanes into one line", () => {
    missionState.data = missionReview({
      board: [
        {
          slice: "01-foundation",
          title: "Foundation",
          phase: "planned",
          laneLabel: "PLAN",
          agentsCount: 2,
          stageCell: "planned",
          changedSinceStamp: false,
          attentionWorthy: false,
        },
        {
          slice: "04-review-tab-observability",
          title: "Review tab observability",
          phase: "locked",
          laneLabel: "LOCKED",
          agentsCount: 3,
          stageCell: "locked",
          changedSinceStamp: false,
          attentionWorthy: false,
        },
      ],
    });
    render(withQuery(<MissionReviewTab missionId="release-0.4.7" />));

    const plan = screen.getByTestId("board-lane-card-PLAN");
    expect(plan.className).toContain("backdrop-blur");
    const planHeader = within(plan).getByTestId("board-lane-header-PLAN");
    expect(within(planHeader).getByText("PLAN")).toBeTruthy();
    expect(within(planHeader).getByText("1")).toBeTruthy();
    const locked = screen.getByTestId("board-lane-card-LOCKED");
    const lockedHeader = within(locked).getByTestId("board-lane-header-LOCKED");
    expect(within(lockedHeader).getByText("LOCKED")).toBeTruthy();
    expect(within(lockedHeader).getByText("1")).toBeTruthy();
    expect(screen.getByTestId("board-empty-lanes").textContent).toBe("INTENT 0 · BUILD 0 · REVIEW 0");
  });

  it("R6 gives SETTLED a vellum card header with cut status inside its hierarchy", () => {
    missionState.data = missionReview({
      ledger: [{
        slice: "04-review-tab-observability",
        candidateSha: "85e67f0",
        gateCells: [],
        mergeSha: null,
        needsHumanCount: 0,
        green: true,
      }],
      cutComplete: true,
      cutCompleteBasis: "all slices settled",
    });
    render(withQuery(<MissionReviewTab missionId="release-0.4.7" />));

    const ledger = screen.getByTestId("mission-ledger");
    expect(ledger.className).toContain("backdrop-blur");
    const header = within(ledger).getByTestId("ledger-header");
    expect(header.textContent).toContain("SETTLED");
    expect(header.textContent).toContain("completion ledger");
    expect(within(header).getByTestId("cut-complete").textContent).toContain("cut-gating COMPLETE");
  });
});
