// OPR.0.4.1.24 — Workspace parent-altitude portfolio. Missions DERIVED from the
// slice index (group by missionId/railItem), sorted most-recently-modified,
// COLLAPSED by default; expanding a row LAZILY projects that mission's
// MISSION_BRIEF.md Building + Needs-you glance (useMission -> useScopeMarkdown).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  RouterProvider,
  createRouter,
  createRootRoute,
  createRoute,
  Outlet,
} from "@tanstack/react-router";
import { WorkspacePortfolioPanel } from "../src/components/project/WorkspacePortfolioPanel.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch as unknown as typeof fetch;
let calls: string[] = [];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

// Two missions, varied recency: alpha is most-recent (has a MISSION_BRIEF), beta
// is older (NO MISSION_BRIEF -> graceful empty glance).
// Alpha is deliberately shaped so PROVEN (hasProofPacket) != DONE (status):
// a1+a3 are proven (hasProofPacket) but still active; a2 is done but NOT
// proven. proven=2, active=2, done=1 — so the rollup metric discriminates a
// hasProofPacket count from a status==='done' count (rev1-r2 OPR.0.4.1.24).
const SLICES = {
  slices: [
    { name: "a1", displayName: "Alpha one", railItem: "alpha", status: "active", rawStatus: "active", qitemCount: 3, hasProofPacket: true, lastActivityAt: "2026-06-23T20:00:00.000Z" },
    { name: "a2", displayName: "Alpha two", railItem: "alpha", status: "done", rawStatus: "done", qitemCount: 1, hasProofPacket: false, lastActivityAt: "2026-06-23T18:00:00.000Z" },
    { name: "a3", displayName: "Alpha three", railItem: "alpha", status: "active", rawStatus: "active", qitemCount: 2, hasProofPacket: true, lastActivityAt: "2026-06-23T19:00:00.000Z" },
    { name: "b1", displayName: "Beta one", railItem: "beta", status: "done", rawStatus: "done", qitemCount: 0, hasProofPacket: false, lastActivityAt: "2026-06-01T00:00:00.000Z" },
  ],
  totalCount: 4,
  filter: "all",
};

const BRIEF_ALPHA = "# Alpha — Brief\n\n## What & why\n\nAlpha mission.\n\n## Building\n\n- the alpha widget\n\n## Needs you\n\n- approve the alpha plan\n";

function installMock(opts: { emptySlices?: boolean } = {}) {
  mockFetch.mockImplementation(async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    // MH-2: the selection-known files gate needs the hosts payload (local).
    if (url.includes("/api/hosts")) return json({ ownName: "localhost", selected: "local", hosts: [] });
    if (url.includes("/api/slices?")) {
      return json(opts.emptySlices ? { slices: [], totalCount: 0, filter: "all" } : SLICES);
    }
    const mission = url.match(/\/api\/missions\/([^/?]+)/);
    if (mission) {
      const id = decodeURIComponent(mission[1]!);
      return json({ missionId: id, missionPath: `/ws/missions/${id}`, slices: [], workflow_spec: null, topology: null });
    }
    if (url.includes("/api/files/roots")) return json({ roots: [{ name: "work", path: "/ws" }] });
    if (url.includes("/api/files/read")) {
      const path = new URL(url, "http://t.local").searchParams.get("path") ?? "";
      if (path === "missions/alpha/MISSION_BRIEF.md") {
        return json({ root: "work", path, absolutePath: `/ws/${path}`, content: BRIEF_ALPHA, mtime: "2026-06-23T20:00:00.000Z", contentHash: "h", size: BRIEF_ALPHA.length });
      }
      return json({ error: "not found" }, 404); // beta has no MISSION_BRIEF
    }
    return json([]);
  });
}

function renderPortfolio() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const projectRoute = createRoute({ getParentRoute: () => rootRoute, path: "/project", component: () => <WorkspacePortfolioPanel /> });
  const missionRoute = createRoute({ getParentRoute: () => rootRoute, path: "/project/mission/$missionId", component: () => null });
  const router = createRouter({
    routeTree: rootRoute.addChildren([projectRoute, missionRoute]),
    history: createMemoryHistory({ initialEntries: ["/project"] }),
  });
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function listFetched(pattern: string): boolean {
  return calls.some((c) => c.includes(pattern));
}

