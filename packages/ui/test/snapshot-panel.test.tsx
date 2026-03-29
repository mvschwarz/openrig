import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SnapshotPanel } from "../src/components/SnapshotPanel.js";
import { RigGraph } from "../src/components/RigGraph.js";
import { createMockEventSourceClass } from "./helpers/mock-event-source.js";
import { createAppTestRouter } from "./helpers/test-router.js";

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
}

function QueryWrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={createTestQueryClient()}>{children}</QueryClientProvider>;
}

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

let OriginalEventSource: typeof EventSource | undefined;

beforeEach(() => {
  mockFetch.mockReset();
  OriginalEventSource = globalThis.EventSource;
  globalThis.EventSource = createMockEventSourceClass() as unknown as typeof EventSource;
});

afterEach(() => {
  if (OriginalEventSource) globalThis.EventSource = OriginalEventSource;
  cleanup();
});

function mockSnapshotList(snaps: Array<{ id: string; kind: string; status: string; createdAt: string }>) {
  return { ok: true, json: async () => snaps };
}

function mockRestoreResult(nodes: Array<{ nodeId: string; logicalId: string; status: string }>) {
  return { ok: true, json: async () => ({ nodes }) };
}

function mockRestoreError(status: number, error: string) {
  return { ok: false, status, json: async () => ({ error }) };
}

function stoppedPsEntries() {
  return [
    {
      rigId: "r1",
      name: "alpha",
      nodeCount: 1,
      runningCount: 0,
      status: "stopped",
      uptime: null,
      latestSnapshot: null,
    },
  ];
}

