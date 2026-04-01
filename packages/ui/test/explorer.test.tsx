import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { QueryClientProvider, QueryClient } from "@tanstack/react-query";
import { Explorer } from "../src/components/Explorer.js";

// Mock TanStack Router hooks
vi.mock("@tanstack/react-router", () => ({
  useRouterState: () => ({ location: { pathname: "/" } }),
  Link: ({ children, ...props }: any) => <a {...props}>{children}</a>,
}));

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

function renderExplorer(props?: {
  selection?: import("../src/components/SharedDetailDrawer.js").DrawerSelection;
  onSelect?: (sel: import("../src/components/SharedDetailDrawer.js").DrawerSelection) => void;
}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  const onSelect = props?.onSelect ?? vi.fn();

  const result = render(
    <QueryClientProvider client={queryClient}>
      <Explorer
        open={true}
        onClose={vi.fn()}
        selection={props?.selection ?? null}
        onSelect={onSelect}
      />
    </QueryClientProvider>
  );

  return { ...result, onSelect };
}

describe("Explorer sidebar", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  // Test 1: Explorer renders rig list
  it("renders rig list from summary endpoint", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/api/rigs/summary")) {
        return { ok: true, json: async () => [{ id: "rig-1", name: "auth-feats", nodeCount: 2, latestSnapshotAt: null, latestSnapshotId: null }] };
      }
      if (url.includes("/api/ps")) {
        return { ok: true, json: async () => [{ rigId: "rig-1", name: "auth-feats", nodeCount: 2, runningCount: 2, status: "running", uptime: "1h", latestSnapshot: null }] };
      }
      return { ok: true, json: async () => [] };
    });

    renderExplorer();

    await waitFor(() => {
      expect(screen.getByText("auth-feats")).toBeDefined();
    });
  });

  // Test 2: Expanding rig fetches node inventory
  it("expanding rig fetches and shows node inventory", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/api/rigs/summary")) {
        return { ok: true, json: async () => [{ id: "rig-1", name: "test-rig", nodeCount: 1, latestSnapshotAt: null, latestSnapshotId: null }] };
      }
      if (url.includes("/api/ps")) {
        return { ok: true, json: async () => [{ rigId: "rig-1", name: "test-rig", nodeCount: 1, runningCount: 1, status: "running", uptime: "1m", latestSnapshot: null }] };
      }
      if (url.includes("/nodes")) {
        return { ok: true, json: async () => [
          { rigId: "rig-1", rigName: "test-rig", logicalId: "dev.impl", podId: "dev", nodeKind: "agent", runtime: "claude-code", startupStatus: "ready", canonicalSessionName: "dev-impl@test-rig" },
        ]};
      }
      return { ok: true, json: async () => [] };
    });

    renderExplorer();

    // Wait for rig to appear
    await waitFor(() => expect(screen.getByText("test-rig")).toBeDefined());

    // Click expand
    const expandBtns = screen.getAllByLabelText("Expand");
    fireEvent.click(expandBtns[0]!);

    // Node should appear
    await waitFor(() => {
      expect(screen.getByText("impl")).toBeDefined();
    });
  });

  // Test 3: Node click calls onSelect with type "node"
  it("clicking a node calls onSelect with type node, rigId, and logicalId", async () => {
    const onSelect = vi.fn();
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/api/rigs/summary")) {
        return { ok: true, json: async () => [{ id: "rig-1", name: "test-rig", nodeCount: 1, latestSnapshotAt: null, latestSnapshotId: null }] };
      }
      if (url.includes("/api/ps")) {
        return { ok: true, json: async () => [{ rigId: "rig-1", name: "test-rig", nodeCount: 1, runningCount: 1, status: "running", uptime: "1m", latestSnapshot: null }] };
      }
      if (url.includes("/nodes")) {
        return { ok: true, json: async () => [
          { rigId: "rig-1", rigName: "test-rig", logicalId: "dev.impl", podId: "dev", nodeKind: "agent", runtime: "claude-code", startupStatus: "ready", canonicalSessionName: "dev-impl@test-rig" },
        ]};
      }
      return { ok: true, json: async () => [] };
    });

    renderExplorer({ onSelect });

    await waitFor(() => expect(screen.getByText("test-rig")).toBeDefined());
    fireEvent.click(screen.getAllByLabelText("Expand")[0]!);
    await waitFor(() => expect(screen.getByText("impl")).toBeDefined());

    const nodeBtn = screen.getByTestId("node-dev.impl");
    await fireEvent.click(nodeBtn);

    await waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith({ type: "node", rigId: "rig-1", logicalId: "dev.impl" });
    });
  });

  // Test PNS-T09: Clicking rig name sets rig selection
  it("clicking rig name calls onSelect with type rig", async () => {
    const onSelect = vi.fn();
    mockFetch.mockImplementation(async (url: string) => {
      if (url === "/api/rigs/summary") return { ok: true, json: async () => [{ id: "rig-1", name: "test-rig", nodeCount: 2, latestSnapshotAt: null, latestSnapshotId: null }] };
      if (url === "/api/ps") return { ok: true, json: async () => [{ rigId: "rig-1", name: "test-rig", nodeCount: 2, runningCount: 1, status: "running", uptime: "1h", latestSnapshot: null }] };
      return { ok: true, json: async () => [] };
    });

    renderExplorer({ onSelect });
    await waitFor(() => expect(screen.getByText("test-rig")).toBeDefined());

    fireEvent.click(screen.getByText("test-rig"));

    await waitFor(() => {
      expect(onSelect).toHaveBeenCalledWith({ type: "rig", rigId: "rig-1" });
    });
  });

  // Test 4: Infrastructure nodes show distinct treatment
  it("infrastructure nodes display INFRA label", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/api/rigs/summary")) {
        return { ok: true, json: async () => [{ id: "rig-1", name: "test-rig", nodeCount: 1, latestSnapshotAt: null, latestSnapshotId: null }] };
      }
      if (url.includes("/api/ps")) {
        return { ok: true, json: async () => [{ rigId: "rig-1", name: "test-rig", nodeCount: 1, runningCount: 1, status: "running", uptime: "1m", latestSnapshot: null }] };
      }
      if (url.includes("/nodes")) {
        return { ok: true, json: async () => [
          { rigId: "rig-1", rigName: "test-rig", logicalId: "infra.server", podId: "infra", nodeKind: "infrastructure", runtime: "terminal", startupStatus: "ready" },
        ]};
      }
      return { ok: true, json: async () => [] };
    });

    renderExplorer();

    await waitFor(() => expect(screen.getAllByTestId("rig-tree-test-rig").length).toBeGreaterThan(0));
    fireEvent.click(screen.getAllByLabelText("Expand")[0]!);
    await waitFor(() => {
      expect(screen.getByText("INFRA")).toBeDefined();
    });
  });

  // Test 5: Explorer shows "No rigs" when empty
  it("shows No rigs when rig list is empty", async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/api/rigs/summary")) {
        return { ok: true, json: async () => [] };
      }
      if (url.includes("/api/ps")) {
        return { ok: true, json: async () => [] };
      }
      return { ok: true, json: async () => [] };
    });

    renderExplorer();

    await waitFor(() => {
      expect(screen.getByText("No rigs")).toBeDefined();
    });
  });

  // Test 6: Turn Off button calls POST /api/down
  it("Turn Off button calls POST /api/down for running rig", async () => {
    mockFetch.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url.includes("/api/rigs/summary")) {
        return { ok: true, json: async () => [{ id: "rig-1", name: "test-rig", nodeCount: 1, latestSnapshotAt: null, latestSnapshotId: null }] };
      }
      if (url.includes("/api/ps")) {
        return { ok: true, json: async () => [{ rigId: "rig-1", name: "test-rig", nodeCount: 1, runningCount: 1, status: "running", uptime: "1m", latestSnapshot: null }] };
      }
      if (url.includes("/nodes")) {
        return { ok: true, json: async () => [
          { rigId: "rig-1", rigName: "test-rig", logicalId: "dev.impl", podId: "dev", nodeKind: "agent", runtime: "claude-code", startupStatus: "ready" },
        ]};
      }
      if (url.includes("/api/down") && opts?.method === "POST") {
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => [] };
    });

    renderExplorer();
    await waitFor(() => expect(screen.getByText("test-rig")).toBeDefined());
    fireEvent.click(screen.getAllByLabelText("Expand")[0]!);
    await waitFor(() => expect(screen.getByTestId("turn-off")).toBeDefined());

    fireEvent.click(screen.getByTestId("turn-off"));

    await waitFor(() => {
      const downCalls = mockFetch.mock.calls.filter((c: any[]) => String(c[0]).includes("/api/down"));
      expect(downCalls.length).toBeGreaterThan(0);
    });
  });

  // Test 7: Turn On button calls POST /api/rigs/:rigId/up
  it("Turn On button calls POST /api/rigs/:rigId/up for stopped rig", async () => {
    mockFetch.mockImplementation(async (url: string, opts?: RequestInit) => {
      if (url.includes("/api/rigs/summary")) {
        return { ok: true, json: async () => [{ id: "rig-1", name: "stopped-rig", nodeCount: 1, latestSnapshotAt: null, latestSnapshotId: null }] };
      }
      if (url.includes("/api/ps")) {
        return { ok: true, json: async () => [{ rigId: "rig-1", name: "stopped-rig", nodeCount: 1, runningCount: 0, status: "stopped", uptime: null, latestSnapshot: null }] };
      }
      if (url.includes("/nodes")) {
        return { ok: true, json: async () => [
          { rigId: "rig-1", rigName: "stopped-rig", logicalId: "dev.impl", podId: "dev", nodeKind: "agent", runtime: "claude-code", startupStatus: null, sessionStatus: null },
        ]};
      }
      if (url.includes("/up") && opts?.method === "POST") {
        return { ok: true, json: async () => ({}) };
      }
      return { ok: true, json: async () => [] };
    });

    renderExplorer();
    await waitFor(() => expect(screen.getByText("stopped-rig")).toBeDefined());
    fireEvent.click(screen.getAllByLabelText("Expand")[0]!);
    await waitFor(() => expect(screen.getByTestId("turn-on")).toBeDefined());

    fireEvent.click(screen.getByTestId("turn-on"));

    await waitFor(() => {
      const upCalls = mockFetch.mock.calls.filter((c: any[]) => String(c[0]).includes("/up"));
      expect(upCalls.length).toBeGreaterThan(0);
    });
  });
});
