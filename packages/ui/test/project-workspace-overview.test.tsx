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
import { WorkspaceScopePage } from "../src/components/project/ScopePages.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  cleanup();
});

function renderWorkspaceScope(): ReturnType<typeof render> {
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes("/api/config")) {
      return new Response(
        JSON.stringify({ settings: { "workspace.root": { value: "/Users/admin/.openrig/workspace" } } }),
        { status: 200 },
      );
    }
    if (url.includes("/api/slices")) {
      return new Response(
        JSON.stringify({
          slices: [
            {
              name: "idea-ledger",
              displayName: "Idea Ledger RSI v2 proof slice",
              railItem: "RSI-V2-PROOF",
              status: "done",
              rawStatus: "done",
              qitemCount: 78,
              hasProofPacket: false,
              lastActivityAt: "2026-05-07T22:06:36.083Z",
            },
            {
              name: "seed-slice-active",
              displayName: "seed-slice-active",
              railItem: null,
              status: "active",
              rawStatus: "active",
              qitemCount: 0,
              hasProofPacket: false,
              lastActivityAt: "2000-01-01T00:00:00.000Z",
            },
          ],
          totalCount: 2,
          filter: "all",
        }),
        { status: 200 },
      );
    }
    return new Response("[]");
  });

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const projectRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/project",
    component: () => <WorkspaceScopePage />,
  });
  const fallbackRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "$",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([projectRoute, fallbackRoute]),
    history: createMemoryHistory({ initialEntries: ["/project"] }),
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("WorkspaceScopePage overview", () => {
  it("summarizes current qitem-backed work separately from archived slices", async () => {
    const { findByTestId } = renderWorkspaceScope();

    expect(await findByTestId("workspace-overview-panel")).toBeTruthy();
    const currentMission = await findByTestId("workspace-overview-mission-RSI-V2-PROOF");
    expect(currentMission.getAttribute("data-mission-bucket")).toBe("current");
    expect((await findByTestId("workspace-overview-slice-idea-ledger")).textContent).toContain(
      "78 qitems",
    );

    const archivedMission = await findByTestId("workspace-overview-mission-unsorted");
    expect(archivedMission.getAttribute("data-mission-bucket")).toBe("archive");
  });
});
