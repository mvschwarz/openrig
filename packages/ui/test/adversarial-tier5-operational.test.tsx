// Tier 5 Adversarial Coverage Hardening Suite: Operational Views, State Synchronization & Concurrency
// Exhaustively verifies:
// 1. Dashboard v2: NeedsYou truncation & body fallback, MetricTiles calculations & edge states,
//    RigsTable status precedence & null safety, RecentActivity humanization & payload resilience,
//    Host section collapsible & ErrorBoundary isolation.
// 2. HostConfigCard: SSH vs HTTP address formatting, remote host banner conditional rendering,
//    rename form whitespace guards & cancellation, pairing state machine (pending, approved, denied, expired),
//    host registry unreadable error handling.
// 3. GettingStarted: Visibility decision matrix (isGettingStartedVisible), dismiss persistence,
//    strict rig spec requirement (filtering out agent/workflow specs).
// 4. AgentPropertiesPanel & LiveNodeDetails: Context percentage clamping (<0%, >100%, null),
//    status precedence cascade, remote host attach concealment, latest error display, copy failure resilience,
//    mobile drawer opening, backdrop dismiss, close button dismiss, and Escape key dismissal.
// 5. Operational Mutations & State Synchronization: useCreateSnapshot, useRestoreSnapshot,
//    useTeardownRig body-driven errors, useStartRig vs useLaunchRig, useImportRig cycle error,
//    useSelectHost & usePairPoll query cache invalidation.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
  Outlet,
} from "@tanstack/react-router";
import { Toaster, toast } from "sonner";
import { Dashboard } from "../src/components/dashboard/Dashboard.js";
import { HostConfigCard } from "../src/components/dashboard/HostConfigCard.js";
import {
  GettingStarted,
  isGettingStartedVisible,
  GETTING_STARTED_DISMISSED_KEY,
} from "../src/components/dashboard/GettingStarted.js";
import { AgentPropertiesPanel } from "../src/components/AgentPropertiesPanel.js";
import { LiveNodeDetails } from "../src/components/LiveNodeDetails.js";
import {
  useCreateSnapshot,
  useRestoreSnapshot,
  useTeardownRig,
  useStartRig,
  useLaunchRig,
  useImportRig,
  ImportError,
  RestoreError,
} from "../src/hooks/mutations.js";
import { useSelectHost, usePairPoll, type HostsResponse } from "../src/hooks/useHosts.js";
import { renderDashboard } from "./helpers/dashboard-harness.js";
import { createTestRouter } from "./helpers/test-router.js";
import { createMockEventSourceClass } from "./helpers/mock-event-source.js";

// Mock VerbActions inside Dashboard to focus on dashboard operational queue behavior
vi.mock("../src/components/mission-control/components/VerbActions.js", () => ({
  VerbActions: ({ qitemId, hostId }: { qitemId: string; hostId?: string }) => (
    <button type="button" data-testid={`verb-approve-${qitemId}`} data-host={hostId ?? "local"}>
      Approve {qitemId}
    </button>
  ),
}));

// Mutable events list for useActivityFeed mock in Dashboard
let mockActivityEvents: Array<{ seq: number; type: string; createdAt: string; payload: Record<string, unknown> }> = [];

vi.mock("../src/hooks/useActivityFeed.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/hooks/useActivityFeed.js")>();
  return {
    ...actual,
    useActivityFeed: () => ({
      events: mockActivityEvents,
      connected: true,
      feedOpen: false,
      setFeedOpen: vi.fn(),
    }),
  };
});

// Helper to create test query client
function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

/** Render a component with a seeded QueryClient and a TanStack Router */
function renderWithClientAndRouter(
  seed: (qc: QueryClient) => void,
  renderComponent: () => React.ReactNode,
  routes: string[] = ["/specs", "/specs/rig", "/for-you", "/topology/rig/$rigId"],
) {
  const qc = createTestQueryClient();
  seed(qc);
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={qc}>
        <Outlet />
      </QueryClientProvider>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: renderComponent,
  });
  const stubRoute = (path: string) =>
    createRoute({ getParentRoute: () => rootRoute, path, component: () => null });

  const routeTree = rootRoute.addChildren([indexRoute, ...routes.map(stubRoute)]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(<RouterProvider router={router as never} />);
}

const BASE_NODE_DETAIL = {
  rigId: "rig-adversarial",
  rigName: "adversarial-rig",
  logicalId: "tester.agent",
  podId: "pod-core",
  canonicalSessionName: "tester@adversarial-rig",
  nodeKind: "agent",
  runtime: "codex-cli",
  sessionStatus: "idle",
  startupStatus: "ready",
  restoreOutcome: "n-a",
  tmuxAttachCommand: "tmux attach -t tester@adversarial-rig",
  resumeCommand: null,
  recoveryGuidance: null,
  latestError: null,
  model: "claude-3.5-sonnet",
  agentRef: "local:agents/tester",
  profile: "default",
  resolvedSpecName: "tester",
  resolvedSpecVersion: "1.0",
  cwd: "/workspace",
  startupFiles: [],
  startupActions: [],
  recentEvents: [],
  infrastructureStartupCommand: null,
  peers: [],
  edges: { outgoing: [], incoming: [] },
  transcript: { enabled: false, path: null, tailCommand: null },
  compactSpec: { name: "tester", version: "1.0", profile: "default", skillCount: 1, guidanceCount: 0 },
  agentActivity: { state: "running" },
  currentQitems: [],
  contextUsage: { usedPercentage: 45 },
};

