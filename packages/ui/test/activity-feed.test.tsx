import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider, Outlet } from "@tanstack/react-router";
import { ActivityFeed } from "../src/components/ActivityFeed.js";
import {
  useActivityFeed,
  formatRelativeTime,
  eventColor,
  eventSummary,
  eventRoute,
  type ActivityEvent,
} from "../src/hooks/useActivityFeed.js";
import { createMockEventSourceClass, instances } from "./helpers/mock-event-source.js";
import type { MockEventSourceInstance } from "./helpers/mock-event-source.js";

let OriginalEventSource: typeof EventSource | undefined;

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

function makeEvent(overrides: Partial<ActivityEvent> & { type: string }): ActivityEvent {
  return {
    seq: Math.floor(Math.random() * 100000),
    type: overrides.type,
    payload: { type: overrides.type, ...overrides.payload },
    createdAt: new Date().toISOString(),
    receivedAt: Date.now(),
    ...overrides,
  };
}

/** Renders ActivityFeed inside a router that has a /rigs/$rigId route */
function renderFeedWithRouter(props: {
  events: ActivityEvent[];
  open: boolean;
  onClose?: () => void;
}) {
  const queryClient = createTestQueryClient();

  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        <ActivityFeed events={props.events} open={props.open} onClose={props.onClose ?? (() => {})} />
        <Outlet />
      </QueryClientProvider>
    ),
  });

  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <div data-testid="index-page">Index</div>,
  });

  const rigRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/rigs/$rigId",
    component: () => <div data-testid="rig-page">Rig Detail</div>,
  });

  const routeTree = rootRoute.addChildren([indexRoute, rigRoute]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });

  return render(<RouterProvider router={router} />);
}

/** Hook test harness */
function HookHarness() {
  const { events, connected, feedOpen, setFeedOpen } = useActivityFeed();
  return (
    <div>
      <span data-testid="connected">{String(connected)}</span>
      <span data-testid="event-count">{events.length}</span>
      <span data-testid="feed-open">{String(feedOpen)}</span>
      <button data-testid="toggle" onClick={() => setFeedOpen(!feedOpen)}>toggle</button>
      {events.map((e, i) => (
        <span key={i} data-testid="hook-event">{e.type}</span>
      ))}
    </div>
  );
}

function renderHookHarness() {
  const queryClient = createTestQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <HookHarness />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  OriginalEventSource = globalThis.EventSource;
  globalThis.EventSource = createMockEventSourceClass() as unknown as typeof EventSource;
});

afterEach(() => {
  if (OriginalEventSource) {
    globalThis.EventSource = OriginalEventSource;
  }
  cleanup();
});

function getLastInstance(): MockEventSourceInstance {
  return instances[instances.length - 1]!;
}