describe("SnapshotPanel", () => {
  // Test 1: Snapshot list with mono IDs
  it("renders snapshot list with monospaced IDs", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/snapshots")) {
        return Promise.resolve(mockSnapshotList([
          { id: "snap-abc123def", kind: "manual", status: "complete", createdAt: "2026-03-24 01:00:00" },
        ]));
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(<QueryWrapper><SnapshotPanel rigId="r1" /></QueryWrapper>);
    await waitFor(() => {
      const idEl = screen.getByTestId("snap-id-snap-abc123def");
      expect(idEl.className).toContain("font-mono");
      expect(idEl.textContent).toContain("snap-abc123");
    });
  });

  // Test 2: Create triggers mutation + refresh
  it("create button triggers mutation", async () => {
    let callCount = 0;
    mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (typeof url === "string" && url.includes("/snapshots") && opts?.method === "POST") {
        return Promise.resolve({ ok: true, json: async () => ({ id: "snap-new" }) });
      }
      if (typeof url === "string" && url.includes("/snapshots")) {
        callCount++;
        return Promise.resolve(mockSnapshotList(
          callCount > 1
            ? [{ id: "snap-new", kind: "manual", status: "complete", createdAt: "2026-03-24 03:00:00" }]
            : []
        ));
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(<QueryWrapper><SnapshotPanel rigId="r1" /></QueryWrapper>);
    await waitFor(() => expect(screen.getByText(/CREATE/)).toBeDefined());

    const createBtn = screen.getAllByText(/CREATE/).find((el) => el.closest("button"));
    fireEvent.click(createBtn!);

    await waitFor(() => {
      const postCall = mockFetch.mock.calls.find(
        (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("/snapshots") && (c[1] as RequestInit)?.method === "POST"
      );
      expect(postCall).toBeDefined();
    });

    // Prove list refreshed with new snapshot
    await waitFor(() => {
      expect(screen.getByText(/snap-new/)).toBeDefined();
    });
  });

  // Test 3: Restore opens Dialog
  it("restore opens confirmation Dialog", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/snapshots")) {
        return Promise.resolve(mockSnapshotList([
          { id: "snap-1", kind: "manual", status: "complete", createdAt: "2026-03-24 01:00:00" },
        ]));
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(<QueryWrapper><SnapshotPanel rigId="r1" /></QueryWrapper>);
    await waitFor(() => expect(screen.getByTestId("restore-btn-snap-1")).toBeDefined());

    fireEvent.click(screen.getByTestId("restore-btn-snap-1"));

    // Dialog should appear with correct role + confirm/cancel
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeDefined();
      expect(screen.getByText(/restore snapshot/i)).toBeDefined();
      expect(screen.getByTestId("confirm-restore-snap-1")).toBeDefined();
      expect(screen.getByTestId("cancel-restore-snap-1")).toBeDefined();
    });
  });

  // Test 4: Confirm triggers restore + per-node result
  it("confirm triggers restore and shows per-node result", async () => {
    mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (typeof url === "string" && url.includes("/restore/") && opts?.method === "POST") {
        return Promise.resolve(mockRestoreResult([
          { nodeId: "n1", logicalId: "orchestrator", status: "resumed" },
          { nodeId: "n2", logicalId: "worker", status: "checkpoint_written" },
        ]));
      }
      if (typeof url === "string" && url.includes("/snapshots")) {
        return Promise.resolve(mockSnapshotList([
          { id: "snap-1", kind: "manual", status: "complete", createdAt: "2026-03-24 01:00:00" },
        ]));
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(<QueryWrapper><SnapshotPanel rigId="r1" /></QueryWrapper>);
    await waitFor(() => expect(screen.getByTestId("restore-btn-snap-1")).toBeDefined());

    fireEvent.click(screen.getByTestId("restore-btn-snap-1"));
    await waitFor(() => expect(screen.getByTestId("confirm-restore-snap-1")).toBeDefined());
    fireEvent.click(screen.getByTestId("confirm-restore-snap-1"));

    await waitFor(() => {
      const result = screen.getByTestId("restore-result");
      expect(result.textContent).toContain("orchestrator");
      expect(result.textContent).toContain("resumed");
      expect(result.textContent).toContain("worker");
      expect(result.textContent).toContain("checkpoint_written");
    });
  });

  // Test 5: Per-node status uses restore-specific color class
  it("per-node status uses correct restore color class", async () => {
    mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === "/api/ps") {
        return Promise.resolve({ ok: true, json: async () => stoppedPsEntries() });
      }
      if (typeof url === "string" && url.includes("/restore/") && opts?.method === "POST") {
        return Promise.resolve(mockRestoreResult([
          { nodeId: "n1", logicalId: "orchestrator", status: "resumed" },
          { nodeId: "n2", logicalId: "worker", status: "failed" },
        ]));
      }
      if (typeof url === "string" && url.includes("/snapshots")) {
        return Promise.resolve(mockSnapshotList([
          { id: "snap-1", kind: "manual", status: "complete", createdAt: "2026-03-24 01:00:00" },
        ]));
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(<QueryWrapper><SnapshotPanel rigId="r1" /></QueryWrapper>);
    await waitFor(() => expect(screen.getByTestId("restore-btn-snap-1")).toBeDefined());
    fireEvent.click(screen.getByTestId("restore-btn-snap-1"));
    await waitFor(() => expect(screen.getByTestId("confirm-restore-snap-1")).toBeDefined());
    fireEvent.click(screen.getByTestId("confirm-restore-snap-1"));

    await waitFor(() => {
      const resumed = screen.getByTestId("restore-status-orchestrator");
      expect(resumed.className).toContain("text-stone-400");
      const failed = screen.getByTestId("restore-status-worker");
      expect(failed.className).toContain("text-tertiary");
    });
  });

  it("restore button is always clickable and opens dialog", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === "/api/ps") {
        return Promise.resolve({
          ok: true,
          json: async () => [
            {
              rigId: "r1",
              name: "alpha",
              nodeCount: 2,
              runningCount: 1,
              status: "partial",
              uptime: "1m",
              latestSnapshot: null,
            },
          ],
        });
      }
      if (typeof url === "string" && url.includes("/snapshots")) {
        return Promise.resolve(mockSnapshotList([
          { id: "snap-1", kind: "manual", status: "complete", createdAt: "2026-03-24 01:00:00" },
        ]));
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(<QueryWrapper><SnapshotPanel rigId="r1" /></QueryWrapper>);
    await waitFor(() => expect(screen.getByTestId("restore-btn-snap-1")).toBeDefined());

    const restoreBtn = screen.getByTestId("restore-btn-snap-1") as HTMLButtonElement;

    fireEvent.click(restoreBtn);
    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeDefined();
    });
  });

  // Test 6: Fetch error uses Alert
  it("fetch error shows Alert", async () => {
    mockFetch.mockImplementation(() => Promise.resolve({ ok: false, status: 500, json: async () => ({}) }));

    render(<QueryWrapper><SnapshotPanel rigId="r1" /></QueryWrapper>);
    await waitFor(() => {
      expect(screen.getByTestId("restore-error")).toBeDefined();
    });
  });

  // Test 7: Empty state
  it("empty state shows 'No snapshots' in muted text", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(mockSnapshotList([])));
    render(<QueryWrapper><SnapshotPanel rigId="r1" /></QueryWrapper>);
    await waitFor(() => expect(screen.getByText(/no snapshots/i)).toBeDefined());
  });

  // Test 8: Cancel -> no POST
  it("cancel confirmation does not call POST", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/snapshots")) {
        return Promise.resolve(mockSnapshotList([
          { id: "snap-1", kind: "manual", status: "complete", createdAt: "2026-03-24 01:00:00" },
        ]));
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(<QueryWrapper><SnapshotPanel rigId="r1" /></QueryWrapper>);
    await waitFor(() => expect(screen.getByTestId("restore-btn-snap-1")).toBeDefined());

    fireEvent.click(screen.getByTestId("restore-btn-snap-1"));
    await waitFor(() => expect(screen.getByTestId("cancel-restore-snap-1")).toBeDefined());
    fireEvent.click(screen.getByTestId("cancel-restore-snap-1"));

    const restoreCalls = mockFetch.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("/restore/")
    );
    expect(restoreCalls).toHaveLength(0);
  });

  // Test 9: Restore loading indicator
  it("shows loading indicator during restore", async () => {
    let resolveRestore: ((v: unknown) => void) | null = null;
    mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (typeof url === "string" && url.includes("/restore/") && opts?.method === "POST") {
        return new Promise((r) => { resolveRestore = r; });
      }
      if (typeof url === "string" && url.includes("/snapshots")) {
        return Promise.resolve(mockSnapshotList([
          { id: "snap-1", kind: "manual", status: "complete", createdAt: "2026-03-24 01:00:00" },
        ]));
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(<QueryWrapper><SnapshotPanel rigId="r1" /></QueryWrapper>);
    await waitFor(() => expect(screen.getByTestId("restore-btn-snap-1")).toBeDefined());

    fireEvent.click(screen.getByTestId("restore-btn-snap-1"));
    await waitFor(() => expect(screen.getByTestId("confirm-restore-snap-1")).toBeDefined());
    fireEvent.click(screen.getByTestId("confirm-restore-snap-1"));

    await waitFor(() => expect(screen.getByTestId("restore-loading")).toBeDefined());

    resolveRestore!(mockRestoreResult([]));
    await waitFor(() => expect(screen.queryByTestId("restore-loading")).toBeNull());
  });

  // Test 10: Restore error Alert
  it("restore error shows Alert", async () => {
    mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (typeof url === "string" && url.includes("/restore/") && opts?.method === "POST") {
        return Promise.resolve(mockRestoreError(500, "restore_error"));
      }
      if (typeof url === "string" && url.includes("/snapshots")) {
        return Promise.resolve(mockSnapshotList([
          { id: "snap-1", kind: "manual", status: "complete", createdAt: "2026-03-24 01:00:00" },
        ]));
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(<QueryWrapper><SnapshotPanel rigId="r1" /></QueryWrapper>);
    await waitFor(() => expect(screen.getByTestId("restore-btn-snap-1")).toBeDefined());
    fireEvent.click(screen.getByTestId("restore-btn-snap-1"));
    await waitFor(() => expect(screen.getByTestId("confirm-restore-snap-1")).toBeDefined());
    fireEvent.click(screen.getByTestId("confirm-restore-snap-1"));

    await waitFor(() => {
      expect(screen.getByTestId("restore-error")).toBeDefined();
    });
  });

  // Test 11: App integration — graph detail includes SnapshotPanel
  it("rig detail route renders SnapshotPanel alongside graph", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/graph")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            nodes: [{ id: "n1", type: "rigNode", position: { x: 0, y: 0 }, data: { logicalId: "w", role: "worker", runtime: "claude-code", model: null, status: null, binding: null } }],
            edges: [],
          }),
        });
      }
      if (typeof url === "string" && url.includes("/snapshots")) {
        return Promise.resolve(mockSnapshotList([]));
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(createAppTestRouter({
      routes: [
        {
          path: "/rigs/$rigId",
          component: () => (
            <div className="flex">
              <RigGraph rigId="r1" />
              <SnapshotPanel rigId="r1" />
            </div>
          ),
        },
      ],
      initialPath: "/rigs/r1",
    }));

    await waitFor(() => {
      expect(screen.getByTestId("snapshot-panel")).toBeDefined();
    });
  });

  // Test 12: Loading skeleton with pulse
  it("loading state shows pulse skeleton", async () => {
    mockFetch.mockReturnValue(new Promise(() => {}));
    render(<QueryWrapper><SnapshotPanel rigId="r1" /></QueryWrapper>);

    await waitFor(() => {
      const skeleton = screen.getByTestId("snapshot-loading");
      expect(skeleton).toBeDefined();
      expect(skeleton.innerHTML).toContain("shimmer");
    });
  });
});