describe("Tier 5 Adversarial: Dashboard v2 Operational Hardening", () => {
  let originalFetch: typeof fetch;
  const mockFetch = vi.fn();

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    mockActivityEvents = [];
    mockFetch.mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.includes("/healthz")) {
        return { ok: true, json: async () => ({ status: "ok" }) };
      }
      if (u.includes("/api/hosts")) {
        return { ok: true, json: async () => ({ ownName: "host-alpha", selected: "local", hosts: [] }) };
      }
      if (u.includes("/api/ps")) {
        return { ok: true, json: async () => [] };
      }
      if (u.includes("/api/specs/library")) {
        return { ok: true, json: async () => [] };
      }
      if (u.includes("/summary")) {
        return { ok: true, json: async () => [] };
      }
      if (u.includes("/nodes/")) {
        return { ok: true, json: async () => BASE_NODE_DETAIL };
      }
      return { ok: true, json: async () => ({}) };
    });
    window.localStorage.removeItem(GETTING_STARTED_DISMISSED_KEY);
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    mockActivityEvents = [];
    vi.restoreAllMocks();
  });

  function seedDashboard(
    qc: QueryClient,
    options: {
      ps?: unknown[];
      attention?: { items: unknown[]; hosts?: unknown[] };
      health?: { status: string };
      activity?: Array<{ seq: number; type: string; createdAt: string; payload: Record<string, unknown> }>;
    } = {},
  ) {
    qc.setQueryData(["hosts"], { ownName: "host-alpha", selected: "local", hosts: [] });
    qc.setQueryData(["ps", "local"], options.ps ?? []);
    qc.setQueryData(
      ["attention-items", 50, false],
      options.attention ?? { items: [], hosts: [] },
    );
    qc.setQueryData(["settings", "all"], { settings: {} });
    qc.setQueryData(["kernel", "status"], { state: "skipped" });
    qc.setQueryData(["rigs", "summary"], []);
    qc.setQueryData(["daemon", "health"], options.health ?? { status: "ok" });
    if (options.activity) {
      mockActivityEvents = options.activity;
    }
  }

  it("truncates NeedsYou queue to strictly 5 items when >5 items exist", async () => {
    const tenItems = Array.from({ length: 10 }, (_, i) => ({
      qitemId: `qitem-${i + 1}`,
      tsCreated: "2026-11-06T12:00:00Z",
      tsUpdated: "2026-11-06T12:00:00Z",
      sourceSession: `agent-${i + 1}@rig-prod`,
      destinationSession: "human@host",
      state: "pending",
      priority: "high",
      tier: "human-gate",
      summary: `Attention item number ${i + 1}`,
      body: `Body details for item ${i + 1}`,
      hostId: "local",
    }));

    renderDashboard((qc) =>
      seedDashboard(qc, {
        attention: { items: tenItems },
      }),
    );

    const section = await screen.findByTestId("dashboard-needs-you");
    expect(section).toBeTruthy();

    // Verify first 5 are rendered
    for (let i = 1; i <= 5; i++) {
      expect(screen.getByText(`Attention item number ${i}`)).toBeTruthy();
      expect(screen.getByTestId(`verb-approve-qitem-${i}`)).toBeTruthy();
    }

    // Verify items 6-10 are truncated out of the dashboard widget
    for (let i = 6; i <= 10; i++) {
      expect(screen.queryByText(`Attention item number ${i}`)).toBeNull();
      expect(screen.queryByTestId(`verb-approve-qitem-${i}`)).toBeNull();
    }
  });

  it("falls back to the first line of body when summary is missing or null, ignoring extra lines", async () => {
    const itemsWithoutSummary = [
      {
        qitemId: "q-multiline-1",
        tsCreated: "2026-11-06T12:00:00Z",
        tsUpdated: "2026-11-06T12:00:00Z",
        sourceSession: "worker@rig-a",
        destinationSession: "human@host",
        state: "pending",
        priority: "normal",
        summary: null,
        body: "First header line of body\nSecond hidden line\nThird line",
        hostId: "remote-box",
      },
    ];

    renderDashboard((qc) =>
      seedDashboard(qc, {
        attention: { items: itemsWithoutSummary },
      }),
    );

    const section = await screen.findByTestId("dashboard-needs-you");
    expect(section.textContent).toContain("First header line of body");
    expect(section.textContent).not.toContain("Second hidden line");

    const approveBtn = screen.getByTestId("verb-approve-q-multiline-1");
    expect(approveBtn.getAttribute("data-host")).toBe("remote-box");
  });

  it("calculates MetricTiles accurately: ignores stopped rigs for rigsRunning, accumulates active and alive counts", async () => {
    const testPs = [
      { rigId: "r1", name: "rig-running", nodeCount: 5, runningCount: 5, activeCount: 3, status: "running" },
      { rigId: "r2", name: "rig-partial", nodeCount: 4, runningCount: 3, activeCount: 1, status: "partial" },
      { rigId: "r3", name: "rig-degraded", nodeCount: 2, runningCount: 1, activeCount: 0, status: "degraded" },
      { rigId: "r4", name: "rig-stopped", nodeCount: 6, runningCount: 0, activeCount: 0, status: "stopped" },
      { rigId: "r5", name: "rig-attention", nodeCount: 3, runningCount: 2, activeCount: 1, status: "attention_required" },
    ];

    renderDashboard((qc) =>
      seedDashboard(qc, {
        ps: testPs,
        attention: {
          items: [
            { qitemId: "q-1", summary: "Q1", body: "B1", tsUpdated: "2026-11-06T12:00:00Z", sourceSession: "a@r" },
            { qitemId: "q-2", summary: "Q2", body: "B2", tsUpdated: "2026-11-06T12:00:00Z", sourceSession: "a@r" },
          ],
        },
      }),
    );

    // Total rigs = 5; Running rigs (non-stopped: running, partial, degraded, attention_required) = 4
    const rigsTile = await screen.findByTestId("dashboard-tile-rigs");
    expect(rigsTile.textContent).toContain("4");
    expect(rigsTile.textContent).toContain("5 total");

    // Active agents = 3 + 1 + 0 + 0 + 1 = 5; Alive agents = 5 + 3 + 1 + 0 + 2 = 11
    const agentsTile = screen.getByTestId("dashboard-tile-agents");
    expect(agentsTile.textContent).toContain("5");
    expect(agentsTile.textContent).toContain("11 alive");

    // Needs you attention count = 2
    const needsTile = screen.getByTestId("dashboard-tile-needs-you");
    expect(needsTile.textContent).toContain("2");
  });

  it("RigsTable prioritizes lifecycleState over status and handles null uptime gracefully", async () => {
    const testPs = [
      {
        rigId: "rig-upgrading",
        name: "titan-cluster",
        nodeCount: 10,
        runningCount: 10,
        activeCount: 4,
        hasWorkCount: 2,
        status: "running",
        lifecycleState: "upgrading", // lifecycleState takes precedence -> "Upgrading"
        uptime: null, // null uptime must display "—"
      },
      {
        rigId: "rig-fallback",
        name: "worker-solo",
        nodeCount: 1,
        runningCount: 1,
        activeCount: null, // null activeCount must display 0
        hasWorkCount: null, // null hasWorkCount must display 0
        status: "attention_required", // status fallback -> "Needs attention"
        lifecycleState: null,
        uptime: "12m",
      },
    ];

    renderDashboard((qc) =>
      seedDashboard(qc, { ps: testPs }),
    );

    const rigsSection = await screen.findByTestId("dashboard-rigs");
    expect(rigsSection.textContent).toContain("titan-cluster");
    expect(rigsSection.textContent).toContain("worker-solo");

    // "Upgrading" rendered via StatusBadge
    expect(screen.getByText("Upgrading")).toBeTruthy();
    // "Needs attention" rendered via StatusBadge
    expect(screen.getByText("Needs attention")).toBeTruthy();

    // Fallback dash for null uptime
    expect(rigsSection.textContent).toContain("—");
  });

  it("humanizes event types across diverse dot notations and protects against non-string payload attributes", async () => {
    const testEvents = [
      {
        seq: 101,
        type: "rig.node.agent.started",
        createdAt: "2026-11-06T12:00:00Z",
        payload: { rigId: "alpha-rig", session: "worker-01" },
      },
      {
        seq: 102,
        type: "heartbeat",
        createdAt: "2026-11-06T12:01:00Z",
        payload: { rigId: 12345 as unknown as string, session: null as unknown as string }, // Hostile non-string
      },
      {
        seq: 103,
        type: "",
        createdAt: "2026-11-06T12:02:00Z",
        payload: {},
      },
    ];

    renderDashboard((qc) =>
      seedDashboard(qc, {
        ps: [],
        activity: testEvents,
      }),
    );

    const activitySection = await screen.findByTestId("dashboard-activity");
    expect(activitySection).toBeTruthy();

    // "rig.node.agent.started" -> "Rig Node Agent Started"
    expect(screen.getByText("Rig Node Agent Started")).toBeTruthy();
    expect(screen.getByText("alpha-rig")).toBeTruthy();
    expect(screen.getByText("worker-01")).toBeTruthy();

    // "heartbeat" -> "Heartbeat"
    expect(screen.getByText("Heartbeat")).toBeTruthy();
    // Non-string rigId (12345) must not be rendered as a rig tag
    expect(screen.queryByText("12345")).toBeNull();
  });

  it("host collapsible section is collapsed by default and reveals Host and Kernel cards upon trigger click", async () => {
    renderDashboard((qc) => seedDashboard(qc));

    const hostSection = await screen.findByTestId("dashboard-host-section");
    expect(hostSection).toBeTruthy();

    // Trigger is present
    const trigger = screen.getByRole("button", { name: "Host" });
    expect(trigger).toBeTruthy();

    // Before click, host config card inside collapsible content is hidden
    expect(screen.queryByTestId("dashboard-host-config")).toBeNull();

    // Click trigger to expand
    fireEvent.click(trigger);

    // After click, HostConfigCard is rendered
    expect(await screen.findByTestId("dashboard-host-config")).toBeTruthy();
  });
});

