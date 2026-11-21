// V1 attempt-3 Phase 3 — Topology view-mode tabs IN-PLACE single URL test (SC-10).
//
// LOAD-BEARING: attempt-2 violated this by using separate URLs per
// view-mode (`/topology/host/table` etc). Phase 3 implements view-mode
// tabs as React state IN-PLACE — the URL stays the same when switching
// tabs.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { createMemoryHistory, RouterProvider, createRouter, createRootRoute, createRoute, Outlet } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createMockEventSourceClass } from "./helpers/mock-event-source.js";
import { AppShell } from "../src/components/AppShell.js";
import { HostScopePage, RigScopePage, SeatScopePage } from "../src/components/topology/ScopePages.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

let OriginalEventSource: typeof EventSource | undefined;

beforeEach(async () => {
  mockFetch.mockReset();
  mockFetch.mockImplementation(async () => new Response("[]"));
  OriginalEventSource = globalThis.EventSource;
  globalThis.EventSource = createMockEventSourceClass() as unknown as typeof EventSource;
  const { queryClient } = await import("../src/lib/query-client.js");
  queryClient.clear();
});

afterEach(() => {
  if (OriginalEventSource) globalThis.EventSource = OriginalEventSource;
  cleanup();
});

// Slice 52 (UI wall-clock hardening): the timed fixture no longer imports
// ../src/routes.js. The scope pages + AppShell chrome are what these tests
// assert; the full route tree (all lazy page modules) was the wall-clock-heavy
// import that raced the 5000ms waitFor under fleet load. A minimal router with
// AppShell as the root and only the topology scope routes mounts the SAME
// components with no heavy import and no clock to race. HostScopePage takes no
// params; RigScopePage reads useParams({ from: "/topology/rig/$rigId" }), so
// that route path is spelled exactly to preserve the strict param binding.
function buildTopologyRouter(initialPath: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <AppShell>
          <Outlet />
        </AppShell>
      </QueryClientProvider>
    ),
  });
  const hostRoute = createRoute({ getParentRoute: () => rootRoute, path: "/topology", component: HostScopePage });
  const rigRoute = createRoute({ getParentRoute: () => rootRoute, path: "/topology/rig/$rigId", component: RigScopePage });
  const seatRoute = createRoute({ getParentRoute: () => rootRoute, path: "/topology/seat/$rigId/$logicalId", component: SeatScopePage });
  const catchAll = createRoute({ getParentRoute: () => rootRoute, path: "$", component: () => null });
  const routeTree = rootRoute.addChildren([hostRoute, rigRoute, seatRoute, catchAll]);
  return createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [initialPath] }) });
}

async function renderTopologyAt(initialPath: string) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440, writable: true });
  const r = buildTopologyRouter(initialPath);
  const result = render(<RouterProvider router={r} />);
  // Wait for the app rail to mount (route resolution complete);
  // each test then waits for its scope-specific tab list.
  await waitFor(() => {
    expect(result.container.querySelector("[data-testid='app-rail']")).toBeTruthy();
  }, { timeout: 5000 });
  return { ...result, router: r };
}