describe("Activity Feed", () => {
  // Test 1: Renders events in reverse chronological order
  it("renders events newest first", async () => {
    const events = [
      makeEvent({ type: "package.installed", seq: 3, payload: { packageName: "pkg-c", packageVersion: "1.0.0", applied: 1, deferred: 0 }, receivedAt: Date.now() }),
      makeEvent({ type: "rig.created", seq: 2, payload: { rigId: "r2" }, receivedAt: Date.now() - 5000 }),
      makeEvent({ type: "snapshot.created", seq: 1, payload: { rigId: "r1", kind: "manual" }, receivedAt: Date.now() - 10000 }),
    ];

    renderFeedWithRouter({ events, open: true });

    await waitFor(() => {
      const entries = screen.getAllByTestId("feed-entry");
      expect(entries).toHaveLength(3);
      // First entry should be the newest (seq 3)
      expect(entries[0]!.querySelector("[data-testid='feed-summary']")!.textContent).toContain("pkg-c");
    });
  });

  // Test 2: SSE message renders correct summary text
  it("package.installed renders correct summary", async () => {
    const events = [
      makeEvent({
        type: "package.installed",
        payload: { packageName: "acme-tools", packageVersion: "2.0.0", applied: 3, deferred: 1 },
      }),
    ];

    renderFeedWithRouter({ events, open: true });

    await waitFor(() => {
      const summary = screen.getByTestId("feed-summary");
      expect(summary.textContent).toContain("acme-tools");
      expect(summary.textContent).toContain("v2.0.0");
      expect(summary.textContent).toContain("3 applied");
      expect(summary.textContent).toContain("1 deferred");
    });
  });

  // Test 3: Status dot uses correct color
  it("status dot uses correct color for event type", async () => {
    const events = [
      makeEvent({ type: "package.installed", payload: { packageName: "p", packageVersion: "1", applied: 0, deferred: 0 } }),
      makeEvent({ type: "rig.created", payload: { rigId: "r1" } }),
      makeEvent({ type: "session.detached", payload: { rigId: "r1", nodeId: "n1", sessionName: "s1" } }),
    ];

    renderFeedWithRouter({ events, open: true });

    await waitFor(() => {
      const dots = screen.getAllByTestId("feed-dot");
      expect(dots).toHaveLength(3);
      expect(dots[0]!.className).toContain("bg-primary"); // package.*
      expect(dots[1]!.className).toContain("bg-accent"); // rig.*
      expect(dots[2]!.className).toContain("bg-destructive"); // session.detached
    });
  });

  // Test 4: Click rig.created entry navigates to /rigs/{rigId}
  it("click rig.created navigates to /rigs/{rigId}", async () => {
    const events = [
      makeEvent({ type: "rig.created", payload: { rigId: "rig-abc" } }),
    ];

    renderFeedWithRouter({ events, open: true });

    await waitFor(() => {
      const entry = screen.getByTestId("feed-entry");
      expect(entry.getAttribute("role")).toBe("link");
    });

    act(() => {
      fireEvent.click(screen.getByTestId("feed-entry"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("rig-page")).toBeTruthy();
    });
  });

  // Test 5: Feed bounded at 30 entries
  it("feed bounded at 30 entries", async () => {
    renderHookHarness();

    await waitFor(() => expect(instances).toHaveLength(1));
    const es = getLastInstance();

    // Send 35 events
    act(() => {
      for (let i = 0; i < 35; i++) {
        es.simulateMessage(JSON.stringify({ type: "rig.created", rigId: `r-${i}`, seq: i, createdAt: new Date().toISOString() }));
      }
    });

    await waitFor(() => {
      expect(screen.getByTestId("event-count").textContent).toBe("30");
    });
  });

  // Test 6: Collapsed state hides feed, toggle reopens
  it("collapsed hides feed, toggle reopens", async () => {
    const onClose = vi.fn();
    const events = [makeEvent({ type: "rig.created", payload: { rigId: "r1" } })];

    // Render closed
    const { rerender } = render(
      <div>
        <ActivityFeed events={events} open={false} onClose={onClose} />
      </div>
    );

    expect(screen.queryByTestId("activity-feed")).toBeNull();

    // Render open
    rerender(
      <div>
        <ActivityFeed events={events} open={true} onClose={onClose} />
      </div>
    );

    expect(screen.getByTestId("activity-feed")).toBeTruthy();
    expect(screen.getAllByTestId("feed-entry")).toHaveLength(1);
  });

  // Test 7a: formatRelativeTime pure function
  it("formatRelativeTime produces correct strings", () => {
    const now = 1711400000000;
    expect(formatRelativeTime(now, now + 3000)).toBe("just now");
    expect(formatRelativeTime(now, now + 15000)).toBe("15s ago");
    expect(formatRelativeTime(now, now + 90000)).toBe("1m ago");
    expect(formatRelativeTime(now, now + 7200000)).toBe("2h ago");
  });

  // Test 7b: Live hook tick re-renders, updating rendered timestamp in full integration
  it("rendered timestamp updates on tick interval via hook", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    // Harness that uses the real hook and renders ActivityFeed
    function LiveFeedHarness() {
      const feed = useActivityFeed();
      return (
        <ActivityFeed events={feed.events} open={true} onClose={() => {}} />
      );
    }

    const queryClient = createTestQueryClient();
    const rootRoute = createRootRoute({
      component: () => (
        <QueryClientProvider client={queryClient}>
          <LiveFeedHarness />
          <Outlet />
        </QueryClientProvider>
      ),
    });
    const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => <div /> });
    const routeTree = rootRoute.addChildren([indexRoute]);
    const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ["/"] }) });
    render(<RouterProvider router={router} />);

    // Wait for SSE connection
    await waitFor(() => expect(instances).toHaveLength(1));
    const es = getLastInstance();

    // Send an event with createdAt = now
    const now = new Date().toISOString();
    act(() => {
      es.simulateMessage(JSON.stringify({ type: "rig.created", rigId: "r1", seq: 1, createdAt: now }));
    });

    await waitFor(() => {
      expect(screen.getByTestId("feed-time").textContent).toBe("just now");
    });

    // Advance 90 seconds (6 ticks of 15s interval)
    act(() => {
      vi.advanceTimersByTime(90_000);
    });

    await waitFor(() => {
      expect(screen.getByTestId("feed-time").textContent).toBe("1m ago");
    });

    vi.useRealTimers();
  });

  // Test 8: Empty state
  it("empty state shows 'No recent activity'", async () => {
    renderFeedWithRouter({ events: [], open: true });

    await waitFor(() => {
      expect(screen.getByTestId("feed-empty").textContent).toContain("No recent activity");
    });
  });

  // Test 9: Connects to /api/events without rigId
  it("connects to /api/events (global stream)", async () => {
    renderHookHarness();

    await waitFor(() => {
      expect(instances).toHaveLength(1);
      expect(instances[0]!.url).toBe("/api/events");
    });
  });

  // Test 10: Package entries are non-interactive — click is a no-op
  it("package.installed entry is non-interactive (deferred to PUX-T02)", async () => {
    const events = [
      makeEvent({ type: "package.installed", payload: { packageName: "p", packageVersion: "1", applied: 1, deferred: 0 } }),
    ];

    renderFeedWithRouter({ events, open: true });

    await waitFor(() => {
      const entry = screen.getByTestId("feed-entry");
      // No link role
      expect(entry.getAttribute("role")).toBeNull();
      // No cursor-pointer
      expect(entry.className).not.toContain("cursor-pointer");
    });

    // Click the entry — should NOT navigate away from index
    act(() => {
      fireEvent.click(screen.getByTestId("feed-entry"));
    });

    // Index page still visible — no navigation occurred
    await waitFor(() => {
      expect(screen.getByTestId("index-page")).toBeTruthy();
    });
    expect(screen.queryByTestId("rig-page")).toBeNull();
  });
});

describe("eventRoute", () => {
  it("returns null for package events", () => {
    expect(eventRoute(makeEvent({ type: "package.installed", payload: {} }))).toBeNull();
    expect(eventRoute(makeEvent({ type: "package.install_failed", payload: {} }))).toBeNull();
  });

  it("returns /rigs/{rigId} for rig-scoped events", () => {
    expect(eventRoute(makeEvent({ type: "rig.created", payload: { rigId: "r1" } }))).toBe("/rigs/r1");
    expect(eventRoute(makeEvent({ type: "snapshot.created", payload: { rigId: "r2", kind: "manual" } }))).toBe("/rigs/r2");
  });
});
