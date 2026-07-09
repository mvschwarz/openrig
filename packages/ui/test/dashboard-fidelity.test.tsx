// OPR.0.4.1.14 — Dashboard route visual refresh.
//
// Guards the two things a pure visual refresh must NOT regress: the six
// destination affordances + their routes (no behaviour change), and the
// Field Environment real-data wiring. Visual fidelity vs the locked twin is
// proven separately by the qa real-live screenshot gate.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
} from "@tanstack/react-router";

vi.mock("../src/hooks/useRigSummary.js", () => ({
  useRigSummary: () => ({ data: [{ id: "r1" }, { id: "r2" }, { id: "r3" }] }),
}));
vi.mock("../src/hooks/usePsEntries.js", () => ({
  usePsEntries: () => ({
    data: [{ nodeCount: 23, runningCount: 12, activeCount: 9 }],
    isError: false,
  }),
}));
vi.mock("../src/hooks/useSettings.js", () => ({
  useSettings: () => ({
    data: { settings: { "agents.operator_session": { value: "orch-lead@openrig-delivery" } } },
  }),
  // OPR.0.4.6.MH1 FR-5: the HostConfigCard (mounted in Dashboard) imports
  // the settings write hook from this module — the module mock must carry
  // it or the import resolves undefined.
  useSetSetting: () => ({ mutateAsync: async () => ({}) }),
}));
vi.mock("../src/hooks/useDaemonVersion.js", () => ({
  useDaemonVersion: () => ({ data: { version: "0.4.0" } }),
}));
// OPR.0.4.6.MH1 FR-5: HostConfigCard's data hooks — mocked so Dashboard
// renders without a QueryClientProvider (this test's concern is the
// field-environment wiring; the card has its own test).
vi.mock("../src/hooks/useHosts.js", () => ({
  useHosts: () => ({ data: { ownName: "localhost", selected: "local", hosts: [] }, error: null }),
  usePairHost: () => ({ mutateAsync: async () => ({}), data: undefined, error: null, isPending: false, reset: () => {} }),
  usePairPoll: () => ({ data: undefined }),
}));

import { Dashboard } from "../src/components/dashboard/Dashboard.js";

function renderDashboard() {
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: Dashboard });
  const stub = (path: string) =>
    createRoute({ getParentRoute: () => rootRoute, path, component: () => null });
  const routeTree = rootRoute.addChildren([
    indexRoute,
    stub("/topology"),
    stub("/project"),
    stub("/for-you"),
    stub("/specs"),
    stub("/search"),
    stub("/settings"),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  // Cast: the test stub tree differs from the app's generated route tree.
  return render(<RouterProvider router={router as never} />);
}

afterEach(cleanup);

describe("Dashboard route visual refresh (OPR.0.4.1.14)", () => {
  it("renders the launcher surface with greeting + field environment", async () => {
    renderDashboard();
    expect(await screen.findByTestId("dashboard-surface")).toBeTruthy();
    expect(screen.getByTestId("dashboard-greeting").textContent?.toLowerCase()).toContain(
      "welcome back",
    );
    expect(screen.getByTestId("dashboard-field-environment")).toBeTruthy();
    expect(screen.getByTestId("dashboard-footer")).toBeTruthy();
  });

  it("keeps all six destinations + their routes (no behaviour change)", async () => {
    renderDashboard();
    await screen.findByTestId("dashboard-surface");
    const expected: Array<[string, string, string]> = [
      ["dashboard-card-01", "/topology", "TOPOLOGY"],
      ["dashboard-card-02", "/project", "PROJECT"],
      ["dashboard-card-03", "/for-you", "FOR YOU"],
      ["dashboard-card-04", "/specs", "LIBRARY"],
      ["dashboard-card-05", "/search", "SEARCH & AUDIT"],
      ["dashboard-card-06", "/settings", "SETTINGS"],
    ];
    for (const [testId, href, label] of expected) {
      const card = screen.getByTestId(testId);
      expect(card.getAttribute("href")).toBe(href);
      expect(card.textContent).toContain(label);
    }
  });

  it("wires real runtime data into the Field Environment (functional refinement)", async () => {
    renderDashboard();
    const fe = await screen.findByTestId("dashboard-field-environment");
    const text = fe.textContent ?? "";
    // RIGS + AGENTS are split onto their own lines as single live counts
    // (3 rigs, 23 agents from the mocked hooks); the active sub-count is dropped.
    expect(text).toContain("RIGS");
    expect(text).toContain("03");
    expect(text).toContain("AGENTS");
    expect(text).toContain("23");
    expect(text).not.toContain("03 / 23"); // old combined RIGS / AGENTS row is gone
    // OPERATOR ID stays wired to the configured operator_session (real source).
    expect(text).toContain("ORCH-LEAD");
    // VERSION shows the REAL running daemon version from useDaemonVersion.
    expect(text).toContain("VERSION");
    expect(text).toContain("0.4.0");
    // The placeholder SESSION row + decorative DECLINATION row were dropped.
    expect(text).not.toContain("SESSION");
    expect(text).not.toContain("OPENRIG-DELIVERY");
    expect(text).not.toContain("DECLINATION");
  });
});
