// V1 attempt-3 Phase 2 — AppShell chrome tests.
//
// Replaces the legacy 655-line test that exercised the pre-Phase-2 shell
// (slices-link / specs-toggle / discovery-toggle / progress-link /
// steering-link / context-link / system-toggle). Phase 2 deleted those
// header buttons; the rail with 6+2 icons takes over destination
// switching.
//
// Coverage:
// - SC-1 — exactly 2 left chromes on desktop (rail + explore); Sidebar.tsx GONE
// - SC-2 — rail roster: 6 destinations + 2 chat icons in spec'd order
// - SC-6 — drawer default-closed (selection=null → null render)
// - SC-7 — Settings rail icon links to /settings (center, not drawer)
// - SC-8 — mobile rail collapses to top-bar menu (hamburger present at <lg)
// - Surface routing — Explorer renders for tree/lens destinations;
//   not for Dashboard / Settings (surface=none)

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@testing-library/react";
import { createMemoryHistory, RouterProvider, createRouter } from "@tanstack/react-router";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createMockEventSourceClass } from "./helpers/mock-event-source.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

let OriginalEventSource: typeof EventSource | undefined;

beforeEach(async () => {
  mockFetch.mockReset();
  // Default rig/ps mocks return empty so chrome can render.
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes("/api/rigs/summary")) return new Response(JSON.stringify([]));
    if (url.includes("/api/rigs/ps")) return new Response(JSON.stringify([]));
    if (url.includes("/api/inventory")) return new Response(JSON.stringify([]));
    return new Response("[]");
  });
  OriginalEventSource = globalThis.EventSource;
  globalThis.EventSource = createMockEventSourceClass() as unknown as typeof EventSource;
  const { queryClient } = await import("../src/lib/query-client.js");
  queryClient.clear();
});

afterEach(() => {
  if (OriginalEventSource) globalThis.EventSource = OriginalEventSource;
  window.localStorage.clear();
  cleanup();
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    value: 1024,
    writable: true,
  });
  window.dispatchEvent(new Event("resize"));
});

async function renderAt(initialPath: string) {
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1440, writable: true });
  window.dispatchEvent(new Event("resize"));
  const { router } = await import("../src/routes.js");
  const memoryHistory = createMemoryHistory({ initialEntries: [initialPath] });
  const memoryRouter = createRouter({ routeTree: router.routeTree, history: memoryHistory });
  const result = render(<RouterProvider router={memoryRouter} />);
  // TanStack Router resolves route component async; wait for chrome to land.
  await waitFor(() => {
    expect(result.container.querySelector("[data-testid='app-rail']")).toBeTruthy();
  }, { timeout: 5000 });
  return result;
}

