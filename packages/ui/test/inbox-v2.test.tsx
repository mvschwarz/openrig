// C11 Inbox v2 (restyle For You).
//
// Page header: "Inbox" + sentence-case tabs ("Needs you" / "Highlights" /
// "Everything"), compact kind segmented control, list rows (StatusDot +
// title + one-line body preview + mono author session + relative time).
// An `approval` card shows its approve button without hover; an
// `observation` card's action container carries `opacity-0`.
//
// The feed is SSE-driven (useActivityFeed subscribes to /api/events), so
// cards are driven through the durable attention endpoint (approval item)
// plus an in-process hub event (observation card). Actionability comes
// from useQueueItemMap (GET /api/queue/:id).
//
// FeedCard renders TanStack <Link>s (AuthorAgentTag, review links), so
// the feed mounts inside a test router; QueueItemTrigger needs the
// DrawerSelectionContext (same wrappers as p5-trigger-sites). The
// attention-hub EventSource is stubbed with the shared mock so the
// observation event flows without a live daemon.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor, act } from "@testing-library/react";
import {
  createMemoryHistory,
  RouterProvider,
  createRouter,
  createRootRoute,
  createRoute,
  Outlet,
} from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Feed } from "../src/components/for-you/Feed.js";
import { DrawerSelectionContext } from "../src/components/AppShell.js";
import { __test_internals as topologyHubInternals } from "../src/lib/topology-events.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  mockFetch.mockReset();
  window.localStorage.clear();
});

function renderFeed() {
  const setSelection = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <DrawerSelectionContext.Provider value={{ selection: null, setSelection }}>
        <Feed />
      </DrawerSelectionContext.Provider>
    ),
  });
  const seatRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/topology/seat/$rigId/$logicalId",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, seatRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

// Highlights-level config: approvals/shipped/progress ON, audit OFF,
// action_required ON (forced).
function settingsResponse() {
  const values: Record<string, boolean> = {
    "feed.subscriptions.action_required": true,
    "feed.subscriptions.approvals": true,
    "feed.subscriptions.shipped": true,
    "feed.subscriptions.progress": true,
    "feed.subscriptions.audit_log": true,
  };
  return {
    settings: Object.fromEntries(
      Object.entries(values).map(([k, v]) => [k, { value: v, source: "default", defaultValue: v }]),
    ),
  };
}

function stubFetch() {
  mockFetch.mockImplementation(async (url: unknown) => {
    const u = String(url);
    if (u.endsWith("/api/config")) return new Response(JSON.stringify(settingsResponse()));
    if (u.includes("/api/queue/list")) {
      return new Response(
        JSON.stringify([
          {
            qitemId: "q-approval-1",
            tsCreated: "2026-05-06T18:00:00Z",
            tsUpdated: "2026-05-06T18:00:00Z",
            sourceSession: "orch-lead@rig",
            destinationSession: "human@host",
            state: "human-gate",
            priority: "urgent",
            tier: "human-gate",
            tags: null,
            blockedOn: null,
            handedOffTo: null,
            handedOffFrom: null,
            body: "Needs approval",
            summary: "Approve the cut",
          },
        ]),
      );
    }
    if (u.includes("/api/queue/q-approval-1")) {
      return new Response(
        JSON.stringify({
          qitemId: "q-approval-1",
          tsCreated: "2026-05-06T18:00:00Z",
          tsUpdated: "2026-05-06T18:00:00Z",
          sourceSession: "orch-lead@rig",
          destinationSession: "human@host",
          state: "open",
          priority: "urgent",
          tier: "fast",
          tags: [],
          body: "Needs approval",
        }),
      );
    }
    return new Response("[]");
  });
}

function emitObservationHub() {
  act(() => {
    const hub = topologyHubInternals.topologyEventHub as unknown as {
      eventListeners: Set<(event: unknown, rawData: string) => void>;
    };
    const raw = JSON.stringify({
      seq: 901,
      type: "watchdog.note",
      createdAt: "2026-05-06T18:05:00Z",
      summary: "Background watchdog note",
      body: "Routine background observation from the watchdog stream.",
    });
    for (const listener of Array.from(hub.eventListeners)) listener(JSON.parse(raw), raw);
  });
  return Promise.resolve();
}

describe("Inbox v2 (C11)", () => {
  it("page title is Inbox with three sentence-case level tabs", async () => {
    stubFetch();
    const { findByTestId, getByText, queryByText } = renderFeed();
    expect(await findByTestId("for-you-feed")).toBeTruthy();
    expect(getByText("Inbox")).toBeTruthy();
    // Three tabs, sentence case.
    expect((await findByTestId("level-control-option-needs-you")).textContent).toBe("Needs you");
    expect((await findByTestId("level-control-option-highlights")).textContent).toBe("Highlights");
    expect((await findByTestId("level-control-option-all-activity")).textContent).toBe("Everything");
    expect(queryByText("SHOW ME")).toBeNull();
    expect(queryByText("For You")).toBeNull();
  });

  it("kind filter is a compact sentence-case segmented control", async () => {
    stubFetch();
    const { findByTestId } = renderFeed();
    for (const [id, label] of [
      ["all", "All"],
      ["action-required", "Action required"],
      ["approval", "Approvals"],
      ["shipped", "Shipped"],
      ["progress", "Progress"],
      ["observation", "Audit"],
    ] as const) {
      expect((await findByTestId(`feed-lens-${id}`)).textContent).toBe(label);
    }
  });

  it("an approval card shows its approve button without hover; an observation card's action container has opacity-0", async () => {
    stubFetch();
    const { findByTestId } = renderFeed();
    // Approval card: the approve verb button renders without hover.
    await findByTestId("mc-verb-approve");
    // Observation card via the SSE hub: its action container carries
    // opacity-0 until hover/focus-within.
    await emitObservationHub();
    const obsActions = await findByTestId("feed-card-actions-watchdog.note-901", undefined, {
      timeout: 5000,
    });
    expect(obsActions.textContent).toContain("Live terminal");
    expect(obsActions.className).toContain("opacity-0");
    await waitFor(() => expect(obsActions.isConnected).toBe(true));
  });
});
