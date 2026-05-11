import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  RouterProvider,
  createRouter,
  createRootRoute,
  createRoute,
  Outlet,
} from "@tanstack/react-router";
import { MissionScopePage, WorkspaceScopePage } from "../src/components/project/ScopePages.js";
import type { SliceDetail } from "../src/hooks/useSlices.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  cleanup();
});

function makeDetail(name: string, missionId: string | null, qitemIds: string[]): SliceDetail {
  return {
    name,
    missionId,
    slicePath: `/workspace/${name}`,
    displayName: name,
    railItem: missionId,
    status: "active",
    rawStatus: "active",
    qitemIds,
    commitRefs: ["abc1234"],
    lastActivityAt: "2026-05-07T22:06:36.083Z",
    workflowBinding: null,
    story: {
      events: qitemIds[0] ? [{
        ts: "2026-05-07T22:06:36.083Z",
        kind: "queue.created",
        actorSession: "driver@rig",
        qitemId: qitemIds[0],
        phase: null,
        summary: `Created ${qitemIds[0]} for ${name}.`,
        detail: { sourceSession: "driver@rig", destinationSession: "human@host" },
      }] : [],
      phaseDefinitions: null,
    },
    acceptance: { totalItems: 1, doneItems: 1, percentage: 100, items: [], closureCallout: null, currentStep: null },
    decisions: { rows: [] },
    docs: { tree: [{ name: "README.md", relPath: "README.md", type: "file", size: 100, mtime: null }] },
    tests: {
      proofPackets: [{
        dirName: `${name}-proof`,
        primaryMarkdown: { relPath: "proof.md", content: "PASS" },
        additionalMarkdown: [],
        screenshots: ["screenshots/proof.png"],
        videos: [],
        traces: [],
        passFailBadge: "pass",
      }],
      aggregate: { passCount: 1, failCount: 0 },
    },
    topology: { affectedRigs: [{ rigId: "rig-1", rigName: "rig-1", sessionNames: ["driver@rig-1"] }], totalSeats: 1, specGraph: null },
  };
}

function installFetchMock() {
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes("/api/config")) {
      return new Response(
        JSON.stringify({ settings: { "workspace.root": { value: "/Users/admin/.openrig/workspace" } } }),
        { status: 200 },
      );
    }
    if (url.includes("/api/slices/idea-ledger")) {
      return new Response(JSON.stringify(makeDetail("idea-ledger", "RELEASE-PROOF", ["qitem-A"])), { status: 200 });
    }
    if (url.includes("/api/slices/seed-slice-active")) {
      return new Response(JSON.stringify(makeDetail("seed-slice-active", null, [])), { status: 200 });
    }
    if (url.includes("/api/queue/qitem-A")) {
      return new Response(JSON.stringify({
        qitemId: "qitem-A",
        tsCreated: "2026-05-07T22:06:36.083Z",
        tsUpdated: "2026-05-07T22:06:36.083Z",
        sourceSession: "driver@rig",
        destinationSession: "human@host",
        state: "done",
        priority: "urgent",
        tier: "fast",
        tags: ["RELEASE-PROOF"],
        body: "Full queue body for workspace rollup.",
      }), { status: 200 });
    }
    if (url.includes("/api/slices?")) {
      return new Response(
        JSON.stringify({
          slices: [
            {
              name: "idea-ledger",
              displayName: "Idea Ledger release proof slice",
              railItem: "RELEASE-PROOF",
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
}

function renderWorkspaceScope(): ReturnType<typeof render> {
  installFetchMock();

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

function renderMissionScope(): ReturnType<typeof render> {
  installFetchMock();

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const missionRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/project/mission/$missionId",
    component: () => <MissionScopePage />,
  });
  const sliceRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/project/slice/$sliceId",
    component: () => null,
  });
  const fallbackRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "$",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([missionRoute, sliceRoute, fallbackRoute]),
    history: createMemoryHistory({ initialEntries: ["/project/mission/RELEASE-PROOF"] }),
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
    const currentMission = await findByTestId("workspace-overview-mission-RELEASE-PROOF");
    expect(currentMission.getAttribute("data-mission-bucket")).toBe("current");
    expect((await findByTestId("workspace-overview-slice-idea-ledger")).textContent).toContain(
      "78 qitems",
    );

    const archivedMission = await findByTestId("workspace-overview-mission-unsorted");
    expect(archivedMission.getAttribute("data-mission-bucket")).toBe("archive");
  });

  // Slice 19: workspace-overview slice items render single-row
  // (flex layout) with meta inline + title/aria-label for hover +
  // screen-reader discovery. HG-1/2/3/5 of slice 19.
  it("slice 19: workspace-overview slice items are single-row with meta inline + a11y attributes", async () => {
    const { findByTestId } = renderWorkspaceScope();
    const link = await findByTestId("workspace-overview-slice-idea-ledger");
    // Single-row flex layout (not stacked `block` spans)
    expect(link.className).toMatch(/\bflex\b/);
    expect(link.className).not.toMatch(/\bblock\b/);
    // Meta carried via title + aria-label so hover + screen readers
    // surface the version/status detail that left the visible row.
    expect(link.getAttribute("title")).toContain("78 qitems");
    expect(link.getAttribute("aria-label")).toContain("78 qitems");
    // Meta span preserved with its own testid for downstream assertions.
    const meta = await findByTestId("workspace-overview-slice-idea-ledger-meta");
    expect(meta.className).toMatch(/\bshrink-0\b/);
    expect(meta.className).not.toMatch(/\bblock\b/);
    expect(meta.textContent).toContain("78 qitems");
  });

  it("workspace progress, queue, and topology tabs render aggregate scoped data", async () => {
    const { findByTestId } = renderWorkspaceScope();

    fireEvent.click(await findByTestId("project-tab-story"));
    expect(await findByTestId("scope-story-rollup")).toBeTruthy();
    expect((await findByTestId("story-row-queue.created")).textContent).toContain("Full queue body");

    fireEvent.click(await findByTestId("project-tab-progress"));
    expect(await findByTestId("scope-progress-rollup")).toBeTruthy();

    fireEvent.click(await findByTestId("project-tab-tests"));
    expect(await findByTestId("scope-tests-rollup")).toBeTruthy();

    fireEvent.click(await findByTestId("project-tab-queue"));
    expect(await findByTestId("scope-queue-rollup")).toBeTruthy();
    expect((await findByTestId("scope-queue-trigger-qitem-A")).textContent).toContain("Full queue body");

    fireEvent.click(await findByTestId("project-tab-topology"));
    expect(await findByTestId("scope-topology-rollup")).toBeTruthy();
  });

  it("mission scope page filters workspace data to that mission", async () => {
    const { findByTestId, queryByText } = renderMissionScope();

    expect(await findByTestId("mission-overview-panel")).toBeTruthy();
    expect((await findByTestId("mission-overview-panel")).textContent).toContain("Idea Ledger release proof slice");
    expect(queryByText("seed-slice-active")).toBeNull();

    fireEvent.click(await findByTestId("project-tab-queue"));
    expect((await findByTestId("scope-queue-trigger-qitem-A")).textContent).toContain("Full queue body");

    fireEvent.click(await findByTestId("project-tab-story"));
    expect(await findByTestId("scope-story-rollup")).toBeTruthy();
    expect(queryByText("seed-slice-active")).toBeNull();
  });
});
