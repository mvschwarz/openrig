import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent, act, within } from "@testing-library/react";
import { createTestRouter } from "./helpers/test-router.js";
import { DiscoveryOverlay } from "../src/components/DiscoveryOverlay.js";
import type { DiscoveredSession } from "../src/hooks/useDiscovery.js";
import {
  eventColor,
  eventRoute,
  type ActivityEvent,
} from "../src/hooks/useActivityFeed.js";

let fetchMock: ReturnType<typeof vi.fn>;
let clipboardWriteMock: ReturnType<typeof vi.fn>;

const MOCK_SESSIONS: DiscoveredSession[] = [
  {
    id: "ds-1", tmuxSession: "organic", tmuxWindow: "0", tmuxPane: "%0",
    pid: 1234, cwd: "/projects/app", activeCommand: "claude",
    runtimeHint: "claude-code", confidence: "high",
    evidenceJson: JSON.stringify({
      layerUsed: 1,
      processSignal: { command: "claude", matched: "claude" },
    }),
    configJson: null, status: "active",
    claimedNodeId: null, firstSeenAt: "2026-03-26 10:00:00", lastSeenAt: "2026-03-26 10:01:00",
  },
  {
    id: "ds-2", tmuxSession: "gone", tmuxWindow: "0", tmuxPane: "%1",
    pid: null, cwd: null, activeCommand: null,
    runtimeHint: "unknown", confidence: "low",
    evidenceJson: null, configJson: null, status: "vanished",
    claimedNodeId: null, firstSeenAt: "2026-03-26 09:00:00", lastSeenAt: "2026-03-26 09:30:00",
  },
];

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock;
  clipboardWriteMock = vi.fn(async () => undefined);
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value: { writeText: clipboardWriteMock },
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function filterSessionsForQuery(url: string, sessions: DiscoveredSession[]): DiscoveredSession[] {
  const parsed = new URL(url, "http://localhost");
  const status = parsed.searchParams.get("status");
  const runtimeHints = parsed.searchParams.get("runtimeHint")?.split(",").filter(Boolean) ?? null;
  const minConfidence = parsed.searchParams.get("minConfidence");
  const rank: Record<string, number> = { low: 0, medium: 1, high: 2, highest: 3 };

  return sessions.filter((session) => {
    if (status && session.status !== status) return false;
    if (runtimeHints && !runtimeHints.includes(session.runtimeHint)) return false;
    if (minConfidence && (rank[session.confidence] ?? 0) < (rank[minConfidence] ?? 0)) return false;
    return true;
  });
}

function mockFetchSessions(sessions: DiscoveredSession[] = MOCK_SESSIONS) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST" && typeof url === "string" && url.includes("/scan")) {
      return { ok: true, json: async () => ({ sessions }) };
    }
    if (typeof url === "string" && url.includes("/discovery")) {
      return { ok: true, json: async () => filterSessionsForQuery(url, sessions) };
    }
    if (typeof url === "string" && url.includes("/api/rigs/summary")) {
      return { ok: true, json: async () => [{ id: "rig-1", name: "r01-test", nodeCount: 3, latestSnapshotAt: null, latestSnapshotId: null }] };
    }
    // Default: return empty success for any other API call
    return { ok: true, json: async () => ({}) };
  });
}