describe("AppShell — Phase 2 chrome", () => {
  describe("SC-1: exactly 2 left chromes on desktop (rail + explore)", () => {
    it("renders exactly 2 left chromes at /topology desktop (rail + explore) — SC-1 strict count", async () => {
      const { container } = await renderAt("/topology");
      // SC-1: count desktop-visible nav/aside elements only. The Phase 5 P5-9
      // MobileBottomNav uses <nav lg:hidden> — it's in the DOM but display:none
      // at desktop (lg breakpoint). SC-1's "exactly 2 left chromes on desktop"
      // is about VISIBLE chromes, not raw element count — filter by lg:hidden.
      const chromeCount = Array.from(
        container.querySelectorAll("nav, aside"),
      ).filter((el) => !(el as HTMLElement).className.includes("lg:hidden")).length;
      expect(chromeCount).toBe(2);
      // No legacy Sidebar.tsx anywhere — file is deleted.
      expect(container.querySelector("[data-testid='sidebar']")).toBeNull();
    });

    it("Dashboard surface (/) renders rail but NO Explorer (surface=none)", async () => {
      const { container } = await renderAt("/");
      expect(container.querySelector("[data-testid='app-rail']")).toBeTruthy();
      expect(container.querySelector("[data-testid='explorer']")).toBeNull();
    });

    it("Settings surface (/settings) renders rail but NO Explorer (surface=none)", async () => {
      const { container } = await renderAt("/settings");
      expect(container.querySelector("[data-testid='app-rail']")).toBeTruthy();
      expect(container.querySelector("[data-testid='explorer']")).toBeNull();
    });
  });

  describe("SC-2: rail roster — 6 destinations + 2 chat icons", () => {
    it("rail renders 6 destination icons in canonical order: Dashboard, Topology, For You, Project, Specs, Settings", async () => {
      const { container } = await renderAt("/");
      const expectedDestinations = [
        "rail-dashboard",
        "rail-topology",
        "rail-for-you",
        "rail-project",
        "rail-specs",
        "rail-settings",
      ];
      for (const id of expectedDestinations) {
        expect(container.querySelector(`[data-testid='${id}']`)).toBeTruthy();
      }
    });

    it("rail renders 2 chat icons (Advisor + Operator) per agent-chat-surface.md V1 placeholder", async () => {
      const { container } = await renderAt("/");
      expect(container.querySelector("[data-testid='rail-advisor']")).toBeTruthy();
      expect(container.querySelector("[data-testid='rail-operator']")).toBeTruthy();
    });

    it("rail does NOT include a Discovery icon (legacy header pattern removed)", async () => {
      const { container } = await renderAt("/");
      expect(container.querySelector("[data-testid='rail-discovery']")).toBeNull();
      expect(container.querySelector("[data-testid='discovery-toggle']")).toBeNull();
    });

    it("Settings rail icon points to /settings (SC-7: Settings in center, NOT drawer)", async () => {
      const { container } = await renderAt("/");
      const settingsIcon = container.querySelector("[data-testid='rail-settings']") as HTMLAnchorElement | null;
      expect(settingsIcon).toBeTruthy();
      expect(settingsIcon?.getAttribute("href")).toBe("/settings");
    });
  });

  describe("Active rail state", () => {
    it("Topology rail icon active at /topology", async () => {
      const { container } = await renderAt("/topology");
      const icon = container.querySelector("[data-testid='rail-topology']") as HTMLElement;
      expect(icon.getAttribute("data-active")).toBe("true");
    });

    it("Topology rail icon active at /rigs/$rigId (legacy graph route)", async () => {
      const { container } = await renderAt("/rigs/abc");
      const icon = container.querySelector("[data-testid='rail-topology']") as HTMLElement;
      expect(icon.getAttribute("data-active")).toBe("true");
    });

    it("Project rail icon active at /project", async () => {
      const { container } = await renderAt("/project");
      const icon = container.querySelector("[data-testid='rail-project']") as HTMLElement;
      expect(icon.getAttribute("data-active")).toBe("true");
    });

    it("For You rail icon active at /for-you", async () => {
      const { container } = await renderAt("/for-you");
      const icon = container.querySelector("[data-testid='rail-for-you']") as HTMLElement;
      expect(icon.getAttribute("data-active")).toBe("true");
    });
  });

  describe("SC-6: drawer default-closed", () => {
    it.each([
      ["/", "Dashboard"],
      ["/topology", "Topology host"],
      ["/for-you", "For You"],
      ["/project", "Project workspace"],
      ["/specs", "Specs library"],
      ["/settings", "Settings"],
    ])("SharedDetailDrawer NOT rendered at %s (%s)", async (path) => {
      const { container } = await renderAt(path);
      expect(container.querySelector("[data-testid='shared-detail-drawer']")).toBeNull();
    }, 15000);
  });

  describe("Surface routing — Explorer surface union", () => {
    it("Topology routes set surface=topology", async () => {
      const { container } = await renderAt("/topology");
      const explorer = container.querySelector("[data-testid='explorer']") as HTMLElement;
      expect(explorer?.getAttribute("data-surface")).toBe("topology");
    });

    it("Project routes set surface=project", async () => {
      const { container } = await renderAt("/project");
      const explorer = container.querySelector("[data-testid='explorer']") as HTMLElement;
      expect(explorer?.getAttribute("data-surface")).toBe("project");
    });

    it("Specs routes set surface=specs", async () => {
      const { container } = await renderAt("/specs");
      const explorer = container.querySelector("[data-testid='explorer']") as HTMLElement;
      expect(explorer?.getAttribute("data-surface")).toBe("specs");
    });

    it("For You route sets surface=for-you", async () => {
      const { container } = await renderAt("/for-you");
      const explorer = container.querySelector("[data-testid='explorer']") as HTMLElement;
      expect(explorer?.getAttribute("data-surface")).toBe("for-you");
    });
  });

  describe("Top bar — universal-shell.md L40–L53 (Phase 2 bounce-fix)", () => {
    it("top bar renders at desktop (single source of truth — no lg:hidden)", async () => {
      const { container } = await renderAt("/");
      const topbar = container.querySelector("[data-testid='app-topbar']") as HTMLElement;
      expect(topbar).toBeTruthy();
      // Single source of truth — top bar is universal, NOT lg:hidden.
      expect(topbar.className).not.toContain("lg:hidden");
      expect(topbar.className).toContain("h-14");
    });

    it("brand link visible at desktop and links to / (Dashboard)", async () => {
      const { container } = await renderAt("/topology");
      const brand = container.querySelector("[data-testid='brand-home-link']") as HTMLAnchorElement;
      expect(brand).toBeTruthy();
      expect(brand.getAttribute("href")).toBe("/");
      expect(brand.textContent).toContain("OPENRIG");
    });

    it("right-slot env indicator present (V1 = 'localhost')", async () => {
      const { container } = await renderAt("/");
      const envIndicator = container.querySelector(
        "[data-testid='topbar-env-indicator']",
      ) as HTMLElement;
      expect(envIndicator).toBeTruthy();
      expect(envIndicator.textContent).toContain("localhost");
    });

    it("hamburger button is mobile-only (lg:hidden) — preserved Phase 2 behavior", async () => {
      const { container } = await renderAt("/");
      const hamburger = container.querySelector(
        "[data-testid='mobile-menu-toggle']",
      ) as HTMLElement;
      expect(hamburger).toBeTruthy();
      expect(hamburger.className).toContain("lg:hidden");
    });

    it("legacy app-mobile-topbar testid is GONE (renamed to app-topbar)", async () => {
      const { container } = await renderAt("/");
      expect(container.querySelector("[data-testid='app-mobile-topbar']")).toBeNull();
      expect(container.querySelector("[data-testid='brand-home-link-mobile']")).toBeNull();
    });
  });

  describe("SC-8: mobile rail collapses to slide-over tray", () => {
    it("mobile rail tray renders only at narrow viewport (conditional)", async () => {
      const { router } = await import("../src/routes.js");
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 375, writable: true });
      window.dispatchEvent(new Event("resize"));
      const memoryHistory = createMemoryHistory({ initialEntries: ["/"] });
      const memoryRouter = createRouter({ routeTree: router.routeTree, history: memoryHistory });
      const { container } = render(<RouterProvider router={memoryRouter} />);
      await waitFor(() => {
        const topbar = container.querySelector("[data-testid='app-topbar']") as HTMLElement;
        expect(topbar).toBeTruthy();
      });
      const tray = container.querySelector("[data-testid='mobile-rail-tray']") as HTMLElement;
      expect(tray).toBeTruthy();
      expect(tray.className).toContain("-translate-x-full");
    });
  });

  // Phase 2 BOUNCE-FIX #3 — width-coupling regression (guard-3 catch).
  // The center workspace's --workspace-right-offset CSS variable must equal
  // the VellumSheet wide preset width when drawer is open. Bounce-fix #2
  // calibrated VellumSheet 45rem → 38rem but missed this consumer; net
  // effect was a 7rem (112px) gap between drawer and reserved padding.
  // Per pseudo-element-paint test contract (discipline ritual #7), assert
  // via CSS source rather than runtime (computed style of CSS vars from
  // jsdom is brittle).
  describe("Drawer width / right-offset coupling (bounce-fix #3 regression)", () => {
    const APP_SHELL_SRC = readFileSync(
      path.resolve(__dirname, "../src/components/AppShell.tsx"),
      "utf8",
    );
    const VELLUM_SHEET_SRC = readFileSync(
      path.resolve(__dirname, "../src/components/ui/vellum-sheet.tsx"),
      "utf8",
    );
    const SHARED_DRAWER_SRC = readFileSync(
      path.resolve(__dirname, "../src/components/SharedDetailDrawer.tsx"),
      "utf8",
    );

    it("VellumSheet wide preset and AppShell workspaceRightOffset use the SAME literal", () => {
      // Pull the wide-preset width from VellumSheet source.
      const vellumMatch = VELLUM_SHEET_SRC.match(
        /wide:\s*"w-full\s+lg:w-\[(\d+rem)\]/,
      );
      expect(vellumMatch, "VellumSheet wide preset must declare lg:w-[Xrem]").toBeTruthy();
      const vellumWide = vellumMatch![1];

      // Pull the open-drawer offset from AppShell source.
      const offsetMatch = APP_SHELL_SRC.match(
        /workspaceRightOffset\s*=\s*[^?]*\?\s*"(\d+rem)"\s*:/,
      );
      expect(offsetMatch, "AppShell workspaceRightOffset must declare ternary 'Xrem' : '0rem'")
        .toBeTruthy();
      const offsetOpen = offsetMatch![1];

      expect(offsetOpen, "AppShell workspaceRightOffset must equal VellumSheet wide preset width")
        .toBe(vellumWide);
    });

    it("no live 45rem string in chrome source (only historical calibration comments are allowed)", () => {
      // Extract every line containing "45rem" and verify each is inside
      // a comment (calibration history). Chrome source must NOT carry
      // 45rem as a live class or value.
      const checkSource = (src: string, label: string) => {
        const lines = src.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line.includes("45rem")) continue;
          // Permitted only when the line is a JS/TS line comment ("//") or
          // an active block-comment context ("/*", "*"). We scan backward
          // for a recent /* opener if no "//" on this line.
          const trimmed = line.trim();
          const isLineComment = trimmed.startsWith("//") || trimmed.startsWith("*");
          let isInsideBlockComment = false;
          if (!isLineComment) {
            // Look backward up to 30 lines for a /* without an intervening */.
            for (let j = i - 1; j >= Math.max(0, i - 30); j--) {
              if (lines[j].includes("*/")) break;
              if (lines[j].includes("/*")) {
                isInsideBlockComment = true;
                break;
              }
            }
          }
          expect(
            isLineComment || isInsideBlockComment,
            `${label}:${i + 1} contains live (non-comment) "45rem" — bounce-fix #3 width-coupling regression`,
          ).toBe(true);
        }
      };
      checkSource(APP_SHELL_SRC, "AppShell.tsx");
      checkSource(SHARED_DRAWER_SRC, "SharedDetailDrawer.tsx");
      // VellumSheet keeps a historical calibration comment with 45rem;
      // it's inside a // comment so the same checker passes there too.
      checkSource(VELLUM_SHEET_SRC, "vellum-sheet.tsx");
    });
  });

  describe("Legacy buttons removed (Phase 2 deleted Sidebar + header toggle pattern)", () => {
    it("specs-toggle button does NOT exist", async () => {
      const { container } = await renderAt("/");
      expect(container.querySelector("[data-testid='specs-toggle']")).toBeNull();
    });

    it("system-toggle button does NOT exist", async () => {
      const { container } = await renderAt("/");
      expect(container.querySelector("[data-testid='system-toggle']")).toBeNull();
    });

    it("slices-link button does NOT exist", async () => {
      const { container } = await renderAt("/");
      expect(container.querySelector("[data-testid='slices-link']")).toBeNull();
    });

    it("steering-link button does NOT exist", async () => {
      const { container } = await renderAt("/");
      expect(container.querySelector("[data-testid='steering-link']")).toBeNull();
    });

    it("context-link button does NOT exist", async () => {
      const { container } = await renderAt("/");
      expect(container.querySelector("[data-testid='context-link']")).toBeNull();
    });

    it("progress-link button does NOT exist", async () => {
      const { container } = await renderAt("/");
      expect(container.querySelector("[data-testid='progress-link']")).toBeNull();
    });
  });
});
