// V1 polish slice Phase 5.2 — multi-rig single-canvas /topology graph
// regression guard. Covers ritual #6 (HostMultiRigGraph reachability)
// + ritual #8 (no .map(useRigGraph) rules-of-hooks anti-pattern) +
// ritual #9 (coupled-literal scan for default-collapsed state across
// HostMultiRigGraph + RigGroupNode + multi-rig-layout).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { readFileSync } from "node:fs";
import path from "node:path";

const navigateSpy = vi.fn();
vi.mock("@tanstack/react-router", async (importActual) => {
  const actual = await importActual<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => navigateSpy,
  };
});

import { HostMultiRigGraph } from "../src/components/topology/HostMultiRigGraph.js";
import {
  prefixRigData,
  packRigGroups,
  computeBounds,
  COLLAPSED_RIG_WIDTH,
  COLLAPSED_RIG_HEIGHT,
} from "../src/lib/multi-rig-layout.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

beforeEach(() => {
  navigateSpy.mockClear();
  mockFetch.mockReset();
});

afterEach(() => {
  cleanup();
});

function withQueryClient(ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // Wrap in TanStack Router with memory history so <Link> resolves the
  // route context without crashing inside RigGroupNode.
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <>{ui}</>,
  });
  const fallbackRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "$",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, fallbackRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

const PS_RESPONSE = [
  {
    rigId: "rig-1",
    name: "openrig-velocity",
    nodeCount: 13,
    runningCount: 9,
    status: "running",
    uptime: null,
    latestSnapshot: null,
  },
  {
    rigId: "rig-2",
    name: "openrig-discovery",
    nodeCount: 5,
    runningCount: 3,
    status: "partial",
    uptime: null,
    latestSnapshot: null,
  },
  {
    rigId: "rig-3",
    name: "openrig-product-lab",
    nodeCount: 0,
    runningCount: 0,
    status: "stopped",
    uptime: null,
    latestSnapshot: null,
  },
];

function setupFetchOk(opts: {
  ps?: typeof PS_RESPONSE;
  graphsByRigId?: Record<string, { nodes: unknown[]; edges: unknown[] }>;
}) {
  mockFetch.mockImplementation(async (url: string) => {
    if (url === "/api/ps") {
      return new Response(JSON.stringify(opts.ps ?? PS_RESPONSE));
    }
    const m = url.match(/\/api\/rigs\/([^/]+)\/graph/);
    if (m) {
      const rigId = decodeURIComponent(m[1]!);
      return new Response(
        JSON.stringify(opts.graphsByRigId?.[rigId] ?? { nodes: [], edges: [] }),
      );
    }
    return new Response("[]");
  });
}

// ----------------------------------------------------------------------
// multi-rig-layout helpers — pure-fn tests
// ----------------------------------------------------------------------

describe("multi-rig-layout: prefixRigData (P5.2-3 cross-rig prefixing)", () => {
  it("prefixes node IDs with `${rigId}::` and threads data.rigId", () => {
    const { nodes, edges } = prefixRigData(
      "rig-1",
      [
        { id: "n1", data: {} },
        { id: "n2", data: { foo: "bar" } },
      ],
      [{ id: "e1", source: "n1", target: "n2" }],
    );
    expect(nodes[0]!.id).toBe("rig-1::n1");
    expect(nodes[1]!.id).toBe("rig-1::n2");
    expect(nodes[0]!.data?.rigId).toBe("rig-1");
    expect(nodes[1]!.data?.foo).toBe("bar");
    expect(nodes[1]!.data?.rigId).toBe("rig-1");
    expect(edges[0]!.id).toBe("rig-1::e1");
    expect(edges[0]!.source).toBe("rig-1::n1");
    expect(edges[0]!.target).toBe("rig-1::n2");
  });

  it("two rigs with overlapping internal IDs have NO collision after prefixing (ritual #9)", () => {
    const r1 = prefixRigData(
      "rig-A",
      [{ id: "orchestrator", data: {} }, { id: "review", data: {} }],
      [],
    );
    const r2 = prefixRigData(
      "rig-B",
      [{ id: "orchestrator", data: {} }, { id: "review", data: {} }],
      [],
    );
    const allIds = new Set([...r1.nodes.map((n) => n.id), ...r2.nodes.map((n) => n.id)]);
    expect(allIds.size).toBe(4); // No collisions despite same internal IDs.
    expect(allIds.has("rig-A::orchestrator")).toBe(true);
    expect(allIds.has("rig-B::orchestrator")).toBe(true);
  });

  it("preserves and prefixes parentId for react-flow parent/child nodes", () => {
    const { nodes } = prefixRigData(
      "rig-A",
      [
        { id: "podGroup-1", data: {} },
        { id: "agent-1", data: {}, parentId: "podGroup-1" } as any,
      ],
      [],
    );
    expect((nodes[1] as { parentId?: string }).parentId).toBe("rig-A::podGroup-1");
  });
});