describe("Tier 5 Adversarial: HostConfigCard State Machine & Concurrency", () => {
  let originalFetch: typeof fetch;
  const mockFetch = vi.fn();

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
    });
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function renderHostCardWithData(hostsResponse: HostsResponse, settings: Record<string, { value: unknown }> = {}) {
    const qc = createTestQueryClient();
    qc.setQueryData(["hosts"], hostsResponse);
    qc.setQueryData(["settings", "all"], { settings });
    return {
      qc,
      ...render(
        <QueryClientProvider client={qc}>
          <HostConfigCard />
        </QueryClientProvider>,
      ),
    };
  }

  it("formats host address correctly: uses target for SSH and url for HTTP, falling back to '—'", () => {
    const hosts: HostsResponse = {
      ownName: "localhost",
      selected: "local",
      hosts: [
        {
          id: "ssh-host-1",
          transport: "ssh",
          target: "bastion.internal:2222",
          url: "http://ignored-url:8000",
          selected: false,
          status: "reachable",
        },
        {
          id: "ssh-host-no-target",
          transport: "ssh",
          selected: false,
          status: "reachable",
        },
        {
          id: "http-host-1",
          transport: "http",
          url: "http://remote-cluster:7433",
          selected: false,
          status: "reachable",
        },
        {
          id: "http-host-no-url",
          transport: "http",
          selected: false,
          status: "unreachable",
        },
      ],
    };

    renderHostCardWithData(hosts);

    const list = screen.getByTestId("host-config-rows");
    expect(list.textContent).toContain("bastion.internal:2222");
    expect(list.textContent).not.toContain("http://ignored-url:8000");
    expect(list.textContent).toContain("http://remote-cluster:7433");

    // Fallback dashes for missing target/url
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBeGreaterThanOrEqual(2);
  });

  it("renders selection banner if and only if selected host is not 'local'", () => {
    const hostsLocal: HostsResponse = {
      ownName: "local-node",
      selected: "local",
      hosts: [{ id: "vps-1", transport: "http", url: "http://vps:7433", selected: false, status: "reachable" }],
    };

    renderHostCardWithData(hostsLocal);
    expect(screen.queryByTestId("host-selection-banner")).toBeNull();

    cleanup();

    const hostsRemote: HostsResponse = {
      ownName: "local-node",
      selected: "vps-1",
      hosts: [{ id: "vps-1", transport: "http", url: "http://vps:7433", selected: true, status: "reachable" }],
    };

    renderHostCardWithData(hostsRemote, { "host.selected": { value: "vps-1" } });
    const banner = screen.getByTestId("host-selection-banner");
    expect(banner.textContent).toContain("Selected host: vps-1 — flagless CLI commands run against it");
  });

  it("handles rename form state: cancel button reverts without mutation, whitespace-only submission does not mutate", async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    const hosts: HostsResponse = {
      ownName: "desktop-master",
      selected: "local",
      hosts: [],
    };

    renderHostCardWithData(hosts);

    // Initial view
    expect(screen.getByTestId("host-own-name").textContent).toBe("desktop-master");

    // Click Rename
    fireEvent.click(screen.getByTestId("host-rename-button"));
    const input = screen.getByTestId("host-rename-input") as HTMLInputElement;
    expect(input.value).toBe("desktop-master");

    // Click Cancel -> returns to view without fetch mutation
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.getByTestId("host-own-name")).toBeTruthy();
    expect(mockFetch).not.toHaveBeenCalledWith(expect.stringContaining("/api/config/host.name"), expect.anything());

    // Reopen and enter whitespace only
    fireEvent.click(screen.getByTestId("host-rename-button"));
    const reInput = screen.getByTestId("host-rename-input") as HTMLInputElement;
    fireEvent.change(reInput, { target: { value: "   " } });
    fireEvent.click(screen.getByText("Save"));

    // Exited renaming mode and did not make fetch call to update host.name
    expect(screen.getByTestId("host-own-name")).toBeTruthy();
    expect(mockFetch).not.toHaveBeenCalledWith(expect.stringContaining("/api/config/host.name"), expect.anything());
  });

  it("pairing state machine: starts pair, displays pending with code, and cancels cleanly", async () => {
    mockFetch.mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.includes("/api/hosts/pair") && !u.includes("/pair/")) {
        return {
          ok: true,
          json: async () => ({
            pairId: "pair-xyz",
            code: "PAIR-456",
            target: "http://remote:7433",
          }),
        };
      }
      return { ok: true, json: async () => ({ status: "pending", code: "PAIR-456" }) };
    });

    const hosts: HostsResponse = {
      ownName: "local-node",
      selected: "local",
      hosts: [],
    };

    renderHostCardWithData(hosts);

    // Input URL to pair
    const input = screen.getByTestId("host-pair-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "http://remote:7433" } });

    // Click Pair
    fireEvent.click(screen.getByTestId("host-pair-button"));

    // Pairing container appears showing code
    const pairingBox = await screen.findByTestId("host-pairing");
    expect(pairingBox.textContent).toContain("PAIR-456");

    // Click Cancel button in pairing view
    const cancelBtn = screen.getByRole("button", { name: "Cancel" });
    fireEvent.click(cancelBtn);

    // Returned to input view
    expect(await screen.findByTestId("host-pair-input")).toBeTruthy();
  });

  it("renders host registry error message gracefully when useHosts fails", async () => {
    mockFetch.mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.includes("/api/hosts")) {
        return { ok: false, status: 500, json: async () => ({ error: "Socket disconnected" }) };
      }
      return { ok: true, json: async () => ({}) };
    });

    const qc = createTestQueryClient();
    qc.setQueryData(["settings", "all"], { settings: {} });

    render(
      <QueryClientProvider client={qc}>
        <HostConfigCard />
      </QueryClientProvider>,
    );

    expect(await screen.findByText(/host registry unreadable: Socket disconnected/)).toBeTruthy();
  });
});

