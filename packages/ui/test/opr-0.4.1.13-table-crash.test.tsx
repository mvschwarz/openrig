// OPR.0.4.1.13 — topology table-view intermittent page-crash repro + fix.
//
// REPRO-FIRST (the crash is intermittent, so reproduce + root-cause before fixing):
// the topology TABLE view (unlike the GRID, which drops infrastructure nodes) builds
// a row for EVERY node and does NOT default `rigName` (rig.name) or `logicalId`
// (n.logicalId) at build time. The `globalFilterFn` then calls `.toLowerCase()` on
// `r.rigName` and `r.logicalId` UNGUARDED. With a malformed node (null logicalId) or
// rig (null name) in the inventory JSON — a real edge data shape — typing in the
// filter throws `Cannot read properties of null (reading 'toLowerCase')` during the
// filtered-row-model build, and with NO error boundary around the table the WHOLE
// /topology page white-screens. That intermittence (only on filter + malformed row)
// matches the founder report.
//
// These tests reproduce that exact trigger; they go GREEN once the filter guards the
// fields (and an error boundary contains any residual render throw).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { readFileSync } from "node:fs";

const navigateSpy = vi.fn();
vi.mock("@tanstack/react-router", async (importActual) => {
  const actual = await importActual<typeof import("@tanstack/react-router")>();
  return { ...actual, useNavigate: () => navigateSpy };
});

import { TopologyTableView } from "../src/components/topology/TopologyTableView.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch as unknown as typeof fetch;

// A MALFORMED inventory: rig-bad has name=null, and its single node has
// logicalId=null + runtime=null (violating the declared types, as real JSON can).
// rig-ok is well-formed so the table mounts a normal row alongside the bad one.
beforeEach(() => {
  navigateSpy.mockClear();
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes("/api/rigs/summary")) {
      return new Response(JSON.stringify([
        { id: "rig-bad", name: null },
        { id: "rig-ok", name: "ok-rig" },
      ]));
    }
    if (url.includes("/api/rigs/rig-bad/nodes")) {
      return new Response(JSON.stringify([
        {
          logicalId: null, podId: "p", podNamespace: "p", canonicalSessionName: null,
          nodeKind: "agent", runtime: null, sessionStatus: "running", startupStatus: null,
          contextUsage: null,
        },
      ]));
    }
    if (url.includes("/api/rigs/rig-ok/nodes")) {
      return new Response(JSON.stringify([
        {
          logicalId: "ok.seat", podId: "p", podNamespace: "p", canonicalSessionName: "s@ok-rig",
          nodeKind: "agent", runtime: "claude-code", sessionStatus: "running", startupStatus: "ready",
          contextUsage: null,
        },
      ]));
    }
    return new Response("[]");
  });
});

afterEach(() => cleanup());

function withQueryClient(ui: ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

describe("OPR.0.4.1.13 — table-view crash repro (malformed row + filter)", () => {
  it("wraps every production ScopePages TopologyTableView mount in the table ErrorBoundary", () => {
    const src = readFileSync("src/components/topology/ScopePages.tsx", "utf8");
    const tableMounts = [...src.matchAll(/<TopologyTableView\b/g)].map((m) => m.index ?? -1);
    expect(tableMounts).toHaveLength(3);

    for (const mountIndex of tableMounts) {
      const beforeMount = src.slice(0, mountIndex);
      const lastTableBoundaryOpen = beforeMount.lastIndexOf('<ErrorBoundary label="Table view">');
      const lastBoundaryClose = beforeMount.lastIndexOf("</ErrorBoundary>");
      expect(lastTableBoundaryOpen).toBeGreaterThan(lastBoundaryClose);

      const afterMount = src.slice(mountIndex);
      expect(afterMount.indexOf("</ErrorBoundary>")).toBeGreaterThan(-1);
    }
  });

  it("renders a malformed row (null rigName/logicalId) without crashing", async () => {
    withQueryClient(<TopologyTableView />);
    await waitFor(() => {
      expect(screen.getAllByTestId(/^topology-table-row-/).length).toBeGreaterThanOrEqual(2);
    });
    // baseline: the page is up with the bad row present (pre-filter is fine).
    expect(screen.getByTestId("topology-table-view")).toBeTruthy();
  });

  it("does NOT crash when the user FILTERS with a malformed row present (the trigger)", async () => {
    withQueryClient(<TopologyTableView />);
    await waitFor(() => {
      expect(screen.getAllByTestId(/^topology-table-row-/).length).toBeGreaterThanOrEqual(2);
    });
    const search = screen.getByTestId("topology-table-search");
    // Typing runs globalFilterFn over EVERY row incl. the null-field one.
    // Pre-fix: r.rigName.toLowerCase() / r.logicalId.toLowerCase() throws -> page crash.
    expect(() => {
      fireEvent.change(search, { target: { value: "ok" } });
    }).not.toThrow();
    // The table survives + filters to the matching well-formed row.
    expect(screen.getByTestId("topology-table-view")).toBeTruthy();
  });

  it("STRESS: many rows with mixed malformed shapes survive filter + sort (no-recur)", async () => {
    // A large, deliberately-ugly inventory: null name, null/missing logicalId,
    // null runtime/status, missing contextUsage - across many rigs/nodes.
    mockFetch.mockReset();
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/api/rigs/summary")) {
        return new Response(JSON.stringify(
          Array.from({ length: 6 }, (_, i) => ({ id: `rig-${i}`, name: i % 2 === 0 ? `rig-${i}` : null })),
        ));
      }
      const m = url.match(/\/api\/rigs\/rig-(\d+)\/nodes/);
      if (m) {
        const idx = Number(m[1]);
        return new Response(JSON.stringify(
          Array.from({ length: 8 }, (_, j) => {
            const bad = (idx + j) % 3 === 0;
            return bad
              ? { logicalId: null, runtime: null, sessionStatus: null, podNamespace: null, canonicalSessionName: null, contextUsage: null }
              : { logicalId: `rig-${idx}.seat-${j}`, runtime: "codex", sessionStatus: "running", podNamespace: "p", canonicalSessionName: `s${j}@rig-${idx}`, startupStatus: "ready", contextUsage: null };
          }),
        ));
      }
      return new Response("[]");
    });

    withQueryClient(<TopologyTableView />);
    await waitFor(() => {
      expect(screen.getAllByTestId(/^topology-table-row-/).length).toBeGreaterThan(10);
    });
    const search = screen.getByTestId("topology-table-search");
    // Hammer the filter with several queries (each re-runs globalFilterFn over all rows).
    expect(() => {
      for (const q of ["seat", "rig", "codex", "running", "zzz", ""]) {
        fireEvent.change(search, { target: { value: q } });
      }
    }).not.toThrow();
    // Sort by clicking each sortable header (re-runs the sorted-row-model over null fields).
    expect(() => {
      for (const th of Array.from(document.querySelectorAll("thead th"))) {
        fireEvent.click(th);
        fireEvent.click(th);
      }
    }).not.toThrow();
    expect(screen.getByTestId("topology-table-view")).toBeTruthy();
  }, 30_000); // Many full-table renders: allow shared-host contention without reducing the stress coverage.
});
