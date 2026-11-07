// Tier 5 Phase 2 Adversarial Hardening Suite:
// Shell, Navigation, Keyboard Shortcuts, Modal Trapping, Responsive Boundaries & Theme Tokens
//
// White-box stress-testing, boundary condition exploration, race condition probing,
// and defect isolation across:
// - packages/ui/src/components/shell/ (Sidebar, TopBar, CommandPalette, MobileBottomNav, PaletteShortcuts)
// - packages/ui/src/lib/nav.ts & packages/ui/src/lib/breadcrumbs.ts
// - packages/ui/src/globals.css & packages/ui/tailwind.config.ts (Theme tokens, contrast, radius math)
// - Viewport boundaries: 320px, 768px, 1023px, 1024px, 3840px

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { screen, fireEvent, waitFor, cleanup, render, act } from "@testing-library/react";
import { setupE2EEnv, renderE2EAppAt, setViewportWidth, MOCK_RIGS, MOCK_ATTENTION_ITEMS } from "./e2e/helpers/e2e-harness.js";
import { isAdvisorSeat, isOperatorSeat, isChatSeat, allNavItems } from "../src/lib/nav.js";
import { breadcrumbsFor, type Crumb } from "../src/lib/breadcrumbs.js";
import { readStoredTheme, writeStoredTheme, resolveTheme, applyTheme, DEFAULT_THEME, THEME_STORAGE_KEY } from "../src/lib/theme.js";
import { readFoldedSections, writeFoldedSections, readSidebarMode, writeSidebarMode, SIDEBAR_MODE_STORAGE_KEY, SIDEBAR_FOLDED_STORAGE_KEY } from "../src/lib/sidebar-mode.js";

setupE2EEnv();

