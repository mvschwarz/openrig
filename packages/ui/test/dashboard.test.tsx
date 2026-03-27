import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent, act } from "@testing-library/react";
import { createMockEventSourceClass } from "./helpers/mock-event-source.js";
import { createTestRouter, createAppTestRouter } from "./helpers/test-router.js";
import { Dashboard } from "../src/components/Dashboard.js";
import { useCountUp } from "../src/hooks/useCountUp.js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

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

function setupSummaryMock(
  rigs: Array<{
    id: string; name: string; nodeCount: number;
    latestSnapshotAt: string | null; latestSnapshotId: string | null;
  }>,
  psEntries?: Array<{
    rigId: string; name: string; nodeCount: number; runningCount: number;
    status: string; uptime: string | null; latestSnapshot: string | null;
  }>,
) {
  const defaultPs = rigs.map((r) => ({
    rigId: r.id, name: r.name, nodeCount: r.nodeCount, runningCount: r.nodeCount,
    status: "running", uptime: "1h", latestSnapshot: null,
  }));
  const ps = psEntries ?? defaultPs;
  mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
    if (url === "/api/rigs/summary") return Promise.resolve({ ok: true, json: async () => rigs });
    if (url === "/api/ps") return Promise.resolve({ ok: true, json: async () => ps });
    if (typeof url === "string" && url.includes("/snapshots") && opts?.method === "POST") return Promise.resolve({ ok: true, json: async () => ({ id: "snap-new" }) });
    if (typeof url === "string" && url.includes("/spec")) return Promise.resolve({ ok: true, text: async () => "yaml: content" });
    if (url === "/healthz") return Promise.resolve({ ok: true, json: async () => ({ status: "ok" }) });
    if (url === "/api/adapters/cmux/status") return Promise.resolve({ ok: true, json: async () => ({ available: false }) });
    if (url === "/api/down" && opts?.method === "POST") return Promise.resolve({ ok: true, json: async () => ({ rigId: "r1", sessionsKilled: 2, deleted: false, deleteBlocked: false, alreadyStopped: false, errors: [] }) });
    return Promise.resolve({ ok: true, json: async () => ({}) });
  });
}