describe("SC-10: topology view-mode tabs IN-PLACE single URL", () => {
  it("at /topology, all three host-scope tabs are rendered (graph/table/terminal)", async () => {
    const { container } = await renderTopologyAt("/topology");
    await waitFor(() => {
      expect(container.querySelector("[data-testid='topology-host-tabs']")).toBeTruthy();
    });
    expect(container.querySelector("[data-testid='topology-host-tab-graph']")).toBeTruthy();
    expect(container.querySelector("[data-testid='topology-host-tab-table']")).toBeTruthy();
    expect(container.querySelector("[data-testid='topology-host-tab-terminal']")).toBeTruthy();
  });

  it("clicking a view-mode tab does NOT change the URL — stays at /topology", async () => {
    const { container, router: r } = await renderTopologyAt("/topology");
    await waitFor(() => {
      expect(container.querySelector("[data-testid='topology-host-tab-table']")).toBeTruthy();
    });
    expect(r.history.location.pathname).toBe("/topology");
    const tableTab = container.querySelector("[data-testid='topology-host-tab-table']") as HTMLElement;
    fireEvent.click(tableTab);
    // URL must remain unchanged.
    expect(r.history.location.pathname).toBe("/topology");
    // Active state moved.
    await waitFor(() => {
      expect(tableTab.getAttribute("data-active")).toBe("true");
    });
  });

  it("rig scope at /topology/rig/$rigId carries rig+pod tab set (graph/table/terminal/overview)", async () => {
    const { container } = await renderTopologyAt("/topology/rig/abc-rig");
    await waitFor(() => {
      expect(container.querySelector("[data-testid='topology-rig-tabs']")).toBeTruthy();
    });
    expect(container.querySelector("[data-testid='topology-rig-tab-graph']")).toBeTruthy();
    expect(container.querySelector("[data-testid='topology-rig-tab-table']")).toBeTruthy();
    expect(container.querySelector("[data-testid='topology-rig-tab-terminal']")).toBeTruthy();
    expect(container.querySelector("[data-testid='topology-rig-tab-overview']")).toBeTruthy();
  });

  it("seat scope switches the current Overview/Details body in place without changing its URL", async () => {
    const detail = {
      rigId: "abc-rig", rigName: "owned-rig", logicalId: "dev.impl", podId: "dev",
      canonicalSessionName: "dev-impl@owned-rig", nodeKind: "infrastructure", runtime: "terminal",
      sessionStatus: "stopped", startupStatus: "ready", restoreOutcome: "n-a", terminalActive: false,
      tmuxAttachCommand: null, resumeCommand: null, latestError: null, model: null,
      agentRef: null, profile: null, resolvedSpecName: null, resolvedSpecVersion: null,
      cwd: "C:\\owned\\workspace", startupFiles: [], startupActions: [], recentEvents: [],
      infrastructureStartupCommand: null, binding: {}, peers: [], edges: { outgoing: [], incoming: [] },
      transcript: { enabled: false, path: null, tailCommand: null }, compactSpec: null,
    };
    mockFetch.mockImplementation(async (url: string) => new Response(JSON.stringify(
      String(url).includes("/api/rigs/abc-rig/nodes/dev.impl") ? detail : [],
    )));
    const url = "/topology/seat/abc-rig/dev.impl";
    const { container, router } = await renderTopologyAt(url);
    await waitFor(() => expect(container.querySelector("[data-testid='live-tab-details']")).toBeTruthy());
    expect(mockFetch.mock.calls.some(([request]) => String(request).includes("/api/rigs/abc-rig/nodes/dev.impl"))).toBe(true);
    expect(container.querySelector("[data-testid='live-overview-section']")).toBeTruthy();
    fireEvent.click(container.querySelector("[data-testid='live-tab-details']")!);
    expect(container.querySelector("[data-testid='live-details-section']")).toBeTruthy();
    expect(container.querySelector("[data-testid='live-overview-section']")).toBeNull();
    expect(router.state.location.pathname).toBe(url);
    fireEvent.click(container.querySelector("[data-testid='live-tab-overview']")!);
    expect(container.querySelector("[data-testid='live-overview-section']")).toBeTruthy();
    expect(router.state.location.pathname).toBe(url);
  });
});

describe("Legacy seat tab definitions", () => {
  it("retains the exported three-tab definition", async () => {
    // This only pins the legacy export shape. The actual current seat page
    // and its route-bound Overview/Details interaction are exercised above.
    const { SEAT_SCOPE_TABS } = await import("../src/components/topology/TopologyViewModeTabs.js");
    expect(SEAT_SCOPE_TABS.map((t) => t.id)).toEqual(["detail", "transcript", "terminal"]);
  });
});

