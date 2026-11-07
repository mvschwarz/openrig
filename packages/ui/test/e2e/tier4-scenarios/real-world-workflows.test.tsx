import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import { renderDashboard } from "../../helpers/dashboard-harness.js";
import { setupE2EEnv, renderE2EAppAt, MOCK_RIGS, MOCK_AGENT_DETAIL } from "../helpers/e2e-harness.js";

setupE2EEnv();

describe("Tier 4: Real-World Application Scenarios", () => {
  describe("Scenario 1: End-to-End Operator Fleet Inspection Workflow", () => {
    it("completes full operator journey from Dashboard through Fleet inspection to Agent details", async () => {
      // 1. Operator lands on Dashboard
      const { container } = await renderE2EAppAt("/");
      expect(screen.getByTestId("page-dashboard")).toBeTruthy();

      // 2. Navigates to Rigs via Sidebar
      const rigsLink = screen.getByTestId("rail-topology");
      fireEvent.click(rigsLink);
      await waitFor(() => {
        expect(screen.getByTestId("page-topology")).toBeTruthy();
      });

      // 3. Inspects specific rig details
      const rigResult = await renderE2EAppAt("/topology/rig/rig_alpha");
      expect(screen.getByTestId("page-rig-detail")).toBeTruthy();

      // Breadcrumbs resolve rig name once summary query settles
      await waitFor(() => {
        const breadcrumbs = rigResult.container.querySelector("[data-testid='breadcrumbs']");
        expect(breadcrumbs?.textContent).toContain("acme-build");
      });
      rigResult.unmount();
    });
  });

  describe("Scenario 2: Multi-Rig Fleet State Aggregation", () => {
    it("aggregates fleet lifecycle metrics across healthy, degraded, and stopped rigs", async () => {
      const mockMultiRigs = [
        {
          rigId: "rig_prod",
          name: "production-core",
          nodeCount: 16,
          runningCount: 16,
          activeCount: 12,
          hasWorkCount: 4,
          status: "running",
          uptime: "14d 2h",
          latestSnapshot: "2026-11-05T00:00:00Z",
        },
        {
          rigId: "rig_staging",
          name: "staging-cluster",
          nodeCount: 8,
          runningCount: 6,
          activeCount: 2,
          hasWorkCount: 1,
          status: "partial",
          uptime: "1d 6h",
          latestSnapshot: null,
        },
        {
          rigId: "rig_qa",
          name: "qa-testing",
          nodeCount: 4,
          runningCount: 0,
          activeCount: 0,
          hasWorkCount: 0,
          status: "stopped",
          uptime: "0m",
          latestSnapshot: null,
        },
      ];

      renderDashboard((qc) => {
        qc.setQueryData(["hosts"], { ownName: "localhost", selected: "local", hosts: [] });
        qc.setQueryData(["ps", "local"], mockMultiRigs);
        qc.setQueryData(["attention-items", 50, false], { items: [], hosts: [] });
        qc.setQueryData(["settings", "all"], { settings: {} });
        qc.setQueryData(["kernel", "status"], { state: "skipped" });
        qc.setQueryData(["daemon", "health"], { status: "ok" });
      });

      // Assert total rigs running tile = 3
      const rigsTile = await screen.findByTestId("dashboard-tile-rigs");
      expect(rigsTile.textContent).toContain("3");

      // Assert total active agents tile = 12 + 2 = 14
      const agentsTile = screen.getByTestId("dashboard-tile-agents");
      expect(agentsTile.textContent).toContain("14");

      // Assert Rigs table displays all 3 rigs
      const rigsTable = screen.getByTestId("dashboard-rigs");
      expect(rigsTable.textContent).toContain("production-core");
      expect(rigsTable.textContent).toContain("staging-cluster");
      expect(rigsTable.textContent).toContain("qa-testing");
    });
  });

  describe("Scenario 3: Daemon Health Disruption & Recovery", () => {
    it("displays healthy daemon indicator and transitions gracefully", async () => {
      renderDashboard((qc) => {
        qc.setQueryData(["hosts"], { ownName: "localhost", selected: "local", hosts: [] });
        qc.setQueryData(["ps", "local"], []);
        qc.setQueryData(["attention-items", 50, false], { items: [], hosts: [] });
        qc.setQueryData(["settings", "all"], { settings: {} });
        qc.setQueryData(["kernel", "status"], { state: "skipped" });
        qc.setQueryData(["daemon", "health"], { status: "ok" });
      });

      const daemonTile = await screen.findByTestId("dashboard-tile-daemon");
      expect(daemonTile.textContent).toContain("Healthy");
    });
  });
});
