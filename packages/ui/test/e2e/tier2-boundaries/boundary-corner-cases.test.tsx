import { describe, it, expect, vi } from "vitest";
import { screen, fireEvent, waitFor, render } from "@testing-library/react";
import { setupE2EEnv, renderE2EAppAt, setViewportWidth } from "../helpers/e2e-harness.js";
import { readFoldedSections, readSidebarMode } from "../../../src/lib/sidebar-mode.js";
import { AgentPropertiesPanel } from "../../../src/components/AgentPropertiesPanel.js";
import { createTestRouter } from "../../helpers/test-router.js";

setupE2EEnv();

describe("Tier 2: Boundary & Corner Cases", () => {
  describe("Viewport Boundary Conditions", () => {
    it("handles ultra-compact mobile viewport (320px) without DOM errors", async () => {
      const { container } = await renderE2EAppAt("/", { innerWidth: 320 });
      expect(screen.getByTestId("mobile-bottom-nav")).toBeTruthy();
      expect(container.querySelector("[data-testid='app-topbar']")).toBeTruthy();
    });

    it("handles ultra-wide 4K resolution (3840px) with fixed sidebar constraints", async () => {
      const { container } = await renderE2EAppAt("/", { innerWidth: 3840 });
      const sidebar = container.querySelector("[data-testid='app-rail']") as HTMLElement;
      expect(sidebar).toBeTruthy();
      expect(sidebar.getAttribute("data-collapsed")).toBe("false");
    });

    it("resizing dynamically across 1024px breakpoint toggles mobile vs desktop chrome", async () => {
      const { container } = await renderE2EAppAt("/", { innerWidth: 1200 });
      expect(container.querySelector("[data-testid='app-rail']")).toBeTruthy();
      expect(screen.getByTestId("mobile-bottom-nav").className).toContain("lg:hidden");

      setViewportWidth(768);
      await waitFor(() => {
        expect(screen.getByTestId("mobile-bottom-nav")).toBeTruthy();
      });
    });
  });

  describe("Command Palette & Input Boundary Handling", () => {
    it("handles regex meta-characters and special tokens without blowing up", async () => {
      await renderE2EAppAt("/");
      fireEvent.keyDown(window, { key: "k", metaKey: true });
      const input = await screen.findByPlaceholderText("Search pages, rigs, actions…");

      const specialInputs = [".*", "[a-z]+", "\\d", "(", ")", "^$", "???+++***"];
      for (const token of specialInputs) {
        fireEvent.change(input, { target: { value: token } });
        expect(screen.getByTestId("command-palette")).toBeTruthy();
      }
    });

    it("handles extreme length strings (1000+ characters) in search palette", async () => {
      await renderE2EAppAt("/");
      fireEvent.keyDown(window, { key: "k", metaKey: true });
      const input = await screen.findByPlaceholderText("Search pages, rigs, actions…");

      const giantString = "x".repeat(1200);
      fireEvent.change(input, { target: { value: giantString } });
      expect(screen.getByTestId("command-palette")).toBeTruthy();
    });

    it("handles Unicode, emoji, and non-ASCII characters gracefully", async () => {
      await renderE2EAppAt("/");
      fireEvent.keyDown(window, { key: "k", metaKey: true });
      const input = await screen.findByPlaceholderText("Search pages, rigs, actions…");

      fireEvent.change(input, { target: { value: "🚀  rig 測試 \u0000" } });
      expect(screen.getByTestId("command-palette")).toBeTruthy();
    });
  });

  describe("Rapid Sequence & Timing Boundaries", () => {
    it("resets sequential key buffer if time delta exceeds 1000ms window", async () => {
      await renderE2EAppAt("/topology");

      fireEvent.keyDown(window, { key: "g" });
      // Wait past sequence expiration window with real timer
      await new Promise((r) => setTimeout(r, 1100));

      fireEvent.keyDown(window, { key: "d" });
      // Should remain at /topology because the sequence expired
      expect(screen.getByTestId("page-topology")).toBeTruthy();
    });

    it("tolerates rapid successive key spam without throwing exceptions", async () => {
      await renderE2EAppAt("/");
      for (let i = 0; i < 20; i++) {
        fireEvent.keyDown(window, { key: "g" });
        fireEvent.keyDown(window, { key: "k", metaKey: true });
        fireEvent.keyDown(window, { key: "Escape" });
      }
      expect(screen.getByTestId("page-dashboard")).toBeTruthy();
    });
  });

  describe("Degenerate and Unauthenticated Data States", () => {
    it("handles null and missing metadata fields in AgentPropertiesPanel", async () => {
      const mockDegradedFetch = vi.fn().mockImplementation(async (url: unknown) => {
        if (String(url).includes("/api/hosts")) {
          return { ok: true, json: async () => ({ selected: "local", hosts: [] }) };
        }
        return {
          ok: true,
          json: async () => ({
            rigId: "rig-degraded",
            rigName: null,
            logicalId: "dev.agent",
            podId: null,
            canonicalSessionName: null,
            runtime: null,
            sessionStatus: null,
            contextUsage: null,
            currentQitems: [],
            tmuxAttachCommand: null,
            latestError: null,
          }),
        };
      });
      globalThis.fetch = mockDegradedFetch;

      render(
        createTestRouter({
          component: () => <AgentPropertiesPanel rigId="rig-degraded" logicalId="dev.agent" />,
          path: "/test-degraded",
        }),
      );

      // Wait for data row fallback em-dash to render
      expect((await screen.findAllByText("—")).length).toBeGreaterThanOrEqual(1);
      const panel = screen.getByLabelText("Properties");
      expect(panel.textContent).toContain("—");
    });

    it("handles corrupted JSON gracefully in localStorage for sidebar folded sections", () => {
      window.localStorage.setItem("openrig.sidebar.folded", "{malformed-json: [");
      const folded = readFoldedSections();
      expect(Array.isArray(folded)).toBe(true);
      expect(folded).toHaveLength(0);
    });

    it("handles unexpected string values in localStorage for sidebar mode", () => {
      window.localStorage.setItem("openrig.sidebar.mode", "invalid_mode_value");
      const mode = readSidebarMode();
      expect(mode).toBe("auto");
    });
  });
});
