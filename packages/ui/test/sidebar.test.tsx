// ui-redesign C06: sidebar shell tests.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { setupAppShellTestEnv, renderAppShellAt } from "./helpers/app-shell-env.js";
import { AppShell } from "../src/components/AppShell.js";
import { SIDEBAR_MODE_STORAGE_KEY } from "../src/lib/sidebar-mode.js";
import { SidebarSection } from "../src/components/shell/SidebarSection.js";

setupAppShellTestEnv();

const renderAt = (initialPath: string, opts: { innerWidth?: number } = {}) =>
  renderAppShellAt(AppShell, initialPath, opts);

const ALL_SIDEBAR_TESTIDS = [
  "rail-dashboard",
  "rail-for-you",
  "rail-topology",
  "rail-agents",
  "rail-fleet",
  "rail-project",
  "rail-workflows",
  "rail-files",
  "rail-specs",
  "rail-settings",
  "rail-advisor",
  "rail-operator",
];

describe("Sidebar shell (C06)", () => {
  it("renders all 12 sidebar nav testids at /", async () => {
    const { container } = await renderAt("/");
    for (const id of ALL_SIDEBAR_TESTIDS) {
      expect(container.querySelector(`[data-testid='${id}']`), id).toBeTruthy();
    }
  });

  it("shows visible labels Inbox, Rigs, Projects, Library", async () => {
    const { container } = await renderAt("/");
    const sidebar = container.querySelector("[data-testid='app-rail']") as HTMLElement;
    for (const label of ["Inbox", "Rigs", "Projects", "Library"]) {
      const matches = Array.from(sidebar.querySelectorAll("span")).filter(
        (el) => el.textContent === label && !el.classList.contains("sr-only"),
      );
      expect(matches.length, label).toBeGreaterThan(0);
    }
  });

  it("auto-collapses at /topology with explorer (data-collapsed=true)", async () => {
    const { container } = await renderAt("/topology");
    const nav = container.querySelector("[data-testid='app-rail']") as HTMLElement;
    expect(nav.getAttribute("data-collapsed")).toBe("true");
  });

  it("is expanded at / with no explorer (data-collapsed=false)", async () => {
    const { container } = await renderAt("/");
    const nav = container.querySelector("[data-testid='app-rail']") as HTMLElement;
    expect(nav.getAttribute("data-collapsed")).toBe("false");
  });

  it("sidebar-toggle flips data-collapsed and persists openrig.sidebar.mode", async () => {
    const { container } = await renderAt("/");
    const nav = () => container.querySelector("[data-testid='app-rail']") as HTMLElement;
    expect(nav().getAttribute("data-collapsed")).toBe("false");
    fireEvent.click(screen.getByTestId("sidebar-toggle"));
    expect(nav().getAttribute("data-collapsed")).toBe("true");
    expect(window.localStorage.getItem(SIDEBAR_MODE_STORAGE_KEY)).toBe("collapsed");
    fireEvent.click(screen.getByTestId("sidebar-toggle"));
    expect(nav().getAttribute("data-collapsed")).toBe("false");
    expect(window.localStorage.getItem(SIDEBAR_MODE_STORAGE_KEY)).toBe("expanded");
  });

  it("rail-topology has aria-current=page at /topology/rig/x", async () => {
    const { container } = await renderAt("/topology/rig/rig_alpha");
    const link = container.querySelector("[data-testid='rail-topology']") as HTMLElement;
    expect(link.getAttribute("aria-current")).toBe("page");
  });

  it("sidebar-search click dispatches openrig:open-palette", async () => {
    await renderAt("/");
    const spy = vi.fn();
    window.addEventListener("openrig:open-palette", spy);
    fireEvent.click(screen.getByTestId("sidebar-search"));
    expect(spy).toHaveBeenCalledTimes(1);
    window.removeEventListener("openrig:open-palette", spy);
  });

  // F9 (#2417): folding two sections keeps both folded (no stale-state clobber).
  it("folding one section preserves other sections' folded state", () => {
    window.localStorage.clear();
    const { unmount } = render(
      <>
        <SidebarSection id="fleet" label="Fleet" collapsed={false}>
          <span>fleet-body</span>
        </SidebarSection>
        <SidebarSection id="work" label="Work" collapsed={false}>
          <span>work-body</span>
        </SidebarSection>
      </>,
    );
    fireEvent.click(screen.getByLabelText("Collapse Fleet section"));
    fireEvent.click(screen.getByLabelText("Collapse Work section"));
    unmount();
    cleanup();

    // Reload: both sections re-read from storage.
    render(
      <>
        <SidebarSection id="fleet" label="Fleet" collapsed={false}>
          <span>fleet-body</span>
        </SidebarSection>
        <SidebarSection id="work" label="Work" collapsed={false}>
          <span>work-body</span>
        </SidebarSection>
      </>,
    );
    expect(screen.getByLabelText("Expand Fleet section")).toBeTruthy();
    expect(screen.getByLabelText("Expand Work section")).toBeTruthy();
    cleanup();
  });
});