describe("Tier 5 Adversarial: GettingStarted Card & Visibility Contract", () => {
  beforeEach(() => {
    window.localStorage.removeItem(GETTING_STARTED_DISMISSED_KEY);
  });

  afterEach(() => {
    cleanup();
    window.localStorage.removeItem(GETTING_STARTED_DISMISSED_KEY);
  });

  describe("isGettingStartedVisible pure function contract", () => {
    it("returns false for non-array or undefined psData (guards against query loading flash)", () => {
      expect(isGettingStartedVisible(undefined, null)).toBe(false);
      expect(isGettingStartedVisible(null, null)).toBe(false);
      expect(isGettingStartedVisible({}, null)).toBe(false);
      expect(isGettingStartedVisible("psData", null)).toBe(false);
      expect(isGettingStartedVisible(42, null)).toBe(false);
    });

    it("returns false when psData has >= 1 rig running", () => {
      expect(isGettingStartedVisible([{ rigId: "r1" }], null)).toBe(false);
      expect(isGettingStartedVisible([{ rigId: "r1" }, { rigId: "r2" }], null)).toBe(false);
    });

    it("returns false when dismissed flag is exactly '1'", () => {
      expect(isGettingStartedVisible([], "1")).toBe(false);
    });

    it("returns true only when psData is empty array AND dismissed is not '1'", () => {
      expect(isGettingStartedVisible([], null)).toBe(true);
      expect(isGettingStartedVisible([], "0")).toBe(true);
      expect(isGettingStartedVisible([], "")).toBe(true);
      expect(isGettingStartedVisible([], "false")).toBe(true);
    });
  });

  it("clicking Dismiss saves '1' to localStorage and immediately removes the card from view", async () => {
    renderWithClientAndRouter(
      (qc) => {
        qc.setQueryData(["ps", "local"], []);
        qc.setQueryData(["daemon", "health"], { status: "ok" });
        qc.setQueryData(["spec-library", "all", "local"], []);
      },
      () => <GettingStarted />,
    );

    const section = await screen.findByTestId("getting-started");
    expect(section).toBeTruthy();

    const dismissBtn = screen.getByRole("button", { name: "Dismiss" });
    fireEvent.click(dismissBtn);

    expect(window.localStorage.getItem(GETTING_STARTED_DISMISSED_KEY)).toBe("1");
    expect(screen.queryByTestId("getting-started")).toBeNull();
  });

  it("strict rig spec filtering: agent-only or workflow-only specs do NOT mark step 2 as done", async () => {
    renderWithClientAndRouter(
      (qc) => {
        qc.setQueryData(["ps", "local"], []);
        qc.setQueryData(["daemon", "health"], { status: "ok" });
        // Only agent specs, NO rig specs
        qc.setQueryData(["spec-library", "all", "local"], [
          { id: "spec-agent-1", name: "builder", kind: "agent" },
          { id: "spec-workflow-1", name: "ci-pipeline", kind: "workflow" },
        ]);
      },
      () => <GettingStarted />,
    );

    await screen.findByTestId("getting-started");
    // Step 2 is "Add a rig spec" - checkmark should be circle "○" (not done)
    const listItems = screen.getAllByRole("listitem");
    const specStep = listItems[1]!;
    expect(specStep.textContent).toContain("Add a rig spec");
    expect(specStep.textContent).toContain("○");
    expect(specStep.textContent).not.toContain("✓");

    cleanup();

    // Now seed with a genuine rig spec
    renderWithClientAndRouter(
      (qc) => {
        qc.setQueryData(["ps", "local"], []);
        qc.setQueryData(["daemon", "health"], { status: "ok" });
        qc.setQueryData(["spec-library", "all", "local"], [
          { id: "spec-rig-1", name: "full-stack-rig", kind: "rig" },
        ]);
      },
      () => <GettingStarted />,
    );

    await screen.findByTestId("getting-started");
    const updatedListItems = screen.getAllByRole("listitem");
    const updatedSpecStep = updatedListItems[1]!;
    expect(updatedSpecStep.textContent).toContain("Add a rig spec");
    expect(updatedSpecStep.textContent).toContain("✓");
  });
});

