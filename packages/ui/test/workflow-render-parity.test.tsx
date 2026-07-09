// OPR.0.4.6.WF4 — RENDER-PARITY (PM refined Rule B, 2026-07-07). The two
// production-UNREACHABLE attention kinds (the no-item ▲ backstop and the S2
// overdue ● — see PROOF.md for the engine reasons: the 4h hardcoded stuck
// threshold with no env override, and the exception item born in the SAME
// failure txn) are proven by CONSTRUCTING the exact row/state and asserting the
// SAME row.workflow deep-link target + the SAME rendered banner as the LIVE
// kinds — render-parity, not unit-trust. Q6-P3 anti-prose is asserted across
// ALL FOUR kinds here (every kind's link resolves from item.workflow only).

import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";

// The NEEDS-YOU chat surface is ProgressiveTerminal (xterm). Mock it so the
// accordion renders in jsdom without booting a canvas (getContext is
// unimplemented in jsdom → xterm throws → empty render). Pattern from
// foryou-bare-approve-chat.test.tsx (OPR.0.4.6.WF4 leg-8 test-only fix).
vi.mock("../src/components/terminal/ProgressiveTerminal.js", () => ({
  ProgressiveTerminal: () => <div data-testid="mock-progressive-terminal" />,
}));
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { NeedsYouAccordion } from "../src/components/review/NeedsYouAccordion.js";
import { ExceptionBanner } from "../src/components/workflow/WorkflowInstancePage.js";
import type { NeedsYouBand, NeedsYouItem } from "../src/hooks/useReview.js";
import type { WorkflowInstanceWithDeadline } from "../src/hooks/useWorkflow.js";
import type { EvidenceContext } from "../src/components/review/EvidenceOpener.js";

afterEach(() => cleanup());

const item = (over: Partial<NeedsYouItem>): NeedsYouItem => ({
  source: "agent",
  identity: "id",
  summary: "s",
  leg: "human-routed",
  where: "human@host",
  ageIso: null,
  priority: null,
  tier: null,
  evidenceRef: null,
  unblocks: null,
  qitemId: "q",
  destinationSession: "human@host",
  derived: null,
  ...over,
});

// The four kinds, each carrying the Q6 row.workflow pointer. Two are live-
// reachable (parked gate ● · human-routed ●), two are disclosed-unreachable
// (orchestrator awareness is live too but grouped here as ▲; the no-item
// backstop is the unreachable ▲). All must render the SAME deep-link.
const FOUR_KINDS: NeedsYouItem[] = [
  item({
    identity: "gate",
    source: "agent",
    leg: "park-on-human",
    workflow: { instanceId: "01GATE", workflowName: "acme-factory", stepId: "ship-signoff" },
  }),
  item({
    identity: "human",
    source: "agent",
    leg: "human-routed",
    workflow: { instanceId: "01HUMAN", workflowName: "linear-build", stepId: "build" },
  }),
  item({
    identity: "aware",
    source: "derived",
    leg: "awareness",
    derived: { kind: "awareness", evidence: "held by floor-lead@acme-factory · 30m", threshold: "awareness" },
    workflow: { instanceId: "01AWARE", workflowName: "acme-factory", stepId: "rework" },
  }),
  item({
    identity: "backstop",
    source: "derived",
    leg: "workflow-failed",
    derived: {
      kind: "workflow-failed",
      evidence: "MISSING-ITEM ANOMALY",
      threshold: "failed instances carry an exception item",
    },
    workflow: { instanceId: "01BACKSTOP", workflowName: "acme-factory" },
  }),
  // S2 overdue/stuck (production-unreachable — 4h hardcoded threshold, no env
  // override): its NEEDS-YOU row must ALSO render the SAME deep-link (qa2
  // re-review #4 — not just the ExceptionBanner). Exact-state row with the
  // Q6 pointer + the ?step= anchor at the stuck step.
  item({
    identity: "overdue",
    source: "derived",
    leg: "stuck",
    derived: {
      kind: "stuck",
      evidence: "step inspect packet qitem-9 held by inspector@acme-factory — 4200s past the created_at anchor",
      threshold: "past the WF-1 deadline evaluator threshold",
    },
    workflow: { instanceId: "01OVERDUE", workflowName: "acme-factory", stepId: "inspect" },
  }),
];

