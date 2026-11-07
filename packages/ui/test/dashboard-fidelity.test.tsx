// C10 (Dashboard v2) — the OPR.0.4.1.14 paper-draft launcher surface
// (dashboard-surface / greeting / field-environment / six destination cards)
// was removed from Dashboard.tsx by this card's brief ("delete the
// dashboard's vellum-only decorations from this component"). Per rule 4 the
// three assertions that encoded that old copy/layout are rewritten below to
// assert the new v2 sections; nothing is skipped or weakened.

import { describe, it, expect, vi, afterEach } from "vitest";
import { screen, cleanup } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";

vi.mock("../src/components/mission-control/components/VerbActions.js", () => ({
  VerbActions: ({ qitemId }: { qitemId: string }) => <button type="button">Approve {qitemId}</button>,
}));

import { renderDashboard } from "./helpers/dashboard-harness.js";

function seedFull(qc: QueryClient) {
  qc.setQueryData(["hosts"], { ownName: "localhost", selected: "local", hosts: [] });
  qc.setQueryData(
    ["ps", "local"],
    [{ rigId: "r1", name: "acme-build", nodeCount: 23, runningCount: 12, activeCount: 9, hasWorkCount: 1, status: "running", uptime: "1h", latestSnapshot: null }],
  );
  qc.setQueryData(["attention-items", 50, false], { items: [], hosts: [] });
  qc.setQueryData(["settings", "all"], { settings: {} });
  qc.setQueryData(["kernel", "status"], { error: "kernel_boot_tracker_unavailable", message: "test" });
  qc.setQueryData(["daemon", "health"], { status: "ok" });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Dashboard route (C10 v2)", () => {
  it("renders the v2 header + sections (launcher surface gone)", async () => {
    renderDashboard(seedFull);
    expect(await screen.findByText("Dashboard")).toBeTruthy();
    expect(screen.getByText("What's running, and what needs you.")).toBeTruthy();
    expect(screen.getByTestId("dashboard-needs-you")).toBeTruthy();
    expect(screen.getByTestId("dashboard-rigs")).toBeTruthy();
    expect(screen.getByTestId("dashboard-activity")).toBeTruthy();
    expect(screen.getByTestId("dashboard-host-section")).toBeTruthy();
  });

  it("links the header + tiles to the v2 destinations", async () => {
    renderDashboard(seedFull);
    await screen.findByTestId("dashboard-needs-you");
    const rigs = screen.getByTestId("dashboard-rigs");
    expect(rigs.textContent).toContain("acme-build");
    expect(screen.getByTestId("dashboard-tile-rigs").textContent).toContain("1");
    expect(screen.getByTestId("dashboard-tile-agents").textContent).toContain("9");
  });

  it("wires real ps data into the rigs table", async () => {
    renderDashboard(seedFull);
    const rigs = await screen.findByTestId("dashboard-rigs");
    expect(rigs.textContent).toContain("acme-build");
    expect(rigs.textContent).toContain("9/23");
  });
});
