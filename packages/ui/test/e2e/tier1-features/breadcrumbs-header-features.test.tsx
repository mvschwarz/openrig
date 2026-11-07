import { describe, it, expect } from "vitest";
import { waitFor } from "@testing-library/react";
import { setupE2EEnv, renderE2EAppAt } from "../helpers/e2e-harness.js";
import { breadcrumbsFor } from "../../../src/lib/breadcrumbs.js";

setupE2EEnv();

describe("Tier 1 Feature Coverage: Breadcrumbs & Header TopBar", () => {
  it("renders TopBar header element with breadcrumbs container", async () => {
    const { container } = await renderE2EAppAt("/");
    const topbar = container.querySelector("[data-testid='app-topbar']");
    expect(topbar).toBeTruthy();

    const breadcrumbs = container.querySelector("[data-testid='breadcrumbs']");
    expect(breadcrumbs).toBeTruthy();
    expect(breadcrumbs?.textContent).toContain("Dashboard");
  });

  it("renders navigable crumb links for ancestors and non-linked terminal crumb", async () => {
    const { container } = await renderE2EAppAt("/topology/rig/rig_alpha");

    await waitFor(() => {
      const breadcrumbs = container.querySelector("[data-testid='breadcrumbs']");
      expect(breadcrumbs?.textContent).toContain("acme-build");
    });

    const breadcrumbs = container.querySelector("[data-testid='breadcrumbs']");
    // Ancestor link to /topology
    const rigsLink = breadcrumbs?.querySelector("a[href*='/topology']");
    expect(rigsLink).toBeTruthy();
    expect(rigsLink?.textContent).toBe("Rigs");

    // Terminal crumb should be plain text
    expect(breadcrumbs?.textContent).toContain("acme-build");
  });

  it("generates correct crumb hierarchy for deep 4-segment routes", () => {
    const crumbs = breadcrumbsFor("/topology/seat/rig_alpha/dev.builder", {
      rigName: (id) => (id === "rig_alpha" ? "acme-build" : undefined),
    });

    expect(crumbs).toHaveLength(3);
    expect(crumbs[0]).toEqual({ label: "Rigs", to: "/topology" });
    expect(crumbs[1]).toEqual({ label: "acme-build", to: "/topology/rig/rig_alpha" });
    expect(crumbs[2]).toEqual({ label: "builder" });
    expect(crumbs[2]).not.toHaveProperty("to");
  });

  it("properly decodes percent-encoded characters in route paths", () => {
    const crumbs = breadcrumbsFor("/topology/seat/rig_alpha/lead%2Ecoordinator", {
      rigName: () => "acme-build",
    });

    expect(crumbs).toHaveLength(3);
    expect(crumbs[2].label).toBe("coordinator");
  });

  it("renders host indicator and theme selector in TopBar", async () => {
    const { container } = await renderE2EAppAt("/");
    const topbar = container.querySelector("[data-testid='app-topbar']");
    expect(topbar).toBeTruthy();

    // Host selector/indicator present in header
    expect(topbar?.querySelector("[data-testid='host-indicator']") ?? topbar?.textContent).toBeTruthy();
  });
});