function renderAccordion(band: NeedsYouBand) {
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <NeedsYouAccordion band={band} slice="acme" actorSession="floor-lead@acme-factory" ctx={{} as EvidenceContext} />
    ),
  });
  const instRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/workflow/instance/$instanceId",
    validateSearch: (s: Record<string, unknown>): { step?: string } => ({
      step: typeof s.step === "string" ? s.step : undefined,
    }),
    component: () => <div data-testid="instance-stub" />,
  });
  const routeTree = rootRoute.addChildren([indexRoute, instRoute]);
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ["/"] }) });
  // NeedsYouAccordion calls useInvalidateReview() → useQueryClient(), so the
  // render needs a QueryClientProvider; without it the component throws and the
  // band renders empty (OPR.0.4.6.WF4 leg-8 test-only fix; pattern from
  // rig-graph.test.tsx).
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

describe("WF-4 render-parity — the NEEDS-YOU deep-link across ALL FOUR kinds", () => {
  it("every kind renders the SAME row.workflow deep-link target (live ● gate/human + ▲ awareness/backstop + the overdue ● row)", async () => {
    const { getByTestId } = renderAccordion({ items: FOUR_KINDS, provenance: "test" });
    // TanStack Router resolves the route asynchronously; await the band before
    // querying rows (OPR.0.4.6.WF4 leg-8 test-only fix; pattern: discovery-overlay).
    await waitFor(() => expect(getByTestId("needs-you-band")).toBeTruthy());
    for (const row of FOUR_KINDS) {
      fireEvent.click(getByTestId(`needs-you-row-${row.identity}`));
      const link = getByTestId(`needs-you-workflow-link-${row.identity}`);
      const href = link.getAttribute("href") ?? "";
      // SAME structure for every kind: an anchor to the instance route resolved
      // from item.workflow.instanceId (Q6-P3: never from prose).
      expect(href).toContain(`/workflow/instance/${row.workflow!.instanceId}`);
      if (row.workflow!.stepId) expect(href).toContain(`step=${row.workflow!.stepId}`);
      expect(link.textContent).toContain("View Instance");
    }
  });

  it("a non-workflow row renders NO deep-link (omit-when-absent render-parity)", async () => {
    const { getByTestId, queryByTestId } = renderAccordion({ items: [item({ identity: "plain" })], provenance: "test" });
    await waitFor(() => expect(getByTestId("needs-you-row-plain")).toBeTruthy());
    fireEvent.click(getByTestId("needs-you-row-plain"));
    expect(queryByTestId("needs-you-workflow-link-plain")).toBeNull();
  });
});

// --- ExceptionBanner render-parity: overdue (disclosed) vs failed (live) ---

const EVIDENCE = {
  instanceId: "01OVERDUE",
  stepId: "inspect",
  packetId: "qitem-9",
  ownerSession: "inspector@acme-factory",
  packetState: "in-progress",
  anchor: "created_at" as const,
  anchorAt: "2026-07-07T00:00:00.000Z",
  overdueBySeconds: 4200,
  ageSeconds: 4200,
  claimedAt: null,
};

const inst = (over: Partial<WorkflowInstanceWithDeadline>): WorkflowInstanceWithDeadline => ({
  instanceId: "01INST",
  workflowName: "acme-factory",
  workflowVersion: "2",
  createdBySession: "floor-lead@acme-factory",
  createdAt: "2026-07-07T00:00:00.000Z",
  status: "active",
  currentFrontier: ["qitem-9"],
  currentStepId: "inspect",
  hopCount: 2,
  fallbackSynthesis: null,
  lastContinuationDecision: null,
  completedAt: null,
  version: 1,
  resumeCount: 0,
  hopsBaseline: 0,
  deadline: { state: "healthy", evidence: null },
  ...over,
});

describe("WF-4 render-parity — the ExceptionBanner (overdue disclosed vs failed live)", () => {
  it("the OVERDUE banner (S2, production-unreachable) renders the SAME banner element a live overdue instance would", () => {
    const overdue = inst({ status: "active", deadline: { state: "overdue-unclaimed", evidence: EVIDENCE } });
    const { getByTestId } = render(
      <ExceptionBanner instance={overdue} onResume={() => {}} resuming={false} resumeError={null} />,
    );
    const banner = getByTestId("workflow-exception-banner");
    expect(banner.textContent).toContain("OVERDUE-UNCLAIMED");
    expect(banner.textContent).toContain("inspector@acme-factory");
  });

  it("the FAILED banner (live) renders + wires Resume (route-from-web omitted)", () => {
    const failed = inst({ status: "failed", currentStepId: null, deadline: { state: "healthy", evidence: null } });
    const { getByTestId, queryByTestId } = render(
      <ExceptionBanner instance={failed} onResume={() => {}} resuming={false} resumeError={null} />,
    );
    expect(getByTestId("workflow-exception-banner").textContent).toContain("FAILED");
    expect(getByTestId("workflow-resume")).toBeTruthy();
    // route-from-web is deferred — no re-route affordance renders.
    expect(queryByTestId("workflow-route")).toBeNull();
  });
});