describe("Dashboard", () => {
  // Test 1: Renders rig cards from query data
  it("renders rig cards from query data", async () => {
    setupSummaryMock([
      { id: "r1", name: "alpha", nodeCount: 3, latestSnapshotAt: null, latestSnapshotId: null },
      { id: "r2", name: "beta", nodeCount: 1, latestSnapshotAt: null, latestSnapshotId: null },
    ]);
    render(createTestRouter({ component: Dashboard }));
    await waitFor(() => {
      expect(screen.getByText("alpha")).toBeDefined();
      expect(screen.getByText("beta")).toBeDefined();
    });
  });

  // Test 2: Card shows name + monospaced node count + snapshot age
  it("card shows name, monospaced node count, and snapshot age", async () => {
    setupSummaryMock([{ id: "r1", name: "alpha", nodeCount: 5, latestSnapshotAt: "2026-03-24 01:00:00", latestSnapshotId: "s1" }]);
    render(createTestRouter({ component: Dashboard }));

    await waitFor(() => {
      expect(screen.getByText("alpha")).toBeDefined();
      // Node count should be in a mono font element
      const countEl = screen.getByTestId("node-count-r1");
      expect(countEl.className).toContain("font-mono");
    });
  });

  // Test 3: Snapshot button triggers mutation (stopPropagation)
  it("snapshot button triggers mutation", async () => {
    setupSummaryMock([{ id: "r1", name: "alpha", nodeCount: 1, latestSnapshotAt: null, latestSnapshotId: null }]);
    render(createTestRouter({ component: Dashboard }));
    await waitFor(() => expect(screen.getByText("alpha")).toBeDefined());

    // Click SNAPSHOT tactical button
    const snapshotBtns = screen.getAllByText(/SNAPSHOT/);
    const actionBtn = snapshotBtns.find((el) => el.closest("button"));
    fireEvent.click(actionBtn!);

    await waitFor(() => {
      const postCall = mockFetch.mock.calls.find(
        (c: unknown[]) => c[0] === "/api/rigs/r1/snapshots" && (c[1] as RequestInit)?.method === "POST"
      );
      expect(postCall).toBeDefined();
    });
  });

  // Test 4: Export button triggers YAML download
  it("export button triggers YAML download", async () => {
    URL.createObjectURL = vi.fn(() => "blob:test");
    URL.revokeObjectURL = vi.fn();

    setupSummaryMock([{ id: "r1", name: "alpha", nodeCount: 1, latestSnapshotAt: null, latestSnapshotId: null }]);
    render(createTestRouter({ component: Dashboard }));
    await waitFor(() => expect(screen.getByText("alpha")).toBeDefined());

    const exportBtns = screen.getAllByText(/EXPORT/);
    const actionBtn = exportBtns.find((el) => el.closest("button"));
    fireEvent.click(actionBtn!);

    await waitFor(() => {
      const specCall = mockFetch.mock.calls.find((c: unknown[]) => c[0] === "/api/rigs/r1/spec");
      expect(specCall).toBeDefined();
    });
  });

  // Test 5: Card click navigates to /rigs/:rigId
  it("card click navigates to rig detail", async () => {
    setupSummaryMock([{ id: "r1", name: "alpha", nodeCount: 1, latestSnapshotAt: null, latestSnapshotId: null }]);

    render(createAppTestRouter({
      routes: [
        { path: "/", component: Dashboard },
        { path: "/rigs/$rigId", component: () => <div data-testid="rig-detail">detail</div> },
      ],
    }));

    await waitFor(() => expect(screen.getByText("alpha")).toBeDefined());

    // Click the card (not a button)
    const card = screen.getByTestId("rig-card-r1");
    fireEvent.click(card);

    await waitFor(() => {
      expect(screen.getByTestId("rig-detail")).toBeDefined();
    });
  });

  // Test 6: Empty state with wireframe ghost + import CTA
  it("empty state renders NO RIGS + muted copy + import button + wireframe ghost", async () => {
    setupSummaryMock([]);
    render(createTestRouter({ component: Dashboard }));

    await waitFor(() => {
      const empty = screen.getByTestId("dashboard-empty");
      expect(empty).toBeDefined();
      expect(screen.getByText("NO RIGS")).toBeDefined();
      expect(screen.getByText(/set up a rig/i)).toBeDefined();
      expect(screen.getByText(/SET UP YOUR FIRST RIG/)).toBeDefined();
      expect(screen.getByTestId("wireframe-ghost")).toBeDefined();
    });
  });

  // Test 7: Loading state renders skeleton with pulse animation
  it("loading state renders skeleton cards with pulse animation", async () => {
    mockFetch.mockReturnValue(new Promise(() => {}));
    render(createTestRouter({ component: Dashboard }));

    await waitFor(() => {
      const loading = screen.getByTestId("dashboard-loading");
      expect(loading).toBeDefined();
      // Should contain pulse animation elements
      expect(loading.innerHTML).toContain("shimmer");
    });
  });

  // Test 8: Error state renders Alert
  it("error state renders Alert component", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });
    render(createTestRouter({ component: Dashboard }));

    await waitFor(() => {
      expect(screen.getByTestId("dashboard-error")).toBeDefined();
    });
  });

  // Test 9: UP button navigates to /bootstrap
  it("UP button navigates to /bootstrap", async () => {
    setupSummaryMock([{ id: "r1", name: "alpha", nodeCount: 1, latestSnapshotAt: null, latestSnapshotId: null }]);

    render(createAppTestRouter({
      routes: [
        { path: "/", component: Dashboard },
        { path: "/bootstrap", component: () => <div data-testid="bootstrap-page">bootstrap</div> },
      ],
    }));

    await waitFor(() => expect(screen.getByText("alpha")).toBeDefined());

    fireEvent.click(screen.getByTestId("header-up-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("bootstrap-page")).toBeDefined();
    });
  });

  // Test 10: No-snapshot fallback renders "none"
  it("card with no snapshot renders 'none' in snapshot age", async () => {
    setupSummaryMock([{ id: "r1", name: "alpha", nodeCount: 1, latestSnapshotAt: null, latestSnapshotId: null }]);
    render(createTestRouter({ component: Dashboard }));

    await waitFor(() => {
      const ageEl = screen.getByTestId("snapshot-age-r1");
      expect(ageEl.textContent).toContain("none");
    });
  });

  // Test 11: Action error shows Alert
  it("snapshot error shows action error Alert", async () => {
    mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === "/api/rigs/summary") {
        return Promise.resolve({ ok: true, json: async () => [{ id: "r1", name: "alpha", nodeCount: 1, latestSnapshotAt: null, latestSnapshotId: null }] });
      }
      if (url === "/api/ps") {
        return Promise.resolve({ ok: true, json: async () => [{ rigId: "r1", name: "alpha", nodeCount: 1, runningCount: 1, status: "running", uptime: "1h", latestSnapshot: null }] });
      }
      if (typeof url === "string" && url.includes("/snapshots") && opts?.method === "POST") {
        return Promise.resolve({ ok: false, status: 500, json: async () => ({ error: "server error" }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(createTestRouter({ component: Dashboard }));
    await waitFor(() => expect(screen.getByText("alpha")).toBeDefined());

    const snapshotBtns = screen.getAllByText(/SNAPSHOT/);
    const actionBtn = snapshotBtns.find((el) => el.closest("button"));
    fireEvent.click(actionBtn!);

    await waitFor(() => {
      expect(screen.getByTestId("action-error")).toBeDefined();
    });
  });

  // Test 12: useCountUp — animates on mount, snaps on update (no re-animation, not stale)
  it("useCountUp animates on mount, snaps to new target on update", async () => {
    const origRAF = globalThis.requestAnimationFrame;
    const origCAF = globalThis.cancelAnimationFrame;
    let rafId = 0;
    globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => {
      rafId++;
      setTimeout(() => cb(performance.now() + 500), 0);
      return rafId;
    };
    globalThis.cancelAnimationFrame = () => {};

    function CountUpHarness({ target }: { target: number }) {
      const val = useCountUp(target);
      return <span data-testid="count">{val}</span>;
    }

    const qc = new QueryClient();
    const { rerender } = render(
      <QueryClientProvider client={qc}><CountUpHarness target={5} /></QueryClientProvider>
    );

    // Wait for first animation to settle at 5
    await waitFor(() => {
      expect(screen.getByTestId("count").textContent).toBe("5");
    }, { timeout: 2000 });

    // Rerender with a different target (simulating data refresh)
    rerender(
      <QueryClientProvider client={qc}><CountUpHarness target={10} /></QueryClientProvider>
    );

    // Value should snap to 10 immediately (no re-animation, but NOT stale)
    await waitFor(() => {
      expect(screen.getByTestId("count").textContent).toBe("10");
    });

    globalThis.requestAnimationFrame = origRAF;
    globalThis.cancelAnimationFrame = origCAF;
  });

  // CCLI-T06 Tests

  // T1: UP button navigates to /bootstrap (both header and empty-state)
  it("empty-state UP button navigates to /bootstrap", async () => {
    setupSummaryMock([]);

    render(createAppTestRouter({
      routes: [
        { path: "/", component: Dashboard },
        { path: "/bootstrap", component: () => <div data-testid="bootstrap-page">bootstrap</div> },
      ],
    }));

    await waitFor(() => expect(screen.getByTestId("dashboard-empty")).toBeDefined());

    fireEvent.click(screen.getByTestId("empty-up-btn"));

    await waitFor(() => {
      expect(screen.getByTestId("bootstrap-page")).toBeDefined();
    });
  });

  // T2: DOWN button opens confirmation dialog
  it("DOWN button opens confirmation dialog", async () => {
    setupSummaryMock([{ id: "r1", name: "alpha", nodeCount: 2, latestSnapshotAt: null, latestSnapshotId: null }]);
    render(createTestRouter({ component: Dashboard }));

    await waitFor(() => expect(screen.getByText("alpha")).toBeDefined());

    fireEvent.click(screen.getByTestId("down-btn-r1"));

    await waitFor(() => {
      expect(screen.getByText(/Tear Down Rig/)).toBeDefined();
      expect(screen.getByTestId("confirm-down-btn")).toBeDefined();
    });
  });

  // T3: Confirm teardown calls POST /api/down and closes dialog
  it("confirm teardown calls POST /api/down and closes dialog", async () => {
    setupSummaryMock([{ id: "r1", name: "alpha", nodeCount: 2, latestSnapshotAt: null, latestSnapshotId: null }]);
    render(createTestRouter({ component: Dashboard }));

    await waitFor(() => expect(screen.getByText("alpha")).toBeDefined());

    fireEvent.click(screen.getByTestId("down-btn-r1"));
    await waitFor(() => expect(screen.getByTestId("confirm-down-btn")).toBeDefined());

    fireEvent.click(screen.getByTestId("confirm-down-btn"));

    await waitFor(() => {
      const downCall = mockFetch.mock.calls.find(
        (c: unknown[]) => c[0] === "/api/down" && (c[1] as RequestInit)?.method === "POST"
      );
      expect(downCall).toBeDefined();
    });

    // Dialog should close on success
    await waitFor(() => {
      expect(screen.queryByText(/Tear Down Rig/)).toBeNull();
    });
  });

  // T4: Status badge shows running/partial/stopped
  it("status badge shows correct status per rig", async () => {
    const rigs = [
      { id: "r1", name: "alpha", nodeCount: 3, latestSnapshotAt: null, latestSnapshotId: null },
      { id: "r2", name: "beta", nodeCount: 2, latestSnapshotAt: null, latestSnapshotId: null },
      { id: "r3", name: "gamma", nodeCount: 1, latestSnapshotAt: null, latestSnapshotId: null },
    ];
    const ps = [
      { rigId: "r1", name: "alpha", nodeCount: 3, runningCount: 3, status: "running", uptime: "2h", latestSnapshot: null },
      { rigId: "r2", name: "beta", nodeCount: 2, runningCount: 1, status: "partial", uptime: "30m", latestSnapshot: null },
      { rigId: "r3", name: "gamma", nodeCount: 1, runningCount: 0, status: "stopped", uptime: null, latestSnapshot: null },
    ];
    setupSummaryMock(rigs, ps);
    render(createTestRouter({ component: Dashboard }));

    await waitFor(() => {
      expect(screen.getByTestId("status-badge-r1").textContent).toBe("RUNNING");
      expect(screen.getByTestId("status-badge-r2").textContent).toBe("PARTIAL");
      expect(screen.getByTestId("status-badge-r3").textContent).toBe("STOPPED");
    });
  });

  // T5: Dashboard header shows aggregate counts
  it("aggregate header shows rig count and running nodes", async () => {
    const rigs = [
      { id: "r1", name: "alpha", nodeCount: 3, latestSnapshotAt: null, latestSnapshotId: null },
      { id: "r2", name: "beta", nodeCount: 2, latestSnapshotAt: null, latestSnapshotId: null },
    ];
    const ps = [
      { rigId: "r1", name: "alpha", nodeCount: 3, runningCount: 3, status: "running", uptime: "2h", latestSnapshot: null },
      { rigId: "r2", name: "beta", nodeCount: 2, runningCount: 0, status: "stopped", uptime: null, latestSnapshot: null },
    ];
    setupSummaryMock(rigs, ps);
    render(createTestRouter({ component: Dashboard }));

    await waitFor(() => {
      const header = screen.getByTestId("aggregate-header");
      expect(header.textContent).toContain("2 rigs");
      expect(header.textContent).toContain("3 nodes running");
    });
  });

  // T6: Stopped rig card has dimmed styling
  it("stopped rig card has opacity-60", async () => {
    const rigs = [{ id: "r1", name: "alpha", nodeCount: 1, latestSnapshotAt: null, latestSnapshotId: null }];
    const ps = [{ rigId: "r1", name: "alpha", nodeCount: 1, runningCount: 0, status: "stopped", uptime: null, latestSnapshot: null }];
    setupSummaryMock(rigs, ps);
    render(createTestRouter({ component: Dashboard }));

    await waitFor(() => {
      const card = screen.getByTestId("rig-card-r1");
      expect(card.className).toContain("opacity-60");
    });
  });

  // T7: 200 + errors[] keeps dialog open, shows error text
  it("teardown with 200 + errors keeps dialog open with error", async () => {
    mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (url === "/api/rigs/summary") {
        return Promise.resolve({ ok: true, json: async () => [{ id: "r1", name: "alpha", nodeCount: 2, latestSnapshotAt: null, latestSnapshotId: null }] });
      }
      if (url === "/api/ps") {
        return Promise.resolve({ ok: true, json: async () => [{ rigId: "r1", name: "alpha", nodeCount: 2, runningCount: 2, status: "running", uptime: "1h", latestSnapshot: null }] });
      }
      if (url === "/api/down" && opts?.method === "POST") {
        return Promise.resolve({ ok: true, json: async () => ({ rigId: "r1", sessionsKilled: 1, deleted: false, deleteBlocked: false, alreadyStopped: false, errors: ["Kill failed for session 'r01-x': timeout"] }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(createTestRouter({ component: Dashboard }));
    await waitFor(() => expect(screen.getByText("alpha")).toBeDefined());

    fireEvent.click(screen.getByTestId("down-btn-r1"));
    await waitFor(() => expect(screen.getByTestId("confirm-down-btn")).toBeDefined());

    fireEvent.click(screen.getByTestId("confirm-down-btn"));

    // Dialog should stay open with error
    await waitFor(() => {
      expect(screen.getByTestId("teardown-error")).toBeDefined();
    });
    // Dialog still visible
    expect(screen.getByText(/Tear Down Rig/)).toBeDefined();
  });

  // T8: /api/ps failure does not show misleading ACTIVE or 0 nodes
  it("ps failure shows dash instead of ACTIVE, omits node count from header", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url === "/api/rigs/summary") {
        return Promise.resolve({ ok: true, json: async () => [{ id: "r1", name: "alpha", nodeCount: 2, latestSnapshotAt: null, latestSnapshotId: null }] });
      }
      if (url === "/api/ps") {
        return Promise.resolve({ ok: false, status: 500 });
      }
      return Promise.resolve({ ok: true, json: async () => ({}) });
    });

    render(createTestRouter({ component: Dashboard }));

    await waitFor(() => {
      // Status should show dash, not ACTIVE
      const badge = screen.getByTestId("status-badge-r1");
      expect(badge.textContent).toBe("—");
      expect(badge.textContent).not.toBe("ACTIVE");
    });

    // Header should NOT show "0 nodes running"
    const header = screen.getByTestId("aggregate-header");
    expect(header.textContent).not.toContain("nodes running");
  });
});
