// V0.3.1 slice 13.5 mission-progress-artifacts-heatmap.
//
// MissionProgressHeatmap is a per-slice acceptance-cell heat-map
// rendered ABOVE the existing Progress tab content. Tests cover:
//
//   T1 — component renders a grid shape with N slices × M acceptance
//        cells per row (HG-1)
//   T2 — cell colors map to slice state via stateTone (done cells
//        carry the slice's status tone; not-done cells outline-only)
//        (HG-2)
//   T3 — legend renders the canonical state -> color mapping (HG-2)
//   T4 — MissionScopePage Progress tab composes markdown + heat-map +
//        per-slice rollup; Artifacts tab unchanged (no heat-map mount)
//        (HG-3 + HG-4)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { MissionProgressHeatmap } from "../src/components/project/MissionProgressHeatmap.js";
import { MissionScopePage } from "../src/components/project/ScopePages.js";
import type { SliceDetail, SliceListEntry } from "../src/hooks/useSlices.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  cleanup();
});

function makeRow(name: string, status: SliceListEntry["status"]): SliceListEntry {
  return {
    name,
    displayName: name,
    railItem: "RELEASE-PROOF",
    status,
    rawStatus: status,
    qitemCount: 0,
    hasProofPacket: false,
    lastActivityAt: "2026-05-11T00:00:00.000Z",
  };
}

function makeDetail(
  name: string,
  items: { text: string; done: boolean }[],
): SliceDetail {
  const doneItems = items.filter((it) => it.done).length;
  const totalItems = items.length;
  const percentage = totalItems === 0 ? 0 : Math.round((doneItems / totalItems) * 100);
  return {
    name,
    missionId: "RELEASE-PROOF",
    slicePath: `/workspace/${name}`,
    displayName: name,
    railItem: "RELEASE-PROOF",
    status: "active",
    rawStatus: "active",
    qitemIds: [],
    commitRefs: [],
    lastActivityAt: "2026-05-11T00:00:00.000Z",
    workflowBinding: null,
    story: { events: [], phaseDefinitions: null },
    acceptance: {
      totalItems,
      doneItems,
      percentage,
      items: items.map((it) => ({
        text: it.text,
        done: it.done,
        source: { file: "PROGRESS.md", line: 1 },
      })),
      closureCallout: null,
      currentStep: null,
    },
    decisions: { rows: [] },
    docs: { tree: [] },
    tests: {
      proofPackets: [],
      aggregate: { passCount: 0, failCount: 0 },
    },
    topology: { affectedRigs: [], totalSeats: 0, specGraph: null },
  };
}

