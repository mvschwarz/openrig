// C10: Dashboard v2 — sections render with seeded query data; empty states
// render with empty data. Cache seeded via setQueryData using the hooks'
// exact keys (no fetch mocking).
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { screen, cleanup, waitFor } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import { renderDashboard as renderWithClient } from "./helpers/dashboard-harness.js";

const PS = [
  { rigId: "rig_alpha", name: "acme-build", nodeCount: 11, runningCount: 11, activeCount: 6, hasWorkCount: 3, status: "running", uptime: "4h 12m", latestSnapshot: "2025-09-01T01:40:00Z" },
  { rigId: "rig_bravo", name: "acme-comms", nodeCount: 8, runningCount: 7, activeCount: 2, hasWorkCount: 1, status: "partial", uptime: "2h 03m", latestSnapshot: null },
  { rigId: "rig_gamma", name: "acme-core", nodeCount: 4, runningCount: 4, activeCount: 1, hasWorkCount: 0, status: "running", uptime: "9h 47m", latestSnapshot: null },
];

const ATTENTION = {
  items: [
    { qitemId: "q1", tsCreated: "2026-11-02T04:55:00Z", tsUpdated: "2026-11-02T04:55:00Z", sourceSession: "builder2@acme-build", destinationSession: "human@host", state: "pending", priority: "high", tier: "human-gate", tags: null, blockedOn: null, handedOffTo: null, handedOffFrom: null, body: "Need approval to proceed\nsecond line", summary: "Approve deploy plan", evidenceRef: null },
  ],
  hosts: [],
};

function seed(qc: QueryClient, ps: unknown, attention: unknown) {
  const entries: Array<[unknown[], unknown]> = [
    [["hosts"], { ownName: "localhost", selected: "local", hosts: [] }],
    [["ps", "local"], ps],
    [["attention-items", 50, false], attention],
    [["settings", "all"], { settings: {} }],
    [["kernel", "status"], { state: "skipped" }],
    [["daemon", "health"], { status: "ok" }],
  ];
  for (const [key, value] of entries) {
    qc.setQueryData(key, value);
  }
}

function seedFull(qc: QueryClient) {
  seed(qc, PS, ATTENTION);
}

function seedEmpty(qc: QueryClient) {
  seed(qc, [], { items: [], hosts: [] });
}

vi.mock("../src/components/mission-control/components/VerbActions.js", () => ({
  VerbActions: ({ qitemId }: { qitemId: string }) => <button type="button">Approve {qitemId}</button>,
}));

afterEach(cleanup);

beforeEach(() => {
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

describe("Dashboard v2 (C10)", () => {
  it("renders header, needs-you, 4 tiles, rigs table, activity", async () => {
    renderWithClient(seedFull);
    expect(await screen.findByText("Dashboard")).toBeTruthy();
    expect(screen.getByText("What's running, and what needs you.")).toBeTruthy();
    const needs = await screen.findByTestId("dashboard-needs-you");
    expect(needs.textContent).toContain("Approve deploy plan");
    expect(needs.textContent).toContain("builder2@acme-build");
    expect(needs.textContent).toContain("Open inbox");
    // Tiles
    expect((await screen.findByTestId("dashboard-tile-rigs")).textContent).toContain("3");
    expect(screen.getByTestId("dashboard-tile-agents").textContent).toContain("9");
    expect(screen.getByTestId("dashboard-tile-needs-you").textContent).toContain("1");
    expect(screen.getByTestId("dashboard-tile-daemon").textContent).toContain("Healthy");
    // Rigs table
    const rigs = screen.getByTestId("dashboard-rigs");
    await waitFor(() => expect(rigs.textContent).toContain("acme-build"));
    expect(rigs.textContent).toContain("acme-comms");
    expect(rigs.textContent).toContain("acme-core");
    expect(screen.getByTestId("dashboard-activity")).toBeTruthy();
    expect(screen.getByTestId("dashboard-host-section")).toBeTruthy();
  });

  it("renders empty states with empty data", async () => {
    renderWithClient(seedEmpty);
    const needs = await screen.findByTestId("dashboard-needs-you");
    expect(needs.textContent).toContain("You're all caught up");
    const rigs = screen.getByTestId("dashboard-rigs");
    expect(rigs.textContent).toContain("No rigs yet");
    const activity = screen.getByTestId("dashboard-activity");
    expect(activity.textContent).toContain("No activity yet.");
  });
});
