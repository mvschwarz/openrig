// OPR.0.4.6.MH2 — the UI host level: FR-2 plumbing (withHostParam identity
// for local = the zero-regression negative), FR-1 tree host level (expand =
// select, one write path), FR-3 indicator states, FR-5 HOSTS toggles over
// the shipped subscription write path.

import type { ReactElement } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import {
  createMemoryHistory,
  RouterProvider,
  createRouter,
  createRootRoute,
  createRoute,
  Outlet,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { withHostParam, LOCAL_HOST_ID } from "../src/lib/host-param.js";
import { TopologyTreeView } from "../src/components/topology/TopologyTreeView.js";
import { HostIndicator } from "../src/components/HostIndicator.js";
import { SubscriptionToggleList } from "../src/components/for-you/SubscriptionToggleList.js";
import { ProjectTreeView } from "../src/components/project/ProjectTreeView.js";
import { SliceScopePage } from "../src/components/project/ScopePages.js";
import { TopologyTableView } from "../src/components/topology/TopologyTableView.js";
import { TopologyTerminalView } from "../src/components/topology/TopologyTerminalView.js";
import { RigScopePage } from "../src/components/topology/ScopePages.js";
import { DiscoveryPanel } from "../src/components/DiscoveryPanel.js";
import { useClearPlacementOnHostSwitch } from "../src/hooks/useHosts.js";

// DiscoveryPanel's discovery hooks are mocked file-wide (no other test here
// consumes them) — the regressions assert AFFORDANCE state, and the adopt
// POST path is covered by zero-POST fetch asserts.
const mockUseDiscoveredSessions = vi.fn();
const mockUseDiscoveryScan = vi.fn();
const mockUseAdoptSession = vi.fn();
vi.mock("../src/hooks/useDiscovery.js", async (importActual) => {
  const actual = await importActual<typeof import("../src/hooks/useDiscovery.js")>();
  return {
    ...actual,
    useDiscoveredSessions: (...args: unknown[]) => mockUseDiscoveredSessions(...args),
    useDiscoveryScan: () => mockUseDiscoveryScan(),
    useAdoptSession: () => mockUseAdoptSession(),
  };
});
import { TopologyTab } from "../src/components/slices/tabs/TopologyTab.js";
import { LiveNodeDetails } from "../src/components/LiveNodeDetails.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch as unknown as typeof fetch;

interface HostsPayload {
  ownName: string;
  selected: string;
  hosts: Array<{ id: string; transport: string; url?: string; selected: boolean; status: string }>;
}

const HOSTS_TWO: HostsPayload = {
  ownName: "Linkpix Proof Host",
  selected: "local",
  hosts: [
    { id: "vps-a", transport: "http", url: "http://vps-a:7433", selected: false, status: "reachable" },
    { id: "vps-b", transport: "http", url: "http://vps-b:7433", selected: false, status: "unreachable" },
  ],
};

function wireFetch(opts: { hosts?: HostsPayload; settings?: Record<string, unknown>; feedHostSubscriptions?: Array<{ hostId: string; enabled: boolean }> } = {}) {
  mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") return { ok: true, json: async () => ({ ok: true }) };
    if (url === "/api/hosts") {
      return { ok: true, json: async () => opts.hosts ?? { ownName: "localhost", selected: "local", hosts: [] } };
    }
    if (url === "/api/config") {
      return {
        ok: true,
        json: async () => ({
          settings: opts.settings ?? {},
          feedHostSubscriptions: opts.feedHostSubscriptions ?? [],
        }),
      };
    }
    return { ok: true, json: async () => [] };
  });
}

function renderWithRouter(node: () => ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: node });
  const mk = (path: string) => createRoute({ getParentRoute: () => rootRoute, path, component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      indexRoute,
      mk("/topology"),
      mk("/topology/rig/$rigId"),
      mk("/topology/pod/$rigId/$podName"),
      mk("/topology/seat/$rigId/$logicalId"),
    ]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockFetch.mockReset();
});
// This vitest setup has NO RTL auto-cleanup (the MH-1 field lesson) —
// explicit cleanup keeps containers from accumulating across tests.
afterEach(() => {
  cleanup();
});

describe("withHostParam (FR-2 — the zero-regression negative)", () => {
  it("is the IDENTITY for local / absent / empty host", () => {
    expect(withHostParam("/api/ps", LOCAL_HOST_ID)).toBe("/api/ps");
    expect(withHostParam("/api/ps", undefined)).toBe("/api/ps");
    expect(withHostParam("/api/ps", "")).toBe("/api/ps");
    expect(withHostParam("/api/slices?filter=all", LOCAL_HOST_ID)).toBe("/api/slices?filter=all");
  });

  it("appends the host envelope with ?/& awareness and encoding", () => {
    expect(withHostParam("/api/ps", "vps-a")).toBe("/api/ps?host=vps-a");
    expect(withHostParam("/api/slices?filter=all", "vps-a")).toBe("/api/slices?filter=all&host=vps-a");
    expect(withHostParam("/api/ps", "a b")).toBe("/api/ps?host=a%20b");
  });
});

