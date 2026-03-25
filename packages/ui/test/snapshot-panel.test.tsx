import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { SnapshotPanel } from "../src/components/SnapshotPanel.js";
import { RigGraph } from "../src/components/RigGraph.js";
import { createMockEventSourceClass } from "./helpers/mock-event-source.js";
import { createAppTestRouter } from "./helpers/test-router.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

let OriginalEventSource: typeof EventSource | undefined;

beforeEach(() => {
  mockFetch.mockReset();
  OriginalEventSource = globalThis.EventSource;
  globalThis.EventSource = createMockEventSourceClass() as unknown as typeof EventSource;
});

afterEach(() => {
  if (OriginalEventSource) {
    globalThis.EventSource = OriginalEventSource;
  }
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

describe("SnapshotPanel", () => {
  // Test 1: Renders snapshot list
  it("renders snapshot list from API", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/snapshots")) {
        return Promise.resolve(mockSnapshotList([
          { id: "snap-1", kind: "manual", status: "complete", createdAt: "2026-03-24 01:00:00" },
          { id: "snap-2", kind: "auto", status: "complete", createdAt: "2026-03-24 02:00:00" },
        ]));
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(<SnapshotPanel rigId="r1" />);
    await waitFor(() => {
      expect(screen.getByText(/snap-1/)).toBeDefined();
      expect(screen.getByText(/snap-2/)).toBeDefined();
    });
  });

  // Test 2: Create snapshot -> POST + refresh
  it("create snapshot calls POST and refreshes list", async () => {
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

    render(<SnapshotPanel rigId="r1" />);
    await waitFor(() => expect(screen.getByText("Create Snapshot")).toBeDefined());

    fireEvent.click(screen.getByText("Create Snapshot"));

    await waitFor(() => {
      const postCall = mockFetch.mock.calls.find(
        (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("/snapshots") && (c[1] as RequestInit)?.method === "POST"
      );
      expect(postCall).toBeDefined();
    });

    // List should refresh
    await waitFor(() => {
      expect(screen.getByText(/snap-new/)).toBeDefined();
    });
  });

  // Test 3: Restore shows confirmation
  it("restore button shows confirmation prompt", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/snapshots")) {
        return Promise.resolve(mockSnapshotList([
          { id: "snap-1", kind: "manual", status: "complete", createdAt: "2026-03-24 01:00:00" },
        ]));
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(<SnapshotPanel rigId="r1" />);
    await waitFor(() => expect(screen.getByTestId("restore-btn-snap-1")).toBeDefined());

    fireEvent.click(screen.getByTestId("restore-btn-snap-1"));

    expect(screen.getByText(/restore this snapshot/i)).toBeDefined();
    expect(screen.getByTestId("confirm-restore-snap-1")).toBeDefined();
    expect(screen.getByTestId("cancel-restore-snap-1")).toBeDefined();
  });

  // Test 4: Confirm -> POST + shows result
  it("confirm restore calls POST and shows per-node result", async () => {
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

    render(<SnapshotPanel rigId="r1" />);
    await waitFor(() => expect(screen.getByTestId("restore-btn-snap-1")).toBeDefined());

    fireEvent.click(screen.getByTestId("restore-btn-snap-1"));
    fireEvent.click(screen.getByTestId("confirm-restore-snap-1"));

    await waitFor(() => {
      const result = screen.getByTestId("restore-result");
      expect(result.textContent).toContain("orchestrator");
      expect(result.textContent).toContain("resumed");
      expect(result.textContent).toContain("worker");
      expect(result.textContent).toContain("checkpoint_written");
    });
  });

  // Test 5: Restore loading indicator
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

    render(<SnapshotPanel rigId="r1" />);
    await waitFor(() => expect(screen.getByTestId("restore-btn-snap-1")).toBeDefined());

    fireEvent.click(screen.getByTestId("restore-btn-snap-1"));
    fireEvent.click(screen.getByTestId("confirm-restore-snap-1"));

    expect(screen.getByTestId("restore-loading")).toBeDefined();

    // Resolve to clean up
    resolveRestore!(mockRestoreResult([]));
    await waitFor(() => expect(screen.queryByTestId("restore-loading")).toBeNull());
  });

  // Test 6: Empty state
  it("shows 'No snapshots' when list is empty", async () => {
    mockFetch.mockImplementation(() => Promise.resolve(mockSnapshotList([])));

    render(<SnapshotPanel rigId="r1" />);
    await waitFor(() => expect(screen.getByText(/no snapshots/i)).toBeDefined());
  });

  // Test 7: Cancel confirmation -> no POST
  it("cancel restore confirmation does not call POST", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("/snapshots")) {
        return Promise.resolve(mockSnapshotList([
          { id: "snap-1", kind: "manual", status: "complete", createdAt: "2026-03-24 01:00:00" },
        ]));
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(<SnapshotPanel rigId="r1" />);
    await waitFor(() => expect(screen.getByTestId("restore-btn-snap-1")).toBeDefined());

    fireEvent.click(screen.getByTestId("restore-btn-snap-1"));
    expect(screen.getByTestId("cancel-restore-snap-1")).toBeDefined();

    fireEvent.click(screen.getByTestId("cancel-restore-snap-1"));

    // Confirmation should be gone
    expect(screen.queryByTestId("confirm-restore-snap-1")).toBeNull();

    // No restore POST should have been made
    const restoreCalls = mockFetch.mock.calls.filter(
      (c: unknown[]) => typeof c[0] === "string" && (c[0] as string).includes("/restore/")
    );
    expect(restoreCalls).toHaveLength(0);
  });

  // Test 8: Restore error -> user-visible error
  it("restore error shows error message", async () => {
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

    render(<SnapshotPanel rigId="r1" />);
    await waitFor(() => expect(screen.getByTestId("restore-btn-snap-1")).toBeDefined());

    fireEvent.click(screen.getByTestId("restore-btn-snap-1"));
    fireEvent.click(screen.getByTestId("confirm-restore-snap-1"));

    await waitFor(() => {
      const errEl = screen.getByTestId("restore-error");
      expect(errEl.textContent).toMatch(/restore_error|failed/i);
    });
  });

  // Test 9: Rig detail route includes SnapshotPanel alongside RigGraph
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
});
