// @vitest-environment jsdom

// slice-04 REV6 regression (qitem-20260722111916-e2575404) — the nested Approve
// controls (mission BOARD row + slice NEEDS YOU) must POST the missions-root-
// RELATIVE scopePath `<mission>/slices/<slice>` to /api/scope/approve. A bare
// slice name 404s the route (it is not a root slice), and the ABSOLUTE
// SliceReviewTab.slicePath must NEVER be used (it couples the action to host
// paths). Bare is correct ONLY for a legacy root slice (missionId null).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BoardSlot, ComposedMissionReview, ComposedSliceReview, NeedsYouItem } from "../src/hooks/useReview.js";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, ...rest }: { children?: React.ReactNode; to?: string }) => (
    <a href={to ?? "#"} {...(rest as Record<string, unknown>)}>{children}</a>
  ),
}));
vi.mock("../src/components/terminal/ProgressiveTerminal.js", () => ({ ProgressiveTerminal: () => null }));
vi.mock("../src/components/review/TranscriptDrillPanel.js", () => ({ TranscriptDrillPanel: () => null }));
vi.mock("../src/components/review/AgentsBandView.js", () => ({ AgentsBandView: () => null }));

const sliceState: { data: ComposedSliceReview | null } = { data: null };
const missionState: { data: ComposedMissionReview | null } = { data: null };
vi.mock("../src/hooks/useReview.js", () => ({
  useSliceReview: () => ({ isLoading: false, isError: false, data: sliceState.data, error: null }),
  useMissionReview: () => ({ isLoading: false, isError: false, data: missionState.data, error: null }),
  useInvalidateReview: () => () => {},
}));
vi.mock("../src/hooks/useScopeMarkdown.js", () => ({ useScopeMarkdown: () => ({ resolved: null, isLoading: false }) }));

import { MissionReviewTab } from "../src/components/review/MissionReviewTab.js";
import { SliceReviewTab } from "../src/components/review/SliceReviewTab.js";
import { sliceScopePath } from "../src/components/review/review-actions.js";

const MISSION = "flagship-mixed-state-78286a69";
const SLICE = "fg1-06-review-not-green";

let posted: Array<{ url: string; body: Record<string, unknown> | null }> = [];
beforeEach(() => {
  posted = [];
  globalThis.fetch = vi.fn(async (url: unknown, init?: { body?: string }) => {
    posted.push({ url: String(url), body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : null });
    return { ok: true, status: 201, json: async () => ({ ok: true }) } as unknown as Response;
  }) as unknown as typeof fetch;
});
afterEach(() => { cleanup(); sliceState.data = null; missionState.data = null; vi.restoreAllMocks(); });

function withQuery(node: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{node}</QueryClientProvider>;
}

function boardSlot(over: Partial<BoardSlot> = {}): BoardSlot {
  return { slice: SLICE, title: "review not green", phase: "locked", laneLabel: "LOCKED", agentsCount: 0, stageCell: "R", changedSinceStamp: false, attentionWorthy: true, ...over } as BoardSlot;
}
function missionReview(): ComposedMissionReview {
  return {
    mission: MISSION, missionId: MISSION, title: "Mixed", intent: "x",
    briefSpine: { building: "", progress: "", proven: "", needsYou: "" },
    board: [boardSlot()], ledger: [], cutComplete: false, cutCompleteBasis: "",
    needsYou: { items: [], provenance: "none" },
    agents: { scope: `mission:${MISSION}`, rows: [], provenance: "", coordinationHealth: null },
    composedAt: "2026-07-22T07:00:00.000Z",
  } as unknown as ComposedMissionReview;
}
function needsYouItem(): NeedsYouItem {
  return {
    source: "agent", identity: "n1", summary: "needs approve", leg: "leg", where: `${MISSION}/slices/${SLICE}`,
    ageIso: null, priority: null, tier: null, evidenceRef: null, unblocks: null, qitemId: null,
    destinationSession: null, derived: null,
  } as NeedsYouItem;
}
function sliceReview(over: Partial<ComposedSliceReview> = {}): ComposedSliceReview {
  return {
    slice: SLICE, sliceId: "id", title: "t", missionId: MISSION, phase: "locked", laneLabel: "LOCKED",
    intent: { text: "", media: [], ssotPath: null, degrade: null },
    plan: { concise: { text: "", media: [] }, lockedArtifacts: [], lock: null, ssotPath: null },
    delivered: { items: [], extraProof: [], lock: null, proofDirPath: null },
    needsYou: { items: [], provenance: "none" },
    agents: { scope: `slice:${SLICE}`, rows: [], provenance: "", coordinationHealth: null },
    lineage: { candidateSha: "78286a69", mergeSha: null, mainTip: "78286a69", freshness: "fresh", staleBehind: 0, gateCells: [] },
    defects: [], composedAt: "2026-07-22T07:00:00.000Z", ...over,
  } as unknown as ComposedSliceReview;
}

