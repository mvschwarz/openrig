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
import { TopologyOverlayProvider } from "../src/components/topology/topology-overlay-context.js";
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

// V0.3.1 slice 12.5 — workspace topology now renders via
// HostMultiRigGraph; tests may override /api/ps to exercise the N=1 vs
// N=2 rig-clustering paths.
type PsEntry = {
  rigId: string;
  name: string;
  nodeCount: number;
  runningCount: number;
  status: "running" | "partial" | "stopped";
  uptime: null;
  latestSnapshot: null;
};

const SINGLE_RIG_PS: PsEntry[] = [
  {
    rigId: "rig-1",
    name: "rig-1",
    nodeCount: 1,
    runningCount: 1,
    status: "running",
    uptime: null,
    latestSnapshot: null,
  },
];

function installFetchMock(opts: { psEntries?: PsEntry[] } = {}) {
  const psEntries = opts.psEntries ?? SINGLE_RIG_PS;
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes("/api/config")) {
      return new Response(
        JSON.stringify({ settings: { "workspace.root": { value: "/Users/admin/.openrig/workspace" } } }),
        { status: 200 },
      );
    }
    // HostMultiRigGraph fetches /api/ps for rig inventory + per-rig
    // /api/rigs/<id>/graph for expanded rig contents. Provide minimal
    // responses so the swap test renders without network errors.
    if (url === "/api/ps" || url.startsWith("/api/ps?")) {
      return new Response(JSON.stringify(psEntries), { status: 200 });
    }
    const rigGraphMatch = url.match(/\/api\/rigs\/([^/]+)\/graph/);
    if (rigGraphMatch) {
      return new Response(JSON.stringify({ nodes: [], edges: [] }), { status: 200 });
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

function renderWorkspaceScope(
  opts: { psEntries?: PsEntry[] } = {},
): ReturnType<typeof render> {
  installFetchMock(opts);

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // V0.3.1 slice 12.5 — TopologyOverlayProvider must be INSIDE the
  // router (HostMultiRigGraph's useRouterState dependency), so wrap
  // <Outlet /> in the root route component, not the RouterProvider.
  const rootRoute = createRootRoute({
    component: () => (
      <TopologyOverlayProvider>
        <Outlet />
      </TopologyOverlayProvider>
    ),
  });
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
  // V0.3.1 slice 12.5 — mission scope topology fallback still uses
  // ScopeTopologyRollup when no specGraph is declared, so the
  // TopologyOverlayProvider isn't strictly required here. Wrap anyway
  // for symmetry with the workspace helper above (and so future tests
  // that exercise HostMultiRigGraph-shaped fallbacks have a working
  // context).
  const rootRoute = createRootRoute({
    component: () => (
      <TopologyOverlayProvider>
        <Outlet />
      </TopologyOverlayProvider>
    ),
  });
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
    expect((await findByTestId("workspace-overview-slice-idea-ledger-qitems")).textContent).toContain("78");

    const archivedMission = await findByTestId("workspace-overview-mission-unsorted");
    expect(archivedMission.getAttribute("data-mission-bucket")).toBe("archive");
  });

  // Slice 19 follow-up: workspace-overview slice items keep title/aria
  // metadata but replace prose meta with compact qitem/status icons.
  it("slice 19 follow-up: workspace-overview slice items use wrapped names with queue/status icons", async () => {
    const { findByTestId } = renderWorkspaceScope();
    const link = await findByTestId("workspace-overview-slice-idea-ledger");
    expect(link.className).toMatch(/\bflex\b/);
    expect(link.className).not.toMatch(/\bblock\b/);
    expect(link.getAttribute("title")).toContain("78 qitems");
    expect(link.getAttribute("aria-label")).toContain("78 qitems");
    const meta = await findByTestId("workspace-overview-slice-idea-ledger-meta");
    expect(meta.className).toMatch(/\bflex\b/);
    expect(meta.className).not.toMatch(/\bblock\b/);
    expect(meta.textContent).toBe("78");
    expect((await findByTestId("workspace-overview-slice-idea-ledger-qitems")).getAttribute("aria-label")).toBe("78 qitems");
    expect((await findByTestId("workspace-overview-slice-idea-ledger-status")).getAttribute("data-tone")).toBe("success");
    expect(link.textContent).not.toContain("qitems");
    expect(link.firstElementChild?.className).toContain("whitespace-normal");
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

    // V0.3.1 slice 12.5 — workspace topology now renders via
    // HostMultiRigGraph (rigs as distinct visual clusters) instead of
    // the flat session-name ScopeTopologyRollup. Mission-scope topology
    // fallback continues to use ScopeTopologyRollup when no specGraph
    // is declared.
    fireEvent.click(await findByTestId("project-tab-topology"));
    expect(await findByTestId("workspace-topology-hostmultirig")).toBeTruthy();
    expect(await findByTestId("host-multi-rig-graph")).toBeTruthy();
  });

  // V0.3.1 slice 12.5 HG-3 — N=1 rig fixture renders cleanly as a
  // single rig cluster on the workspace topology surface (no flat
  // session-name aggregation).
  it("slice 12.5 HG-3: single-rig workspace renders a single rig cluster on /topology", async () => {
    const { findByTestId, queryByTestId } = renderWorkspaceScope({
      psEntries: SINGLE_RIG_PS,
    });
    fireEvent.click(await findByTestId("project-tab-topology"));
    expect(await findByTestId("workspace-topology-hostmultirig")).toBeTruthy();
    expect(await findByTestId("host-multi-rig-graph")).toBeTruthy();
    expect(await findByTestId("rig-group-node-rig-1")).toBeTruthy();
    expect(queryByTestId("rig-group-node-rig-2")).toBeNull();
    // Back-compat: the legacy flat session-name rollup is NOT mounted
    // for the workspace topology surface anymore.
    expect(queryByTestId("scope-topology-rollup")).toBeNull();
  });

  // V0.3.1 slice 12.5 HG-2 — N=2+ rig fixture renders distinct visual
  // rig clusters. Compounds with slice 05 (kernel-rig-as-default ships
  // multi-rig workspaces): without rig-clustering, kernel agents make
  // the flat view noisier; with rig-clustering, structure stays legible
  // as rigs multiply.
  it("slice 12.5 HG-2: multi-rig workspace renders distinct rig clusters on /topology", async () => {
    const { findByTestId } = renderWorkspaceScope({
      psEntries: [
        ...SINGLE_RIG_PS,
        {
          rigId: "rig-2",
          name: "openrig-kernel",
          nodeCount: 2,
          runningCount: 2,
          status: "running",
          uptime: null,
          latestSnapshot: null,
        },
      ],
    });
    fireEvent.click(await findByTestId("project-tab-topology"));
    expect(await findByTestId("workspace-topology-hostmultirig")).toBeTruthy();
    expect(await findByTestId("host-multi-rig-graph")).toBeTruthy();
    expect(await findByTestId("rig-group-node-rig-1")).toBeTruthy();
    expect(await findByTestId("rig-group-node-rig-2")).toBeTruthy();
  });

  it("mission scope page filters workspace data to that mission", async () => {
    const { findByTestId, queryByText } = renderMissionScope();

    expect(await findByTestId("mission-overview-panel")).toBeTruthy();
    expect((await findByTestId("mission-overview-panel")).textContent).toContain("Idea Ledger release proof slice");
    expect((await findByTestId("mission-overview-slice-idea-ledger-qitems")).textContent).toContain("78");
    expect((await findByTestId("mission-overview-slice-idea-ledger-status")).getAttribute("data-tone")).toBe("success");
    expect(queryByText("seed-slice-active")).toBeNull();

    fireEvent.click(await findByTestId("project-tab-queue"));
    expect((await findByTestId("scope-queue-trigger-qitem-A")).textContent).toContain("Full queue body");

    fireEvent.click(await findByTestId("project-tab-story"));
    expect(await findByTestId("scope-story-rollup")).toBeTruthy();
    expect(queryByText("seed-slice-active")).toBeNull();
  });
});
