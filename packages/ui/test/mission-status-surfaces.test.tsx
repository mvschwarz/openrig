// VM-005 (release-0.4.7) — DOM tier: the chip surfaces consume the
// reconciled home (plan §D V1/V2 per reachable surface; harness pattern
// from p5-mission-discovery.test.tsx). Asserts:
//  - the tree chip renders the AUTHORED word from the slices-payload
//    sidecar (V1), with NO PROGRESS.md status fetch (Q1 Option A — the
//    live override is retired);
//  - the idle mission renders "idle", never the retired UNKNOWN word (V2);
//  - the portfolio badge renders the authored word (V1, C5 surface).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  RouterProvider,
  createRouter,
  createRootRoute,
  createRoute,
  Outlet,
} from "@tanstack/react-router";
import { ProjectTreeView } from "../src/components/project/ProjectTreeView.js";
import { WorkspacePortfolioPanel } from "../src/components/project/WorkspacePortfolioPanel.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

beforeEach(() => mockFetch.mockReset());
afterEach(() => cleanup());

type SliceRowFixture = {
  name: string;
  missionId: string | null;
  displayName: string;
  railItem: string | null;
  status: string;
  rawStatus: string | null;
  qitemCount: number;
  hasProofPacket: boolean;
  lastActivityAt: string | null;
};

function sliceRow(over: Partial<SliceRowFixture>): SliceRowFixture {
  return {
    name: "s1",
    missionId: "m1",
    displayName: "S1",
    railItem: null,
    status: "active",
    rawStatus: null,
    qitemCount: 0,
    hasProofPacket: false,
    lastActivityAt: new Date(Date.now() - 60_000).toISOString(),
    ...over,
  };
}

function setupFetch(opts: {
  slices: SliceRowFixture[];
  missions?: Record<string, { authoredStatus: string | null }>;
}) {
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes("/api/hosts")) {
      return new Response(
        JSON.stringify({ ownName: "localhost", selected: "local", hosts: [] }),
        { status: 200 },
      );
    }
    if (url.includes("/api/config")) {
      return new Response(JSON.stringify({ settings: {} }), { status: 200 });
    }
    if (url.includes("/api/files/roots")) {
      return new Response(JSON.stringify({ roots: [] }), { status: 200 });
    }
    if (url.includes("/api/slices")) {
      return new Response(
        JSON.stringify({
          slices: opts.slices,
          totalCount: opts.slices.length,
          filter: "all",
          missions: opts.missions ?? {},
        }),
        { status: 200 },
      );
    }
    return new Response("[]");
  });
}

function mount(node: React.ReactNode): ReturnType<typeof render> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <>{node}</>,
  });
  const fallbackRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "$",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, fallbackRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("VM-005 tree chip — authored-wins via the sidecar (V1) + override retired (Q1-A)", () => {
  it("renders the authored word 'complete' for a mission with a recently-active slice", async () => {
    setupFetch({
      slices: [sliceRow({ missionId: "relx", name: "target" })],
      missions: { relx: { authoredStatus: "complete" } },
    });
    const { findByTestId } = mount(<ProjectTreeView />);
    const badge = await findByTestId("project-mission-relx-badge");
    expect(badge.textContent).toContain("complete"); // the raw authored word
    // Q1 Option A: zero PROGRESS.md-status reads — the override is retired.
    const fileReads = mockFetch.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes("/api/files/read"));
    expect(fileReads).toEqual([]);
  });

  it("renders 'idle' (never the retired word) for an aged-out mission with no authored status", async () => {
    const stale = new Date(Date.now() - 40 * 60 * 60 * 1000).toISOString();
    setupFetch({
      slices: [sliceRow({ missionId: "sleepy", name: "old-slice", lastActivityAt: stale })],
      missions: {},
    });
    const { findByTestId } = mount(<ProjectTreeView />);
    const badge = await findByTestId("project-mission-sleepy-badge");
    expect(badge.textContent).toContain("idle");
    expect(badge.textContent).not.toContain("unknown");
  });
});

describe("VM-005 portfolio badge — authored-wins (V1, C5 surface)", () => {
  it("renders the authored word on the portfolio mission row", async () => {
    setupFetch({
      slices: [sliceRow({ missionId: "relx", name: "target" })],
      missions: { relx: { authoredStatus: "complete" } },
    });
    const { findByText } = mount(<WorkspacePortfolioPanel />);
    expect(await findByText("complete")).toBeTruthy();
  });
});
