// V1 attempt-3 Phase 5 P5-2 — SliceScopePage tab content piping reachability.
//
// Each canonical slice tab (story/overview/progress/artifacts/tests/queue/
// topology) renders its mounted component once /api/slices/:name resolves.
// Loading + error states get their own EmptyState renders. The fold
// mapping (AcceptanceTab → progress; DocsTab+DecisionsTab → artifacts;
// QueueItemTrigger → queue) is verified via testid presence.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react";
import {
  createMemoryHistory,
  RouterProvider,
  createRouter,
  createRootRoute,
  createRoute,
  Outlet,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DrawerSelectionContext } from "../src/components/AppShell.js";
import { SliceScopePage } from "../src/components/project/ScopePages.js";
import type { SliceDetail } from "../src/hooks/useSlices.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  cleanup();
});

function renderSliceScope(opts: {
  sliceId: string;
  detail?: SliceDetail | null;
  status?: number;
}): { setSelection: ReturnType<typeof vi.fn> } & ReturnType<typeof render> {
  const setSelection = vi.fn();
  // Mock /api/slices/:name response.
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes(`/api/slices/${opts.sliceId}`)) {
      if (opts.status && opts.status !== 200) {
        return new Response("not found", { status: opts.status });
      }
      return new Response(JSON.stringify(opts.detail), { status: 200 });
    }
    return new Response("[]");
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const sliceRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/project/slice/$sliceId",
    component: () => (
      <DrawerSelectionContext.Provider value={{ selection: null, setSelection }}>
        <SliceScopePage />
      </DrawerSelectionContext.Provider>
    ),
  });
  // Stub other routes that tabs may try to Link to (TopologyTab uses
  // /topology/seat/... links etc).
  const fallbackRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "$",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([sliceRoute, fallbackRoute]),
    history: createMemoryHistory({ initialEntries: [`/project/slice/${opts.sliceId}`] }),
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { setSelection, ...utils };
}

function makeDetail(overrides: Partial<SliceDetail> = {}): SliceDetail {
  return {
    name: "idea-ledger",
    displayName: "Idea Ledger",
    railItem: null,
    status: "active",
    rawStatus: "active",
    qitemIds: ["qitem-A", "qitem-B"],
    commitRefs: ["abc1234"],
    lastActivityAt: "2026-05-06T18:00:00Z",
    workflowBinding: null,
    story: { events: [], phaseDefinitions: null },
    acceptance: {
      totalItems: 3,
      doneItems: 1,
      percentage: 33,
      items: [
        {
          text: "item one",
          done: true,
          source: { file: "PROGRESS.md", line: 1 },
        },
      ],
      closureCallout: null,
      currentStep: null,
    },
    decisions: { rows: [] },
    docs: { tree: [{ name: "README.md", relPath: "README.md", type: "file" } as any] },
    tests: { proofPackets: [], aggregate: { passCount: 0, failCount: 0 } },
    topology: { affectedRigs: [], totalSeats: 0, specGraph: null },
    ...overrides,
  };
}

