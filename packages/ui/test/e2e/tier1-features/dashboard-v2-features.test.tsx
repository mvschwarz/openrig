import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import { renderDashboard } from "../../helpers/dashboard-harness.js";
import { GETTING_STARTED_DISMISSED_KEY } from "../../../src/components/dashboard/GettingStarted.js";

const TEST_PS = [
  {
    rigId: "rig_alpha",
    name: "acme-build",
    nodeCount: 10,
    runningCount: 10,
    activeCount: 5,
    hasWorkCount: 2,
    status: "running",
    uptime: "3h 45m",
    latestSnapshot: "2026-11-06T10:00:00Z",
  },
  {
    rigId: "rig_beta",
    name: "data-service",
    nodeCount: 4,
    runningCount: 4,
    activeCount: 1,
    hasWorkCount: 0,
    status: "partial",
    uptime: "1h 12m",
    latestSnapshot: null,
  },
];

const TEST_ATTENTION = {
  items: [
    {
      qitemId: "q-urgent-01",
      tsCreated: "2026-11-06T12:00:00Z",
      tsUpdated: "2026-11-06T12:00:00Z",
      sourceSession: "lead-agent@acme-build",
      destinationSession: "human@host",
      state: "pending",
      priority: "high",
      tier: "human-gate",
      tags: null,
      blockedOn: null,
      handedOffTo: null,
      handedOffFrom: null,
      body: "Please confirm deployment authorization.",
      summary: "Authorize build release",
      evidenceRef: null,
    },
  ],
  hosts: [],
};

function seedData(qc: QueryClient, ps: unknown, attention: unknown, library: unknown = []) {
  qc.setQueryData(["hosts"], { ownName: "localhost", selected: "local", hosts: [] });
  qc.setQueryData(["ps", "local"], ps);
  qc.setQueryData(["attention-items", 50, false], attention);
  qc.setQueryData(["settings", "all"], { settings: {} });
  qc.setQueryData(["kernel", "status"], { state: "skipped" });
  qc.setQueryData(["daemon", "health"], { status: "ok" });
  qc.setQueryData(["spec-library", "all", "local"], library);
}

vi.mock("../../../src/components/mission-control/components/VerbActions.js", () => ({
  VerbActions: ({ qitemId }: { qitemId: string }) => (
    <button type="button" data-testid={`verb-approve-${qitemId}`}>
      Approve {qitemId}
    </button>
  ),
}));

afterEach(cleanup);

beforeEach(() => {
  window.localStorage.removeItem(GETTING_STARTED_DISMISSED_KEY);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      if (String(url).includes("/healthz")) {
        return { ok: true, json: async () => ({ status: "ok" }) } as Response;
      }
      return { ok: false, status: 404, json: async () => ({}) } as Response;
    }),
  );
});

describe("Tier 1 Feature Coverage: Dashboard v2 Operational Command Center", () => {
  it("renders page header with title, subtitle, and primary action buttons", async () => {
    renderDashboard((qc) => seedData(qc, TEST_PS, TEST_ATTENTION));
    expect(await screen.findByText("Dashboard")).toBeTruthy();
    expect(screen.getByText("What's running, and what needs you.")).toBeTruthy();
    expect(screen.getByText("Import")).toBeTruthy();
    expect(screen.getAllByText("New rig").length).toBeGreaterThan(0);
  });

  it("renders 4 KPI metric tiles with active statistics and navigation links", async () => {
    renderDashboard((qc) => seedData(qc, TEST_PS, TEST_ATTENTION));

    const rigsTile = await screen.findByTestId("dashboard-tile-rigs");
    expect(rigsTile.textContent).toContain("2"); // 2 rigs running

    const agentsTile = screen.getByTestId("dashboard-tile-agents");
    expect(agentsTile.textContent).toContain("6"); // 5 + 1 active agents

    const needsTile = screen.getByTestId("dashboard-tile-needs-you");
    expect(needsTile.textContent).toContain("1"); // 1 attention item

    const daemonTile = screen.getByTestId("dashboard-tile-daemon");
    expect(daemonTile.textContent).toContain("Healthy");
  });

  it("renders Needs You list with pending approvals, source session, and verb action", async () => {
    renderDashboard((qc) => seedData(qc, TEST_PS, TEST_ATTENTION));

    const needsSection = await screen.findByTestId("dashboard-needs-you");
    expect(needsSection.textContent).toContain("Authorize build release");
    expect(needsSection.textContent).toContain("lead-agent@acme-build");
    expect(screen.getByTestId("verb-approve-q-urgent-01")).toBeTruthy();
  });

  it("renders Rigs Table with status badges, node counts, and uptime", async () => {
    renderDashboard((qc) => seedData(qc, TEST_PS, TEST_ATTENTION));

    const rigsTable = await screen.findByTestId("dashboard-rigs");
    await waitFor(() => {
      expect(rigsTable.textContent).toContain("acme-build");
    });
    expect(rigsTable.textContent).toContain("data-service");
    expect(rigsTable.textContent).toContain("3h 45m");
  });

  it("renders empty state representations when no rigs or attention items exist", async () => {
    renderDashboard((qc) => seedData(qc, [], { items: [], hosts: [] }));

    const needsSection = await screen.findByTestId("dashboard-needs-you");
    expect(needsSection.textContent).toContain("You're all caught up");

    const rigsTable = screen.getByTestId("dashboard-rigs");
    expect(rigsTable.textContent).toContain("No rigs yet");
  });

  it("first-run GettingStarted checklist displays when 0 rigs exist and respects dismissal", async () => {
    const { unmount } = renderDashboard((qc) => seedData(qc, [], { items: [], hosts: [] }));

    const gettingStarted = await screen.findByTestId("getting-started");
    expect(gettingStarted).toBeTruthy();
    expect(gettingStarted.textContent).toContain("Get started with OpenRig");

    const dismissBtn = screen.getByText("Dismiss");
    fireEvent.click(dismissBtn);

    expect(window.localStorage.getItem(GETTING_STARTED_DISMISSED_KEY)).toBe("1");
    unmount();
    cleanup();

    // Re-render: should be hidden now
    renderDashboard((qc) => seedData(qc, [], { items: [], hosts: [] }));
    expect(screen.queryByTestId("getting-started")).toBeNull();
  });
});
