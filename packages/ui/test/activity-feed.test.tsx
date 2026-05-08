import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider, Outlet } from "@tanstack/react-router";
import { ActivityFeed } from "../src/components/ActivityFeed.js";
import {
  useActivityFeed,
  formatLogTime,
  eventColor,
  eventSummary,
  eventRoute,
  type ActivityEvent,
} from "../src/hooks/useActivityFeed.js";
import { usePackages } from "../src/hooks/usePackages.js";
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

  const bootstrapRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/bootstrap",
    component: () => <div data-testid="bootstrap-page">Bootstrap</div>,
  });

  const routeTree = rootRoute.addChildren([indexRoute, rigRoute, bootstrapRoute]);
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

function ReplayHarness({ testId }: { testId: string }) {
  const { events } = useActivityFeed();
  return <span data-testid={testId}>{events.map((event) => event.type).join(",")}</span>;
}

function renderHookHarness() {
  const queryClient = createTestQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <HookHarness />
    </QueryClientProvider>
  );
}

function PackagesInvalidationHarness() {
  const { events } = useActivityFeed();
  const { data: packages = [] } = usePackages();

  return (
    <div>
      <span data-testid="packages-count">{packages.length}</span>
      <span data-testid="feed-events">{events.length}</span>
    </div>
  );
}