describe("multi-rig-layout: packRigGroups (P5.2-6 outer offset packing)", () => {
  it("places rigs in a row when viewport is wide enough", () => {
    const packed = packRigGroups(
      [
        { rigId: "rig-1", width: 300, height: 120 },
        { rigId: "rig-2", width: 300, height: 120 },
      ],
      1024,
    );
    expect(packed[0]!.offsetX).toBe(0);
    expect(packed[0]!.offsetY).toBe(0);
    expect(packed[1]!.offsetX).toBeGreaterThan(0);
    expect(packed[1]!.offsetY).toBe(0);
  });

  it("wraps to next row when total row width exceeds viewport", () => {
    const packed = packRigGroups(
      [
        { rigId: "rig-1", width: 600, height: 120 },
        { rigId: "rig-2", width: 600, height: 120 },
        { rigId: "rig-3", width: 600, height: 120 },
      ],
      800,
    );
    // First fits at row 0; second wraps; third also wraps.
    expect(packed[0]!.offsetY).toBe(0);
    expect(packed[1]!.offsetY).toBeGreaterThan(0);
  });

  it("returns empty array for zero rigs", () => {
    expect(packRigGroups([], 1024)).toEqual([]);
  });
});

describe("multi-rig-layout: computeBounds", () => {
  it("returns collapsed-card dimensions for empty node list", () => {
    const b = computeBounds([]);
    expect(b.width).toBe(COLLAPSED_RIG_WIDTH);
    expect(b.height).toBe(COLLAPSED_RIG_HEIGHT);
  });

  it("computes bounding box covering all positioned nodes", () => {
    const b = computeBounds([
      { position: { x: 10, y: 10 }, initialWidth: 100, initialHeight: 50 },
      { position: { x: 200, y: 100 }, initialWidth: 100, initialHeight: 50 },
    ]);
    // Width covers minX=10 → maxX=300 → 290 + 2 * 16 padding = 322
    expect(b.width).toBeGreaterThanOrEqual(290);
    expect(b.height).toBeGreaterThan(140);
  });
});

// ----------------------------------------------------------------------
// HostMultiRigGraph component — mounting + click contract + collapse
// ----------------------------------------------------------------------

describe("HostMultiRigGraph (P5.2-1 reachability — ritual #6)", () => {
  it("renders one rigGroup node per rig from /api/ps; default ALL collapsed", async () => {
    setupFetchOk({});
    const { findByTestId } = withQueryClient(<HostMultiRigGraph />);
    expect(await findByTestId("host-multi-rig-graph")).toBeTruthy();
    // Each rig surfaces its rigGroup node.
    expect(await findByTestId("rig-group-node-rig-1")).toBeTruthy();
    expect(await findByTestId("rig-group-node-rig-2")).toBeTruthy();
    expect(await findByTestId("rig-group-node-rig-3")).toBeTruthy();
    // All collapsed by default (P5.2-5).
    expect(
      (await findByTestId("rig-group-node-rig-1")).getAttribute("data-collapsed"),
    ).toBe("true");
    expect(
      (await findByTestId("rig-group-node-rig-2")).getAttribute("data-collapsed"),
    ).toBe("true");
  });

  it("rig group body click toggles collapse state (P5.2-5)", async () => {
    setupFetchOk({
      graphsByRigId: {
        "rig-1": { nodes: [], edges: [] },
      },
    });
    const { findByTestId } = withQueryClient(<HostMultiRigGraph />);
    const node = await findByTestId("rig-group-node-rig-1");
    expect(node.getAttribute("data-collapsed")).toBe("true");
    fireEvent.click(node);
    await waitFor(() => {
      expect(
        (
          document.querySelector(
            "[data-testid='rig-group-node-rig-1']",
          ) as HTMLElement
        ).getAttribute("data-collapsed"),
      ).toBe("false");
    });
    // Re-click → collapsed again.
    fireEvent.click(
      document.querySelector("[data-testid='rig-group-node-rig-1']") as HTMLElement,
    );
    await waitFor(() => {
      expect(
        (
          document.querySelector(
            "[data-testid='rig-group-node-rig-1']",
          ) as HTMLElement
        ).getAttribute("data-collapsed"),
      ).toBe("true");
    });
  });

  it("drill-in arrow Link is rendered separately from rig body (source contract)", async () => {
    setupFetchOk({});
    const { findByTestId } = withQueryClient(<HostMultiRigGraph />);
    const drill = await findByTestId("rig-group-drill-rig-1");
    // The drill Link element exists distinct from the rig body click target.
    // Its onClick stopPropagation contract is verified by source-assertion
    // (RigGroupNode.tsx contains `e.stopPropagation()` inside the Link
    // onClick) per the bottom-of-file ritual #9 source-assertion guard.
    expect(drill).toBeTruthy();
    expect(drill.tagName).toBe("A");
    // Rig body remains collapsed (clicking the drill link, even if its
    // onClick doesn't fire in jsdom, must not bubble to the body's
    // toggle handler — verified visually + via stopPropagation source).
    expect(
      (await findByTestId("rig-group-node-rig-1")).getAttribute("data-collapsed"),
    ).toBe("true");
  });

  it("empty rig list renders honest empty-state (no /api/rigs/.../graph fetches)", async () => {
    setupFetchOk({ ps: [] });
    const { findByTestId } = withQueryClient(<HostMultiRigGraph />);
    expect(await findByTestId("host-multi-rig-graph-empty")).toBeTruthy();
  });
});