describe("TopologyTreeView host level (FR-1)", () => {
  it("empty registry: single chip-less local node — today's tree shape (zero-regression)", async () => {
    wireFetch(); // no hosts
    renderWithRouter(() => <TopologyTreeView />);
    await waitFor(() => expect(screen.getByTestId("topology-host-localhost")).toBeTruthy());
    expect(screen.queryByTestId("topology-host-chip-local")).toBeNull();
    expect(screen.queryByTestId("topology-host-vps-a")).toBeNull();
  });

  it("registry hosts render as collapsed nodes; local is expanded + viewing", async () => {
    // The tree's local label reads MH-1's canonical stored name — the
    // host.name SETTINGS key (the settings twins), not the hosts payload.
    wireFetch({ hosts: HOSTS_TWO, settings: { "host.name": { value: "Linkpix Proof Host" } } });
    renderWithRouter(() => <TopologyTreeView />);
    await waitFor(() => expect(screen.getByTestId("topology-host-vps-a")).toBeTruthy());
    const local = screen.getByTestId("topology-host-localhost");
    expect(local.getAttribute("data-selected")).toBe("true");
    await waitFor(() => expect(local.textContent).toContain("Linkpix Proof Host"));
    expect(screen.getByTestId("topology-host-chip-local").textContent).toBe("viewing");
    const vpsA = screen.getByTestId("topology-host-vps-a");
    expect(vpsA.getAttribute("data-selected")).toBe("false");
    // the unreachable registry probe renders honestly on the collapsed row
    expect(screen.getByTestId("topology-host-chip-vps-b").textContent).toBe("unreachable");
  });

  it("clicking a collapsed host writes the ONE selection key (expand = select)", async () => {
    wireFetch({ hosts: HOSTS_TWO });
    renderWithRouter(() => <TopologyTreeView />);
    await waitFor(() => expect(screen.getByTestId("topology-host-vps-a")).toBeTruthy());
    fireEvent.click(screen.getByTestId("topology-host-vps-a").querySelector("button")!);
    await waitFor(() => {
      const post = mockFetch.mock.calls.find(
        ([url, init]) => String(url) === "/api/config/host.selected" && (init as RequestInit)?.method === "POST",
      );
      expect(post).toBeTruthy();
      expect(JSON.parse((post![1] as RequestInit).body as string)).toEqual({ value: "vps-a" });
    });
  });

  it("remote selected: its node is the expanded one; Archive stays local-only", async () => {
    wireFetch({ hosts: { ...HOSTS_TWO, selected: "vps-a" } });
    renderWithRouter(() => <TopologyTreeView />);
    await waitFor(() =>
      expect(screen.getByTestId("topology-host-vps-a").getAttribute("data-selected")).toBe("true"),
    );
    expect(screen.getByTestId("topology-host-localhost").getAttribute("data-selected")).toBe("false");
    // the archived-rigs read is not allowlisted — no Archive under a remote host
    expect(screen.queryByTestId("topology-archive-section")).toBeNull();
  });
});

describe("HostIndicator (FR-3 — truthful states)", () => {
  it("defaults to the quiet local state with no hosts payload", async () => {
    wireFetch();
    renderWithRouter(() => <HostIndicator />);
    await waitFor(() => expect(screen.getByTestId("host-indicator")).toBeTruthy());
    const el = screen.getByTestId("host-indicator");
    expect(el.getAttribute("data-state")).toBe("local");
    expect(el.textContent?.toLowerCase()).toContain("localhost");
  });

  it("local with an own-name renders the name (quiet register)", async () => {
    wireFetch({ hosts: HOSTS_TWO });
    renderWithRouter(() => <HostIndicator />);
    await waitFor(() =>
      expect(screen.getByTestId("host-indicator").textContent).toContain("Linkpix Proof Host"),
    );
    expect(screen.getByTestId("host-indicator").getAttribute("data-state")).toBe("local");
  });

  it("remote selected renders the emphasized VIEWING chip naming the host", async () => {
    wireFetch({ hosts: { ...HOSTS_TWO, selected: "vps-a" } });
    renderWithRouter(() => <HostIndicator />);
    await waitFor(() =>
      expect(screen.getByTestId("host-indicator").getAttribute("data-state")).toBe("viewing"),
    );
    expect(screen.getByTestId("host-indicator").textContent?.toLowerCase()).toContain("vps-a");
  });

  it("a selected host whose registry probe reads unreachable renders the red state", async () => {
    wireFetch({ hosts: { ...HOSTS_TWO, selected: "vps-b" } });
    renderWithRouter(() => <HostIndicator />);
    await waitFor(() =>
      expect(screen.getByTestId("host-indicator").getAttribute("data-state")).toBe("unreachable"),
    );
    expect(screen.getByTestId("host-indicator").textContent?.toLowerCase()).toContain("vps-b");
  });
});

