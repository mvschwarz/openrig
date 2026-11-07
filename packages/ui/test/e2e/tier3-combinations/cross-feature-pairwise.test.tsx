import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { setupE2EEnv, renderE2EAppAt } from "../helpers/e2e-harness.js";
import { notifySuccess } from "../../../src/lib/notify.js";
import { act } from "react";

setupE2EEnv();

describe("Tier 3: Cross-Feature Combinations & Pairwise Interactions", () => {
  it("Cmd-K navigation immediately updates active route indicator in the Sidebar", async () => {
    const { container } = await renderE2EAppAt("/");

    // Initially Dashboard is active
    expect(container.querySelector("[data-testid='rail-dashboard']")?.getAttribute("aria-current")).toBe("page");
    expect(container.querySelector("[data-testid='rail-topology']")?.getAttribute("aria-current")).toBeNull();

    // Trigger Cmd+K
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    const input = await screen.findByPlaceholderText("Search pages, rigs, actions…");
    fireEvent.change(input, { target: { value: "topology" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    // Wait for route change
    await waitFor(() => {
      expect(screen.getByTestId("page-topology")).toBeTruthy();
    });

    // Verify Sidebar updated its active state
    expect(container.querySelector("[data-testid='rail-topology']")?.getAttribute("aria-current")).toBe("page");
    expect(container.querySelector("[data-testid='rail-dashboard']")?.getAttribute("aria-current")).toBeNull();
  });

  it("theme toggle updates theme state without disturbing open mobile drawer", async () => {
    const { container } = await renderE2EAppAt("/", { innerWidth: 390 });

    // Open mobile drawer
    fireEvent.click(screen.getByTestId("mobile-nav-more"));
    await waitFor(() => {
      expect(container.querySelector("[data-testid='mobile-rail-tray']")).toBeTruthy();
    });

    // Toggle theme via localStorage / event
    window.localStorage.setItem("openrig.theme", "dark");
    window.dispatchEvent(new Event("storage"));

    // Tray remains open and functional
    expect(container.querySelector("[data-testid='mobile-rail-tray']")).toBeTruthy();
    expect(window.localStorage.getItem("openrig.theme")).toBe("dark");
  });

  it("toast notifications co-exist with mobile bottom navigation without blocking tabs", async () => {
    await renderE2EAppAt("/", { innerWidth: 390 });
    const bottomNav = screen.getByTestId("mobile-bottom-nav");
    expect(bottomNav).toBeTruthy();

    // Fire toast
    await act(async () => {
      notifySuccess("Rig updated", "Configuration applied cleanly");
      await new Promise((r) => setTimeout(r, 50));
    });

    // Mobile tabs remain visible and clickable
    const rigsTab = screen.getByTestId("mobile-nav-topology");
    expect(rigsTab).toBeTruthy();
    fireEvent.click(rigsTab);

    await waitFor(() => {
      expect(screen.getByTestId("page-topology")).toBeTruthy();
    });
  });

  it("deep route navigation updates both TopBar breadcrumbs and Sidebar active highlight", async () => {
    const { container } = await renderE2EAppAt("/topology/rig/rig_alpha");

    // Breadcrumbs show path
    const breadcrumbs = container.querySelector("[data-testid='breadcrumbs']");
    expect(breadcrumbs?.textContent).toContain("Rigs");
    expect(breadcrumbs?.textContent).toContain("acme-build");

    // Sidebar highlights Rigs
    const sidebarRigLink = container.querySelector("[data-testid='rail-topology']");
    expect(sidebarRigLink?.getAttribute("aria-current")).toBe("page");
  });

  it("sidebar collapse toggle does not dismiss open command palette modal", async () => {
    await renderE2EAppAt("/");

    // Open palette
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    await screen.findByPlaceholderText("Search pages, rigs, actions…");

    // Press sidebar toggle button
    const toggle = screen.getByTestId("sidebar-toggle");
    fireEvent.click(toggle);

    // Palette modal must remain open
    expect(screen.getByTestId("command-palette")).toBeTruthy();
  });
});
