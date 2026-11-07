import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { setupE2EEnv, renderE2EAppAt, MOCK_ATTENTION_ITEMS } from "../helpers/e2e-harness.js";
import { SIDEBAR_MODE_STORAGE_KEY } from "../../../src/lib/sidebar-mode.js";

setupE2EEnv();

describe("Tier 1 Feature Coverage: Labeled Sidebar Navigation", () => {
  it("renders primary labeled sections and distinct nav items", async () => {
    const { container } = await renderE2EAppAt("/");
    const sidebar = container.querySelector("[data-testid='app-rail']");
    expect(sidebar).toBeTruthy();
    expect(sidebar?.getAttribute("aria-label")).toBe("Primary navigation");

    // Core navigation buttons
    expect(screen.getByTestId("rail-dashboard")).toBeTruthy();
    expect(screen.getByTestId("rail-for-you")).toBeTruthy();
    expect(screen.getByTestId("rail-topology")).toBeTruthy();
    expect(screen.getByTestId("rail-agents")).toBeTruthy();
    expect(screen.getByTestId("rail-fleet")).toBeTruthy();
    expect(screen.getByTestId("rail-project")).toBeTruthy();
    expect(screen.getByTestId("rail-workflows")).toBeTruthy();
    expect(screen.getByTestId("rail-files")).toBeTruthy();
    expect(screen.getByTestId("rail-specs")).toBeTruthy();
    expect(screen.getByTestId("rail-settings")).toBeTruthy();
  });

  it("indicates active route with aria-current='page' and data-active='true'", async () => {
    const { container } = await renderE2EAppAt("/topology");
    const link = container.querySelector("[data-testid='rail-topology']");
    expect(link).toBeTruthy();
    expect(link?.getAttribute("aria-current")).toBe("page");
    expect(link?.getAttribute("data-active")).toBe("true");

    const inboxLink = container.querySelector("[data-testid='rail-for-you']");
    expect(inboxLink?.getAttribute("aria-current")).toBeNull();
  });

  it("expands and collapses via sidebar-toggle and persists state to localStorage", async () => {
    const { container } = await renderE2EAppAt("/");
    const nav = () => container.querySelector("[data-testid='app-rail']") as HTMLElement;
    expect(nav().getAttribute("data-collapsed")).toBe("false");

    const toggle = screen.getByTestId("sidebar-toggle");
    fireEvent.click(toggle);

    expect(nav().getAttribute("data-collapsed")).toBe("true");
    expect(window.localStorage.getItem(SIDEBAR_MODE_STORAGE_KEY)).toBe("collapsed");

    fireEvent.click(toggle);
    expect(nav().getAttribute("data-collapsed")).toBe("false");
    expect(window.localStorage.getItem(SIDEBAR_MODE_STORAGE_KEY)).toBe("expanded");
  });

  it("renders badge counter corresponding to pending attention items count", async () => {
    await renderE2EAppAt("/");
    const inboxItem = screen.getByTestId("rail-for-you");
    await waitFor(() => {
      expect(inboxItem.textContent).toContain(String(MOCK_ATTENTION_ITEMS.length));
    });
  });

  it("renders live rigs list in Fleet section with links and status dots", async () => {
    const { container } = await renderE2EAppAt("/");
    await waitFor(() => {
      const rigLink = container.querySelector("a[href*='/topology/rig/rig_alpha']");
      expect(rigLink).toBeTruthy();
      expect(rigLink?.textContent).toContain("acme-build");
    });
  });

  it("dispatches openrig:open-palette custom event when sidebar-search button is clicked", async () => {
    await renderE2EAppAt("/");
    const listener = vi.fn();
    window.addEventListener("openrig:open-palette", listener);

    const searchBtn = screen.getByTestId("sidebar-search");
    fireEvent.click(searchBtn);

    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener("openrig:open-palette", listener);
  });
});
