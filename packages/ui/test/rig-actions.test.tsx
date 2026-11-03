// C12: rig actions menu — opens with keyDown Enter, "Stop rig" opens a
// confirm dialog, Cancel closes without fetch, dialog "Stop rig" calls the
// teardown endpoint.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { createMemoryHistory, RouterProvider, createRouter, createRootRoute, createRoute, Outlet } from "@tanstack/react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMockEventSourceClass } from "./helpers/mock-event-source.js";
import { AppShell } from "../src/components/AppShell.js";
import { RigScopePage, RigActionsMenu } from "../src/components/topology/ScopePages.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

let OriginalEventSource: typeof EventSource | undefined;

const RIG_SUMMARY = [
  { id: "rig_alpha", name: "acme-build", nodeCount: 2, latestSnapshotAt: null, latestSnapshotId: null, lifecycleState: "running" as const },
];

function fetchImpl(url: unknown) {
  const u = String(url);
  if (u === "/api/hosts") return Promise.resolve(new Response(JSON.stringify({ selected: "local", ownName: "localhost", hosts: [] })));
  if (u.includes("/api/rigs/summary")) return Promise.resolve(new Response(JSON.stringify(RIG_SUMMARY)));
  if (u.includes("/api/rigs/rig_alpha/status")) {
    return Promise.resolve(new Response(JSON.stringify({ rigName: "acme-build", status: "up", src: [], seatsRunning: 1, seatsTotal: 2 })));
  }
  if (u.includes("/api/rigs/rig_alpha/nodes")) return Promise.resolve(new Response(JSON.stringify([])));
  return Promise.resolve(new Response("[]"));
}

beforeEach(async () => {
  mockFetch.mockReset();
  mockFetch.mockImplementation(fetchImpl);
  OriginalEventSource = globalThis.EventSource;
  globalThis.EventSource = createMockEventSourceClass() as unknown as typeof EventSource;
  const { queryClient } = await import("../src/lib/query-client.js");
  queryClient.clear();
});

afterEach(() => {
  if (OriginalEventSource) globalThis.EventSource = OriginalEventSource;
  cleanup();
});

vi.mock("../src/components/terminal/ProgressiveTerminal.js", () => ({
  ProgressiveTerminal: () => null,
}));

vi.mock("../src/components/topology/TopologyTerminalView.js", () => ({
  TopologyTerminalView: () => null,
}));

vi.mock("../src/components/topology/HostMultiRigGraph.js", () => ({
  HostMultiRigGraph: () => null,
}));

vi.mock("../src/components/RigGraph.js", () => ({
  RigGraph: () => null,
}));

vi.mock("../src/components/RigStatusControl.js", () => ({
  RigStatusControl: () => null,
}));

function buildRouter() {
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
  const rigRoute = createRoute({ getParentRoute: () => rootRoute, path: "/topology/rig/$rigId", component: RigScopePage });
  const catchAll = createRoute({ getParentRoute: () => rootRoute, path: "$", component: () => null });
  const routeTree = rootRoute.addChildren([rigRoute, catchAll]);
  return createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ["/topology/rig/rig_alpha"] }) });
}

async function renderRigPage() {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440, writable: true });
  const r = buildRouter();
  const result = render(<RouterProvider router={r} />);
  await waitFor(() => {
    expect(result.container.querySelector("[data-testid='page-header']")).toBeTruthy();
  }, { timeout: 5000 });
  return result;
}

/** Render the standalone actions menu and open it via keyboard Enter.
 *  Shared by the Cancel and teardown tests so the menu-open flow
 *  (trigger → menuitem "Stop rig") is asserted in one place. */
function renderOpenMenu() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={queryClient}>
      <RigActionsMenu rigId="rig_alpha" rigName="acme-build" />
    </QueryClientProvider>,
  );
  const trigger = document.body.querySelector("[data-testid='rig-actions']") as HTMLElement;
  expect(trigger).toBeTruthy();
  fireEvent.keyDown(trigger, { key: "Enter" });
}

/** After renderOpenMenu, find the destructive "Stop rig" menu item and click it. */
function clickStopMenuItem() {
  const stopItem = Array.from(document.body.querySelectorAll("[role='menuitem']")).find((e) =>
    e.textContent?.includes("Stop rig"),
  ) as HTMLElement | undefined;
  expect(stopItem).toBeTruthy();
  fireEvent.click(stopItem as HTMLElement);
}

describe("C12: rig actions menu", () => {
  it("page header shows rig name, lifecycle badge, and mono rig id", async () => {
    const { container } = await renderRigPage();
    await waitFor(() => {
      expect(container.querySelector("[data-testid='rig-actions']")).toBeTruthy();
    }, { timeout: 5000 });
    const header = container.querySelector("[data-testid='page-header']");
    expect(header?.textContent).toContain("acme-build");
    expect(container.querySelector("[data-testid='rig-lifecycle-badge']")).toBeTruthy();
    expect(container.querySelector("[data-testid='rig-lifecycle-badge']")?.textContent).toBe("Running");
    expect(container.querySelector("[data-testid='rig-id-mono']")?.textContent).toBe("rig_alpha");
  });

  it("actions menu opens with keyDown Enter", async () => {
    const { container } = await renderRigPage();
    await waitFor(() => {
      expect(container.querySelector("[data-testid='rig-actions']")).toBeTruthy();
    }, { timeout: 5000 });
    fireEvent.keyDown(container.querySelector("[data-testid='rig-actions']") as HTMLElement, { key: "Enter" });
    await waitFor(() => {
      expect(document.body.textContent).toContain("Save snapshot");
    });
    expect(document.body.textContent).toContain("Stop rig");
  });


  it("\"Stop rig\" opens the confirm dialog; Cancel closes it without calling fetch", async () => {
    renderOpenMenu();
    clickStopMenuItem();
    const callsBefore = mockFetch.mock.calls.length;
    await waitFor(() => {
      expect(document.body.textContent).toContain("All agents in this rig will be stopped");
    });
    expect(document.body.textContent).toContain("Stop acme-build?");
    const cancelBtn = Array.from(document.body.querySelectorAll("button")).find((el) =>
      el.textContent === "Cancel",
    ) as HTMLElement;
    fireEvent.click(cancelBtn);
    expect(document.body.textContent).not.toContain("All agents in this rig will be stopped");
    expect(mockFetch.mock.calls.length).toBe(callsBefore);
  });

  it("\"Stop rig\" in the dialog calls the teardown endpoint with the rig id", async () => {
    renderOpenMenu();
    clickStopMenuItem();
    const confirmBtn = await waitFor(() => {
      const el = document.body.querySelector("[data-testid='rig-stop-confirm-button']") as HTMLElement | null;
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    mockFetch.mockClear();
    fireEvent.click(confirmBtn);
    await waitFor(() => {
      expect(mockFetch.mock.calls.some((c) => String(c[0]).includes("/api/down"))).toBe(true);
    }, { timeout: 8000 });
    const calls = mockFetch.mock.calls.map((c) => JSON.stringify(c[0]) + " " + JSON.stringify(c[1]?.body ?? ""));
    expect(calls.find((c) => c.includes("rig_alpha"))).toBeTruthy();
  });

});