describe("OPR.0.4.1.24 — workspace portfolio", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    installMock();
    calls = [];
  });
  afterEach(() => cleanup());

  it("AC-1: derives missions from the slice index, COLLAPSED by default", async () => {
    renderPortfolio();
    await waitFor(() => expect(screen.getByTestId("workspace-portfolio")).toBeTruthy());
    expect(screen.getByTestId("portfolio-mission-alpha")).toBeTruthy();
    expect(screen.getByTestId("portfolio-mission-beta")).toBeTruthy();
    // collapsed by default — no glance, and (lazy) no per-mission brief fetch yet.
    expect(screen.queryByTestId("portfolio-glance-alpha")).toBeNull();
    expect(listFetched("/api/missions/")).toBe(false);
    expect(listFetched("/api/files/")).toBe(false);
  });

  it("AC-2: missions are sorted most-recently-modified (alpha before beta)", async () => {
    renderPortfolio();
    await waitFor(() => expect(screen.getByTestId("portfolio-mission-alpha")).toBeTruthy());
    const order = Array.from(document.querySelectorAll("[data-testid^='portfolio-mission-']")).map(
      (el) => el.getAttribute("data-testid"),
    );
    expect(order.indexOf("portfolio-mission-alpha")).toBeLessThan(order.indexOf("portfolio-mission-beta"));
  });

  it("AC-3: expanding a row LAZILY projects the mission's MISSION_BRIEF Building + Needs-you", async () => {
    renderPortfolio();
    await waitFor(() => expect(screen.getByTestId("portfolio-toggle-alpha")).toBeTruthy());
    fireEvent.click(screen.getByTestId("portfolio-toggle-alpha"));
    await waitFor(() => expect(screen.getByTestId("portfolio-glance-alpha")).toBeTruthy());
    // the brief was fetched only on expand (lazy), and the Building/Needs-you prose rendered.
    expect(listFetched("/api/missions/alpha")).toBe(true);
    expect(listFetched("missions%2Falpha%2FMISSION_BRIEF.md")).toBe(true);
    const glance = screen.getByTestId("portfolio-glance-alpha");
    expect(glance.textContent).toContain("the alpha widget");
    expect(glance.textContent).toContain("approve the alpha plan");
  });

  it("AC-4: a mission with no MISSION_BRIEF.md shows a graceful empty glance on expand", async () => {
    renderPortfolio();
    await waitFor(() => expect(screen.getByTestId("portfolio-toggle-beta")).toBeTruthy());
    fireEvent.click(screen.getByTestId("portfolio-toggle-beta"));
    await waitFor(() => expect(screen.getByTestId("portfolio-glance-empty-beta")).toBeTruthy());
    expect(screen.getByTestId("portfolio-glance-empty-beta").textContent).toMatch(/no mission_brief/i);
  });

  it("AC-6: the collapsed row metric reads PROVEN (hasProofPacket), not done-status", async () => {
    renderPortfolio();
    await waitFor(() => expect(screen.getByTestId("portfolio-mission-alpha")).toBeTruthy());
    const row = screen.getByTestId("portfolio-mission-alpha");
    // alpha: proven=2 (a1,a3 hasProofPacket), active=2 (a1,a3), slices=3, done=1 (a2).
    // The metric must report the PROVEN count, matching the founder-approved mockup.
    // Contiguous match proves BOTH the label word and the count come from
    // hasProofPacket (2), not status==='done' (which would render "1 done · ...").
    expect(row.textContent).toContain("2 proven · 2 active · 3 slices");
    // Precise regression guard against the original "{doneCount} done · ..." form.
    expect(row.textContent).not.toContain("done · ");
  });

  it("AC-5: an empty workspace (no slices) renders the self-explanatory empty-state", async () => {
    mockFetch.mockReset();
    installMock({ emptySlices: true });
    renderPortfolio();
    await waitFor(() => expect(screen.getByTestId("portfolio-empty")).toBeTruthy());
  });
});