function withRouter(ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <>{ui}</>,
  });
  const sliceRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/project/slice/$sliceId",
    component: () => null,
  });
  const fallback = createRoute({
    getParentRoute: () => rootRoute,
    path: "$",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, sliceRoute, fallback]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("MissionProgressHeatmap (slice 13.5)", () => {
  it("HG-1: renders N rows × M acceptance cells in a grid shape", async () => {
    const rows = [makeRow("alpha", "active"), makeRow("beta", "done")];
    const detailsByName = new Map<string, SliceDetail>([
      [
        "alpha",
        makeDetail("alpha", [
          { text: "a1", done: true },
          { text: "a2", done: true },
          { text: "a3", done: false },
        ]),
      ],
      [
        "beta",
        makeDetail("beta", [
          { text: "b1", done: true },
          { text: "b2", done: true },
        ]),
      ],
    ]);
    const { findByTestId, queryAllByTestId } = withRouter(
      <MissionProgressHeatmap rows={rows} detailsByName={detailsByName} />,
    );
    expect(await findByTestId("mission-progress-heatmap")).toBeTruthy();
    expect(await findByTestId("mission-progress-heatmap-row-alpha")).toBeTruthy();
    expect(await findByTestId("mission-progress-heatmap-row-beta")).toBeTruthy();

    // Each row's cells container holds the per-acceptance-item span.
    const alphaCells = queryAllByTestId(/^mission-progress-heatmap-cell-alpha-\d+$/);
    expect(alphaCells.length).toBe(3);
    const betaCells = queryAllByTestId(/^mission-progress-heatmap-cell-beta-\d+$/);
    expect(betaCells.length).toBe(2);
  });

  it("HG-2: done cells take the slice's status tone; not-done cells render outline-only", async () => {
    const rows = [makeRow("alpha", "active")];
    const detailsByName = new Map<string, SliceDetail>([
      [
        "alpha",
        makeDetail("alpha", [
          { text: "a1", done: true },
          { text: "a2", done: false },
        ]),
      ],
    ]);
    const { findByTestId } = withRouter(
      <MissionProgressHeatmap rows={rows} detailsByName={detailsByName} />,
    );
    const row = await findByTestId("mission-progress-heatmap-row-alpha");
    expect(row.getAttribute("data-status")).toBe("active");
    // The heat-map's local heatmapTone() overrides stateTone for the
    // canonical SliceStatus value "active" -> "info", so done cells on
    // an active slice are visually distinct from done cells on a
    // shipped done slice. This matches the legend.
    expect(row.getAttribute("data-tone")).toBe("info");

    const doneCell = await findByTestId("mission-progress-heatmap-cell-alpha-0");
    const notDoneCell = await findByTestId("mission-progress-heatmap-cell-alpha-1");
    expect(doneCell.getAttribute("data-done")).toBe("true");
    expect(notDoneCell.getAttribute("data-done")).toBe("false");
    // Active slice done cells render in the info tone (sky); not-done
    // cells stay outline-only.
    expect(doneCell.className).toMatch(/bg-sky-200/);
    expect(notDoneCell.className).toMatch(/border-outline-variant/);
    expect(notDoneCell.className).not.toMatch(/bg-sky-200/);
  });

  it("HG-2 (blocked tone): blocked-status slice rows mark done cells with the danger tone", async () => {
    const rows = [makeRow("blockedSlice", "blocked")];
    const detailsByName = new Map<string, SliceDetail>([
      [
        "blockedSlice",
        makeDetail("blockedSlice", [
          { text: "x1", done: true },
          { text: "x2", done: false },
        ]),
      ],
    ]);
    const { findByTestId } = withRouter(
      <MissionProgressHeatmap rows={rows} detailsByName={detailsByName} />,
    );
    const row = await findByTestId("mission-progress-heatmap-row-blockedSlice");
    expect(row.getAttribute("data-tone")).toBe("danger");
    const doneCell = await findByTestId("mission-progress-heatmap-cell-blockedSlice-0");
    expect(doneCell.className).toMatch(/bg-rose-300/);
  });

  it("HG-2 (legend): legend renders all five state -> color samples", async () => {
    const rows = [makeRow("alpha", "active")];
    const detailsByName = new Map<string, SliceDetail>([
      ["alpha", makeDetail("alpha", [{ text: "a1", done: true }])],
    ]);
    const { findByTestId } = withRouter(
      <MissionProgressHeatmap rows={rows} detailsByName={detailsByName} />,
    );
    const legend = await findByTestId("mission-progress-heatmap-legend");
    expect(legend.textContent).toContain("done (active)");
    expect(legend.textContent).toContain("done (complete)");
    expect(legend.textContent).toContain("done (warning)");
    expect(legend.textContent).toContain("done (blocked)");
    expect(legend.textContent).toContain("not done");
  });

  // Forward-fix-1 coverage gap closed: legend swatch className must
  // match the className of an actual heat-map cell rendered for a
  // slice of that status. The legend says "done (active)" labels the
  // info-toned swatch; an active-status slice's done cell must use the
  // same className. Previously, legend hard-coded cellToneClass.info
  // but active-status rows fell through neutral->success (emerald) for
  // their done cells, leaving the legend out of sync with reality.
  it("HG-2 (legend ↔ cell parity): legend swatch className equals the actual cell className for each canonical SliceStatus", async () => {
    const rows = [
      makeRow("activeSlice", "active"),
      makeRow("doneSlice", "done"),
      makeRow("blockedSlice", "blocked"),
    ];
    const detailsByName = new Map<string, SliceDetail>([
      ["activeSlice", makeDetail("activeSlice", [{ text: "a1", done: true }])],
      ["doneSlice", makeDetail("doneSlice", [{ text: "b1", done: true }])],
      ["blockedSlice", makeDetail("blockedSlice", [{ text: "c1", done: true }])],
    ]);
    const { findByTestId } = withRouter(
      <MissionProgressHeatmap rows={rows} detailsByName={detailsByName} />,
    );

    // active -> legend-active swatch should carry the SAME color
    // classes (bg + border) the actual active-row done cell renders.
    const activeCell = await findByTestId("mission-progress-heatmap-cell-activeSlice-0");
    const activeLegend = await findByTestId("mission-progress-heatmap-legend-active");
    expect(activeLegend.className).toMatch(/bg-sky-200/);
    expect(activeCell.className).toMatch(/bg-sky-200/);

    const doneCell = await findByTestId("mission-progress-heatmap-cell-doneSlice-0");
    const completeLegend = await findByTestId("mission-progress-heatmap-legend-complete");
    expect(completeLegend.className).toMatch(/bg-emerald-400/);
    expect(doneCell.className).toMatch(/bg-emerald-400/);

    const blockedCell = await findByTestId("mission-progress-heatmap-cell-blockedSlice-0");
    const blockedLegend = await findByTestId("mission-progress-heatmap-legend-blocked");
    expect(blockedLegend.className).toMatch(/bg-rose-300/);
    expect(blockedCell.className).toMatch(/bg-rose-300/);

    // warning tone has no canonical SliceStatus mapping but the legend
    // still publishes the swatch shape. Asserting the legend swatch
    // for warning gives operators a forward-compatible reference for
    // any future status string that resolves to the warning tone.
    const warningLegend = await findByTestId("mission-progress-heatmap-legend-warning");
    expect(warningLegend.className).toMatch(/bg-amber-300/);
  });

  it("renders an empty-state when the mission has no scoped slices", async () => {
    const { findByTestId } = withRouter(
      <MissionProgressHeatmap rows={[]} detailsByName={new Map()} />,
    );
    expect(await findByTestId("mission-progress-heatmap-empty")).toBeTruthy();
  });

  it("renders the tally column with done/total + percentage when acceptance items exist", async () => {
    const rows = [makeRow("alpha", "active")];
    const detailsByName = new Map<string, SliceDetail>([
      [
        "alpha",
        makeDetail("alpha", [
          { text: "a1", done: true },
          { text: "a2", done: true },
          { text: "a3", done: false },
        ]),
      ],
    ]);
    const { findByTestId } = withRouter(
      <MissionProgressHeatmap rows={rows} detailsByName={detailsByName} />,
    );
    const row = await findByTestId("mission-progress-heatmap-row-alpha");
    expect(row.textContent).toContain("2/3");
    expect(row.textContent).toContain("67%");
  });
});

describe("MissionScopePage Progress tab composes heat-map (slice 13.5)", () => {
  function installMissionFetchMock() {
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("/api/config")) {
        return new Response(
          JSON.stringify({
            settings: { "workspace.root": { value: "/Users/admin/.openrig/workspace" } },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/missions/RELEASE-PROOF") && !url.includes("/api/missions/RELEASE-PROOF/")) {
        return new Response(
          JSON.stringify({
            missionId: "RELEASE-PROOF",
            missionPath: "/workspace/missions/release-proof",
            slices: [
              {
                name: "alpha",
                displayName: "alpha",
                railItem: "RELEASE-PROOF",
                status: "active",
                rawStatus: "active",
                qitemCount: 0,
                hasProofPacket: false,
                lastActivityAt: "2026-05-11T00:00:00.000Z",
              },
            ],
            topology: { specGraph: null },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/api/slices/alpha")) {
        return new Response(JSON.stringify(makeDetail("alpha", [{ text: "a1", done: true }])), {
          status: 200,
        });
      }
      if (url.includes("/api/slices")) {
        return new Response(
          JSON.stringify({
            slices: [
              {
                name: "alpha",
                displayName: "alpha",
                railItem: "RELEASE-PROOF",
                status: "active",
                rawStatus: "active",
                qitemCount: 0,
                hasProofPacket: false,
                lastActivityAt: "2026-05-11T00:00:00.000Z",
              },
            ],
            totalCount: 1,
            filter: "all",
          }),
          { status: 200 },
        );
      }
      if (url.includes("/scope-markdown") || url.includes("PROGRESS.md") || url.includes("README.md")) {
        return new Response(JSON.stringify({ content: "# Mission progress goes here\n" }), {
          status: 200,
        });
      }
      return new Response("[]", { status: 200 });
    });
  }

  function renderMissionScope(): ReturnType<typeof render> {
    installMissionFetchMock();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const rootRoute = createRootRoute({ component: () => <Outlet /> });
    const missionRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/project/mission/$missionId",
      component: () => <MissionScopePage />,
    });
    const sliceRoute = createRoute({
      getParentRoute: () => rootRoute,
      path: "/project/slice/$sliceId",
      component: () => null,
    });
    const fallback = createRoute({
      getParentRoute: () => rootRoute,
      path: "$",
      component: () => null,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([missionRoute, sliceRoute, fallback]),
      history: createMemoryHistory({ initialEntries: ["/project/mission/RELEASE-PROOF"] }),
    });
    return render(
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>,
    );
  }

  it("HG-3: Mission Progress tab includes heat-map ALONGSIDE existing rollup", async () => {
    const { findByTestId } = renderMissionScope();
    // Sanity: mission overview mounts.
    expect(await findByTestId("mission-overview-panel")).toBeTruthy();

    // Switch to Progress tab.
    fireEvent.click(await findByTestId("project-tab-progress"));

    // Heat-map renders.
    expect(await findByTestId("mission-progress-heatmap")).toBeTruthy();
    // Per-slice rollup still present (composition, not replacement).
    expect(await findByTestId("scope-progress-rollup")).toBeTruthy();
  });

  // Forward-fix-1: heat-map must render BEFORE the PROGRESS.md
  // markdown section so the new visual gestalt is the first thing on
  // the Progress tab. Asserting DOM order via Node.compareDocument-
  // Position protects against silent reordering that the old
  // "both render" assertion (HG-3 above) would not catch.
  it("HG-3 (DOM order): heat-map renders BEFORE the PROGRESS.md markdown section", async () => {
    const { findByTestId } = renderMissionScope();
    expect(await findByTestId("mission-overview-panel")).toBeTruthy();
    fireEvent.click(await findByTestId("project-tab-progress"));

    const heatmap = await findByTestId("mission-progress-heatmap");
    const panel = await findByTestId("mission-progress-panel");

    // The markdown section only renders when missionProgress.content
    // is non-empty; the integration mock returns "# Mission progress
    // goes here" so it should mount. If it doesn't, this assertion
    // skips (no order to compare).
    const readme = panel.querySelector(
      "[data-testid='mission-progress-readme']",
    );
    if (readme) {
      // DOCUMENT_POSITION_FOLLOWING (4) means readme comes AFTER
      // heatmap in DOM order — i.e., heatmap renders first.
      expect(heatmap.compareDocumentPosition(readme)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
    }

    // Heat-map must also precede the rollup; this is the structural
    // claim of the slice and the legend depends on it visually.
    const rollup = await findByTestId("scope-progress-rollup");
    expect(heatmap.compareDocumentPosition(rollup)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("HG-4: Mission Artifacts tab does NOT mount the heat-map", async () => {
    const { findByTestId, queryByTestId } = renderMissionScope();
    expect(await findByTestId("mission-overview-panel")).toBeTruthy();

    fireEvent.click(await findByTestId("project-tab-artifacts"));
    expect(queryByTestId("mission-progress-heatmap")).toBeNull();
  });
});