describe("DiscoveryOverlay", () => {
  it("renders inside the shared workspace page shell", async () => {
    mockFetchSessions();
    render(createTestRouter({ component: DiscoveryOverlay, path: "/discovery", initialPath: "/discovery" }));

    await waitFor(() => {
      expect(screen.getByTestId("workspace-page")).toBeDefined();
      expect(screen.getByTestId("workspace-page-inner")).toBeDefined();
    });
  });

  // T1: Discovered nodes render with dashed border
  it("discovered nodes have dashed border", async () => {
    mockFetchSessions();
    render(createTestRouter({ component: DiscoveryOverlay, path: "/discovery", initialPath: "/discovery" }));

    await waitFor(() => {
      const nodes = screen.getAllByTestId("discovered-node");
      expect(nodes.length).toBeGreaterThanOrEqual(1);
      expect(nodes[0]!.className).toContain("border-dashed");
    });
  });

  it("shows human-readable runtime, session name, and cwd", async () => {
    mockFetchSessions();
    render(createTestRouter({ component: DiscoveryOverlay, path: "/discovery", initialPath: "/discovery" }));

    await waitFor(() => {
      const activeSection = screen.getByTestId("discovery-active-section");
      const badges = screen.getAllByTestId("runtime-badge");
      expect(badges[0]!.textContent).toContain("Claude Code");
      expect(within(activeSection).getByTestId("session-name").textContent).toContain("organic");
      expect(within(activeSection).getByText("/projects/app")).toBeTruthy();
      expect(screen.queryByText("Found via")).toBeNull();
      expect(screen.queryByText("organic · window 0 · pane %0")).toBeNull();
    });
  });

  it("filters out vanished and low-confidence sessions", async () => {
    mockFetchSessions();
    render(createTestRouter({ component: DiscoveryOverlay, path: "/discovery", initialPath: "/discovery" }));

    await waitFor(() => {
      const nodes = screen.getAllByTestId("discovered-node");
      expect(nodes).toHaveLength(1);
      expect(screen.queryByText("gone")).toBeNull();
      expect(screen.queryByText("Low confidence")).toBeNull();
    });
  });

  it("copy attach copies a tmux attach command", async () => {
    mockFetchSessions();
    render(createTestRouter({ component: DiscoveryOverlay, path: "/discovery", initialPath: "/discovery" }));

    await waitFor(() => {
      const activeSection = screen.getByTestId("discovery-active-section");
      expect(within(activeSection).getByTestId("copy-tmux-btn")).toBeTruthy();
    });

    await act(async () => {
      const activeSection = screen.getByTestId("discovery-active-section");
      fireEvent.click(within(activeSection).getByTestId("copy-tmux-btn"));
    });

    await waitFor(() => {
      expect(clipboardWriteMock).toHaveBeenCalledWith("tmux attach -t 'organic:0'");
      const activeSection = screen.getByTestId("discovery-active-section");
      expect(within(activeSection).getByTestId("copy-tmux-btn").textContent).toContain("copied");
    });
  });

  it("does not auto-scan on mount", async () => {
    mockFetchSessions();
    render(createTestRouter({ component: DiscoveryOverlay, path: "/discovery", initialPath: "/discovery" }));

    await waitFor(() => {
      expect(screen.getByTestId("discovery-active-section")).toBeTruthy();
    });

    const scanCalls = fetchMock.mock.calls.filter((c: unknown[]) =>
      typeof c[0] === "string" && (c[0] as string).includes("/scan")
    );
    expect(scanCalls).toHaveLength(0);
  });

  it("scan now triggers a discovery scan", async () => {
    mockFetchSessions();
    render(createTestRouter({ component: DiscoveryOverlay, path: "/discovery", initialPath: "/discovery" }));

    await waitFor(() => {
      expect(screen.getByTestId("scan-now-btn")).toBeTruthy();
    });

    act(() => { fireEvent.click(screen.getByTestId("scan-now-btn")); });

    await waitFor(() => {
      const scanCalls = fetchMock.mock.calls.filter((c: unknown[]) =>
        typeof c[0] === "string" && (c[0] as string).includes("/scan")
      );
      expect(scanCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("adopt button opens dialog", async () => {
    mockFetchSessions();
    render(createTestRouter({ component: DiscoveryOverlay, path: "/discovery", initialPath: "/discovery" }));

    await waitFor(() => {
      expect(screen.getByTestId("adopt-btn")).toBeTruthy();
    });

    act(() => { fireEvent.click(screen.getByTestId("adopt-btn")); });

    await waitFor(() => {
      expect(screen.getByTestId("adopt-dialog")).toBeTruthy();
    });
  });

  it("adopt uses bind when an existing logical id is provided", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && typeof url === "string" && url.includes("/bind")) {
        return { ok: true, json: async () => ({ ok: true, nodeId: "n-1", sessionId: "s-1" }) };
      }
      if (typeof url === "string" && url.includes("/discovery")) {
        return { ok: true, json: async () => filterSessionsForQuery(url, MOCK_SESSIONS) };
      }
      if (typeof url === "string" && url.includes("/api/rigs/summary")) {
        return { ok: true, json: async () => [{ id: "rig-1", name: "r01-test", nodeCount: 3, latestSnapshotAt: null, latestSnapshotId: null }] };
      }
      return { ok: true, json: async () => ({}) };
    });

    render(createTestRouter({ component: DiscoveryOverlay, path: "/discovery", initialPath: "/discovery" }));

    await waitFor(() => expect(screen.getByTestId("adopt-btn")).toBeTruthy());
    act(() => { fireEvent.click(screen.getByTestId("adopt-btn")); });
    await waitFor(() => expect(screen.getByTestId("adopt-dialog")).toBeTruthy());

    act(() => { fireEvent.change(screen.getByTestId("adopt-rig-input"), { target: { value: "rig-1" } }); });
    act(() => { fireEvent.change(screen.getByTestId("adopt-logical-input"), { target: { value: "orch.lead" } }); });
    act(() => { fireEvent.click(screen.getByTestId("adopt-confirm")); });

    await waitFor(() => {
      const bindCalls = fetchMock.mock.calls.filter((c: unknown[]) =>
        typeof c[0] === "string" && (c[0] as string).includes("/bind")
      );
      expect(bindCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("adopt creates a new managed node when logical id is blank", async () => {
    let claimDone = false;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && typeof url === "string" && url.includes("/claim")) {
        claimDone = true;
        return { ok: true, json: async () => ({ ok: true, nodeId: "n-1", sessionId: "s-1" }) };
      }
      if (typeof url === "string" && url.includes("/discovery")) {
        const sessions = claimDone
          ? [{ ...MOCK_SESSIONS[0]!, status: "claimed", claimedNodeId: "n-1" }]
          : [MOCK_SESSIONS[0]!];
        return {
          ok: true,
          json: async () => filterSessionsForQuery(url, sessions),
        };
      }
      if (typeof url === "string" && url.includes("/api/rigs/summary")) {
        return { ok: true, json: async () => [{ id: "rig-1", name: "r01-test", nodeCount: 3, latestSnapshotAt: null, latestSnapshotId: null }] };
      }
      return { ok: true, json: async () => ({}) };
    });

    render(createTestRouter({ component: DiscoveryOverlay, path: "/discovery", initialPath: "/discovery" }));

    // Wait for sessions to render
    await waitFor(() => expect(screen.getByTestId("adopt-btn")).toBeTruthy());

    act(() => { fireEvent.click(screen.getByTestId("adopt-btn")); });
    await waitFor(() => expect(screen.getByTestId("adopt-dialog")).toBeTruthy());
    act(() => { fireEvent.change(screen.getByTestId("adopt-rig-input"), { target: { value: "rig-1" } }); });
    act(() => { fireEvent.click(screen.getByTestId("adopt-confirm")); });

    await waitFor(() => {
      expect(screen.queryByTestId("adopt-dialog")).toBeNull();
    });

    await waitFor(() => {
      expect(screen.getByTestId("discovery-empty")).toBeTruthy();
    });
  });

  it("adopt invalidates rig graph after success", async () => {
    let graphFetchCount = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && typeof url === "string" && url.includes("/bind")) {
        return { ok: true, json: async () => ({ ok: true, nodeId: "n-1", sessionId: "s-1" }) };
      }
      if (typeof url === "string" && url.includes("/api/rigs/rig-1/graph")) {
        graphFetchCount++;
        return { ok: true, json: async () => ({ nodes: [], edges: [] }) };
      }
      if (typeof url === "string" && url.includes("/discovery")) {
        return { ok: true, json: async () => filterSessionsForQuery(url, MOCK_SESSIONS) };
      }
      if (typeof url === "string" && url.includes("/api/rigs/summary")) {
        return { ok: true, json: async () => [{ id: "rig-1", name: "r01-test", nodeCount: 3, latestSnapshotAt: null, latestSnapshotId: null }] };
      }
      return { ok: true, json: async () => ({}) };
    });

    // Harness: renders DiscoveryOverlay + subscribes to rig graph query
    const { useQuery } = await import("@tanstack/react-query");
    function GraphSubscriber() {
      useQuery({
        queryKey: ["rig", "rig-1", "graph"],
        queryFn: async () => {
          const res = await fetch("/api/rigs/rig-1/graph");
          return res.json();
        },
      });
      return null;
    }

    const { QueryClientProvider, QueryClient } = await import("@tanstack/react-query");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });

    const { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider, Outlet } = await import("@tanstack/react-router");
    const root = createRootRoute({
      component: () => <QueryClientProvider client={qc}><GraphSubscriber /><Outlet /></QueryClientProvider>,
    });
    const route = createRoute({ getParentRoute: () => root, path: "/discovery", component: DiscoveryOverlay });
    const tree = root.addChildren([route]);
    const router = createRouter({ routeTree: tree, history: createMemoryHistory({ initialEntries: ["/discovery"] }) });

    render(<RouterProvider router={router} />);

    // Wait for initial graph fetch + discovery render
    await waitFor(() => {
      expect(graphFetchCount).toBeGreaterThanOrEqual(1);
      expect(screen.getByTestId("adopt-btn")).toBeTruthy();
    });

    const countBefore = graphFetchCount;

    act(() => { fireEvent.click(screen.getByTestId("adopt-btn")); });
    await waitFor(() => expect(screen.getByTestId("adopt-dialog")).toBeTruthy());
    act(() => { fireEvent.change(screen.getByTestId("adopt-rig-input"), { target: { value: "rig-1" } }); });
    act(() => { fireEvent.change(screen.getByTestId("adopt-logical-input"), { target: { value: "orch.lead" } }); });
    act(() => { fireEvent.click(screen.getByTestId("adopt-confirm")); });

    await waitFor(() => {
      expect(graphFetchCount).toBeGreaterThan(countBefore);
    });
  });

  // T8: Empty state
  it("empty state when no sessions", async () => {
    mockFetchSessions([]);
    render(createTestRouter({ component: DiscoveryOverlay, path: "/discovery", initialPath: "/discovery" }));

    await waitFor(() => {
      expect(screen.getByTestId("discovery-empty")).toBeTruthy();
      expect(screen.getByText("No running Claude or Codex sessions are currently visible.")).toBeTruthy();
    });
  });
});