// V1 attempt-3 Phase 3 bounce-fix Class B — selective vellum overlay
// negative assertion (ritual #8): non-topology destinations MUST NEVER
// receive the vellum-translucent overlay treatment. Only the topology
// destination (and only its graph view-mode) gets data-explorer-mode='overlay';
// all other routes — including /, /project, /specs, /for-you, /settings —
// must show data-explorer-mode='opaque' (or no Explorer at all for
// destinations with surface='none').
//
// Codifies the runtime assertion that previously only ran in agent-browser
// during driver self-walk. guard-3 process gate: this test must be in CI.
describe("Class B negative assertion: non-topology routes never get vellum overlay (ritual #8)", () => {
  async function renderAndWait(initialPath: string) {
    // Slice 52: minimal router (no ../src/routes.js import) — same as
    // renderTopologyAt above. Non-topology routes fall through to the
    // catch-all stub; AppShell still computes their surface from the pathname.
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440, writable: true });
    const r = buildTopologyRouter(initialPath);
    const result = render(<RouterProvider router={r} />);
    await waitFor(() => {
      expect(result.container.querySelector("[data-testid='app-rail']")).toBeTruthy();
    }, { timeout: 5000 });
    return result;
  }

  it.each([
    ["/", "Dashboard"],
    ["/project", "Project workspace"],
    ["/specs", "Specs library"],
    ["/for-you", "For You feed"],
    ["/settings", "Settings"],
  ])("route %s (%s) does NOT carry data-explorer-mode='overlay' anywhere in DOM", async (route) => {
    const { container } = await renderAndWait(route);
    const overlayElements = container.querySelectorAll("[data-explorer-mode='overlay']");
    expect(overlayElements.length).toBe(0);
  });

  it("topology graph (/topology) DOES carry data-explorer-mode='overlay' (positive companion)", async () => {
    const { container } = await renderAndWait("/topology");
    // The active tab defaults to 'graph' on first mount per HostScopePage;
    // useOverlayForActiveTab effect sets the topology overlay context to
    // 'overlay'. AppShell propagates that to the Explorer's overlayMode prop.
    await waitFor(() => {
      const explorer = container.querySelector("[data-testid='explorer']");
      expect(explorer?.getAttribute("data-explorer-mode")).toBe("overlay");
    }, { timeout: 5000 });
  });
});

// CSS-source-assertion regression test (per pseudo-element-paint contract):
// guard that routes.tsx never grows view-mode-as-URL paths
// (e.g., `/topology/host/table`, `/topology/rig/$rigId/graph`).
// Attempt-2 violated SC-10 with exactly this anti-pattern.
describe("SC-10 source-assertion regression — no view-mode-as-URL paths in routes.tsx", () => {
  const ROUTES_SRC = readFileSync(
    path.resolve(__dirname, "../src/routes.tsx"),
    "utf8",
  );

  const FORBIDDEN_PATTERNS: { name: string; re: RegExp }[] = [
    { name: "/topology/host/table", re: /\/topology\/host\/table/ },
    { name: "/topology/host/terminal", re: /\/topology\/host\/terminal/ },
    { name: "/topology/host/graph", re: /\/topology\/host\/graph/ },
    { name: "/topology/rig/$rigId/table", re: /\/topology\/rig\/\$rigId\/table/ },
    { name: "/topology/rig/$rigId/graph", re: /\/topology\/rig\/\$rigId\/graph/ },
    { name: "/topology/rig/$rigId/terminal", re: /\/topology\/rig\/\$rigId\/terminal/ },
    { name: "/topology/seat/$rigId/$logicalId/transcript", re: /\/topology\/seat\/\$rigId\/\$logicalId\/transcript/ },
    { name: "/topology/seat/$rigId/$logicalId/terminal", re: /\/topology\/seat\/\$rigId\/\$logicalId\/terminal/ },
  ];

  for (const f of FORBIDDEN_PATTERNS) {
    it(`routes.tsx does NOT contain forbidden view-mode-as-URL path: ${f.name}`, () => {
      expect(ROUTES_SRC).not.toMatch(f.re);
    });
  }
});