describe("guard-B1 files gate — a remote selection issues ZERO /api/files/* requests", () => {
  const SLICE_DETAIL = {
    name: "test-slice",
    displayName: "Test Slice",
    slicePath: "/remote/workspace/missions/m1/slices/test-slice",
    missionId: "m1",
    qitemIds: [],
    status: "active",
    acceptance: { currentStep: null, items: [] },
    tests: { proofPackets: [] },
    topology: null,
  };

  function wireFilesGateFetch(selected: string) {
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === "POST") return { ok: true, json: async () => ({ ok: true }) };
      if (u === "/api/hosts") return { ok: true, json: async () => ({ ...HOSTS_TWO, selected }) };
      if (u === "/api/config") return { ok: true, json: async () => ({ settings: { "workspace.root": { value: "/local/ws" } }, feedHostSubscriptions: [] }) };
      if (u.startsWith("/api/files/roots")) return { ok: true, json: async () => ({ roots: [{ name: "ws", path: "/local/ws" }] }) };
      if (u.startsWith("/api/files/list")) return { ok: true, json: async () => ({ root: "ws", path: "missions", entries: [] }) };
      if (u.startsWith("/api/slices/test-slice")) return { ok: true, json: async () => SLICE_DETAIL };
      if (u.startsWith("/api/slices")) return { ok: true, json: async () => ({ slices: [] }) };
      // Review composer deliberately errors — its UNAVAILABLE state is a
      // deterministic render; the PROOF.md scope-markdown hook has already
      // run by then (hooks precede early returns), which is what we gate.
      if (u.startsWith("/api/review")) return { ok: false, status: 500, json: async () => ({}) };
      if (u.startsWith("/api/scope/audit")) return { ok: true, json: async () => ({ slices: [] }) };
      return { ok: true, json: async () => [] };
    });
  }

  const filesCalls = () => mockFetch.mock.calls.filter(([u]) => String(u).startsWith("/api/files/"));
  const reviewCalls = () => mockFetch.mock.calls.filter(([u]) => String(u).startsWith("/api/review"));

  it("ProjectTreeView: remote-selected → zero file requests; local control → discovery fires (non-vacuous)", async () => {
    wireFilesGateFetch("vps-a");
    renderWithRouter(() => <ProjectTreeView />);
    await waitFor(() => expect(screen.getByTestId("project-host-vps-a")).toBeTruthy());
    expect(filesCalls()).toEqual([]);
    cleanup();
    mockFetch.mockClear();
    // Local control: the same tree with local selected DOES walk discovery —
    // proving this harness would catch a gate violation.
    wireFilesGateFetch("local");
    renderWithRouter(() => <ProjectTreeView />);
    await waitFor(() => expect(screen.getByTestId("project-workspace-node")).toBeTruthy());
    await waitFor(() => expect(filesCalls().length).toBeGreaterThan(0));
  });

  it("SliceScopePage default Review path: remote-selected → zero file requests; local control → PROOF.md roots fetch fires", async () => {
    wireFilesGateFetch("vps-a");
    const qc1 = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const rootRoute1 = createRootRoute({ component: () => <Outlet /> });
    const sliceRoute1 = createRoute({ getParentRoute: () => rootRoute1, path: "/project/slice/$sliceId", component: SliceScopePage });
    const router1 = createRouter({
      routeTree: rootRoute1.addChildren([sliceRoute1]),
      history: createMemoryHistory({ initialEntries: ["/project/slice/test-slice"] }),
    });
    render(
      <QueryClientProvider client={qc1}>
        <RouterProvider router={router1} />
      </QueryClientProvider>,
    );
    // Under remote the Review tab renders the honest gated state (the
    // composer reads LOCAL /api/review — same A-over-B class, API flavor).
    await waitFor(() => expect(screen.getByTestId("slice-review-remote-gated")).toBeTruthy());
    expect(filesCalls()).toEqual([]);
    expect(reviewCalls()).toEqual([]);
    cleanup();
    mockFetch.mockClear();
    // Local control: same page, local selected — the PROOF.md scope reader
    // resolves against local roots, so /api/files/roots fires.
    wireFilesGateFetch("local");
    const qc2 = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const rootRoute2 = createRootRoute({ component: () => <Outlet /> });
    const sliceRoute2 = createRoute({ getParentRoute: () => rootRoute2, path: "/project/slice/$sliceId", component: SliceScopePage });
    const router2 = createRouter({
      routeTree: rootRoute2.addChildren([sliceRoute2]),
      history: createMemoryHistory({ initialEntries: ["/project/slice/test-slice"] }),
    });
    render(
      <QueryClientProvider client={qc2}>
        <RouterProvider router={router2} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(filesCalls().length).toBeGreaterThan(0));
    // Local-positive /api/review control: the composer DOES fire when
    // known-local — proving the review-gate assertions are non-vacuous.
    await waitFor(() => expect(reviewCalls().length).toBeGreaterThan(0));
  });

  it("SliceScopePage Review under an UNKNOWN selection: pending state, zero /api/review (the race class)", async () => {
    // /api/hosts NEVER resolves — the selection stays unknown; the review
    // composer must not fire local reads on the local-presumed default.
    wireFilesGateFetch("vps-a");
    const base = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url) === "/api/hosts") return new Promise(() => {});
      return base(url, init);
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const rootRoute = createRootRoute({ component: () => <Outlet /> });
    const sliceRoute = createRoute({ getParentRoute: () => rootRoute, path: "/project/slice/$sliceId", component: SliceScopePage });
    const router = createRouter({
      routeTree: rootRoute.addChildren([sliceRoute]),
      history: createMemoryHistory({ initialEntries: ["/project/slice/test-slice"] }),
    });
    render(
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("slice-review-selection-pending")).toBeTruthy());
    expect(reviewCalls()).toEqual([]);
    expect(filesCalls()).toEqual([]);
  });

  it("MissionScopePage Review tab: remote-selected → honest gate + zero /api/review; local control → composer fires", async () => {
    const { MissionScopePage } = await import("../src/components/project/ScopePages.js");
    // The default steering landing renders first — give it a valid payload
    // so the walk to the Review tab is deterministic; the review composer
    // itself deliberately 500s (its error state is deterministic and the
    // fetch COUNT is what the control asserts).
    const wireMission = (selected: string) => {
      wireFilesGateFetch(selected);
      const base = mockFetch.getMockImplementation()!;
      mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.startsWith("/api/steering")) {
          return {
            ok: true,
            json: async () => ({ priorityStack: null, roadmapRail: null, laneRails: [], unavailableSources: [] }),
          };
        }
        if (u.startsWith("/api/missions/")) {
          return { ok: true, json: async () => ({ missionId: "m1", missionPath: "/remote/ws/missions/m1", slices: [] }) };
        }
        return base(url, init);
      });
    };
    const mountMission = (qc: QueryClient) => {
      const rootRoute = createRootRoute({ component: () => <Outlet /> });
      const missionRoute = createRoute({ getParentRoute: () => rootRoute, path: "/project/mission/$missionId", component: MissionScopePage });
      const router = createRouter({
        routeTree: rootRoute.addChildren([missionRoute]),
        history: createMemoryHistory({ initialEntries: ["/project/mission/m1"] }),
      });
      return render(
        <QueryClientProvider client={qc}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      );
    };

    wireMission("vps-a");
    mountMission(new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }));
    await waitFor(() => expect(screen.getByTestId("project-tab-review")).toBeTruthy());
    fireEvent.click(screen.getByTestId("project-tab-review"));
    await waitFor(() => expect(screen.getByTestId("mission-review-remote-gated")).toBeTruthy());
    expect(reviewCalls()).toEqual([]);
    cleanup();
    mockFetch.mockClear();

    wireMission("local");
    mountMission(new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }));
    await waitFor(() => expect(screen.getByTestId("project-tab-review")).toBeTruthy());
    fireEvent.click(screen.getByTestId("project-tab-review"));
    await waitFor(() => expect(reviewCalls().length).toBeGreaterThan(0));
  });
});

