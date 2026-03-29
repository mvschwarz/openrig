import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent, act } from "@testing-library/react";
import { createTestRouter } from "./helpers/test-router.js";
import { DiscoveryOverlay } from "../src/components/DiscoveryOverlay.js";
import type { DiscoveredSession } from "../src/hooks/useDiscovery.js";
import {
  eventColor,
  eventRoute,
  type ActivityEvent,
} from "../src/hooks/useActivityFeed.js";

let fetchMock: ReturnType<typeof vi.fn>;

const MOCK_SESSIONS: DiscoveredSession[] = [
  {
    id: "ds-1", tmuxSession: "organic", tmuxWindow: "0", tmuxPane: "%0",
    pid: 1234, cwd: "/projects/app", activeCommand: "claude",
    runtimeHint: "claude-code", confidence: "high",
    evidenceJson: null, configJson: null, status: "active",
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
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mockFetchSessions(sessions: DiscoveredSession[] = MOCK_SESSIONS) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST" && typeof url === "string" && url.includes("/scan")) {
      return { ok: true, json: async () => ({ sessions }) };
    }
    if (typeof url === "string" && url.includes("/discovery")) {
      return { ok: true, json: async () => sessions };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

describe("DiscoveryOverlay", () => {
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

  // T3: Runtime hint and confidence displayed
  it("shows runtime hint and confidence badges", async () => {
    mockFetchSessions();
    render(createTestRouter({ component: DiscoveryOverlay, path: "/discovery", initialPath: "/discovery" }));

    await waitFor(() => {
      const badges = screen.getAllByTestId("runtime-badge");
      expect(badges[0]!.textContent).toContain("claude-code");
      const confBadges = screen.getAllByTestId("confidence-badge");
      expect(confBadges[0]!.textContent).toContain("high");
    });
  });

  // T4: Claim button opens dialog
  it("claim button opens dialog", async () => {
    mockFetchSessions();
    render(createTestRouter({ component: DiscoveryOverlay, path: "/discovery", initialPath: "/discovery" }));

    await waitFor(() => {
      expect(screen.getByTestId("claim-btn")).toBeTruthy();
    });

    act(() => { fireEvent.click(screen.getByTestId("claim-btn")); });

    await waitFor(() => {
      expect(screen.getByTestId("claim-dialog")).toBeTruthy();
    });
  });

  // T5: Claim submits and invalidates
  it("claim dialog submits with rigId", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && typeof url === "string" && url.includes("/claim")) {
        return { ok: true, json: async () => ({ ok: true, nodeId: "n-1", sessionId: "s-1" }) };
      }
      if (init?.method === "POST" && typeof url === "string" && url.includes("/scan")) {
        return { ok: true, json: async () => ({ sessions: MOCK_SESSIONS }) };
      }
      if (typeof url === "string" && url.includes("/discovery")) {
        return { ok: true, json: async () => MOCK_SESSIONS };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    render(createTestRouter({ component: DiscoveryOverlay, path: "/discovery", initialPath: "/discovery" }));

    await waitFor(() => expect(screen.getByTestId("claim-btn")).toBeTruthy());
    act(() => { fireEvent.click(screen.getByTestId("claim-btn")); });
    await waitFor(() => expect(screen.getByTestId("claim-dialog")).toBeTruthy());

    act(() => { fireEvent.change(screen.getByTestId("claim-rig-input"), { target: { value: "rig-1" } }); });
    act(() => { fireEvent.click(screen.getByTestId("claim-confirm")); });

    await waitFor(() => {
      // Claim fetch should have been called
      const claimCalls = fetchMock.mock.calls.filter((c: unknown[]) =>
        typeof c[0] === "string" && (c[0] as string).includes("/claim")
      );
      expect(claimCalls.length).toBeGreaterThanOrEqual(1);
    });
  });

  // T5b: Claim transition — claimed session disappears + rig graph invalidated
  it("claimed session disappears from discovery list after successful claim", async () => {
    let claimDone = false;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && typeof url === "string" && url.includes("/claim")) {
        claimDone = true;
        return { ok: true, json: async () => ({ ok: true, nodeId: "n-1", sessionId: "s-1" }) };
      }
      if (init?.method === "POST" && typeof url === "string" && url.includes("/scan")) {
        return { ok: true, json: async () => ({ sessions: claimDone ? [] : MOCK_SESSIONS }) };
      }
      if (typeof url === "string" && url.includes("/discovery")) {
        // The real API returns claimed rows from the unfiltered list.
        // The overlay must hide them while still allowing vanished rows through.
        return {
          ok: true,
          json: async () => claimDone
            ? [{ ...MOCK_SESSIONS[0]!, status: "claimed", claimedNodeId: "n-1" }]
            : [MOCK_SESSIONS[0]!],
        };
      }
      return { ok: false, status: 404, json: async () => ({}) };
    });

    render(createTestRouter({ component: DiscoveryOverlay, path: "/discovery", initialPath: "/discovery" }));

    // Wait for sessions to render
    await waitFor(() => expect(screen.getByTestId("claim-btn")).toBeTruthy());

    // Open claim dialog and submit
    act(() => { fireEvent.click(screen.getByTestId("claim-btn")); });
    await waitFor(() => expect(screen.getByTestId("claim-dialog")).toBeTruthy());
    act(() => { fireEvent.change(screen.getByTestId("claim-rig-input"), { target: { value: "rig-1" } }); });
    act(() => { fireEvent.click(screen.getByTestId("claim-confirm")); });

    // After claim, the discovery list should refresh (via invalidation) to empty
    await waitFor(() => {
      // Dialog should close (claim succeeded)
      expect(screen.queryByTestId("claim-dialog")).toBeNull();
    });

    // The claim mutation's onSuccess invalidates ['discovery'] which triggers refetch.
    // After refetch with claimDone=true, the backend still returns the claimed row,
    // but the overlay hides claimed sessions from the discovery list.
    await waitFor(() => {
      expect(screen.getByTestId("discovery-empty")).toBeTruthy();
    });
  });

  // T5c: Claim invalidates rig graph — harness with both discovery + graph query
  it("claim triggers rig graph refetch via invalidation", async () => {
    let graphFetchCount = 0;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST" && typeof url === "string" && url.includes("/claim")) {
        return { ok: true, json: async () => ({ ok: true, nodeId: "n-1", sessionId: "s-1" }) };
      }
      if (init?.method === "POST" && typeof url === "string" && url.includes("/scan")) {
        return { ok: true, json: async () => ({ sessions: MOCK_SESSIONS }) };
      }
      if (typeof url === "string" && url.includes("/api/rigs/rig-1/graph")) {
        graphFetchCount++;
        return { ok: true, json: async () => ({ nodes: [], edges: [] }) };
      }
      if (typeof url === "string" && url.includes("/discovery")) {
        return { ok: true, json: async () => MOCK_SESSIONS };
      }
      return { ok: false, status: 404, json: async () => ({}) };
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
      expect(screen.getByTestId("claim-btn")).toBeTruthy();
    });

    const countBefore = graphFetchCount;

    // Claim
    act(() => { fireEvent.click(screen.getByTestId("claim-btn")); });
    await waitFor(() => expect(screen.getByTestId("claim-dialog")).toBeTruthy());
    act(() => { fireEvent.change(screen.getByTestId("claim-rig-input"), { target: { value: "rig-1" } }); });
    act(() => { fireEvent.click(screen.getByTestId("claim-confirm")); });

    // Graph should be refetched via invalidation
    await waitFor(() => {
      expect(graphFetchCount).toBeGreaterThan(countBefore);
    });
  });

  // T6: Vanished sessions dimmed
  it("vanished sessions rendered with reduced opacity", async () => {
    mockFetchSessions();
    render(createTestRouter({ component: DiscoveryOverlay, path: "/discovery", initialPath: "/discovery" }));

    await waitFor(() => {
      const nodes = screen.getAllByTestId("discovered-node");
      const vanished = nodes.find((n) => n.className.includes("opacity-40"));
      expect(vanished).toBeDefined();
    });
  });

  // T8: Empty state
  it("empty state when no sessions", async () => {
    mockFetchSessions([]);
    render(createTestRouter({ component: DiscoveryOverlay, path: "/discovery", initialPath: "/discovery" }));

    await waitFor(() => {
      expect(screen.getByTestId("discovery-empty")).toBeTruthy();
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
