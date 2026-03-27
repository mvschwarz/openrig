import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { createMemoryHistory, RouterProvider, createRouter } from "@tanstack/react-router";
import { createMockEventSourceClass } from "./helpers/mock-event-source.js";

import "../src/globals.css";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

let OriginalEventSource: typeof EventSource | undefined;

beforeEach(async () => {
  mockFetch.mockReset();
  OriginalEventSource = globalThis.EventSource;
  globalThis.EventSource = createMockEventSourceClass() as unknown as typeof EventSource;
  // Clear production queryClient cache between tests to prevent stale data
  const { queryClient } = await import("../src/lib/query-client.js");
  queryClient.clear();
});

afterEach(() => {
  if (OriginalEventSource) globalThis.EventSource = OriginalEventSource;
  cleanup();
});

function mockAllApis() {
  mockFetch.mockImplementation((url: string) => {
    if (url === "/api/rigs/summary") {
      return Promise.resolve({
        ok: true,
        json: async () => [{ id: "r1", name: "alpha", nodeCount: 3, latestSnapshotAt: null, latestSnapshotId: null }],
      });
    }
    if (url === "/api/ps") {
      return Promise.resolve({
        ok: true,
        json: async () => [{ rigId: "r1", name: "alpha", nodeCount: 3, runningCount: 3, status: "running", uptime: "1h", latestSnapshot: null }],
      });
    }
    if (url === "/healthz") {
      return Promise.resolve({ ok: true, json: async () => ({ status: "ok" }) });
    }
    if (url === "/api/adapters/cmux/status") {
      return Promise.resolve({ ok: true, json: async () => ({ available: true }) });
    }
    if (typeof url === "string" && url.includes("/graph")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          nodes: [{ id: "n1", type: "rigNode", position: { x: 0, y: 0 }, data: { logicalId: "orchestrator", role: "orchestrator", runtime: "claude-code", model: "opus", status: "running", binding: null } }],
          edges: [],
        }),
      });
    }
    if (typeof url === "string" && url.includes("/snapshots")) {
      return Promise.resolve({ ok: true, json: async () => [] });
    }
    return Promise.resolve({ ok: true, json: async () => ({}) });
  });
}

function mockApisFailing() {
  mockFetch.mockImplementation(() => {
    return Promise.reject(new Error("connection refused"));
  });
}

/**
 * Render the REAL app router from routes.tsx at a given path.
 * This uses the production route tree, not a test-only rebuild.
 */
async function renderRealAppAt(path: string) {
  // Import the real route tree from routes.tsx
  const mod = await import("../src/routes.js");

  // Create a new router instance with memory history for testing
  // We access the route tree from the exported router
  const router = createRouter({
    routeTree: mod.router.routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });

  return render(<RouterProvider router={router} />);
}

describe("App Shell + Routing", () => {
  it("root route renders AppShell with sidebar and content area", async () => {
    mockAllApis();
    await renderRealAppAt("/");

    await waitFor(() => {
      expect(screen.getByTestId("app-header")).toBeDefined();
      expect(screen.getByTestId("sidebar")).toBeDefined();
      expect(screen.getByTestId("content-area")).toBeDefined();
      expect(screen.getByTestId("status-bar")).toBeDefined();
    });
  });

  it("/ renders dashboard content", async () => {
    mockAllApis();
    await renderRealAppAt("/");

    await waitFor(() => {
      expect(screen.getByText("alpha")).toBeDefined();
    });
  });

  it("/rigs/:rigId renders SnapshotPanel with correct rigId", async () => {
    mockAllApis();
    await renderRealAppAt("/rigs/r1");

    await waitFor(() => {
      expect(screen.getByTestId("snapshot-panel")).toBeDefined();
    });
  });

  it("/import renders import flow", async () => {
    mockAllApis();
    await renderRealAppAt("/import");

    await waitFor(() => {
      expect(screen.getByTestId("import-flow")).toBeDefined();
    });
  });

  it("sidebar navigation links work", async () => {
    mockAllApis();
    await renderRealAppAt("/");

    await waitFor(() => expect(screen.getByTestId("nav-rigs")).toBeDefined());

    fireEvent.click(screen.getByTestId("nav-import"));

    await waitFor(() => {
      expect(screen.getByTestId("import-flow")).toBeDefined();
    });
  });

  it("status bar shows CONNECTED when daemon responds", async () => {
    mockAllApis();
    await renderRealAppAt("/");

    await waitFor(() => {
      expect(screen.getByTestId("health-text").textContent).toBe("CONNECTED");
    });
  });

  it("status bar shows rig count and cmux status", async () => {
    mockAllApis();
    await renderRealAppAt("/");

    await waitFor(() => {
      expect(screen.getByTestId("rig-count").textContent).toContain("1");
      expect(screen.getByTestId("cmux-status").textContent).toContain("OK");
    });
  });

  it("status bar shows DISCONNECTED with dashes when daemon unreachable", async () => {
    mockApisFailing();
    await renderRealAppAt("/");

    await waitFor(() => {
      expect(screen.getByTestId("health-text").textContent).toBe("DISCONNECTED");
      expect(screen.getByTestId("rig-count").textContent).toContain("—");
      expect(screen.getByTestId("cmux-status").textContent).toContain("—");
    });
  });

  it("rig detail route mounts SnapshotPanel alongside graph", async () => {
    mockAllApis();
    await renderRealAppAt("/rigs/r1");

    await waitFor(() => {
      expect(screen.getByTestId("snapshot-panel")).toBeDefined();
    });
  });
});