describe("guard-B1 files gate round 2 — mission landing + portfolio glance (remote never touches /api/files)", () => {
  const MISSION_PAYLOAD = {
    missionPath: "/remote/workspace/missions/m1",
    slices: [],
  };

  function wireMissionFetch(selected: string) {
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === "POST") return { ok: true, json: async () => ({ ok: true }) };
      if (u === "/api/hosts") return { ok: true, json: async () => ({ ...HOSTS_TWO, selected }) };
      if (u === "/api/config") return { ok: true, json: async () => ({ settings: { "workspace.root": { value: "/local/ws" } }, feedHostSubscriptions: [] }) };
      if (u.startsWith("/api/files/roots")) return { ok: true, json: async () => ({ roots: [{ name: "ws", path: "/local/ws" }] }) };
      if (u.startsWith("/api/files/read")) return { ok: true, json: async () => ({ root: "ws", path: "x", absolutePath: "/local/ws/x", content: "## Building\nstuff", mtime: "now", contentHash: "h", size: 1 }) };
      if (u.startsWith("/api/missions/")) return { ok: true, json: async () => MISSION_PAYLOAD };
      if (u.startsWith("/api/slices")) return { ok: true, json: async () => ({ slices: [] }) };
      if (u.startsWith("/api/scope/audit")) return { ok: true, json: async () => ({ slices: [] }) };
      return { ok: true, json: async () => [] };
    });
  }

  const filesCalls2 = () => mockFetch.mock.calls.filter(([u]) => String(u).startsWith("/api/files/"));

  it("MissionScopePage default steering landing: remote-selected → zero file requests (honest gated brief); local control → roots fires", async () => {
    const { MissionScopePage } = await import("../src/components/project/ScopePages.js");
    const mountAt = (qc: QueryClient) => {
      const rootRoute = createRootRoute({ component: () => <Outlet /> });
      const missionRoute = createRoute({ getParentRoute: () => rootRoute, path: "/project/mission/$missionId", component: MissionScopePage });
      const router = createRouter({
        routeTree: rootRoute.addChildren([missionRoute]),
        history: createMemoryHistory({ initialEntries: ["/project/mission/m1"] }),
      });
      return render(
        <QueryClientProvider client={qc}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      );
    };

    wireMissionFetch("vps-a");
    mountAt(new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }));
    await waitFor(() => expect(screen.getByTestId("brief-panel-remote-gated")).toBeTruthy());
    expect(filesCalls2()).toEqual([]);
    cleanup();
    mockFetch.mockClear();

    // Local control: the same landing DOES read MISSION_BRIEF via the roots
    // resolver — proving the harness catches gate violations.
    wireMissionFetch("local");
    mountAt(new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } }));
    await waitFor(() => expect(filesCalls2().length).toBeGreaterThan(0));
  });

  it("WorkspacePortfolioPanel expanded MissionGlance: remote-selected → zero file requests (honest gated glance); local control → roots fires", async () => {
    const { WorkspacePortfolioPanel } = await import("../src/components/project/WorkspacePortfolioPanel.js");
    const SLICE_ROW = {
      name: "s1",
      displayName: "S1",
      missionId: "m1",
      status: "active",
      qitemCount: 0,
      hasProofPacket: false,
    };
    const wire = (selected: string) => {
      wireMissionFetch(selected);
      const base = mockFetch.getMockImplementation()!;
      mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
        if (String(url).startsWith("/api/slices")) return { ok: true, json: async () => ({ slices: [SLICE_ROW] }) };
        return base(url, init);
      });
    };

    wire("vps-a");
    renderWithRouter(() => <WorkspacePortfolioPanel />);
    await waitFor(() => expect(screen.getByTestId("portfolio-toggle-m1")).toBeTruthy());
    fireEvent.click(screen.getByTestId("portfolio-toggle-m1"));
    await waitFor(() => expect(screen.getByTestId("portfolio-glance-remote-gated-m1")).toBeTruthy());
    expect(filesCalls2()).toEqual([]);
    cleanup();
    mockFetch.mockClear();

    // Local control: the expanded glance DOES read MISSION_BRIEF via roots.
    wire("local");
    renderWithRouter(() => <WorkspacePortfolioPanel />);
    await waitFor(() => expect(screen.getByTestId("portfolio-toggle-m1")).toBeTruthy());
    fireEvent.click(screen.getByTestId("portfolio-toggle-m1"));
    await waitFor(() => expect(filesCalls2().length).toBeGreaterThan(0));
  });
});