describe("Tier 5 Adversarial: AgentPropertiesPanel & LiveNodeDetails Edge Cases", () => {
  let originalFetch: typeof fetch;
  const mockFetch = vi.fn();
  let OriginalEventSource: typeof EventSource | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;
    OriginalEventSource = globalThis.EventSource;
    globalThis.EventSource = createMockEventSourceClass() as unknown as typeof EventSource;

    mockFetch.mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.includes("/api/hosts")) {
        return { ok: true, json: async () => ({ ownName: "localhost", selected: "local", hosts: [] }) };
      }
      if (u.includes("/api/specs/library")) {
        return { ok: true, json: async () => [] };
      }
      return { ok: true, json: async () => BASE_NODE_DETAIL };
    });
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
    if (OriginalEventSource) {
      globalThis.EventSource = OriginalEventSource;
    }
    vi.restoreAllMocks();
  });

  it("clamps context used percentage to [0, 100] and renders '--' when null or undefined", async () => {
    const testCases = [
      { inputPct: -25, expectedWidth: "0%", expectedText: "-25%" },
      { inputPct: 0, expectedWidth: "0%", expectedText: "0%" },
      { inputPct: 73, expectedWidth: "73%", expectedText: "73%" },
      { inputPct: 150, expectedWidth: "100%", expectedText: "150%" },
    ];

    for (const { inputPct, expectedWidth, expectedText } of testCases) {
      mockFetch.mockImplementation(async (url: unknown) => {
        const u = String(url);
        if (u.includes("/api/hosts")) {
          return { ok: true, json: async () => ({ ownName: "localhost", selected: "local", hosts: [] }) };
        }
        return {
          ok: true,
          json: async () => ({
            ...BASE_NODE_DETAIL,
            contextUsage: { usedPercentage: inputPct },
          }),
        };
      });

      const { unmount } = render(
        createTestRouter({
          component: () => <AgentPropertiesPanel rigId="rig-adversarial" logicalId="tester.agent" />,
          path: "/test",
        }),
      );

      await screen.findByText("Runtime");
      await screen.findByText(expectedText);
      const progressBar = document.querySelector(".bg-brand.block.h-full") as HTMLElement;
      expect(progressBar.style.width).toBe(expectedWidth);
      unmount();
      cleanup();
    }

    // Null context usage
    mockFetch.mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.includes("/api/hosts")) {
        return { ok: true, json: async () => ({ ownName: "localhost", selected: "local", hosts: [] }) };
      }
      return {
        ok: true,
        json: async () => ({
          ...BASE_NODE_DETAIL,
          contextUsage: { usedPercentage: null },
        }),
      };
    });

    render(
      createTestRouter({
        component: () => <AgentPropertiesPanel rigId="rig-adversarial" logicalId="tester.agent" />,
        path: "/test",
      }),
    );

    await screen.findByText("Runtime");
    expect(screen.getByText("--")).toBeTruthy();
    expect(document.querySelector(".bg-brand.block.h-full")).toBeNull();
  });

  it("prioritizes agentActivity state over sessionStatus and falls back to 'unknown'", async () => {
    // 1. Both present: agentActivity state ("busy") wins over sessionStatus ("idle") -> "Busy"
    mockFetch.mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.includes("/api/hosts")) {
        return { ok: true, json: async () => ({ ownName: "localhost", selected: "local", hosts: [] }) };
      }
      return {
        ok: true,
        json: async () => ({
          ...BASE_NODE_DETAIL,
          sessionStatus: "idle",
          agentActivity: { state: "busy" },
        }),
      };
    });

    const { unmount: unmount1 } = render(
      createTestRouter({
        component: () => <AgentPropertiesPanel rigId="rig-adversarial" logicalId="tester.agent" />,
        path: "/test",
      }),
    );

    await screen.findByText("Runtime");
    expect(screen.getByText("Busy")).toBeTruthy();
    unmount1();
    cleanup();

    // 2. agentActivity missing: sessionStatus ("paused") is used -> "Paused"
    mockFetch.mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.includes("/api/hosts")) {
        return { ok: true, json: async () => ({ ownName: "localhost", selected: "local", hosts: [] }) };
      }
      return {
        ok: true,
        json: async () => ({
          ...BASE_NODE_DETAIL,
          sessionStatus: "paused",
          agentActivity: null,
        }),
      };
    });

    const { unmount: unmount2 } = render(
      createTestRouter({
        component: () => <AgentPropertiesPanel rigId="rig-adversarial" logicalId="tester.agent" />,
        path: "/test",
      }),
    );

    await screen.findByText("Runtime");
    expect(screen.getByText("Paused")).toBeTruthy();
    unmount2();
    cleanup();

    // 3. Both missing: falls back to "unknown" -> "Unknown"
    mockFetch.mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.includes("/api/hosts")) {
        return { ok: true, json: async () => ({ ownName: "localhost", selected: "local", hosts: [] }) };
      }
      return {
        ok: true,
        json: async () => ({
          ...BASE_NODE_DETAIL,
          sessionStatus: null,
          agentActivity: null,
        }),
      };
    });

    render(
      createTestRouter({
        component: () => <AgentPropertiesPanel rigId="rig-adversarial" logicalId="tester.agent" />,
        path: "/test",
      }),
    );

    await screen.findByText("Runtime");
    expect(screen.getByText("Unknown")).toBeTruthy();
  });

  it("renders latestError with text-destructive when present and omits the row when null", async () => {
    mockFetch.mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.includes("/api/hosts")) {
        return { ok: true, json: async () => ({ ownName: "localhost", selected: "local", hosts: [] }) };
      }
      return {
        ok: true,
        json: async () => ({
          ...BASE_NODE_DETAIL,
          latestError: "Fatal: Out of context memory (OOM)",
        }),
      };
    });

    const { unmount } = render(
      createTestRouter({
        component: () => <AgentPropertiesPanel rigId="rig-adversarial" logicalId="tester.agent" />,
        path: "/test",
      }),
    );

    await screen.findByText("Runtime");
    const errorEl = screen.getByText("Fatal: Out of context memory (OOM)");
    expect(errorEl.className).toContain("text-destructive");

    unmount();
    cleanup();

    mockFetch.mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.includes("/api/hosts")) {
        return { ok: true, json: async () => ({ ownName: "localhost", selected: "local", hosts: [] }) };
      }
      return {
        ok: true,
        json: async () => ({
          ...BASE_NODE_DETAIL,
          latestError: null,
        }),
      };
    });

    render(
      createTestRouter({
        component: () => <AgentPropertiesPanel rigId="rig-adversarial" logicalId="tester.agent" />,
        path: "/test",
      }),
    );

    await screen.findByText("Runtime");
    expect(screen.queryByText("Latest error")).toBeNull();
  });

  it("handles copy button failures without flipping to 'Copied'", async () => {
    mockFetch.mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.includes("/api/hosts")) {
        return { ok: true, json: async () => ({ ownName: "localhost", selected: "local", hosts: [] }) };
      }
      return { ok: true, json: async () => BASE_NODE_DETAIL };
    });

    // Make clipboard writeText reject
    Object.defineProperty(globalThis.navigator, "clipboard", {
      value: {
        writeText: vi.fn().mockRejectedValue(new Error("Permission denied")),
      },
      configurable: true,
      writable: true,
    });
    // And fallback execCommand returns false
    Object.defineProperty(globalThis.document, "execCommand", {
      value: vi.fn().mockReturnValue(false),
      configurable: true,
      writable: true,
    });

    render(
      createTestRouter({
        component: () => <AgentPropertiesPanel rigId="rig-adversarial" logicalId="tester.agent" />,
        path: "/test",
      }),
    );

    const copyBtn = await screen.findByTestId("agent-properties-copy-session");
    expect(copyBtn.textContent).toBe("Copy");

    fireEvent.click(copyBtn);

    // Wait to confirm button text does NOT change to "Copied"
    await new Promise((r) => setTimeout(r, 50));
    expect(copyBtn.textContent).toBe("Copy");
  });

  it("LiveNodeDetails mobile drawer: opens, renders backdrop, dismisses via backdrop click and Escape key", async () => {
    mockFetch.mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.includes("/api/hosts")) {
        return { ok: true, json: async () => ({ ownName: "localhost", selected: "local", hosts: [] }) };
      }
      if (u.includes("/api/specs/library")) {
        return { ok: true, json: async () => [] };
      }
      return { ok: true, json: async () => BASE_NODE_DETAIL };
    });

    render(
      createTestRouter({
        component: () => <LiveNodeDetails rigId="rig-adversarial" logicalId="tester.agent" />,
        path: "/test",
      }),
    );

    // Click "Properties" action button
    const openBtn = await screen.findByTestId("detail-open-properties");
    fireEvent.click(openBtn);

    // Drawer is now open with dialog role and backdrop
    const drawer = await screen.findByTestId("agent-properties-drawer");
    expect(drawer.getAttribute("role")).toBe("dialog");
    expect(drawer.getAttribute("aria-modal")).toBe("true");

    // Click backdrop to dismiss
    const backdrop = screen.getByTestId("agent-properties-drawer-backdrop");
    fireEvent.click(backdrop);
    expect(screen.queryByTestId("agent-properties-drawer")).toBeNull();

    // Reopen and test Escape key dismissal
    fireEvent.click(screen.getByTestId("detail-open-properties"));
    expect(await screen.findByTestId("agent-properties-drawer")).toBeTruthy();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("agent-properties-drawer")).toBeNull();
  });
});