function makeEvent(overrides: { type: string; payload?: Record<string, unknown> }): ActivityEvent {
  return {
    seq: 1, type: overrides.type,
    payload: { type: overrides.type, ...overrides.payload },
    createdAt: new Date().toISOString(), receivedAt: Date.now(),
  };
}

describe("Discovery activity feed events", () => {
  // T7a: session.discovered color
  it("session.discovered uses bg-accent color", () => {
    expect(eventColor("session.discovered")).toBe("bg-accent");
  });

  // T7b: session.vanished color
  it("session.vanished uses bg-destructive color", () => {
    expect(eventColor("session.vanished")).toBe("bg-destructive");
  });

  // T7c: node.claimed color + route
  it("node.claimed uses bg-primary color and routes to rig", () => {
    expect(eventColor("node.claimed")).toBe("bg-primary");
    expect(eventRoute(makeEvent({ type: "node.claimed", payload: { rigId: "rig-1" } }))).toBe("/rigs/rig-1");
  });

  // T7d: session.discovered route
  it("session.discovered routes to /discovery", () => {
    expect(eventRoute(makeEvent({ type: "session.discovered" }))).toBe("/discovery");
  });

  // T7e: session.vanished route
  it("session.vanished routes to /discovery", () => {
    expect(eventRoute(makeEvent({ type: "session.vanished" }))).toBe("/discovery");
  });
});