function lastApprovePath(): string {
  const approves = posted.filter((p) => p.url.includes("/api/scope/approve"));
  const last = approves[approves.length - 1];
  expect(last, "no POST to /api/scope/approve captured").toBeTruthy();
  return String((last!.body as { scopePath?: string }).scopePath);
}

describe("slice-04 REV6 — nested Approve posts missions-root-relative scopePath", () => {
  it("sliceScopePath composes <mission>/slices/<slice>, bare when missionId is null, never absolute", () => {
    expect(sliceScopePath(MISSION, SLICE)).toBe(`${MISSION}/slices/${SLICE}`);
    expect(sliceScopePath(null, SLICE)).toBe(SLICE);
    expect(sliceScopePath(undefined, SLICE)).toBe(SLICE);
    expect(sliceScopePath(MISSION, SLICE).startsWith("/")).toBe(false);
  });

  it("mission BOARD Approve posts <mission>/slices/<slice>", async () => {
    missionState.data = missionReview();
    sliceState.data = sliceReview(); // BoardRowExpansion's useSliceReview
    render(withQuery(<MissionReviewTab missionId={MISSION} />));
    fireEvent.click(screen.getByTestId(`board-row-${SLICE}`));
    fireEvent.click(await screen.findByTestId(`board-approve-${SLICE}`));
    await waitFor(() => expect(posted.some((p) => p.url.includes("/api/scope/approve"))).toBe(true));
    expect(lastApprovePath()).toBe(`${MISSION}/slices/${SLICE}`);
    expect(lastApprovePath().startsWith("/")).toBe(false);
  });

  it("mission BOARD Approve falls back to bare slice for a legacy root slice (missionId null)", async () => {
    missionState.data = missionReview();
    sliceState.data = sliceReview({ missionId: null });
    render(withQuery(<MissionReviewTab missionId={MISSION} />));
    fireEvent.click(screen.getByTestId(`board-row-${SLICE}`));
    fireEvent.click(await screen.findByTestId(`board-approve-${SLICE}`));
    await waitFor(() => expect(posted.some((p) => p.url.includes("/api/scope/approve"))).toBe(true));
    expect(lastApprovePath()).toBe(SLICE);
  });

  it("slice NEEDS YOU Approve posts <mission>/slices/<slice> and NEVER the absolute slicePath", async () => {
    sliceState.data = sliceReview({ needsYou: { items: [needsYouItem()], provenance: "x" } });
    // slicePath is an ABSOLUTE host path — the approve must ignore it entirely.
    render(withQuery(<SliceReviewTab sliceName={SLICE} slicePath={`/abs/host/missions/${MISSION}/slices/${SLICE}`} />));
    fireEvent.click(screen.getByTestId("needs-you-row-n1"));
    fireEvent.click(await screen.findByTestId("needs-you-approve"));
    await waitFor(() => expect(posted.some((p) => p.url.includes("/api/scope/approve"))).toBe(true));
    expect(lastApprovePath()).toBe(`${MISSION}/slices/${SLICE}`);
    expect(lastApprovePath()).not.toContain("/abs/host");
    expect(lastApprovePath().startsWith("/")).toBe(false);
  });

  it("slice NEEDS YOU Approve falls back to bare slice when missionId is null", async () => {
    sliceState.data = sliceReview({ missionId: null, needsYou: { items: [needsYouItem()], provenance: "x" } });
    render(withQuery(<SliceReviewTab sliceName={SLICE} slicePath={null} />));
    fireEvent.click(screen.getByTestId("needs-you-row-n1"));
    fireEvent.click(await screen.findByTestId("needs-you-approve"));
    await waitFor(() => expect(posted.some((p) => p.url.includes("/api/scope/approve"))).toBe(true));
    expect(lastApprovePath()).toBe(SLICE);
  });
});