function renderPackagesInvalidationHarness() {
  const queryClient = createTestQueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <PackagesInvalidationHarness />
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
      expect(summary.textContent).toBe("package acme-tools@2.0.0 3 applied 1 deferred");
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

  // Test 5: Feed bounded at 100 entries
  it("feed bounded at 100 entries", async () => {
    renderHookHarness();

    await waitFor(() => expect(instances).toHaveLength(1));
    const es = getLastInstance();

    // Send 105 events
    act(() => {
      for (let i = 0; i < 105; i++) {
        es.simulateMessage(JSON.stringify({ type: "rig.created", rigId: `r-${i}`, seq: i, createdAt: new Date().toISOString() }));
      }
    });

    await waitFor(() => {
      expect(screen.getByTestId("event-count").textContent).toBe("100");
    });
  });

  it("shows recent-log disclosure copy and capped-history footer", async () => {
    const events = Array.from({ length: 100 }, (_, i) =>
      makeEvent({ type: "rig.created", seq: i + 1, payload: { rigId: `r-${i}` } })
    );

    renderFeedWithRouter({ events, open: true });

    await waitFor(() => {
      expect(screen.getByText("RECENT LOG")).toBeTruthy();
      expect(screen.getByTestId("feed-disclosure").textContent).toContain("Showing last 100 live events");
      expect(screen.getByTestId("feed-scroll-region").className).toContain("overflow-y-auto");
      expect(screen.getByTestId("feed-end-of-history").textContent).toContain("Older events are not loaded in this panel yet");
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

    const feed = screen.getByTestId("activity-feed");
    expect(feed).toBeTruthy();
    expect(feed.className).toContain("fixed");
    expect(feed.className).not.toContain("relative");
    expect(feed.className).toContain("backdrop-blur-[14px]");
    expect(feed.className).not.toContain("bg-surface-dark");
    expect(screen.getAllByTestId("feed-entry")).toHaveLength(1);
  });

  // Test 7a: terminal log time format
  it("formatLogTime produces HH:MM:SS", () => {
    expect(formatLogTime("2026-04-01T16:48:20")).toBe("16:48:20");
  });

  // Test 7b: rendered timestamp uses compact wall-clock time
  it("rendered timestamp uses compact wall-clock time", async () => {
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

    // Send an event with a fixed local timestamp
    act(() => {
      es.simulateMessage(JSON.stringify({ type: "rig.created", rigId: "r1", seq: 1, createdAt: "2026-04-01T16:48:20" }));
    });

    await waitFor(() => {
      expect(screen.getByTestId("feed-time").textContent).toBe("16:48:20");
    });
  });

  // Test 8: Empty state
  it("empty state shows 'No recent log entries'", async () => {
    renderFeedWithRouter({ events: [], open: true });

    await waitFor(() => {
      expect(screen.getByTestId("feed-empty").textContent).toContain("No recent log entries");
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

  it("replays recent events to Feed consumers mounted after the shared hub is already connected", async () => {
    const queryClient = createTestQueryClient();
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <ReplayHarness testId="early-feed" />
      </QueryClientProvider>
    );

    await waitFor(() => expect(instances).toHaveLength(1));
    act(() => {
      getLastInstance().simulateMessage(JSON.stringify({
        type: "queue.created",
        qitemId: "qitem-late-feed",
        sourceSession: "orch@rig",
        destinationSession: "driver@rig",
        seq: 91,
        createdAt: "2026-05-08T00:00:00.000Z",
      }));
    });

    await waitFor(() => {
      expect(screen.getByTestId("early-feed").textContent).toContain("queue.created");
    });

    rerender(
      <QueryClientProvider client={queryClient}>
        <ReplayHarness testId="early-feed" />
        <ReplayHarness testId="late-feed" />
      </QueryClientProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId("late-feed").textContent).toContain("queue.created");
    });
  });

  // Test 10: Package entries navigate to /bootstrap because package installs are bootstrap-adjacent legacy tools
  it("package.installed entry navigates to /bootstrap on click", async () => {
    const events = [
      makeEvent({ type: "package.installed", payload: { packageName: "p", packageVersion: "1", applied: 1, deferred: 0 } }),
    ];

    renderFeedWithRouter({ events, open: true });

    await waitFor(() => {
      const entry = screen.getByTestId("feed-entry");
      expect(entry.getAttribute("role")).toBe("link");
      expect(entry.className).toContain("cursor-pointer");
    });

    act(() => {
      fireEvent.click(screen.getByTestId("feed-entry"));
    });

    await waitFor(() => {
      expect(screen.getByTestId("bootstrap-page")).toBeTruthy();
    });
  });

  it("package SSE invalidates and refetches the packages query", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    fetchSpy
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [],
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => [
          {
            id: "pkg-1",
            name: "demo",
            version: "1.0.0",
            sourceKind: "local_path",
            sourceRef: "/tmp/demo",
            manifestHash: "abc",
            summary: "demo pkg",
            createdAt: "2026-03-25 10:00:00",
            installCount: 1,
            latestInstallStatus: "applied",
          },
        ],
      } as Response);

    renderPackagesInvalidationHarness();

    await waitFor(() => {
      expect(screen.getByTestId("packages-count").textContent).toBe("0");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    act(() => {
      getLastInstance().simulateMessage(JSON.stringify({
        type: "package.installed",
        packageName: "demo",
        packageVersion: "1.0.0",
        applied: 1,
        deferred: 0,
        createdAt: new Date().toISOString(),
        seq: 1,
      }));
    });

    await waitFor(() => {
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId("packages-count").textContent).toBe("1");
      expect(screen.getByTestId("feed-events").textContent).toBe("1");
    });

    fetchSpy.mockRestore();
  });
});

