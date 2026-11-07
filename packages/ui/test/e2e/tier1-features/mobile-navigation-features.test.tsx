import { describe, it, expect } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { setupE2EEnv, renderE2EAppAt, MOCK_ATTENTION_ITEMS } from "../helpers/e2e-harness.js";

setupE2EEnv();

describe("Tier 1 Feature Coverage: Mobile Navigation Drawer & Bottom Bar", () => {
  it("renders MobileBottomNav and hides desktop sidebar on viewports < 1024px", async () => {
    const { container } = await renderE2EAppAt("/", { innerWidth: 390 });
    const bottomNav = screen.getByTestId("mobile-bottom-nav");
    expect(bottomNav).toBeTruthy();
    expect(bottomNav.getAttribute("aria-label")).toBe("Mobile bottom navigation");

    // The desktop sidebar is hidden via CSS breakpoint wrapper (.hidden)
    const desktopRail = container.querySelector("[data-testid='app-rail']");
    expect(desktopRail?.closest(".hidden")).toBeTruthy();
  });

  it("renders 4 primary destination tabs with proper hrefs and active indicator", async () => {
    await renderE2EAppAt("/for-you", { innerWidth: 390 });
    const inboxTab = screen.getByTestId("mobile-nav-for-you");
    expect(inboxTab).toBeTruthy();
    expect(inboxTab.getAttribute("aria-current")).toBe("page");

    expect(screen.getByTestId("mobile-nav-dashboard")).toBeTruthy();
    expect(screen.getByTestId("mobile-nav-topology")).toBeTruthy();
    expect(screen.getByTestId("mobile-nav-project")).toBeTruthy();
  });

  it("displays badge count on mobile Inbox tab when attention items exist", async () => {
    await renderE2EAppAt("/", { innerWidth: 390 });
    const inboxTab = screen.getByTestId("mobile-nav-for-you");
    await waitFor(() => {
      expect(inboxTab.textContent).toContain(String(MOCK_ATTENTION_ITEMS.length));
    });
  });

  it("clicking More button opens the mobile drawer slide-over tray", async () => {
    const { container } = await renderE2EAppAt("/", { innerWidth: 390 });
    const moreBtn = screen.getByTestId("mobile-nav-more");
    fireEvent.click(moreBtn);

    await waitFor(() => {
      const tray = container.querySelector("[data-testid='mobile-rail-tray']");
      expect(tray).toBeTruthy();
    });
  });

  it("clicking mobile drawer backdrop dismisses the drawer", async () => {
    const { container } = await renderE2EAppAt("/", { innerWidth: 390 });
    fireEvent.click(screen.getByTestId("mobile-nav-more"));

    const backdrop = await waitFor(() => {
      const el = container.querySelector("[data-testid='mobile-drawer-backdrop']");
      if (!el) throw new Error("no backdrop");
      return el;
    });

    fireEvent.click(backdrop);

    await waitFor(() => {
      const tray = container.querySelector("[data-testid='mobile-rail-tray']");
      expect(tray?.getAttribute("inert")).toBe("");
    });
  });
});