// NS-T14: Generate Draft Rig Spec button — runtime regression
import { GenerateDraftSection } from "../src/components/DiscoveryOverlay.js";

describe("Discovery Generate Draft", () => {
  it("clicking Generate Rig Spec button calls /api/discovery/draft-rig and renders YAML", async () => {
    fetchMock = vi.fn(async (url: string, opts?: RequestInit) => {
      if (typeof url === "string" && url.includes("/api/discovery/draft-rig") && opts?.method === "POST") {
        return { ok: true, text: async () => '# WARNING: Excluded session\nversion: "0.2"\nname: discovered-rig\npods: []' };
      }
      return { ok: true, json: async () => ({}) };
    });
    global.fetch = fetchMock;

    render(<GenerateDraftSection />);

    // Button should be present
    const btn = screen.getByTestId("generate-draft-btn");
    expect(btn).toBeDefined();
    expect(btn.textContent).toContain("GENERATE RIG SPEC");

    // Click generate
    await act(async () => {
      fireEvent.click(btn);
    });

    // Draft YAML should appear with warnings extracted
    await waitFor(() => {
      expect(screen.getByTestId("draft-yaml")).toBeDefined();
      expect(screen.getByTestId("draft-yaml").textContent).toContain("discovered-rig");
      // Warning should be extracted into separate section
      expect(screen.getByTestId("draft-warnings")).toBeDefined();
      expect(screen.getByTestId("draft-warnings").textContent).toContain("Excluded session");
      // YAML body should NOT contain the warning comment
      expect(screen.getByTestId("draft-yaml").textContent).not.toContain("# WARNING");
    });

    // Verify fetch was called with POST
    const draftCalls = fetchMock.mock.calls.filter((c: any[]) => String(c[0]).includes("draft-rig"));
    expect(draftCalls.length).toBeGreaterThan(0);
    expect(draftCalls[0]![1]).toEqual(expect.objectContaining({ method: "POST" }));
  });
});