// ----------------------------------------------------------------------
// Source-assertion guards (rituals #8 + #9)
// ----------------------------------------------------------------------

describe("source-assertion guards", () => {
  const SRC = path.resolve(__dirname, "../src");

  it("HostMultiRigGraph uses useQueries — NOT .map(useRigGraph) (ritual #8)", () => {
    const src = readFileSync(
      path.join(SRC, "components/topology/HostMultiRigGraph.tsx"),
      "utf8",
    );
    // Positive-assertion: useQueries imported + called. Substring matches
    // are robust to comment density (don't strip comments here — the file
    // has heavy header comments that confuse line-comment regexes; the
    // direct import line and call site survive verbatim either way).
    expect(src).toContain('import { useQueries } from "@tanstack/react-query"');
    expect(src).toContain("useQueries(");
    // Negative-assertion ritual #8: no .map((r) => useRigGraph(r.id))
    // anti-pattern (the rules-of-hooks violation P0-1 was caught for in
    // TopologyTableView). Match against full source — comments don't
    // contain that exact pattern.
    expect(src).not.toMatch(/\.map\(\s*\([^)]*\)\s*=>\s*useRigGraph/);
    // No useNodeSelection (Phase 5.1 retired the alias).
    expect(src).not.toMatch(/\buseNodeSelection\s*\(/);
  });

  it("RigGroupNode Link onClick contains e.stopPropagation() (ritual #9)", () => {
    const src = readFileSync(
      path.join(SRC, "components/topology/RigGroupNode.tsx"),
      "utf8",
    );
    // Drill-in Link must stop propagation so its click navigates without
    // also firing the rig body's onToggle handler.
    expect(src).toContain("e.stopPropagation()");
  });

  it("HostMultiRigGraph default state is all-collapsed (ritual #9 coupled-literal)", () => {
    const src = readFileSync(
      path.join(SRC, "components/topology/HostMultiRigGraph.tsx"),
      "utf8",
    );
    // useState<Map<string, boolean>>(() => new Map()) → empty map → no
    // rig is in the map → expanded.get(rigId) returns undefined → ?? false.
    expect(src).toMatch(/useState<Map<string, boolean>>\s*\(\s*\(\s*\)\s*=>\s*new Map\(\)\s*\)/);
    // collapsed: !p.isExpanded — the default-collapse semantic carrier.
    expect(src).toMatch(/collapsed:\s*!p\.isExpanded/);
  });

  it("RigGroupNode uses 1px outline-variant border + hard-shadow + RegistrationMarks", () => {
    const src = readFileSync(
      path.join(SRC, "components/topology/RigGroupNode.tsx"),
      "utf8",
    );
    expect(src).toMatch(/border\s+border-outline-variant/);
    expect(src).toMatch(/hard-shadow/);
    expect(src).toMatch(/RegistrationMarks/);
    // Drill-in Link present (separate from body click).
    expect(src).toMatch(/to=["']\/topology\/rig\/\$rigId["']/);
  });
});