describe("eventRoute", () => {
  it("returns /bootstrap for package events", () => {
    expect(eventRoute(makeEvent({ type: "package.installed", payload: {} }))).toBe("/bootstrap");
    expect(eventRoute(makeEvent({ type: "package.install_failed", payload: {} }))).toBe("/bootstrap");
    expect(eventRoute(makeEvent({ type: "package.rolledback", payload: {} }))).toBe("/bootstrap");
  });

  it("returns /rigs/{rigId} for rig-scoped events", () => {
    expect(eventRoute(makeEvent({ type: "rig.created", payload: { rigId: "r1" } }))).toBe("/rigs/r1");
    expect(eventRoute(makeEvent({ type: "snapshot.created", payload: { rigId: "r2", kind: "manual" } }))).toBe("/rigs/r2");
  });

  // T11: bootstrap event color = bg-accent
  it("returns bg-accent for bootstrap events", () => {
    expect(eventColor("bootstrap.planned")).toBe("bg-accent");
    expect(eventColor("bootstrap.started")).toBe("bg-accent");
    expect(eventColor("bootstrap.completed")).toBe("bg-accent");
    expect(eventColor("bootstrap.partial")).toBe("bg-accent");
    expect(eventColor("bootstrap.failed")).toBe("bg-accent");
  });

  // T12: bootstrap event route -> /bootstrap
  it("returns /bootstrap for bootstrap events", () => {
    expect(eventRoute(makeEvent({ type: "bootstrap.planned", payload: {} }))).toBe("/bootstrap");
    expect(eventRoute(makeEvent({ type: "bootstrap.completed", payload: {} }))).toBe("/bootstrap");
    expect(eventRoute(makeEvent({ type: "bootstrap.partial", payload: {} }))).toBe("/bootstrap");
    expect(eventRoute(makeEvent({ type: "bootstrap.failed", payload: {} }))).toBe("/bootstrap");
  });

  it("uses nodeId when node.launched payload does not include logicalId", () => {
    expect(
      eventSummary(
        makeEvent({
          type: "node.launched",
          payload: { nodeId: "dev", sessionName: "r00-dogfood-dev" },
        })
      )
    ).toBe("startup dev launched");
  });

  it("tails rig and snapshot IDs in restore and snapshot summaries", () => {
    expect(
      eventSummary(
        makeEvent({
          type: "restore.completed",
          payload: {
            rigId: "01KN5DX669Z02VTZEZK7RGT7NK",
            snapshotId: "01KN5E0BAW8SD3HQY72W58RWDP",
            result: { nodes: [{}, {}, {}] },
          },
        })
      )
    ).toBe("restore rig#RGT7NK 3 nodes restored");

    expect(
      eventSummary(
        makeEvent({
          type: "snapshot.created",
          payload: {
            rigId: "01KN5DX669Z02VTZEZK7RGT7NK",
            snapshotId: "01KN5E0BAW8SD3HQY72W58RWDP",
            kind: "pre_restore",
          },
        })
      )
    ).toBe("snapshot rig#RGT7NK pre_restore snap#58RWDP");
  });

  it("formats chat messages as compact operator log lines", () => {
    expect(
      eventSummary(
        makeEvent({
          type: "chat.message",
          payload: {
            sender: "orch.lead",
            body: "review the restore path",
          },
        })
      )
    ).toBe("chat orch.lead: review the restore path");
  });

  // Bundle event
  it("bundle.created uses bg-accent color, correct summary, and null route", () => {
    expect(eventColor("bundle.created")).toBe("bg-accent");
    const evt = makeEvent({ type: "bundle.created", payload: { bundleName: "my-bundle", bundleVersion: "2.0" } });
    expect(eventSummary(evt)).toContain("my-bundle");
    expect(eventSummary(evt)).toContain("v2.0");
    expect(eventSummary(evt)).toContain("bundled");
    expect(eventRoute(evt)).toBeNull();
  });

  // Discovery event feed tests
  it("session.discovered uses bg-accent color and /discovery route", () => {
    expect(eventColor("session.discovered")).toBe("bg-accent");
    expect(eventRoute(makeEvent({ type: "session.discovered", payload: {} }))).toBe("/discovery");
  });

  it("session.vanished uses bg-destructive color and /discovery route", () => {
    expect(eventColor("session.vanished")).toBe("bg-destructive");
    expect(eventRoute(makeEvent({ type: "session.vanished", payload: {} }))).toBe("/discovery");
  });

  it("node.claimed uses bg-primary color and routes to rig", () => {
    expect(eventColor("node.claimed")).toBe("bg-primary");
    expect(eventRoute(makeEvent({ type: "node.claimed", payload: { rigId: "rig-1" } }))).toBe("/rigs/rig-1");
  });
});