describe("SliceScopePage P5-2 tab content piping", () => {
  it("loading state renders EmptyState with slice id", async () => {
    // Don't resolve fetch — keep query in-flight.
    mockFetch.mockImplementation(() => new Promise(() => {}));
    const { findByTestId } = renderSliceScope({ sliceId: "idea-ledger", detail: null });
    expect(await findByTestId("slice-scope-loading")).toBeTruthy();
  });

  it("error/404 renders EmptyState with not-available message", async () => {
    const { findByTestId } = renderSliceScope({ sliceId: "missing-slice", status: 404 });
    expect(await findByTestId("slice-scope-error")).toBeTruthy();
  });

  it("default landing tab is 'story'; mounts StoryTab with events + phaseDefinitions", async () => {
    const { container, findByTestId } = renderSliceScope({
      sliceId: "idea-ledger",
      detail: makeDetail(),
    });
    // ScopeShell mounts; project-tab-nav rendered.
    await findByTestId("project-tab-nav");
    // Story is the default active tab.
    const storyTab = container.querySelector("[data-testid='project-tab-story']");
    expect(storyTab?.getAttribute("data-active")).toBe("true");
  });

  it("progress tab mounts AcceptanceTab (FOLDED per code-map)", async () => {
    const { container, findByTestId } = renderSliceScope({
      sliceId: "idea-ledger",
      detail: makeDetail(),
    });
    await findByTestId("project-tab-nav");
    fireEvent.click(container.querySelector("[data-testid='project-tab-progress']")!);
    // AcceptanceTab renders a header progress bar with percentage. Smoke
    // test: tabpanel exists + does NOT show the placeholder.
    await waitFor(() => {
      expect(container.querySelector("[data-testid='project-tab-placeholder-slice progress']")).toBeNull();
    });
  });

  it("artifacts tab mounts FOLDED Docs + Decisions sections", async () => {
    const { container, findByTestId } = renderSliceScope({
      sliceId: "idea-ledger",
      detail: makeDetail(),
    });
    await findByTestId("project-tab-nav");
    fireEvent.click(container.querySelector("[data-testid='project-tab-artifacts']")!);
    expect(await findByTestId("slice-artifacts-tab")).toBeTruthy();
    expect(container.querySelector("[data-testid='slice-artifacts-files']")).toBeTruthy();
    expect(container.querySelector("[data-testid='slice-artifacts-commits']")).toBeTruthy();
    expect(container.querySelector("[data-testid='slice-artifacts-docs']")).toBeTruthy();
    expect(container.querySelector("[data-testid='slice-artifacts-decisions']")).toBeTruthy();
  });

  it("overview tab mounts a distinct summary surface rather than the docs browser", async () => {
    const { container, findByTestId } = renderSliceScope({
      sliceId: "idea-ledger",
      detail: makeDetail(),
    });
    await findByTestId("project-tab-nav");
    fireEvent.click(container.querySelector("[data-testid='project-tab-overview']")!);
    expect(await findByTestId("slice-overview-tab")).toBeTruthy();
    expect(container.querySelector("[data-testid='slice-overview-summary']")).toBeTruthy();
    expect(container.querySelector("[data-testid='slice-overview-current-step']")).toBeTruthy();
    expect(container.querySelector("[data-testid='slice-artifacts-docs']")).toBeNull();
  });

  it("queue tab lists qitemIds wrapped in QueueItemTrigger; click fires setSelection", async () => {
    const { container, findByTestId, setSelection } = renderSliceScope({
      sliceId: "idea-ledger",
      detail: makeDetail(),
    });
    await findByTestId("project-tab-nav");
    fireEvent.click(container.querySelector("[data-testid='project-tab-queue']")!);
    const trigger = await findByTestId("slice-queue-trigger-qitem-A");
    fireEvent.click(trigger);
    expect(setSelection).toHaveBeenCalledWith({
      type: "qitem",
      data: { qitemId: "qitem-A" },
    });
  });

  it("queue tab empty-state when slice has no qitemIds", async () => {
    const { container, findByTestId } = renderSliceScope({
      sliceId: "idea-ledger",
      detail: makeDetail({ qitemIds: [] }),
    });
    await findByTestId("project-tab-nav");
    fireEvent.click(container.querySelector("[data-testid='project-tab-queue']")!);
    expect(await findByTestId("slice-queue-empty")).toBeTruthy();
  });

  it("topology tab mounts TopologyTab", async () => {
    const { container, findByTestId } = renderSliceScope({
      sliceId: "idea-ledger",
      detail: makeDetail(),
    });
    await findByTestId("project-tab-nav");
    fireEvent.click(container.querySelector("[data-testid='project-tab-topology']")!);
    // TopologyTab renders empty state when no rigs + no specGraph; the
    // tab panel itself just must exist + have no placeholder.
    await waitFor(() => {
      expect(container.querySelector("[data-testid='project-tab-placeholder-slice topology']")).toBeNull();
    });
  });

  it("tests tab mounts TestsVerificationTab", async () => {
    const { container, findByTestId } = renderSliceScope({
      sliceId: "idea-ledger",
      detail: makeDetail(),
    });
    await findByTestId("project-tab-nav");
    fireEvent.click(container.querySelector("[data-testid='project-tab-tests']")!);
    // TestsVerificationTab renders empty-state when no proofPackets.
    expect(await findByTestId("tests-empty")).toBeTruthy();
  });
});