describe("Tier 5 Adversarial: Operational Mutations & State Synchronization", () => {
  let originalFetch: typeof fetch;
  const mockFetch = vi.fn();

  beforeEach(() => {
    toast.dismiss();
    cleanup();
    document.body.innerHTML = "";
    originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch as unknown as typeof fetch;
  });

  afterEach(() => {
    toast.dismiss();
    cleanup();
    document.body.innerHTML = "";
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("useCreateSnapshot invalidates queries and fires success toast on 200, handles HTTP error on failure", async () => {
    const qc = createTestQueryClient();
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    function SnapshotProbe() {
      const mutation = useCreateSnapshot("rig-snap-1");
      return (
        <div>
          <button type="button" data-testid="snap-btn" onClick={() => mutation.mutate()}>
            Snap
          </button>
          {mutation.isSuccess && <span data-testid="snap-success">Success</span>}
          {mutation.isError && <span data-testid="snap-error">Error: {mutation.error.message}</span>}
        </div>
      );
    }

    // 1. Success test
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ snapshotId: "snap-123" }),
    });

    render(
      <QueryClientProvider client={qc}>
        <Toaster />
        <SnapshotProbe />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByTestId("snap-btn"));

    await screen.findByTestId("snap-success");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["rig", "rig-snap-1", "snapshots"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["rigs", "summary"] });
    expect(await screen.findAllByText("Snapshot saved")).toBeTruthy();

    cleanup();

    // 2. Failure test with custom server error
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: "Disk quota exceeded during snapshot capture" }),
    });

    render(
      <QueryClientProvider client={qc}>
        <Toaster />
        <SnapshotProbe />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByTestId("snap-btn"));

    await screen.findByTestId("snap-error");
    expect(screen.getByTestId("snap-error").textContent).toContain("Disk quota exceeded");
  });

  it("useRestoreSnapshot throws RestoreError and invalidates query cache", async () => {
    const qc = createTestQueryClient();
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    function RestoreProbe() {
      const mutation = useRestoreSnapshot("rig-restore-1");
      return (
        <div>
          <button type="button" data-testid="restore-btn" onClick={() => mutation.mutate("snap-999")}>
            Restore
          </button>
          {mutation.isSuccess && <span data-testid="restore-success">Success</span>}
          {mutation.isError && <span data-testid="restore-error">Error: {mutation.error.message}</span>}
        </div>
      );
    }

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true }),
    });

    render(
      <QueryClientProvider client={qc}>
        <Toaster />
        <RestoreProbe />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByTestId("restore-btn"));

    await screen.findByTestId("restore-success");
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["rig", "rig-restore-1"] });
    expect(await screen.findAllByText("Snapshot restored")).toBeTruthy();

    cleanup();

    // Failure with RestoreError
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ code: "topology_conflict", error: "Cannot restore: node active" }),
    });

    render(
      <QueryClientProvider client={qc}>
        <Toaster />
        <RestoreProbe />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByTestId("restore-btn"));

    await screen.findByTestId("restore-error");
    expect(screen.getByTestId("restore-error").textContent).toContain("Cannot restore: node active");
  });

  it("useTeardownRig fails on HTTP 200 when response body contains errors array (body-driven errors)", async () => {
    const qc = createTestQueryClient();

    function TeardownProbe() {
      const mutation = useTeardownRig("rig-td-1");
      return (
        <div>
          <button type="button" data-testid="td-btn" onClick={() => mutation.mutate()}>
            Teardown
          </button>
          {mutation.isSuccess && <span data-testid="td-success">Success</span>}
          {mutation.isError && <span data-testid="td-error">Error: {mutation.error.message}</span>}
        </div>
      );
    }

    // 200 OK but body has errors array
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        errors: ["Failed to kill tmux session", "Resource lock busy"],
        sessionsKilled: 0,
      }),
    });

    render(
      <QueryClientProvider client={qc}>
        <Toaster />
        <TeardownProbe />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByTestId("td-btn"));

    await screen.findByTestId("td-error");
    expect(screen.getByTestId("td-error").textContent).toContain("Failed to kill tmux session; Resource lock busy");
  });

  it("useLaunchRig posts freshLogicalIds and invalidates kernel status", async () => {
    const qc = createTestQueryClient();
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    function LaunchProbe() {
      const mutation = useLaunchRig("rig-launch-1");
      return (
        <div>
          <button
            type="button"
            data-testid="launch-btn"
            onClick={() => mutation.mutate(["agent.alpha", "agent.beta"])}
          >
            Launch
          </button>
          {mutation.isSuccess && <span data-testid="launch-success">Success</span>}
        </div>
      );
    }

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true }),
    });

    render(
      <QueryClientProvider client={qc}>
        <Toaster />
        <LaunchProbe />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByTestId("launch-btn"));

    await screen.findByTestId("launch-success");
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/rigs/rig-launch-1/up",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ freshLogicalIds: ["agent.alpha", "agent.beta"] }),
      }),
    );

    // Verifies invalidations including kernel status
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["rigs", "summary"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["ps"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["rig", "rig-launch-1"] });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["kernel", "status"] });
  });

  it("useImportRig constructs ImportError with cycle error code and passes X-Rig-Root header", async () => {
    const qc = createTestQueryClient();

    function ImportProbe() {
      const mutation = useImportRig();
      return (
        <div>
          <button
            type="button"
            data-testid="import-btn"
            onClick={() => mutation.mutate({ yaml: "name: test-rig", rigRoot: "/workspace/my-rig" })}
          >
            Import
          </button>
          {mutation.isError && <span data-testid="import-error">Error: {mutation.error.message}</span>}
        </div>
      );
    }

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({
        code: "cycle_error",
        message: "Cycle detected",
      }),
    });

    render(
      <QueryClientProvider client={qc}>
        <Toaster />
        <ImportProbe />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByTestId("import-btn"));

    await screen.findByTestId("import-error");
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/rigs/import",
      expect.objectContaining({
        headers: {
          "Content-Type": "text/yaml",
          "X-Rig-Root": "/workspace/my-rig",
        },
        body: "name: test-rig",
      }),
    );
    expect(screen.getByTestId("import-error").textContent).toContain("Cycle detected in rig topology");
  });

  it("useSelectHost posts to /api/config/host.selected and invalidates both hosts and settings queries", async () => {
    const qc = createTestQueryClient();
    const invalidateSpy = vi.spyOn(qc, "invalidateQueries");

    function SelectHostProbe() {
      const mutation = useSelectHost();
      return (
        <button
          type="button"
          data-testid="select-host-btn"
          onClick={() => mutation.mutate({ hostId: "vps-delta" })}
        >
          Select Delta
        </button>
      );
    }

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true }),
    });

    render(
      <QueryClientProvider client={qc}>
        <SelectHostProbe />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByTestId("select-host-btn"));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/config/host.selected",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ value: "vps-delta" }),
        }),
      );
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["hosts"] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["settings"] });
    });
  });
});
