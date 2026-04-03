import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { createMemoryHistory, RouterProvider, createRouter } from "@tanstack/react-router";
import { createMockEventSourceClass } from "./helpers/mock-event-source.js";

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
  window.localStorage.clear();
  cleanup();
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1024,
    writable: true,
  });
  window.dispatchEvent(new Event("resize"));
});

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: width,
    writable: true,
  });
  window.dispatchEvent(new Event("resize"));
}

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
    if (typeof url === "string" && url.includes("/nodes/")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({
          rigId: "r1",
          rigName: "alpha",
          logicalId: "orch.lead",
          podId: "orch",
          canonicalSessionName: "orch-lead@alpha",
          nodeKind: "agent",
          runtime: "claude-code",
          sessionStatus: "running",
          startupStatus: "ready",
          restoreOutcome: "resumed",
          tmuxAttachCommand: "tmux attach -t orch-lead@alpha",
          resumeCommand: "claude --resume abc-123",
          latestError: null,
          model: "opus",
          agentRef: "local:agents/lead",
          profile: "default",
          resolvedSpecName: "lead",
          resolvedSpecVersion: "1.0.0",
          startupFiles: [],
          startupActions: [],
          recentEvents: [],
          infrastructureStartupCommand: null,
          binding: { tmuxSession: "orch-lead@alpha" },
        }),
      });
    }
    if (typeof url === "string" && url.includes("/api/rigs/r1/nodes")) {
      return Promise.resolve({
        ok: true,
        json: async () => [
          { rigId: "r1", rigName: "alpha", logicalId: "orch.lead", podId: "orch", nodeKind: "agent", runtime: "claude-code", startupStatus: "ready", canonicalSessionName: "orch-lead@alpha" },
        ],
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
      expect(screen.getByTestId("explorer")).toBeDefined();
      expect(screen.getByTestId("content-area")).toBeDefined();
      expect(screen.getByTestId("specs-toggle")).toBeDefined();
      expect(screen.getByTestId("system-toggle")).toBeDefined();
    });
  });

  it("header brand links back to home and the gear is borderless", async () => {
    mockAllApis();
    await renderRealAppAt("/rigs/r1");

    await waitFor(() => {
      expect(screen.getByTestId("brand-home-link")).toBeDefined();
      expect(screen.getByTestId("discovery-toggle")).toBeDefined();
      expect(screen.getByTestId("specs-toggle")).toBeDefined();
      expect(screen.getByTestId("system-toggle")).toBeDefined();
    });

    const brand = screen.getByTestId("brand-home-link");
    expect(brand.getAttribute("href")).toBe("/");
    expect(brand.className).toContain("bg-stone-950");

    const gear = screen.getByTestId("system-toggle");
    expect(gear.className).not.toContain("border");
    expect(gear.className).not.toContain("bg-white");
  });

  it("header specs button opens the specs drawer", async () => {
    mockAllApis();
    await renderRealAppAt("/rigs/r1");

    await waitFor(() => {
      expect(screen.getByTestId("specs-toggle")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("specs-toggle"));

    await waitFor(() => {
      expect(screen.getByTestId("specs-panel")).toBeDefined();
      expect(screen.getByText("Import RigSpec")).toBeDefined();
      expect(screen.getByText("Bootstrap")).toBeDefined();
      expect(screen.getByText("Validate AgentSpec")).toBeDefined();
    });
  });

  it("wide layouts keep the specs drawer open across navigation", async () => {
    mockAllApis();
    setViewportWidth(1280);
    await renderRealAppAt("/specs");

    await waitFor(() => {
      expect(screen.getByTestId("specs-panel")).toBeDefined();
      expect(screen.getByText("Import RigSpec")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Import RigSpec"));

    await waitFor(() => {
      expect(screen.getByTestId("import-flow")).toBeDefined();
      expect(screen.getByTestId("specs-panel")).toBeDefined();
    });
  });

  it("wide layouts keep specs open when launching validate agent", async () => {
    mockAllApis();
    setViewportWidth(1280);
    await renderRealAppAt("/specs");

    await waitFor(() => {
      expect(screen.getByTestId("specs-panel")).toBeDefined();
      expect(screen.getByText("Validate AgentSpec")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Validate AgentSpec"));

    await waitFor(() => {
      expect(screen.getByTestId("agent-spec-validate-flow")).toBeDefined();
      expect(screen.getByTestId("specs-panel")).toBeDefined();
    });
  });

  it("wide layouts keep specs open when opening a rig draft review from the drawer", async () => {
    window.localStorage.setItem("rigged.specs.recent-rig-drafts", JSON.stringify([
      {
        id: "rig-review",
        kind: "rig",
        label: "review-target",
        yaml: "name: review-target\npods: []\n",
        updatedAt: Date.now(),
      },
    ]));

    mockAllApis();
    setViewportWidth(1280);
    await renderRealAppAt("/specs");

    await waitFor(() => {
      expect(screen.getByTestId("specs-panel")).toBeDefined();
      expect(screen.getByText("review-target")).toBeDefined();
    });

    fireEvent.click(screen.getByText("review-target"));

    await waitFor(() => {
      expect(screen.getByTestId("rig-spec-review")).toBeDefined();
      expect(screen.getByTestId("specs-panel")).toBeDefined();
    });
  });

  it("wide layouts keep specs open when opening an agent draft review from the drawer", async () => {
    window.localStorage.setItem("rigged.specs.recent-agent-drafts", JSON.stringify([
      {
        id: "agent-review",
        kind: "agent",
        label: "qa",
        yaml: "name: qa\nprofiles:\n  default:\n",
        updatedAt: Date.now(),
      },
    ]));

    mockAllApis();
    setViewportWidth(1280);
    await renderRealAppAt("/specs");

    await waitFor(() => {
      expect(screen.getByTestId("specs-panel")).toBeDefined();
      expect(screen.getByText("qa")).toBeDefined();
    });

    fireEvent.click(screen.getByText("qa"));

    await waitFor(() => {
      expect(screen.getByTestId("agent-spec-review")).toBeDefined();
      expect(screen.getByTestId("specs-panel")).toBeDefined();
    });
  });

  it("compact layouts clear the specs drawer on navigation to a workspace page", async () => {
    mockAllApis();
    setViewportWidth(768);
    await renderRealAppAt("/specs");

    await waitFor(() => {
      expect(screen.getByTestId("specs-panel")).toBeDefined();
      expect(screen.getByText("Import RigSpec")).toBeDefined();
    });

    fireEvent.click(screen.getByText("Import RigSpec"));

    await waitFor(() => {
      expect(screen.getByTestId("import-flow")).toBeDefined();
      expect(screen.queryByTestId("specs-panel")).toBeNull();
    });
  });

  it("header discovery button opens the discovery drawer", async () => {
    mockAllApis();
    await renderRealAppAt("/rigs/r1");

    await waitFor(() => {
      expect(screen.getByTestId("discovery-toggle")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("discovery-toggle"));

    await waitFor(() => {
      expect(screen.getByTestId("discovery-panel")).toBeDefined();
    });
  });

  it("header no longer renders top navigation links", async () => {
    mockAllApis();
    await renderRealAppAt("/");

    await waitFor(() => {
      expect(screen.getByTestId("app-header")).toBeDefined();
    });

    const header = screen.getByTestId("app-header");
    expect(header.textContent).not.toContain("RIGS");
    expect(header.textContent).not.toContain("SPECS");
    expect(header.textContent).not.toContain("DISCOVERY");
  });

  it("desktop explorer is controlled by a single edge toggle", async () => {
    mockAllApis();
    await renderRealAppAt("/");

    await waitFor(() => {
      expect(screen.getByTestId("explorer-edge-toggle")).toBeDefined();
      expect(screen.getByTestId("explorer")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("explorer-edge-toggle"));

    await waitFor(() => {
      expect(screen.getByTestId("explorer").className).toContain("lg:w-12");
      expect(screen.getByTestId("explorer-edge-toggle").getAttribute("aria-label")).toContain("Expand");
    });

    fireEvent.click(screen.getByTestId("explorer-edge-toggle"));

    await waitFor(() => {
      expect(screen.getByTestId("explorer").className).not.toContain("lg:hidden");
      expect(screen.getByTestId("explorer-edge-toggle").getAttribute("aria-label")).toContain("Collapse");
    });
  });

  it("/ renders the explorer-first workspace home", async () => {
    mockAllApis();
    await renderRealAppAt("/");

    await waitFor(() => {
      expect(screen.getByTestId("workspace-home")).toBeDefined();
      expect(screen.getByText(/Select a rig from the explorer/i)).toBeDefined();
      expect(screen.getByTestId("workspace-open-explorer")).toBeDefined();
    });
  });

  it("workspace Explore button reopens the explorer", async () => {
    mockAllApis();
    await renderRealAppAt("/");

    await waitFor(() => {
      expect(screen.getByTestId("explorer-edge-toggle")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("explorer-edge-toggle"));

    await waitFor(() => {
      expect(screen.getByTestId("explorer").className).toContain("lg:w-12");
    });

    fireEvent.click(screen.getByTestId("workspace-open-explorer"));

    await waitFor(() => {
      expect(screen.getByTestId("explorer").className).toContain("lg:w-72");
      expect(screen.getByTestId("explorer-edge-toggle").getAttribute("aria-label")).toContain("Collapse");
    });
  });

  it("workspace discovery button opens the discovery drawer instead of routing away", async () => {
    mockAllApis();
    await renderRealAppAt("/");

    await waitFor(() => {
      expect(screen.getByTestId("workspace-open-discovery")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("workspace-open-discovery"));

    await waitFor(() => {
      expect(screen.getByTestId("discovery-panel")).toBeDefined();
    });
  });

  it("workspace specs button opens the specs drawer instead of routing away", async () => {
    mockAllApis();
    await renderRealAppAt("/");

    await waitFor(() => {
      expect(screen.getByTestId("workspace-open-specs")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("workspace-open-specs"));

    await waitFor(() => {
      expect(screen.getByTestId("specs-panel")).toBeDefined();
    });
  });

  it("/rigs/:rigId renders without standalone SnapshotPanel", async () => {
    mockAllApis();
    await renderRealAppAt("/rigs/r1");

    // Wait for route to render
    await waitFor(() => {
      expect(screen.getByTestId("content-area")).toBeDefined();
    });
    // SnapshotPanel should NOT be in the route (moved to rig drawer)
    expect(screen.queryByTestId("snapshot-panel")).toBeNull();
  });

  it("/import renders import flow", async () => {
    mockAllApis();
    await renderRealAppAt("/import");

    await waitFor(() => {
      expect(screen.getByTestId("import-flow")).toBeDefined();
      expect(screen.getByTestId("header-surface-title").textContent).toBe("Specs");
    });
  });

  it("/agents/validate renders the agent validation flow with a Specs title", async () => {
    mockAllApis();
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
      if (url === "/healthz") return Promise.resolve({ ok: true, json: async () => ({ status: "ok" }) });
      if (url === "/api/adapters/cmux/status") return Promise.resolve({ ok: true, json: async () => ({ available: true }) });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    await renderRealAppAt("/agents/validate");

    await waitFor(() => {
      expect(screen.getByTestId("agent-spec-validate-flow")).toBeDefined();
      expect(screen.getByTestId("header-surface-title").textContent).toBe("Specs");
    });
  });

  it("explorer renders with rig tree", async () => {
    mockAllApis();
    await renderRealAppAt("/");

    await waitFor(() => expect(screen.getByTestId("explorer")).toBeDefined());
  });

  it("system gear opens the system drawer on the log tab by default", async () => {
    mockAllApis();
    await renderRealAppAt("/");

    await waitFor(() => {
      expect(screen.getByTestId("system-toggle")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("system-toggle"));

    await waitFor(() => {
      expect(screen.getByTestId("system-panel")).toBeDefined();
      expect(screen.getByTestId("system-log-tab")).toBeDefined();
      expect(screen.getByTestId("system-tab-log").className).toContain("font-bold");
    });
  });

  it("/discovery opens the discovery drawer over the workspace shell", async () => {
    mockAllApis();
    await renderRealAppAt("/discovery");

    await waitFor(() => {
      expect(screen.getByTestId("discovery-panel")).toBeDefined();
      expect(screen.getByTestId("workspace-home")).toBeDefined();
      expect(screen.getByTestId("header-surface-title").textContent).toBe("Discovery");
    });
  });

  it("/discovery/inventory renders the inventory workspace with a discovery title", async () => {
    mockAllApis();
    await renderRealAppAt("/discovery/inventory");

    await waitFor(() => {
      expect(screen.getByTestId("discovery-overlay")).toBeDefined();
      expect(screen.getByTestId("header-surface-title").textContent).toBe("Discovery");
    });
  });

  it("system status tab spells out daemon and cmux state", async () => {
    mockAllApis();
    await renderRealAppAt("/");

    await waitFor(() => {
      expect(screen.getByTestId("system-toggle")).toBeDefined();
    });

    fireEvent.click(screen.getByTestId("system-toggle"));
    await waitFor(() => {
      expect(screen.getByTestId("system-panel")).toBeDefined();
    });
    fireEvent.click(screen.getByTestId("system-tab-status"));

    await waitFor(() => {
      expect(screen.getByTestId("system-daemon-status").textContent).toBe("connected");
      expect(screen.getByTestId("system-cmux-status").textContent).toBe("available");
    });
  });

  it("rig detail route renders full-width without snapshot panel", async () => {
    mockAllApis();
    await renderRealAppAt("/rigs/r1");

    await waitFor(() => {
      expect(screen.getByTestId("content-area")).toBeDefined();
      expect(screen.getByTestId("header-surface-title").textContent).toBe("alpha");
    });
    expect(screen.queryByTestId("snapshot-panel")).toBeNull();
  });

  it("home route leaves the header title blank", async () => {
    mockAllApis();
    await renderRealAppAt("/");

    await waitFor(() => {
      expect(screen.getByTestId("app-header")).toBeDefined();
    });

    expect(screen.queryByTestId("header-surface-title")).toBeNull();
  });
});
