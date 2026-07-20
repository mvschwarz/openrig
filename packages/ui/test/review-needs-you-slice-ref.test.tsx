// @vitest-environment jsdom

// qitem-render-driver D3 + #5a — mission NEEDS-YOU slice attribution and
// VERIFY LINEAGE token labelling.
//
// D3 root (MissionReviewTab.tsx:320): the mission band unions slice-derived
// exceptions VERBATIM, so item.where already carries `<mission>/slices/<name>`
// (compose.ts:1070/1150). The tab COMPUTES sliceName from that ref but uses it
// only as the Link target — the rendered row (:322-327) shows summary + leg +
// priority only. Because the insufficient-proof summary is slice-agnostic
// ("insufficient proof: N/M promised items missing", compose.ts:670-676), two
// slices produce visually identical rows with no attribution. The honest fix
// SURFACES the ref already in the payload; it must never invent one.
//
// #5a root (VerifyLineageCard.tsx:29-33, per QA evidence): the FINAL token is
// `lineage.freshness` rendered with NO label — so a payload freshness of
// "unknown" reads as a dangling bare token after "main tip unknown". The
// sibling proven-at / merged-at / main-tip labels are correct and must stay.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComposedMissionReview, VerifyLineage } from "../src/hooks/useReview.js";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children?: React.ReactNode }) => <a {...(rest as Record<string, unknown>)}>{children}</a>,
}));
vi.mock("../src/components/review/AgentsBandView.js", () => ({ AgentsBandView: () => null }));
vi.mock("../src/components/terminal/ProgressiveTerminal.js", () => ({ ProgressiveTerminal: () => null }));

const missionState: { data: ComposedMissionReview | null } = { data: null };
vi.mock("../src/hooks/useReview.js", () => ({
  useMissionReview: () => ({ isLoading: false, isError: false, data: missionState.data, error: null }),
  useSliceReview: () => ({ isLoading: false, isError: false, data: null, error: null }),
  useInvalidateReview: () => () => {},
}));

import { MissionReviewTab } from "../src/components/review/MissionReviewTab.js";
import { VerifyLineageCard } from "../src/components/review/VerifyLineageCard.js";

afterEach(() => {
  cleanup();
  missionState.data = null;
});

function withQuery(node: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{node}</QueryClientProvider>;
}

/** A slice-derived insufficient-proof item exactly as compose.ts emits it. */
function insufficientProof(slice: string) {
  return {
    source: "derived",
    identity: `m/slices/${slice}|insufficient-proof|1`,
    summary: "insufficient proof: 1/2 promised items missing",
    leg: "insufficient-proof",
    where: `m/slices/${slice}`,
    ageIso: null,
    priority: null,
    tier: null,
    evidenceRef: null,
    unblocks: null,
    qitemId: null,
    destinationSession: null,
    derived: {
      kind: "insufficient-proof",
      evidence: "1 of 2 promised deliverables have no delivered evidence",
      threshold: "delivered.items MISSING count > 0",
    },
  };
}

/** A MISSION-scope item — its `where` carries no /slices/ segment. */
function missionScopeItem() {
  return {
    source: "agent",
    identity: "q-mission-1|overdue|x",
    summary: "a mission-scope attention item",
    leg: "overdue",
    where: "mission queue+slice unions",
    ageIso: null,
    priority: null,
    tier: null,
    evidenceRef: null,
    unblocks: null,
    qitemId: "q-mission-1",
    destinationSession: null,
    derived: null,
  };
}

function missionReview(items: unknown[]): ComposedMissionReview {
  return {
    mission: "m",
    missionId: "OPR.M",
    title: "m",
    intent: null,
    briefSpine: { building: "", progress: "", proven: "", needsYou: "" },
    board: [],
    ledger: [],
    cutComplete: false,
    cutCompleteBasis: "basis",
    needsYou: { items, provenance: "union" },
    agents: { scope: "mission:m", rows: [], provenance: "0", coordinationHealth: null },
    composedAt: "2026-07-20T00:00:00.000Z",
  } as unknown as ComposedMissionReview;
}

describe("qitem-render-driver D3 — mission NEEDS-YOU shows which slice each item belongs to", () => {
  it("RED: two slice-derived insufficient-proof rows VISIBLY carry their own slice refs (not just distinct hrefs)", () => {
    missionState.data = missionReview([insufficientProof("alpha"), insufficientProof("beta")]);
    render(withQuery(<MissionReviewTab missionId="m" />));
    const alphaRow = screen.getByTestId("mission-needs-you-m/slices/alpha|insufficient-proof|1");
    const betaRow = screen.getByTestId("mission-needs-you-m/slices/beta|insufficient-proof|1");
    // Each row must name its own slice in VISIBLE text — today both rows
    // render the identical slice-agnostic summary.
    expect(alphaRow.textContent, "alpha row must name its slice").toContain("alpha");
    expect(betaRow.textContent, "beta row must name its slice").toContain("beta");
    expect(alphaRow.textContent, "alpha row must not claim beta").not.toContain("beta");
  });

  it("GREEN pin (no fabrication): a mission-scope item whose `where` lacks /slices/ invents no slice ref", () => {
    missionState.data = missionReview([missionScopeItem()]);
    const { container } = render(withQuery(<MissionReviewTab missionId="m" />));
    const band = container.textContent ?? "";
    expect(band).toContain("a mission-scope attention item");
    expect(band, "no slices/ token may be fabricated for a mission-scope item").not.toContain("slices/");
    expect(band, "no alpha/beta slice name may leak onto a mission-scope row").not.toMatch(/\b(alpha|beta)\b/);
  });
});

describe("qitem-render-driver #5a — VERIFY LINEAGE tokens are all labelled", () => {
  const lineage = (over: Partial<VerifyLineage> = {}): VerifyLineage => ({
    candidateSha: null,
    mergeSha: null,
    mainTip: "unknown",
    freshness: "unknown",
    staleBehind: null,
    gateCells: [],
    ...over,
  } as VerifyLineage);

  it("RED: the trailing freshness token is LABELLED (not a bare dangling 'unknown')", () => {
    render(<VerifyLineageCard lineage={lineage()} />);
    const token = screen.getByTestId("lineage-freshness");
    // The freshness value must not stand alone: its own element (or an
    // immediately adjacent label) must name what the value describes.
    const own = (token.textContent ?? "").trim();
    expect(
      /freshness/i.test(own),
      `freshness token must be labelled; rendered bare as "${own}"`,
    ).toBe(true);
  });

  it("GREEN pin: proven-at / merged-at / main tip labels are preserved verbatim", () => {
    const { container } = render(<VerifyLineageCard lineage={lineage({ candidateSha: "cafe1234", mergeSha: null, mainTip: "tip99" })} />);
    const text = container.textContent ?? "";
    expect(text).toContain("proven-at");
    expect(text).toContain("cafe1234");
    expect(text).toContain("merged-at");
    expect(text).toContain("UNMERGED");
    expect(text).toContain("main tip");
    expect(text).toContain("tip99");
  });
});
