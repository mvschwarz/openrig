// V0.3.1 bug-fix slice topology-perf — large-N smoke fixture.
//
// Production VM walk 2026-05-11 reported a scale-dependent page hang
// on /topology Table view (~13+ seats across multiple rigs hangs
// Chrome; smaller topologies do not reproduce). This file is the
// synthetic-fixture smoke gate: render TopologyTableView with N=20
// seats across 4 rigs and assert the render path stays bounded.
//
// What this test asserts (and what it does NOT — be explicit):
//
//   DOES assert (smoke gate):
//     - Initial mount of N=20 rows completes synchronously under
//       happy-dom in <2s. Guards against runaway synchronous render
//       (infinite re-render loop, O(N²) render path, etc.).
//     - DOM cell cardinality is exactly N per cell kind (StatusCell,
//       ContextCell, TokenCell) — i.e., no row double-mounts.
//     - Re-rendering the parent with stable props leaves the table's
//       testid skeleton stable (smoke for React keying + reconciliation;
//       NOT a memoization proof).
//
//   Does NOT assert:
//     - Chrome painting/compositing perf at scale (happy-dom doesn't
//       paint or composite — only Chrome can tell us about the hang).
//     - That the React.memo wrappers on the cell components actually
//       skip re-renders. (This test cannot discriminate the memo'd
//       vs un-memo'd build — it would pass either way. The memo
//       wrappers are a scale-perf win whose verification belongs in a
//       real Chrome DevTools profile at production scale.)
//     - That the Table hang root cause is fixed.
//
// Limitations:
//   - happy-dom does not implement React.Profiler render-phase tracking
//     in a way that lets a test discriminate a memo'd subtree from a
//     non-memo'd one without exporting internal cell components +
//     instrumenting them. Per the slice's "narrow + honest" charter we
//     keep the cell components un-exported and the test scope honest.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const navigateSpy = vi.fn();
vi.mock("@tanstack/react-router", async (importActual) => {
  const actual = await importActual<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => navigateSpy,
  };
});

import { TopologyTableView } from "../src/components/topology/TopologyTableView.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

// N=20 seats across 4 rigs = production-scale fixture per the bug
// report. 5 seats per rig matches a typical mid-size rig (orch HA
// pair + 3 specialized seats).
const RIG_COUNT = 4;
const SEATS_PER_RIG = 5;
const TOTAL_SEATS = RIG_COUNT * SEATS_PER_RIG;

function makeRig(i: number) {
  return { id: `rig-${i}`, name: `synth-rig-${i}` };
}

function makeSeat(rigId: string, rigName: string, idx: number) {
  return {
    rigId,
    rigName,
    logicalId: `${rigName}.seat-${idx}`,
    podId: idx % 2 === 0 ? "orch" : "specialist",
    podNamespace: idx % 2 === 0 ? "orch" : "specialist",
    canonicalSessionName: `${rigName}-seat-${idx}@${rigName}`,
    nodeKind: "agent",
    runtime: "claude-code",
    sessionStatus: "running",
    startupStatus: "ready",
    contextUsage: {
      usedPercentage: 20 + idx * 5,
      remainingPercentage: 80 - idx * 5,
      contextWindowSize: 320000,
      availability: "known",
      sampledAt: "2026-05-11T10:00:00Z",
      fresh: true,
      totalInputTokens: 100_000 + idx * 5_000,
      totalOutputTokens: 10_000 + idx * 1_000,
    },
    restoreOutcome: "n-a",
    tmuxAttachCommand: null,
    resumeCommand: null,
    latestError: null,
  };
}

beforeEach(() => {
  navigateSpy.mockClear();
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes("/api/rigs/summary")) {
      const rigs = Array.from({ length: RIG_COUNT }, (_, i) => makeRig(i));
      return new Response(JSON.stringify(rigs));
    }
    const m = url.match(/\/api\/rigs\/rig-(\d+)\/nodes/);
    if (m) {
      const rigIdx = Number(m[1]);
      const rig = makeRig(rigIdx);
      const seats = Array.from({ length: SEATS_PER_RIG }, (_, i) =>
        makeSeat(rig.id, rig.name, i),
      );
      return new Response(JSON.stringify(seats));
    }
    return new Response("[]");
  });
});

afterEach(() => {
  cleanup();
});

function withQueryClient(ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe("TopologyTableView large-N smoke (bug-fix slice topology-perf)", () => {
  it("renders N=20 seats across 4 rigs without runaway synchronous render time", async () => {
    const t0 = performance.now();
    const { container } = withQueryClient(<TopologyTableView />);
    await waitFor(() => {
      const rows = container.querySelectorAll("[data-testid^='topology-table-row-']");
      expect(rows.length).toBe(TOTAL_SEATS);
    });
    const elapsedMs = performance.now() - t0;
    // happy-dom initial render of 20 rows should complete in <2s.
    // Anything higher is a red flag for runaway synchronous render
    // (infinite re-render loop, O(N²) pattern, etc.).
    expect(elapsedMs).toBeLessThan(2000);
  });

  it("renders exactly N cells of each kind (one per row); count is bounded by N (no double-mounts)", async () => {
    const { container } = withQueryClient(<TopologyTableView />);
    await waitFor(() => {
      const rows = container.querySelectorAll("[data-testid^='topology-table-row-']");
      expect(rows.length).toBe(TOTAL_SEATS);
    });
    const contextCells = container.querySelectorAll(
      "[data-testid^='topology-table-context-']",
    );
    const tokenCells = container.querySelectorAll(
      "[data-testid^='topology-table-tokens-']",
    );
    const statusCells = container.querySelectorAll(
      "[data-testid^='topology-table-status-']",
    );
    expect(contextCells.length).toBe(TOTAL_SEATS);
    expect(tokenCells.length).toBe(TOTAL_SEATS);
    expect(statusCells.length).toBe(TOTAL_SEATS);
  });

  it("re-rendering the parent with stable props leaves the table testid skeleton stable", async () => {
    // Smoke for React keying + reconciliation (NOT a memo proof — see
    // file header). The assertion catches "rerender mints fresh testids"
    // or "rerender unmounts rows", which would be a different class of
    // bug than the memo wins this slice is targeting.
    const { container, rerender } = withQueryClient(<TopologyTableView />);
    await waitFor(() => {
      const rows = container.querySelectorAll("[data-testid^='topology-table-row-']");
      expect(rows.length).toBe(TOTAL_SEATS);
    });
    const before = Array.from(
      container.querySelectorAll("[data-testid^='topology-table-context-']"),
    ).slice(0, 5).map((el) => el.getAttribute("data-testid"));

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rerender(
      <QueryClientProvider client={queryClient}>
        <TopologyTableView />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      const rows = container.querySelectorAll("[data-testid^='topology-table-row-']");
      expect(rows.length).toBe(TOTAL_SEATS);
    });
    const after = Array.from(
      container.querySelectorAll("[data-testid^='topology-table-context-']"),
    ).slice(0, 5).map((el) => el.getAttribute("data-testid"));

    expect(after).toEqual(before);
  });
});