describe("SubscriptionToggleList HOSTS section (FR-5 — complete, don't rebuild)", () => {
  it("no hosts + no subscription rows: NO hosts section — today's panel (zero-regression)", async () => {
    wireFetch();
    renderWithRouter(() => <SubscriptionToggleList />);
    await waitFor(() => expect(screen.getByTestId("subscription-toggle-list")).toBeTruthy());
    expect(screen.queryByTestId("subscription-host-toggle-list")).toBeNull();
  });

  it("renders this-host forced ON + per-host rows from registry ∪ persisted subscriptions", async () => {
    wireFetch({
      hosts: HOSTS_TWO,
      feedHostSubscriptions: [
        { hostId: "vps-a", enabled: true },
        { hostId: "vps-gone", enabled: true }, // persisted row outliving its registry entry — still rendered
      ],
    });
    renderWithRouter(() => <SubscriptionToggleList />);
    await waitFor(() => expect(screen.getByTestId("subscription-host-toggle-list")).toBeTruthy());
    expect(screen.getByTestId("subscription-host-toggle-local").textContent).toContain("forced ON");
    expect(screen.getByTestId("subscription-host-toggle-vps-a").getAttribute("data-on")).toBe("true");
    expect(screen.getByTestId("subscription-host-toggle-vps-b").getAttribute("data-on")).toBe("false");
    expect(screen.getByTestId("subscription-host-toggle-vps-gone").getAttribute("data-on")).toBe("true");
  });

  it("toggling a host writes the SHIPPED per-host subscription key (a local config write, never read-through)", async () => {
    wireFetch({ hosts: HOSTS_TWO, feedHostSubscriptions: [{ hostId: "vps-a", enabled: true }] });
    renderWithRouter(() => <SubscriptionToggleList />);
    await waitFor(() => expect(screen.getByTestId("subscription-host-toggle-vps-a-button")).toBeTruthy());
    fireEvent.click(screen.getByTestId("subscription-host-toggle-vps-a-button"));
    await waitFor(() => {
      const post = mockFetch.mock.calls.find(
        ([url, init]) =>
          String(url) === "/api/config/feed.subscriptions.vps-a.enabled" && (init as RequestInit)?.method === "POST",
      );
      expect(post).toBeTruthy();
      expect(JSON.parse((post![1] as RequestInit).body as string)).toEqual({ value: "false" });
    });
  });
});

// ── rev1-r2 B1/B2 — remote views mount NO local action affordances and fire
// NO bare local requests (FR-7 UI contract). Every remote zero-case carries a
// LOCAL-POSITIVE CONTROL proving the harness would catch a violation.
// The gate primitive is the useSelectedHostId CACHE OBSERVER, so these tests
// PRIME the ["hosts"] cache directly (no /api/hosts fetch needed).