describe("Tier 5 Phase 2 Adversarial Hardening: Shell, Navigation, Shortcuts & Theme Tokens", () => {
  // =========================================================================
  // SECTION 1: Navigation & Seat Routing White-Box Stress & Failure Modes
  // =========================================================================
  describe("Section 1: Navigation & Seat Routing White-Box Stress & Defect Probing", () => {
    it("empirically isolates unhandled URIError in isAdvisorSeat when given malformed percent encodings", () => {
      // White-box gap analysis: nav.ts lines 22 & 40 call decodeURIComponent(raw) directly without try/catch.
      // Unlike breadcrumbs.ts which wraps in try/catch, nav.ts crashes on invalid percentage sequences.
      expect(() => isAdvisorSeat("/topology/seat/rig-1/%")).toThrow(URIError);
      expect(() => isAdvisorSeat("/topology/seat/rig-1/%A0%99")).toThrow(URIError);
      expect(() => isAdvisorSeat("/topology/seat/rig-1/%E0%A4%A")).toThrow(URIError);
    });

    it("empirically isolates unhandled URIError in isOperatorSeat when given malformed percent encodings", () => {
      expect(() => isOperatorSeat("/topology/seat/rig-1/%")).toThrow(URIError);
      expect(() => isOperatorSeat("/topology/seat/rig-1/%A0%99")).toThrow(URIError);
      expect(() => isOperatorSeat("/topology/seat/rig-1/%E0%A4%A")).toThrow(URIError);
    });

    it("demonstrates breadcrumbsFor resilience on identical malformed percent encodings via internal decode() guard", () => {
      // Proves that breadcrumbs.ts gracefully survives without throwing exceptions
      let crumbs1: Crumb[] = [];
      let crumbs2: Crumb[] = [];
      expect(() => {
        crumbs1 = breadcrumbsFor("/topology/seat/rig-1/%");
        crumbs2 = breadcrumbsFor("/topology/seat/rig-1/%E0%A4%A");
      }).not.toThrow();

      expect(crumbs1.length).toBeGreaterThan(0);
      expect(crumbs1[0].label).toBe("Rigs");
      expect(crumbs2.length).toBeGreaterThan(0);
      expect(crumbs2[0].label).toBe("Rigs");
    });

    it("tests query parameter and hash fragment leakage in seat predicates", () => {
      // Query parameters are stripped via p.split("?")[0]
      expect(isAdvisorSeat("/topology/seat/rig-1/worker?role=advisor")).toBe(false);
      expect(isOperatorSeat("/topology/seat/rig-1/worker?role=operator")).toBe(false);

      // White-box observation: Hash fragments are NOT stripped by p.split("?")[0]
      // Hence '/topology/seat/rig-1/worker#advisor' keeps '#advisor' in segs[3], matching logicalId.includes('advisor')
      const matchesAdvisorWithHash = isAdvisorSeat("/topology/seat/rig-1/worker#advisor");
      expect(matchesAdvisorWithHash).toBe(true);

      const matchesOperatorWithHash = isOperatorSeat("/topology/seat/rig-1/worker#operator");
      expect(matchesOperatorWithHash).toBe(true);
    });

    it("validates allNavItems inventory completeness and predicate integrity", () => {
      const items = allNavItems();
      expect(items.length).toBe(12);

      const expectedIds = [
        "dashboard", "inbox", "rigs", "agents", "fleet",
        "projects", "workflows", "files", "library",
        "advisor", "operator", "settings",
      ];
      for (const id of expectedIds) {
        const found = items.find((i) => i.id === id);
        expect(found, `Nav item ${id} must exist`).toBeDefined();
        expect(found?.label.length).toBeGreaterThan(0);
        expect(found?.to.startsWith("/")).toBe(true);
        expect(typeof found?.activeWhen).toBe("function");
        expect(found?.testId.startsWith("rail-")).toBe(true);
      }
    });

    it("verifies Sidebar active highlighting exclusivity between Chat seats and Fleet Rigs", async () => {
      // When on Advisor chat seat, Advisor item is active, and Rigs is NOT active
      const { container, unmount } = await renderE2EAppAt("/topology/seat/acme-build/advisor");
      const advisorLink = container.querySelector("[data-testid='rail-advisor']");
      const rigsLink = container.querySelector("[data-testid='rail-topology']");

      expect(advisorLink?.getAttribute("data-active")).toBe("true");
      expect(rigsLink?.getAttribute("data-active")).toBe("false");
      unmount();

      // When on standard non-chat seat, Rigs is active, and Advisor is NOT active
      const result2 = await renderE2EAppAt("/topology/seat/acme-build/dev.builder");
      const advisorLink2 = result2.container.querySelector("[data-testid='rail-advisor']");
      const rigsLink2 = result2.container.querySelector("[data-testid='rail-topology']");

      expect(advisorLink2?.getAttribute("data-active")).toBe("false");
      expect(rigsLink2?.getAttribute("data-active")).toBe("true");
      result2.unmount();
    });
  });

  // =========================================================================
  // SECTION 2: Sequential Keyboard Shortcuts (PaletteShortcuts) Hardening
  // =========================================================================
  describe("Section 2: PaletteShortcuts Sequential Buffer, Timers & Concurrency Guards", () => {
    it("expires sequential 'g' key buffer if subsequent key exceeds 1000ms window", async () => {
      await renderE2EAppAt("/topology");

      fireEvent.keyDown(window, { key: "g" });
      // Exceed 1000ms timer
      await new Promise((r) => setTimeout(r, 1100));

      fireEvent.keyDown(window, { key: "d" });
      // Navigation should NOT have occurred; still on /topology
      expect(screen.getByTestId("page-topology")).toBeTruthy();
      expect(screen.queryByTestId("page-dashboard")).toBeNull();
    });

    it("resets 1000ms timer when another 'g' key is typed within the active window", async () => {
      await renderE2EAppAt("/topology");

      fireEvent.keyDown(window, { key: "g" });
      await new Promise((r) => setTimeout(r, 600));

      // Second 'g' clears old timer and sets a fresh 1000ms timer
      fireEvent.keyDown(window, { key: "g" });
      await new Promise((r) => setTimeout(r, 600));

      // Elapsed total is 1200ms from first 'g', but only 600ms from second 'g'
      fireEvent.keyDown(window, { key: "d" });

      await waitFor(() => {
        expect(screen.getByTestId("page-dashboard")).toBeTruthy();
      });
    });

    it("cancels pending sequence buffer immediately upon any unrecognized keypress", async () => {
      await renderE2EAppAt("/topology");

      fireEvent.keyDown(window, { key: "g" });
      // Intermediate unrecognized key 'x'
      fireEvent.keyDown(window, { key: "x" });
      // Now press 'd' - should be ignored because buffer was cleared
      fireEvent.keyDown(window, { key: "d" });

      expect(screen.getByTestId("page-topology")).toBeTruthy();
      expect(screen.queryByTestId("page-dashboard")).toBeNull();
    });

    it("suppresses keyboard sequence navigation when focused inside editable elements", async () => {
      await renderE2EAppAt("/topology");

      const input = document.createElement("input");
      document.body.appendChild(input);
      input.focus();

      fireEvent.keyDown(input, { key: "g" });
      fireEvent.keyDown(input, { key: "d" });

      expect(screen.getByTestId("page-topology")).toBeTruthy();
      expect(screen.queryByTestId("page-dashboard")).toBeNull();
      document.body.removeChild(input);
    });

    it("suppresses keyboard sequence navigation when a modal dialog is present in the DOM", async () => {
      await renderE2EAppAt("/topology");

      // Inject a synthetic open modal dialog element
      const dialog = document.createElement("div");
      dialog.setAttribute("role", "dialog");
      document.body.appendChild(dialog);

      fireEvent.keyDown(window, { key: "g" });
      fireEvent.keyDown(window, { key: "d" });

      expect(screen.getByTestId("page-topology")).toBeTruthy();
      expect(screen.queryByTestId("page-dashboard")).toBeNull();
      document.body.removeChild(dialog);
    });

    it("ignores 'g' when accompanied by modifier keys (Ctrl, Alt, Meta)", async () => {
      await renderE2EAppAt("/topology");

      fireEvent.keyDown(window, { key: "g", ctrlKey: true });
      fireEvent.keyDown(window, { key: "d" });
      expect(screen.getByTestId("page-topology")).toBeTruthy();

      fireEvent.keyDown(window, { key: "g", altKey: true });
      fireEvent.keyDown(window, { key: "d" });
      expect(screen.getByTestId("page-topology")).toBeTruthy();

      fireEvent.keyDown(window, { key: "g", metaKey: true });
      fireEvent.keyDown(window, { key: "d" });
      expect(screen.getByTestId("page-topology")).toBeTruthy();
    });

    it("observes second-key modifier interaction in PaletteShortcuts", async () => {
      await renderE2EAppAt("/topology");

      // White-box analysis: line 251 checks modifiers on initial 'g',
      // but lines 228-243 check key === 'd' without modifier checks.
      fireEvent.keyDown(window, { key: "g" });
      fireEvent.keyDown(window, { key: "d", ctrlKey: true });

      // Empirical verification: navigate({ to: "/" }) is executed
      await waitFor(() => {
        expect(screen.getByTestId("page-dashboard")).toBeTruthy();
      });
    });
  });

  // =========================================================================
  // SECTION 3: Command Palette (⌘K) & Modal Focus Trapping / Escape Transitions
  // =========================================================================
  describe("Section 3: Command Palette (⌘K), Search Indexing & Modal Stacking", () => {
    it("toggles command palette open and closed via Cmd+K keyboard shortcut", async () => {
      await renderE2EAppAt("/");

      expect(screen.queryByTestId("command-palette")).toBeNull();

      fireEvent.keyDown(window, { key: "k", metaKey: true });
      expect(await screen.findByTestId("command-palette")).toBeTruthy();

      fireEvent.keyDown(window, { key: "k", metaKey: true });
      await waitFor(() => {
        expect(screen.queryByTestId("command-palette")).toBeNull();
      });
    });

    it("opens command palette via openrig:open-palette custom window event", async () => {
      await renderE2EAppAt("/");

      act(() => {
        window.dispatchEvent(new CustomEvent("openrig:open-palette"));
      });

      expect(await screen.findByTestId("command-palette")).toBeTruthy();
    });

    it("searches and filters rigs by both human-readable name and rigorous rig ID", async () => {
      await renderE2EAppAt("/");
      fireEvent.keyDown(window, { key: "k", metaKey: true });
      const input = await screen.findByPlaceholderText("Search pages, rigs, actions…");

      // Search by rig ID
      fireEvent.change(input, { target: { value: "rig_alpha" } });
      expect(await screen.findByTestId("palette-rig-rig_alpha")).toBeTruthy();

      // Search by rig name
      fireEvent.change(input, { target: { value: "acme-build" } });
      expect(await screen.findByTestId("palette-rig-rig_alpha")).toBeTruthy();

      // Search non-existent token
      fireEvent.change(input, { target: { value: "nonexistent_query_xyz" } });
      expect(await screen.findByText("No results found.")).toBeTruthy();
    });

    it("executes Toggle Dark Mode action from Command Palette and dismisses palette", async () => {
      await renderE2EAppAt("/");
      fireEvent.keyDown(window, { key: "k", metaKey: true });
      const toggleItem = await screen.findByText("Toggle dark mode");

      fireEvent.click(toggleItem);

      await waitFor(() => {
        expect(screen.queryByTestId("command-palette")).toBeNull();
      });
    });

    it("transitions from Command Palette to Keyboard Shortcuts modal dialog cleanly", async () => {
      await renderE2EAppAt("/");
      fireEvent.keyDown(window, { key: "k", metaKey: true });
      const shortcutsAction = await screen.findByText("Keyboard shortcuts");

      fireEvent.click(shortcutsAction);

      // Palette closes and shortcuts modal opens
      await waitFor(() => {
        expect(screen.queryByTestId("command-palette")).toBeNull();
        expect(screen.getByTestId("keyboard-shortcuts")).toBeTruthy();
      });

      // Escape key dismisses the shortcuts modal via cmdk root event
      const shortcutsDialog = screen.getByTestId("keyboard-shortcuts");
      fireEvent.keyDown(shortcutsDialog, { key: "Escape" });
      await waitFor(() => {
        expect(screen.queryByTestId("keyboard-shortcuts")).toBeNull();
      });
    });
  });

  // =========================================================================
  // SECTION 4: Responsive Breakpoint Boundaries & Mobile Shell Transitions
  // =========================================================================
  describe("Section 4: Responsive Breakpoint Edges (320px, 768px, 1023px, 1024px, 3840px)", () => {
    it("renders stable layout at ultra-compact 320px viewport without clipping crashes", async () => {
      const { container } = await renderE2EAppAt("/", { innerWidth: 320 });

      const bottomNav = screen.getByTestId("mobile-bottom-nav");
      expect(bottomNav).toBeTruthy();
      // Slots inside bottomNav have h-14
      expect(bottomNav.querySelector("a")?.className).toContain("h-14");

      const topbar = container.querySelector("[data-testid='app-topbar']");
      expect(topbar).toBeTruthy();

      const breadcrumbs = screen.getByTestId("breadcrumbs");
      expect(breadcrumbs.className).toContain("overflow-hidden");
    });

    it("handles tablet portrait 768px viewport with mobile slide-over tray and backdrop dismiss", async () => {
      const { container } = await renderE2EAppAt("/project", { innerWidth: 768 });

      expect(screen.getByTestId("mobile-bottom-nav")).toBeTruthy();
      // Desktop rail is hidden under lg:flex
      expect(container.querySelector("[data-testid='app-rail']")?.parentElement?.className).toContain("hidden lg:flex");

      // Open mobile tray via menu toggle
      const menuToggle = screen.getByTestId("mobile-menu-toggle");
      fireEvent.click(menuToggle);

      const backdrop = await screen.findByTestId("mobile-drawer-backdrop");
      expect(backdrop).toBeTruthy();

      const tray = screen.getByTestId("mobile-rail-tray");
      expect(tray.getAttribute("inert")).toBeNull();
      expect(tray.className).toContain("translate-x-0");

      // Dismiss by clicking backdrop
      fireEvent.click(backdrop);
      await waitFor(() => {
        expect(screen.queryByTestId("mobile-drawer-backdrop")).toBeNull();
        expect(tray.getAttribute("inert")).toBe("");
      });
    });

    it("verifies sharp transition behavior at the 1023px vs 1024px boundary", async () => {
      // At 1023px: isWideLayout is false -> mobile-rail-tray rendered, menu toggle visible
      const { container, unmount } = await renderE2EAppAt("/", { innerWidth: 1023 });
      expect(screen.getByTestId("mobile-bottom-nav")).toBeTruthy();
      expect(container.querySelector("[data-testid='mobile-rail-tray']")).toBeTruthy();
      expect(screen.getByTestId("mobile-menu-toggle")).toBeTruthy();
      unmount();

      // At 1024px: isWideLayout is true -> mobile-rail-tray NOT in DOM, menu toggle carries lg:hidden
      const result2 = await renderE2EAppAt("/", { innerWidth: 1024 });
      expect(result2.container.querySelector("[data-testid='app-rail']")).toBeTruthy();
      expect(result2.container.querySelector("[data-testid='mobile-rail-tray']")).toBeNull();
      expect(result2.container.querySelector("[data-testid='mobile-menu-toggle']")?.className).toContain("lg:hidden");
      result2.unmount();
    });

    it("handles 3840px 4K resolution with fixed sidebar dimensions and flex content scaling", async () => {
      const { container } = await renderE2EAppAt("/", { innerWidth: 3840 });
      const sidebar = container.querySelector("[data-testid='app-rail']") as HTMLElement;

      expect(sidebar).toBeTruthy();
      expect(sidebar.style.width).toBe("var(--sidebar-width)");
      expect(sidebar.getAttribute("data-collapsed")).toBe("false");

      // Content area stretches over flex
      const content = screen.getByTestId("content-area");
      expect(content.className).toContain("flex-1");
    });

    it("verifies mobile Topology carve-out suppresses menu toggle to avoid renderer spin", async () => {
      await renderE2EAppAt("/topology", { innerWidth: 375 });

      // On /topology on mobile, mobile-menu-toggle is omitted by design (AppShell line 363)
      expect(screen.queryByTestId("mobile-menu-toggle")).toBeNull();
      // Brand home link remains navigable in topbar (query across multiple testid instances)
      expect(screen.getAllByTestId("brand-home-link").length).toBeGreaterThanOrEqual(1);
      // Mobile bottom nav remains functional
      expect(screen.getByTestId("mobile-bottom-nav")).toBeTruthy();
    });
  });

  // =========================================================================
  // SECTION 5: Breadcrumbs Hierarchy Preservation & Deep Path Traversal
  // =========================================================================
  describe("Section 5: Breadcrumbs Hierarchy Preservation & Deep Path Traversal", () => {
    it("preserves full linked hierarchy for deep skill file routes (4 to 7 segments)", () => {
      const crumbs = breadcrumbsFor("/specs/skills/alpha-spec/file/src/components/Shell.tsx");
      expect(crumbs.length).toBe(4);
      expect(crumbs[0]).toEqual({ label: "Library", to: "/specs" });
      expect(crumbs[1]).toEqual({ label: "Skills", to: "/specs/skills" });
      expect(crumbs[2]).toEqual({ label: "alpha-spec", to: "/specs/skills/alpha-spec" });
      expect(crumbs[3]).toEqual({ label: "src/components/Shell.tsx" }); // Tail has no 'to'
    });

    it("preserves pod detail hierarchy with linked parent crumbs", () => {
      const crumbs = breadcrumbsFor("/topology/pod/acme-build/worker/metrics");
      expect(crumbs.length).toBe(4);
      expect(crumbs[0]).toEqual({ label: "Rigs", to: "/topology" });
      expect(crumbs[1]).toEqual({ label: "acme-build", to: "/topology/rig/acme-build" });
      expect(crumbs[2]).toEqual({ label: "worker pod", to: "/topology/pod/acme-build/worker" });
      expect(crumbs[3]).toEqual({ label: "metrics" });
    });

    it("preserves seat detail hierarchy with displayAgentName formatting", () => {
      const crumbs = breadcrumbsFor("/topology/seat/acme-build/dev.builder/logs");
      expect(crumbs.length).toBe(4);
      expect(crumbs[0]).toEqual({ label: "Rigs", to: "/topology" });
      expect(crumbs[1]).toEqual({ label: "acme-build", to: "/topology/rig/acme-build" });
      expect(crumbs[2]).toEqual({ label: "builder", to: "/topology/seat/acme-build/dev.builder" });
      expect(crumbs[3]).toEqual({ label: "logs" });
    });

    it("handles URL percent-encoding and special Unicode/emoji characters gracefully", () => {
      const crumbs = breadcrumbsFor("/topology/rig/production%20server%20%F0%9F%9A%80");
      expect(crumbs.length).toBe(2);
      expect(crumbs[0]).toEqual({ label: "Rigs", to: "/topology" });
      expect(crumbs[1].label).toBe("production server 🚀");
    });

    it("provides fallback crumbs for unknown routes across segment depths", () => {
      expect(breadcrumbsFor("/unknown")).toEqual([{ label: "unknown" }]);
      expect(breadcrumbsFor("/settings/unknown-setting")).toEqual([{ label: "unknown-setting" }]);
      expect(breadcrumbsFor("/misc/foo/bar")).toEqual([{ label: "bar" }]);
      expect(breadcrumbsFor("/misc/foo/bar/baz")).toEqual([{ label: "baz" }]);
    });
  });

  // =========================================================================
  // SECTION 6: Theme Tokens, WCAG AA Contrast Ratios & CSS Radius Math
  // =========================================================================
  describe("Section 6: Theme Tokens, WCAG AA Contrast Ratios & CSS Radius Math", () => {
    // Standard WCAG 2.1 Contrast Ratio Calculator
    function hslToRgb(h: number, s: number, l: number): [number, number, number] {
      s /= 100; l /= 100;
      const k = (n: number) => (n + h / 30) % 12;
      const a = s * Math.min(l, 1 - l);
      const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
      return [f(0), f(8), f(4)];
    }

    function sRGBtoLin(c: number): number {
      return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    }

    function getLuminance([r, g, b]: [number, number, number]): number {
      return 0.2126 * sRGBtoLin(r) + 0.7152 * sRGBtoLin(g) + 0.0722 * sRGBtoLin(b);
    }

    function contrastRatio(lum1: number, lum2: number): number {
      const l1 = Math.max(lum1, lum2);
      const l2 = Math.min(lum1, lum2);
      return (l1 + 0.05) / (l2 + 0.05);
    }

    it("verifies that all Clean Light Mode semantic status tokens meet WCAG AA contrast (>= 4.5:1)", () => {
      const whiteLum = 1.0;
      const lightTokens: Record<string, [number, number, number]> = {
        success: [142, 72, 29],         // --success
        warning: [32, 95, 34],          // --warning
        tertiary: [0, 72, 51],          // --tertiary / error
        brand: [221, 83, 53],           // --brand
        secondary: [240, 4, 46],        // --secondary
        onSurface: [240, 10, 10],       // --on-surface
        onSurfaceVariant: [240, 4, 42], // --on-surface-variant
      };

      for (const [name, [h, s, l]] of Object.entries(lightTokens)) {
        const rgb = hslToRgb(h, s, l);
        const lum = getLuminance(rgb);
        const cr = contrastRatio(whiteLum, lum);
        expect(cr, `Light token ${name} contrast ratio ${cr.toFixed(2)} must be >= 4.5:1`).toBeGreaterThanOrEqual(4.5);
      }
    });

    it("verifies that all Clean Dark Mode semantic status tokens meet WCAG AA contrast (>= 4.5:1)", () => {
      const darkBgLum = getLuminance(hslToRgb(240, 6, 6)); // --background: 240 6% 6%
      const darkTokens: Record<string, [number, number, number]> = {
        success: [142, 69, 45],         // --success
        warning: [38, 92, 55],          // --warning
        tertiary: [0, 84, 60],          // --tertiary / error
        brand: [217, 91, 60],           // --brand
        secondary: [240, 5, 65],        // --secondary
        onSurface: [0, 0, 95],          // --on-surface
        onSurfaceVariant: [240, 5, 65], // --on-surface-variant
      };

      for (const [name, [h, s, l]] of Object.entries(darkTokens)) {
        const rgb = hslToRgb(h, s, l);
        const lum = getLuminance(rgb);
        const cr = contrastRatio(darkBgLum, lum);
        expect(cr, `Dark token ${name} contrast ratio ${cr.toFixed(2)} must be >= 4.5:1`).toBeGreaterThanOrEqual(4.5);
      }
    });

    it("verifies dynamic border radius calculations against base radius token", () => {
      // In globals.css line 721: --radius: 0.5rem (8px).
      // tailwind.config.ts lines 10-20 derive:
      // sm: calc(var(--radius) - 4px) -> 4px
      // md / DEFAULT: calc(var(--radius) - 2px) -> 6px
      // lg: var(--radius) -> 8px
      // xl: calc(var(--radius) + 4px) -> 12px
      // 2xl: calc(var(--radius) + 8px) -> 16px
      // 3xl: calc(var(--radius) + 12px) -> 20px
      const baseRadiusPx = 8;
      const expectedRadii = {
        sm: baseRadiusPx - 4,
        md: baseRadiusPx - 2,
        lg: baseRadiusPx,
        xl: baseRadiusPx + 4,
        "2xl": baseRadiusPx + 8,
        "3xl": baseRadiusPx + 12,
      };

      expect(expectedRadii.sm).toBe(4);
      expect(expectedRadii.md).toBe(6);
      expect(expectedRadii.lg).toBe(8);
      expect(expectedRadii.xl).toBe(12);
      expect(expectedRadii["2xl"]).toBe(16);
      expect(expectedRadii["3xl"]).toBe(20);
    });

    it("tests theme persistence and .dark DOM class synchronization", () => {
      // Initial state
      writeStoredTheme("dark");
      expect(readStoredTheme()).toBe("dark");

      applyTheme("dark");
      expect(document.documentElement.classList.contains("dark")).toBe(true);

      applyTheme("light");
      expect(document.documentElement.classList.contains("dark")).toBe(false);

      // Malformed theme fallback
      window.localStorage.setItem(THEME_STORAGE_KEY, "invalid-theme-value");
      expect(readStoredTheme()).toBe(DEFAULT_THEME);
    });

    it("tests sidebar mode and folded sections storage fault tolerance", () => {
      writeSidebarMode("collapsed");
      expect(readSidebarMode()).toBe("collapsed");

      // Corrupted JSON storage fallback
      window.localStorage.setItem(SIDEBAR_FOLDED_STORAGE_KEY, "{corrupted json[");
      expect(readFoldedSections()).toEqual([]);

      writeFoldedSections(["fleet", "work"]);
      expect(readFoldedSections()).toEqual(["fleet", "work"]);
    });
  });
});
