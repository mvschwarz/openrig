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

function setupSummaryMock(rigs: Array<{
  id: string; name: string; nodeCount: number;
  latestSnapshotAt: string | null; latestSnapshotId: string | null;
}>) {
  mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
    if (url === "/api/rigs/summary") return Promise.resolve({ ok: true, json: async () => rigs });
    if (typeof url === "string" && url.includes("/snapshots") && opts?.method === "POST") return Promise.resolve({ ok: true, json: async () => ({ id: "snap-new" }) });
    if (typeof url === "string" && url.includes("/spec")) return Promise.resolve({ ok: true, text: async () => "yaml: content" });
    if (url === "/healthz") return Promise.resolve({ ok: true, json: async () => ({ status: "ok" }) });
    if (url === "/api/adapters/cmux/status") return Promise.resolve({ ok: true, json: async () => ({ available: false }) });
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
      expect(screen.getByText(/import a rig spec/i)).toBeDefined();
      expect(screen.getByText(/IMPORT YOUR FIRST RIG/)).toBeDefined();
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
      expect(loading.innerHTML).toContain("animate-pulse-tactical");
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

  // Test 9: Import button navigates to /import
  it("import button navigates to /import", async () => {
    setupSummaryMock([{ id: "r1", name: "alpha", nodeCount: 1, latestSnapshotAt: null, latestSnapshotId: null }]);

    render(createAppTestRouter({
      routes: [
        { path: "/", component: Dashboard },
        { path: "/import", component: () => <div data-testid="import-page">import</div> },
      ],
    }));

    await waitFor(() => expect(screen.getByText("alpha")).toBeDefined());

    // Click the IMPORT tactical button in header
    const importBtns = screen.getAllByText(/IMPORT/);
    const headerImport = importBtns.find((el) => el.closest("button") && !el.textContent?.includes("FIRST"));
    fireEvent.click(headerImport!);

    await waitFor(() => {
      expect(screen.getByTestId("import-page")).toBeDefined();
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
});
