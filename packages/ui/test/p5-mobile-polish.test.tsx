// V1 attempt-3 Phase 5 P5-9 — Mobile responsive polish.
//
// Coverage:
//   - MobileBottomNav renders 3 slots at <lg viewport (For You / Project /
//     Topology). Talk slots are V2-deferred per universal-shell.md L144;
//     negative-assertion that "talk" / advisor / operator do NOT appear
//     in the mobile bottom nav.
//   - Topology graph view-mode degrades to table at <lg viewport per
//     universal-shell.md L143; tab nav still shows graph as the user's
//     selected mode (so resize-to-wide reactivates the graph).
//   - useShellViewport hook reflects window.innerWidth changes.
//   - Bottom nav is hidden at >= lg viewport (lg:hidden class).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  RouterProvider,
  createRouter,
} from "@tanstack/react-router";
import { readFileSync } from "node:fs";
import path from "node:path";
import { useShellViewport } from "../src/hooks/useShellViewport.js";
import { renderHook, act } from "@testing-library/react";
import { createMockEventSourceClass } from "./helpers/mock-event-source.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

let OriginalEventSource: typeof EventSource | undefined;

beforeEach(async () => {
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes("/api/rigs/summary")) return new Response(JSON.stringify([]));
    if (url.includes("/api/rigs/ps")) return new Response(JSON.stringify([]));
    if (url.includes("/api/inventory")) return new Response(JSON.stringify([]));
    if (url.includes("/api/config")) return new Response("not implemented", { status: 404 });
    return new Response("[]");
  });
  OriginalEventSource = globalThis.EventSource;
  globalThis.EventSource = createMockEventSourceClass() as unknown as typeof EventSource;
  const { queryClient } = await import("../src/lib/query-client.js");
  queryClient.clear();
});

afterEach(() => {
  if (OriginalEventSource) globalThis.EventSource = OriginalEventSource;
  window.localStorage.clear();
  cleanup();
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1024,
    writable: true,
  });
  window.dispatchEvent(new Event("resize"));
});

async function renderAt(initialPath: string, viewportWidth: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: viewportWidth,
    writable: true,
  });
  window.dispatchEvent(new Event("resize"));
  const { router } = await import("../src/routes.js");
  const memoryHistory = createMemoryHistory({ initialEntries: [initialPath] });
  const memoryRouter = createRouter({ routeTree: router.routeTree, history: memoryHistory });
  const result = render(<RouterProvider router={memoryRouter} />);
  await waitFor(() => {
    expect(result.container.querySelector("[data-testid='app-rail']")).toBeTruthy();
  }, { timeout: 5000 });
  return result;
}

describe("useShellViewport (P5-9 hook)", () => {
  it("reports isWideLayout=true when innerWidth >= 1024", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440, writable: true });
    const { result } = renderHook(() => useShellViewport());
    expect(result.current.isWideLayout).toBe(true);
    expect(result.current.innerWidth).toBeGreaterThanOrEqual(1024);
  });

  it("reports isWideLayout=false when innerWidth < 1024", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 375, writable: true });
    const { result } = renderHook(() => useShellViewport());
    expect(result.current.isWideLayout).toBe(false);
  });

  it("reacts to window resize events", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440, writable: true });
    const { result } = renderHook(() => useShellViewport());
    expect(result.current.isWideLayout).toBe(true);
    act(() => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 375, writable: true });
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current.isWideLayout).toBe(false);
  });
});

describe("MobileBottomNav P5-9 — universal-shell.md L135 + L144", () => {
  it("renders 3 slots (For You / Project / Topology) at mobile viewport", async () => {
    const { container } = await renderAt("/", 375);
    const nav = container.querySelector("[data-testid='mobile-bottom-nav']");
    expect(nav).toBeTruthy();
    expect(container.querySelector("[data-testid='mobile-nav-for-you']")).toBeTruthy();
    expect(container.querySelector("[data-testid='mobile-nav-project']")).toBeTruthy();
    expect(container.querySelector("[data-testid='mobile-nav-topology']")).toBeTruthy();
  });

  it("does NOT render Talk / advisor / operator slots (V2 deferred per L144)", async () => {
    const { container } = await renderAt("/", 375);
    expect(container.querySelector("[data-testid='mobile-nav-advisor']")).toBeNull();
    expect(container.querySelector("[data-testid='mobile-nav-operator']")).toBeNull();
    expect(container.querySelector("[data-testid='mobile-nav-talk']")).toBeNull();
    // Source-assertion: AppShell.tsx mobile-bottom-nav block must not
    // mention "advisor" or "operator" or "talk" in slot ids.
    const src = readFileSync(
      path.resolve(__dirname, "../src/components/AppShell.tsx"),
      "utf8",
    );
    const navBlock = src.match(/MobileBottomNav[\s\S]*?^}/m)?.[0] ?? "";
    expect(navBlock).not.toMatch(/id:\s*"(advisor|operator|talk)"/);
  });

  it("active route highlights the matching mobile nav slot", async () => {
    const { container } = await renderAt("/topology", 375);
    const topology = container.querySelector("[data-testid='mobile-nav-topology']");
    expect(topology?.getAttribute("data-active")).toBe("true");
    const project = container.querySelector("[data-testid='mobile-nav-project']");
    expect(project?.getAttribute("data-active")).toBe("false");
  });

  it("nav element carries lg:hidden so desktop never shows it (CSS-source contract)", async () => {
    const { container } = await renderAt("/", 375);
    const nav = container.querySelector("[data-testid='mobile-bottom-nav']");
    expect(nav?.className).toMatch(/lg:hidden/);
  });
});

describe("Topology graph degradation P5-9 (universal-shell.md L143)", () => {
  it("at <lg viewport, /topology graph view-mode renders the table view + degraded hint", async () => {
    const { container, findByTestId } = await renderAt("/topology", 375);
    // The table view-mode is what actually mounts (graph degraded).
    expect(await findByTestId("topology-mobile-graph-degraded")).toBeTruthy();
    // graph placeholder is NOT rendered at mobile.
    expect(container.querySelector("[data-testid='topology-host-graph-placeholder']")).toBeNull();
  });

  it("at >= lg viewport, /topology graph view-mode renders the graph (no degradation hint)", async () => {
    const { findByTestId, container } = await renderAt("/topology", 1440);
    // Default tab is graph; placeholder visible.
    expect(await findByTestId("topology-host-graph-placeholder")).toBeTruthy();
    expect(container.querySelector("[data-testid='topology-mobile-graph-degraded']")).toBeNull();
  });
});
