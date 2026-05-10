// V1 attempt-3 Phase 5 ship-gate bounce P0-1 + P0-2 regression guards.
//
// P0-1: TopologyTableView previously called useNodeInventory inside a
// scopedRigs.map() — when rigs grew from undefined → [N], hook count
// jumped 0 → N which is a Rules-of-Hooks violation. At desktop this was
// masked because table view-mode mounted only after the user clicked,
// by which time rigs was already resolved (consistent count from first
// render). At mobile (P5-9), /topology graph degrades to table at first
// render, so the table mounts BEFORE rigs resolves → crash. Fixed by
// switching to `useQueries` (single hook call regardless of array length).
//
// P0-2: NodeDetailPanel previously self-pinned with
// `absolute inset-y-0 right-0 z-20 w-80` (320px) which left ~288px
// orphan whitespace inside the 38rem (608px) drawer chrome. Fixed by
// switching to fill-parent (`relative w-full h-full`).
//
// Both regressions break the V1 ship-gate UX; tests must permanently guard.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import path from "node:path";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  cleanup();
});

function withQueryClient(ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

// -----------------------------------------------------------------------
// P0-1: TopologyTableView no-crash regression — mount before rigs resolve.
// -----------------------------------------------------------------------

import { TopologyTableView } from "../src/components/topology/TopologyTableView.js";

describe("TopologyTableView P0-1 regression: no rules-of-hooks crash on first-render-before-rigs-resolved", () => {
  it("mounts cleanly when /api/rigs/summary has not yet resolved (mobile P5-9 first-render path)", async () => {
    let resolveSummary: ((value: unknown) => void) | null = null;
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/api/rigs/summary")) {
        // Hold the summary promise so first render sees rigs=undefined,
        // then resolve it → second render sees rigs=[N]. Pre-fix, this
        // sequence crashed (hook count 0 → N).
        return new Promise((resolve) => {
          resolveSummary = (value) => {
            resolve(new Response(JSON.stringify(value)));
          };
        });
      }
      const m = url.match(/\/api\/rigs\/([^/]+)\/nodes/);
      if (m) {
        return new Response(JSON.stringify([]));
      }
      return new Response("[]");
    });

    const { container } = withQueryClient(<TopologyTableView />);
    // Initial render: rigs not yet resolved; component must NOT crash.
    expect(container.querySelector("[data-testid='topology-table-view']")).toBeTruthy();

    // Now resolve the summary with multiple rigs — hook count would
    // change under the old shape; under the fix (useQueries) it stays at 1.
    resolveSummary!([
      { id: "rig-1", name: "rig-1" },
      { id: "rig-2", name: "rig-2" },
      { id: "rig-3", name: "rig-3" },
    ]);

    await waitFor(() => {
      // Component still alive after rigs resolution.
      expect(container.querySelector("[data-testid='topology-table-view']")).toBeTruthy();
    });
  });

  it("source asserts useQueries replaces the .map(useNodeInventory) loop (ritual #9)", () => {
    const src = readFileSync(
      path.resolve(
        __dirname,
        "../src/components/topology/TopologyTableView.tsx",
      ),
      "utf8",
    );
    // useQueries import + call present.
    expect(src).toMatch(/import\s*\{[^}]*useQueries[^}]*\}\s*from\s*["']@tanstack\/react-query["']/);
    expect(src).toMatch(/useQueries\s*\(/);
    // Negative-assertion: legacy `.map((r) => ({ ..., inv: useNodeInventory(r.id) }))`
    // pattern absent — strip comments first.
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/[^\n]*\n/gm, "");
    expect(codeOnly).not.toMatch(/inv:\s*useNodeInventory/);
  });
});

// -----------------------------------------------------------------------
// P0-2: NodeDetailPanel fill-parent regression — no self-pinning.
// -----------------------------------------------------------------------

describe("NodeDetailPanel P0-2 regression: drawer fill-parent guard", () => {
  // V1 polish slice Phase 5.1 P5.1-D2: NodeDetailPanel.tsx is fully
  // RETIRED at V1 polish; the canonical agent-detail surface is now
  // LiveNodeDetails.tsx (center page). The original P0-2 ship-gate
  // bounce regression guarded NodeDetailPanel's drawer fill-parent
  // layout; now that the file is gone, the guard becomes the
  // file-doesn't-exist assertion (which lives in
  // node-selection-migration.test.tsx). This block converts to a
  // companion source-assertion on LiveNodeDetails: the canonical
  // surface must NOT regress into legacy absolute self-pinning.
  it("LiveNodeDetails.tsx does not regress into legacy 'absolute inset-y-0 right-0 w-80' self-pinning", async () => {
    const liveSrc = readFileSync(
      path.resolve(__dirname, "../src/components/LiveNodeDetails.tsx"),
      "utf8",
    );
    const codeOnly = liveSrc
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/[^\n]*\n/gm, "");
    expect(codeOnly).not.toMatch(/absolute\s+inset-y-0\s+right-0/);
    expect(codeOnly).not.toMatch(/\bw-80\b/);
  });
});