describe("rev1-r2 B1/B2 — remote action gates (topology table / terminal grid / slice seats / seat page)", () => {
  let OriginalEventSource: typeof EventSource | undefined;

  beforeEach(() => {
    OriginalEventSource = globalThis.EventSource;
    // useTopologyActivity surfaces (table + seat page) subscribe to SSE.
    class StubEventSource {
      onmessage: ((e: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      addEventListener() {}
      removeEventListener() {}
      close() {}
    }
    globalThis.EventSource = StubEventSource as unknown as typeof EventSource;
  });
  afterEach(() => {
    if (OriginalEventSource) globalThis.EventSource = OriginalEventSource;
  });

  const RIG_SUMMARY = [{ id: "r1", name: "rig-one", nodeCount: 1 }];
  const NODES_R1 = [
    {
      logicalId: "a1",
      nodeKind: "agent",
      canonicalSessionName: "a1@rig-one",
      runtime: "claude-code",
      sessionStatus: "running",
      startupStatus: "ready",
    },
  ];
  const NODE_DETAIL_MIN = {
    rigId: "r1", rigName: "rig-one", logicalId: "a1", podId: null,
    canonicalSessionName: "a1@rig-one", nodeKind: "agent", runtime: "claude-code",
    sessionStatus: "running", startupStatus: "ready", restoreOutcome: "n-a",
    tmuxAttachCommand: "tmux attach -t a1@rig-one", resumeCommand: null,
    recoveryGuidance: null, latestError: null, model: null, agentRef: null,
    profile: null, resolvedSpecName: null, resolvedSpecVersion: null, cwd: null,
    startupFiles: [], startupActions: [], recentEvents: [],
    infrastructureStartupCommand: null, peers: [],
    edges: { outgoing: [], incoming: [] },
    transcript: { enabled: false, path: null, tailCommand: null },
    compactSpec: { name: null, version: null, profile: null, skillCount: 0, guidanceCount: 0 },
    agentActivity: null, currentQitems: [],
  };

  /** hostsSelected must MATCH the primed-cache selection — components with an
   *  ACTIVE useHosts (ProjectTreeView) refetch /api/hosts and would otherwise
   *  overwrite the primed entry with a conflicting selection. */
  function hostsPayload(selected: string) {
    return {
      ownName: "Linkpix Proof Host",
      selected,
      hosts: [{ id: "vps-a", transport: "http", url: "http://vps-a:7433", selected: selected === "vps-a", status: "reachable" }],
    };
  }

  function wireB1Fetch(hostsSelected: string = LOCAL_HOST_ID) {
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return { ok: true, json: async () => ({ ok: true }) };
      const u = String(url);
      if (u.startsWith("/api/hosts")) {
        return { ok: true, json: async () => hostsPayload(hostsSelected) };
      }
      if (u.startsWith("/api/rigs/summary")) return { ok: true, json: async () => RIG_SUMMARY };
      if (u.includes("/nodes/")) return { ok: true, json: async () => NODE_DETAIL_MIN };
      if (u.includes("/nodes")) return { ok: true, json: async () => NODES_R1 };
      if (u.includes("/api/specs/library")) return { ok: true, json: async () => [] };
      if (u.startsWith("/api/slices")) return { ok: true, json: async () => ({ slices: [] }) };
      if (u.startsWith("/api/config")) return { ok: true, json: async () => ({ settings: {}, feedHostSubscriptions: [] }) };
      return { ok: true, json: async () => ({}) };
    });
  }

  /** Renders with a PRIMED ["hosts"] cache (the gate primitive is a cache
   *  observer) — gcTime kept finite-large so the primed entry survives. */
  function renderPrimed(node: () => ReactElement, selected: string, opts: { path?: string; entry?: string } = {}) {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 5 * 60_000 } },
    });
    qc.setQueryData(["hosts"], {
      ownName: "Linkpix Proof Host",
      selected,
      hosts: [{ id: "vps-a", transport: "http", url: "http://vps-a:7433", selected: selected === "vps-a", status: "reachable" }],
    });
    const rootRoute = createRootRoute({ component: () => <Outlet /> });
    const nodePath = opts.path ?? "/";
    const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: nodePath, component: node });
    const mk = (path: string) => createRoute({ getParentRoute: () => rootRoute, path, component: () => null });
    const extras = ["/topology", "/topology/rig/$rigId", "/topology/seat/$rigId/$logicalId", "/rigs/$rigId", "$"]
      .filter((p) => p !== nodePath)
      .map(mk);
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, ...extras]),
      history: createMemoryHistory({ initialEntries: [opts.entry ?? nodePath] }),
    });
    return render(
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
  }

  function postCalls() {
    return mockFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST");
  }

  it("TopologyTableView remote: actions cell = honest read-only marker, NO cmux affordance, ZERO POSTs", async () => {
    wireB1Fetch();
    renderPrimed(() => <TopologyTableView />, "vps-a");
    await waitFor(() => expect(screen.getByTestId("topology-table-actions-a1")).toBeTruthy());
    expect(screen.getByTestId("topology-table-actions-a1").getAttribute("data-remote-readonly")).toBe("true");
    expect(screen.queryByTestId("topology-table-cmux-a1")).toBeNull();
    expect(screen.queryByTestId("topology-table-a1-terminal-open")).toBeNull();
    expect(postCalls()).toEqual([]);
  });

  it("TopologyTableView local CONTROL: the cmux affordance renders (the harness catches violations)", async () => {
    wireB1Fetch();
    renderPrimed(() => <TopologyTableView />, LOCAL_HOST_ID);
    await waitFor(() => expect(screen.getByTestId("topology-table-cmux-a1")).toBeTruthy());
    expect(screen.getByTestId("topology-table-actions-a1").getAttribute("data-remote-readonly")).toBeNull();
    // proves the trigger testid shape the remote negative asserts against
    // (the -terminal-popover panel only exists while OPEN; the always-rendered
    // affordance is the -terminal-open trigger button)
    expect(screen.getByTestId("topology-table-a1-terminal-open")).toBeTruthy();
  });

  it("TopologyTerminalView remote: honest gated state, NO terminal grid/picker mounts (zero local session reads)", async () => {
    wireB1Fetch();
    renderPrimed(() => <TopologyTerminalView scope="host" />, "vps-a");
    await waitFor(() => expect(screen.getByTestId("topology-terminal-remote-gated")).toBeTruthy());
    expect(screen.queryByTestId("topology-terminal-host-picker")).toBeNull();
    expect(screen.queryByTestId("topology-terminal-grid")).toBeNull();
    expect(postCalls()).toEqual([]);
  });

  it("TopologyTerminalView local CONTROL: the rig picker renders", async () => {
    wireB1Fetch();
    renderPrimed(() => <TopologyTerminalView scope="host" />, LOCAL_HOST_ID);
    await waitFor(() => expect(screen.getByTestId("topology-terminal-host-picker")).toBeTruthy());
    expect(screen.queryByTestId("topology-terminal-remote-gated")).toBeNull();
  });

  const SLICE_TOPOLOGY = {
    affectedRigs: [{ rigId: "r1", rigName: "rig-one", sessionNames: ["a1@rig-one"] }],
    totalSeats: 1,
    specGraph: null,
  } as Parameters<typeof TopologyTab>[0]["topology"];

  it("slice TopologyTab remote: seat rows read-only — NO preview toggle (click-to-live is a local session read)", async () => {
    wireB1Fetch();
    renderPrimed(() => <TopologyTab topology={SLICE_TOPOLOGY} />, "vps-a");
    await waitFor(() => expect(screen.getByTestId("topology-seat-a1@rig-one")).toBeTruthy());
    expect(screen.getByTestId("topology-seat-a1@rig-one").getAttribute("data-remote-readonly")).toBe("true");
    expect(screen.queryByTestId("topology-seat-a1@rig-one-toggle")).toBeNull();
  });

  it("slice TopologyTab local CONTROL: the preview toggle renders", async () => {
    wireB1Fetch();
    renderPrimed(() => <TopologyTab topology={SLICE_TOPOLOGY} />, LOCAL_HOST_ID);
    await waitFor(() => expect(screen.getByTestId("topology-seat-a1@rig-one-toggle")).toBeTruthy());
  });

  it("seat page remote (B1+B2): host-keyed detail fetch, NO bare local URL, actions row read-only, inline terminal gated, ZERO POSTs", async () => {
    wireB1Fetch();
    renderPrimed(() => <LiveNodeDetails rigId="r1" logicalId="a1" />, "vps-a");
    await waitFor(() => expect(screen.getByTestId("live-node-actions-remote-readonly")).toBeTruthy());
    // B1: no local action affordances, terminal honestly gated
    expect(screen.queryByTestId("detail-cmux-open")).toBeNull();
    expect(screen.queryByTestId("detail-copy-attach")).toBeNull();
    expect(screen.getByTestId("node-detail-terminal-remote-gated")).toBeTruthy();
    // B2: the detail read rides the host envelope; the bare local URL never fires
    const detailCalls = mockFetch.mock.calls.map(([u]) => String(u)).filter((u) => u.includes("/nodes/a1"));
    expect(detailCalls.length).toBeGreaterThan(0);
    expect(detailCalls.every((u) => u === "/api/rigs/r1/nodes/a1?host=vps-a")).toBe(true);
    expect(postCalls()).toEqual([]);
  });

  it("seat page local CONTROL: bare detail URL + the cmux action renders", async () => {
    wireB1Fetch();
    renderPrimed(() => <LiveNodeDetails rigId="r1" logicalId="a1" />, LOCAL_HOST_ID);
    await waitFor(() => expect(screen.getByTestId("detail-cmux-open")).toBeTruthy());
    expect(screen.queryByTestId("live-node-actions-remote-readonly")).toBeNull();
    const detailCalls = mockFetch.mock.calls.map(([u]) => String(u)).filter((u) => u.includes("/nodes/a1"));
    expect(detailCalls.length).toBeGreaterThan(0);
    expect(detailCalls.every((u) => u === "/api/rigs/r1/nodes/a1")).toBe(true);
  });

  // ── rev1-r2 RE-VERDICT B1 — the restore/launch class + the enumerated
  // same-class refresh affordance (mutation-verb enumeration, not feature
  // family). RigGraph's placement-target sibling lives in rig-graph.test.tsx
  // next to its local-positive control.

  const RIG_STATUS = {
    // rigId rides IN the response — RigStatusCard testids derive from
    // status.rigId, not the page param (run-4 field find: omitting it
    // renders rig-primary-action-undefined).
    rigId: "r1", rigName: "rig-one", isKernel: false, status: "down",
    seatsTotal: 1, seatsRunning: 0, recoverable: true, perSeat: [], src: ["daemon"],
  };

  function wireRigScopeFetch(hostsSelected: string = LOCAL_HOST_ID) {
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return { ok: true, json: async () => ({ ok: true }) };
      const u = String(url);
      if (u.startsWith("/api/hosts")) return { ok: true, json: async () => hostsPayload(hostsSelected) };
      if (u.startsWith("/api/rigs/summary")) return { ok: true, json: async () => RIG_SUMMARY };
      if (u.includes("/status")) return { ok: true, json: async () => RIG_STATUS };
      if (u.includes("/graph")) return { ok: true, json: async () => ({ nodes: [], edges: [] }) };
      if (u.includes("/nodes/")) return { ok: true, json: async () => NODE_DETAIL_MIN };
      if (u.includes("/nodes")) return { ok: true, json: async () => NODES_R1 };
      return { ok: true, json: async () => ({}) };
    });
  }

  it("rig-scope remote: NO restore/launch control (honest marker), NO rig-primary-action, NO bare local status read, ZERO POSTs", async () => {
    wireRigScopeFetch("vps-a");
    renderPrimed(() => <RigScopePage />, "vps-a", { path: "/topology/rig/$rigId", entry: "/topology/rig/r1" });
    await waitFor(() => expect(screen.getByTestId("rig-status-remote-readonly")).toBeTruthy());
    expect(document.querySelector('[data-testid^="rig-primary-action"]')).toBeNull();
    const statusCalls = mockFetch.mock.calls.map(([u]) => String(u)).filter((u) => u.includes("/status"));
    expect(statusCalls).toEqual([]);
    expect(postCalls()).toEqual([]);
  });

  it("rig-scope local CONTROL: RigStatusControl mounts — status read fires + the primary action renders", async () => {
    wireRigScopeFetch();
    renderPrimed(() => <RigScopePage />, LOCAL_HOST_ID, { path: "/topology/rig/$rigId", entry: "/topology/rig/r1" });
    await waitFor(() => expect(screen.getByTestId("rig-primary-action-r1")).toBeTruthy());
    expect(screen.queryByTestId("rig-status-remote-readonly")).toBeNull();
    const statusCalls = mockFetch.mock.calls.map(([u]) => String(u)).filter((u) => u.includes("/status"));
    expect(statusCalls).toContain("/api/rigs/r1/status");
  });

  it("project tree remote: the local rescan (refresh) affordance never renders", async () => {
    wireB1Fetch("vps-a");
    renderPrimed(() => <ProjectTreeView />, "vps-a");
    await waitFor(() => expect(screen.getByTestId("project-host-vps-a")).toBeTruthy());
    expect(screen.queryByTestId("project-tree-refresh")).toBeNull();
    expect(postCalls()).toEqual([]);
  });

  it("project tree local CONTROL: the refresh affordance renders", async () => {
    wireB1Fetch();
    renderPrimed(() => <ProjectTreeView />, LOCAL_HOST_ID);
    await waitFor(() => expect(screen.getByTestId("project-tree-refresh")).toBeTruthy());
  });

  // ── rev1-r2 RE-RE-VERDICT B1 (stale placement/adopt) + GUARD tri-state
  // (unknown-selection fail-open on lifecycle surfaces).

  /** UNPRIMED render — the ["hosts"] cache starts EMPTY so the selection is
   *  genuinely UNKNOWN (the guard blocker's window). */
  function renderUnprimed(node: () => ReactElement, opts: { path?: string; entry?: string } = {}) {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: 5 * 60_000 } },
    });
    const rootRoute = createRootRoute({ component: () => <Outlet /> });
    const nodePath = opts.path ?? "/";
    const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: nodePath, component: node });
    const mk = (path: string) => createRoute({ getParentRoute: () => rootRoute, path, component: () => null });
    const extras = ["/topology", "/topology/rig/$rigId", "/topology/seat/$rigId/$logicalId", "/rigs/$rigId", "$"]
      .filter((p) => p !== nodePath)
      .map(mk);
    const router = createRouter({
      routeTree: rootRoute.addChildren([indexRoute, ...extras]),
      history: createMemoryHistory({ initialEntries: [opts.entry ?? nodePath] }),
    });
    return {
      qc,
      view: render(
        <QueryClientProvider client={qc}>
          <RouterProvider router={router} />
        </QueryClientProvider>,
      ),
    };
  }

  it("rig-scope UNKNOWN selection (never-resolving /api/hosts): NO local lifecycle controls, NO bare status read, pending marker only (guard tri-state)", async () => {
    mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return { ok: true, json: async () => ({ ok: true }) };
      const u = String(url);
      if (u.startsWith("/api/hosts")) return new Promise(() => {}); // never resolves — selection stays UNKNOWN
      if (u.startsWith("/api/rigs/summary")) return { ok: true, json: async () => RIG_SUMMARY };
      if (u.includes("/status")) return { ok: true, json: async () => RIG_STATUS };
      if (u.includes("/graph")) return { ok: true, json: async () => ({ nodes: [], edges: [] }) };
      return { ok: true, json: async () => ({}) };
    });
    renderUnprimed(() => <RigScopePage />, { path: "/topology/rig/$rigId", entry: "/topology/rig/r1" });
    await waitFor(() => expect(screen.getByTestId("rig-status-selection-pending")).toBeTruthy());
    expect(document.querySelector('[data-testid^="rig-primary-action"]')).toBeNull();
    expect(document.querySelector('[data-testid^="rig-status-control"]')).toBeNull();
    expect(screen.queryByTestId("rig-status-remote-readonly")).toBeNull();
    const statusCalls = mockFetch.mock.calls.map(([u]) => String(u)).filter((u) => u.includes("/status"));
    expect(statusCalls).toEqual([]);
    expect(postCalls()).toEqual([]);
  });

  const ELIGIBLE_NODE_TARGET = {
    kind: "node" as const,
    rigId: "r1",
    logicalId: "a1",
    eligible: true,
  };

  function wireDiscoveryMocks() {
    // the target-flow region renders INSIDE the selected discovered-session's
    // card — the selected id must resolve to a real session (stage-1 field
    // find: an empty list renders neither the card nor the remote note).
    mockUseDiscoveredSessions.mockReturnValue({
      data: [
        {
          id: "ds-1",
          tmuxSession: "proof-ui-add-pod",
          tmuxWindow: "0",
          tmuxPane: "%7",
          pid: 111,
          cwd: "/Users/example/code/openrig",
          activeCommand: "codex",
          runtimeHint: "codex",
          confidence: "high",
          evidenceJson: null,
          configJson: null,
          status: "active",
          claimedNodeId: null,
          firstSeenAt: "2026-04-02 10:00:00",
          lastSeenAt: "2026-04-02 10:05:00",
        },
      ],
    });
    mockUseDiscoveryScan.mockReturnValue({ mutate: vi.fn(), isPending: false });
    mockUseAdoptSession.mockReturnValue({ mutate: vi.fn(), isPending: false, isError: false, error: null });
  }

  it("discovery panel remote (rev1-r2 stale-target path): an eligible target renders NO target card / NO adopt — honest note + zero POSTs", async () => {
    wireDiscoveryMocks();
    wireB1Fetch("vps-a");
    renderPrimed(
      () => (
        <DiscoveryPanel
          onClose={() => {}}
          selectedDiscoveredId="ds-1"
          onSelectDiscoveredId={() => {}}
          placementTarget={ELIGIBLE_NODE_TARGET}
          onClearPlacement={() => {}}
        />
      ),
      "vps-a",
    );
    await waitFor(() => expect(screen.getByTestId("discovery-remote-readonly")).toBeTruthy());
    expect(screen.queryByTestId("discovery-target-card")).toBeNull();
    expect(screen.queryByTestId("discovery-confirm-adopt")).toBeNull();
    expect(postCalls()).toEqual([]);
  });

  it("discovery panel local CONTROL: the eligible target renders the card + adopt", async () => {
    wireDiscoveryMocks();
    wireB1Fetch();
    renderPrimed(
      () => (
        <DiscoveryPanel
          onClose={() => {}}
          selectedDiscoveredId="ds-1"
          onSelectDiscoveredId={() => {}}
          placementTarget={ELIGIBLE_NODE_TARGET}
          onClearPlacement={() => {}}
        />
      ),
      LOCAL_HOST_ID,
    );
    await waitFor(() => expect(screen.getByTestId("discovery-target-card")).toBeTruthy());
    expect(screen.getByTestId("discovery-confirm-adopt")).toBeTruthy();
    expect(screen.queryByTestId("discovery-remote-readonly")).toBeNull();
  });

  it("the shell belt: ANY selected-host change clears placement (useClearPlacementOnHostSwitch)", async () => {
    wireB1Fetch();
    const clear = vi.fn();
    function Probe() {
      useClearPlacementOnHostSwitch(clear);
      return <div data-testid="belt-probe" />;
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 5 * 60_000 } } });
    qc.setQueryData(["hosts"], {
      ownName: "Linkpix Proof Host",
      selected: "local",
      hosts: [{ id: "vps-a", transport: "http", url: "http://vps-a:7433", selected: false, status: "reachable" }],
    });
    render(
      <QueryClientProvider client={qc}>
        <Probe />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("belt-probe")).toBeTruthy());
    expect(clear).not.toHaveBeenCalled();
    // the host switch — a target created while local must not survive this
    qc.setQueryData(["hosts"], {
      ownName: "Linkpix Proof Host",
      selected: "vps-a",
      hosts: [{ id: "vps-a", transport: "http", url: "http://vps-a:7433", selected: true, status: "reachable" }],
    });
    await waitFor(() => expect(clear).toHaveBeenCalled());
  });
});
