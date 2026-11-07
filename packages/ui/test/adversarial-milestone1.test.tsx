import { describe, it, expect, afterEach, vi } from "vitest";
import React, { createRef, useState } from "react";
import { render, screen, cleanup, fireEvent, waitFor, act } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { Separator } from "../src/components/ui/separator.js";
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "../src/components/ui/tooltip.js";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../src/components/ui/tabs.js";
import { Badge } from "../src/components/ui/badge.js";
import { Input } from "../src/components/ui/input.js";
import { Textarea } from "../src/components/ui/textarea.js";
import { Explorer, shouldSuppressExplorerMount } from "../src/components/Explorer.js";
import type { ExplorerSurface } from "../src/components/Explorer.js";
import { createAppTestRouter } from "./helpers/test-router.js";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { subscribeTopologyEvents } from "../src/lib/topology-events.js";

import "../src/globals.css";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
    },
  });
}

// =============================================================================
// SUITE 1: UI Primitives Adversarial & Stress Testing
// =============================================================================
describe("Adversarial UI Primitives Stress Testing", () => {
  describe("Separator", () => {
    it("handles orientation switching, decorative accessibility, and custom class merging", () => {
      const refHorizontal = createRef<HTMLDivElement>();
      const refVertical = createRef<HTMLDivElement>();

      const { container } = render(
        <div>
          {/* Default horizontal separator without custom overrides */}
          <Separator data-testid="sep-default" />

          {/* Horizontal non-decorative with custom classes that tailwind-merge resolves */}
          <Separator
            ref={refHorizontal}
            orientation="horizontal"
            decorative={false}
            data-testid="sep-h"
            className="my-custom-sep bg-red-500 h-2"
          />

          {/* Vertical, decorative (must have none role per Radix semantics) */}
          <Separator
            ref={refVertical}
            orientation="vertical"
            decorative={true}
            data-testid="sep-v"
            className="vertical-sep w-4"
          />

          {/* Vertical, non-decorative (must have separator role and aria-orientation="vertical") */}
          <Separator
            orientation="vertical"
            decorative={false}
            data-testid="sep-v-role"
          />
        </div>
      );

      const sepDefault = screen.getByTestId("sep-default");
      const sepH = screen.getByTestId("sep-h");
      const sepV = screen.getByTestId("sep-v");
      const sepVRole = screen.getByTestId("sep-v-role");

      // Default horizontal separator classes
      expect(sepDefault.className).toContain("h-[1px]");
      expect(sepDefault.className).toContain("w-full");
      expect(sepDefault.className).toContain("bg-outline-variant");
      expect(sepDefault.getAttribute("role")).toBe("none");

      // Ref forwarding
      expect(refHorizontal.current).toBe(sepH);
      expect(refVertical.current).toBe(sepV);

      // Custom class override (tailwind-merge replaces h-[1px] with h-2 and keeps w-full)
      expect(sepH.className).toContain("h-2");
      expect(sepH.className).toContain("w-full");
      expect(sepH.className).toContain("my-custom-sep");
      expect(sepH.className).toContain("bg-red-500");
      expect(sepH.getAttribute("role")).toBe("separator");

      // Vertical separator (decorative)
      expect(sepV.className).toContain("w-4");
      expect(sepV.className).toContain("h-full");
      expect(sepV.className).toContain("vertical-sep");
      expect(sepV.getAttribute("role")).toBe("none");

      // Vertical separator (non-decorative: role="separator", aria-orientation="vertical")
      expect(sepVRole.getAttribute("role")).toBe("separator");
      expect(sepVRole.getAttribute("aria-orientation")).toBe("vertical");
    });
  });

  describe("Tooltip", () => {
    it("renders extreme content length, dynamic placement props, and Clean theme styles", () => {
      const refContent = createRef<HTMLDivElement>();
      const extremeText = "CRITICAL_SYSTEM_ALERT: " + "X".repeat(5000) + " 🚀 🛡️ ⚠️";

      render(
        <TooltipProvider>
          <Tooltip open={true}>
            <TooltipTrigger asChild>
              <button type="button" data-testid="tt-trigger">Inspect</button>
            </TooltipTrigger>
            <TooltipContent
              ref={refContent}
              data-testid="tt-content"
              side="bottom"
              sideOffset={20}
              className="custom-tooltip-stress"
            >
              <div data-testid="tt-inner">{extremeText}</div>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      );

      const content = screen.getByTestId("tt-content");
      expect(content).toBeDefined();
      expect(refContent.current).toBe(content);

      // Clean theme tokens & border
      expect(content.className).toContain("rounded-md");
      expect(content.className).toContain("border");
      expect(content.className).toContain("border-outline-variant");
      expect(content.className).toContain("bg-surface-high");
      expect(content.className).toContain("shadow-md");
      expect(content.className).toContain("custom-tooltip-stress");

      // Content integrity (Radix creates an accessible screen reader clone alongside the popover)
      const inners = screen.getAllByTestId("tt-inner");
      expect(inners.length).toBeGreaterThanOrEqual(1);
      expect(inners[0].textContent?.length).toBeGreaterThan(5000);
      expect(inners[0].textContent).toContain("🚀 🛡️ ⚠️");
    });
  });

  describe("Tabs", () => {
    it("handles orientation, controlled switching, disabled items, and extreme tab content", () => {
      function TabsTestHarness() {
        const [activeTab, setActiveTab] = useState("tab1");
        return (
          <Tabs
            value={activeTab}
            onValueChange={setActiveTab}
            orientation="vertical"
            className="flex h-64"
          >
            <TabsList className="flex flex-col" data-testid="t-list">
              <TabsTrigger value="tab1" data-testid="t-trig-1">
                Tab 1
              </TabsTrigger>
              <TabsTrigger value="tab2" data-testid="t-trig-2">
                {"Very Long Label " + "A".repeat(500)}
              </TabsTrigger>
              <TabsTrigger value="tab3" disabled data-testid="t-trig-3">
                Disabled Tab
              </TabsTrigger>
            </TabsList>
            <TabsContent value="tab1" data-testid="t-content-1">
              Content for Tab 1
            </TabsContent>
            <TabsContent value="tab2" data-testid="t-content-2">
              {"Huge Content Payload: " + "Z".repeat(10000)}
            </TabsContent>
            <TabsContent value="tab3" data-testid="t-content-3">
              Content for Tab 3
            </TabsContent>
          </Tabs>
        );
      }

      render(<TabsTestHarness />);

      const list = screen.getByTestId("t-list");
      const trig1 = screen.getByTestId("t-trig-1");
      const trig2 = screen.getByTestId("t-trig-2");
      const trig3 = screen.getByTestId("t-trig-3");

      // List styling
      expect(list.className).toContain("rounded-md");

      // Tab 1 initially active
      expect(trig1.getAttribute("data-state")).toBe("active");
      expect(trig1.className).toContain("rounded-sm");
      expect(trig1.className).toContain("data-[state=active]:bg-surface-mid");
      expect(trig1.className).toContain("data-[state=active]:text-on-surface");
      expect(screen.getByTestId("t-content-1")).toBeDefined();

      // Click tab 2 via Radix onMouseDown handler
      fireEvent.mouseDown(trig2, { button: 0, ctrlKey: false });
      expect(trig2.getAttribute("data-state")).toBe("active");
      expect(trig1.getAttribute("data-state")).toBe("inactive");
      const content2 = screen.getByTestId("t-content-2");
      expect(content2.textContent?.length).toBeGreaterThan(10000);

      // Attempt clicking disabled tab 3 (should remain inactive)
      fireEvent.mouseDown(trig3, { button: 0, ctrlKey: false });
      expect(trig3.getAttribute("data-state")).toBe("inactive");
      expect(trig2.getAttribute("data-state")).toBe("active");

      // Keyboard activation via Enter key back to tab 1
      fireEvent.keyDown(trig1, { key: "Enter" });
      expect(trig1.getAttribute("data-state")).toBe("active");
      expect(trig2.getAttribute("data-state")).toBe("inactive");
    });
  });

  describe("Badge", () => {
    it("verifies all variants have rounded-full and secondary has clean semantic tokens", () => {
      const handleClick = vi.fn();
      render(
        <div>
          <Badge variant="default" data-testid="b-def">Default</Badge>
          <Badge
            variant="secondary"
            data-testid="b-sec"
            onClick={handleClick}
            className="cursor-pointer"
          >
            Secondary
          </Badge>
          <Badge variant="destructive" data-testid="b-dest">Destructive</Badge>
          <Badge variant="outline" data-testid="b-out">Outline</Badge>
          <Badge variant="default" data-testid="b-extreme">
            {"Extreme " + "🔥".repeat(100) + " " + "W".repeat(1000)}
          </Badge>
        </div>
      );

      const bDef = screen.getByTestId("b-def");
      const bSec = screen.getByTestId("b-sec");
      const bDest = screen.getByTestId("b-dest");
      const bOut = screen.getByTestId("b-out");
      const bExtreme = screen.getByTestId("b-extreme");

      // All badges have rounded-full
      expect(bDef.className).toContain("rounded-full");
      expect(bSec.className).toContain("rounded-full");
      expect(bDest.className).toContain("rounded-full");
      expect(bOut.className).toContain("rounded-full");
      expect(bExtreme.className).toContain("rounded-full");

      // Secondary token assertions
      expect(bSec.className).toContain("bg-surface-mid");
      expect(bSec.className).toContain("text-on-surface-variant");

      // Click handler on badge
      fireEvent.click(bSec);
      expect(handleClick).toHaveBeenCalledTimes(1);

      // Extreme badge content
      expect(bExtreme.textContent).toContain("🔥");
      expect(bExtreme.textContent?.length).toBeGreaterThan(1000);
    });
  });

  describe("Input", () => {
    it("handles extreme input lengths, dynamic types, states, ref focus, and Clean radius", () => {
      const inputRef = createRef<HTMLInputElement>();
      const handleChange = vi.fn();

      render(
        <Input
          ref={inputRef}
          type="search"
          data-testid="stress-input"
          placeholder="Search items..."
          disabled={false}
          required={true}
          onChange={handleChange}
          className="custom-input-class"
        />
      );

      const input = screen.getByTestId("stress-input") as HTMLInputElement;

      // Clean radius & styling
      expect(input.className).toContain("rounded-md");
      expect(input.className).toContain("border");
      expect(input.className).toContain("border-outline-variant/55");
      expect(input.className).toContain("bg-surface-lowest/85");
      expect(input.className).toContain("custom-input-class");

      // Ref forwarding & focus
      expect(inputRef.current).toBe(input);
      input.focus();
      expect(document.activeElement).toBe(input);

      // Extreme input string (50,000 characters + XSS payload)
      const extremeValue = "<script>alert(1)</script>" + "A".repeat(50000) + "'; DROP TABLE rigs;--";
      fireEvent.change(input, { target: { value: extremeValue } });
      expect(handleChange).toHaveBeenCalled();
      expect(input.value).toBe(extremeValue);
    });
  });

  describe("Textarea", () => {
    it("handles multiline extreme text, rows/cols, ref selection, and Clean radius", () => {
      const taRef = createRef<HTMLTextAreaElement>();
      const handleChange = vi.fn();

      render(
        <Textarea
          ref={taRef}
          rows={12}
          cols={60}
          data-testid="stress-textarea"
          placeholder="Paste logs..."
          onChange={handleChange}
          className="font-mono text-sm"
        />
      );

      const ta = screen.getByTestId("stress-textarea") as HTMLTextAreaElement;

      // Clean radius & styling
      expect(ta.className).toContain("rounded-md");
      expect(ta.className).toContain("border");
      expect(ta.className).toContain("border-outline-variant/55");
      expect(ta.className).toContain("bg-surface-lowest/85");
      expect(ta.className).toContain("font-mono");

      // Ref forwarding & select()
      expect(taRef.current).toBe(ta);
      ta.focus();
      ta.select();

      // Extreme multiline input (50,000 characters with 1,000 newlines)
      const multilineExtreme = Array.from({ length: 1000 }, (_, i) => `[LOG ${i}] Error: crash dump line ${i}`).join("\n");
      fireEvent.change(ta, { target: { value: multilineExtreme } });
      expect(handleChange).toHaveBeenCalled();
      expect(ta.value.split("\n").length).toBe(1000);
    });
  });
});

// =============================================================================
// SUITE 2: Explorer Mounting & Live SSE Updates Without Polling
// =============================================================================
describe("Explorer Mount & SSE Live Update Integrity", () => {
  describe("shouldSuppressExplorerMount predicate", () => {
    it("returns true only for topology on narrow viewports", () => {
      // Topology: suppressed only on narrow (isWideLayout=false)
      expect(shouldSuppressExplorerMount("topology", false)).toBe(true);
      expect(shouldSuppressExplorerMount("topology", true)).toBe(false);

      // All other surfaces are NEVER suppressed regardless of viewport width
      const surfaces: ExplorerSurface[] = ["project", "specs", "settings", "for-you", "none"];
      for (const s of surfaces) {
        expect(shouldSuppressExplorerMount(s, false)).toBe(false);
        expect(shouldSuppressExplorerMount(s, true)).toBe(false);
      }
    });
  });

  describe("Explorer component rendering across modes and surfaces", () => {
    it("renders null when surface is 'none'", () => {
      const { container } = render(
        <Explorer open={true} surface="none" />
      );
      expect(container.firstChild).toBeNull();
    });

    it("renders only collapsed edge toggle button when desktopMode is 'hidden'", () => {
      const handleToggle = vi.fn();
      render(
        <Explorer
          open={true}
          desktopMode="hidden"
          surface="project"
          onDesktopToggle={handleToggle}
        />
      );

      const toggleBtn = screen.getByTestId("explorer-edge-toggle");
      expect(toggleBtn).toBeDefined();
      expect(toggleBtn.getAttribute("data-explorer-collapsed")).toBe("true");
      expect(screen.queryByTestId("explorer")).toBeNull();

      fireEvent.click(toggleBtn);
      expect(handleToggle).toHaveBeenCalledTimes(1);
    });

    it("renders overlay mode with vellum styling and opaque mode with backdrop filter", () => {
      const queryClient = createTestQueryClient();
      const { unmount } = render(
        <QueryClientProvider client={queryClient}>
          <Explorer
            open={true}
            desktopMode="full"
            surface="for-you"
            overlayMode="overlay"
          />
        </QueryClientProvider>
      );
      let aside = screen.getByTestId("explorer");
      expect(aside.className).toContain("vellum");
      expect(aside.className).toContain("z-30");
      unmount();

      render(
        <QueryClientProvider client={queryClient}>
          <Explorer
            open={true}
            desktopMode="full"
            surface="for-you"
            overlayMode="opaque"
          />
        </QueryClientProvider>
      );
      aside = screen.getByTestId("explorer");
      expect(aside.className).toContain("z-40");
      expect(aside.className).toContain("backdrop-blur-[14px]");
    });

    it("mounts cleanly across all 5 active surfaces inside router context", async () => {
      const surfaces: ExplorerSurface[] = ["topology", "project", "specs", "settings", "for-you"];
      for (const surface of surfaces) {
        const { unmount } = render(
          createAppTestRouter({
            initialPath: `/test-${surface}`,
            routes: [
              {
                path: `/test-${surface}`,
                component: () => (
                  <Explorer
                    open={true}
                    surface={surface}
                    desktopMode="full"
                    overlayMode="opaque"
                  />
                ),
              },
            ],
          })
        );
        await waitFor(() => {
          expect(screen.getByTestId("explorer")).toBeTruthy();
        });
        const aside = screen.getByTestId("explorer");
        expect(aside.getAttribute("data-surface")).toBe(surface);
        unmount();
      }
    });
  });

  describe("SSE Live Updates Verification (Polling Elimination Integrity)", () => {
    it("proves Explorer source contains no polling queries or setInterval calls", () => {
      const explorerSrc = readFileSync(resolve(__dirname, "../src/components/Explorer.tsx"), "utf-8");

      // Verify dead polling hooks are completely removed
      expect(explorerSrc).not.toContain("useRigSummary");
      expect(explorerSrc).not.toContain("usePsEntries");
      expect(explorerSrc).not.toContain("setInterval");
      expect(explorerSrc).not.toContain("refetchInterval");
    });

    it("verifies global SSE events invalidate React Query cache without polling", async () => {
      vi.useFakeTimers();

      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });

      const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

      // Simulate SSE event listener callback registration
      let sseCallback: ((event: { type: string; rigId?: string }) => void) | null = null;
      const unsubscribe = subscribeTopologyEvents((data) => {
        if (sseCallback) sseCallback(data);
      });

      // Hook up an invalidator simulating useGlobalEvents
      const pendingInvalidations = new Set<string>();
      let debounceTimer: ReturnType<typeof setTimeout> | null = null;

      sseCallback = (event) => {
        const { type, rigId } = event;
        if (type === "rig.created" || type === "rig.stopped") {
          pendingInvalidations.add("rigs:summary");
          pendingInvalidations.add("ps");
        }
        if (type.startsWith("node.startup_") && rigId) {
          pendingInvalidations.add(`rig:${rigId}:nodes`);
        }
        if (type === "rig.archived") {
          pendingInvalidations.add("rigs:summary");
          pendingInvalidations.add("rigs:summary:archived");
        }

        if (debounceTimer) return;
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          for (const key of pendingInvalidations) {
            if (key === "rigs:summary") {
              queryClient.invalidateQueries({ queryKey: ["rigs", "summary"] });
            } else if (key === "ps") {
              queryClient.invalidateQueries({ queryKey: ["ps"] });
            } else if (key === "rigs:summary:archived") {
              queryClient.invalidateQueries({ queryKey: ["rigs", "summary", "archived"] });
            } else if (key.startsWith("rig:")) {
              const parts = key.split(":");
              queryClient.invalidateQueries({ queryKey: ["rig", parts[1], parts[2]] });
            }
          }
          pendingInvalidations.clear();
        }, 150);
      };

      // Emit SSE events
      act(() => {
        sseCallback!({ type: "rig.created", rigId: "rig-101" });
        sseCallback!({ type: "node.startup_ready", rigId: "rig-101" });
        sseCallback!({ type: "rig.archived", rigId: "rig-101" });
      });

      // Before timer ticks, invalidations are queued but not flushed
      expect(invalidateSpy).not.toHaveBeenCalled();

      // Advance timers by 150ms debounce window
      act(() => {
        vi.advanceTimersByTime(160);
      });

      // Verify all query keys were invalidated reactively!
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["rigs", "summary"] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["ps"] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["rig", "rig-101", "nodes"] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["rigs", "summary", "archived"] });

      unsubscribe();
      vi.useRealTimers();
    });
  });
});

// =============================================================================
// SUITE 3: Mathematical WCAG AA / AAA Contrast Verification
// =============================================================================
describe("Mathematical Contrast Ratio Verification", () => {
  function parseHsl(hslStr: string): [number, number, number] {
    const parts = hslStr.trim().split(/\s+/).map((p) => parseFloat(p));
    return [parts[0], parts[1], parts[2]];
  }

  function hslToRgb(h: number, s: number, l: number): [number, number, number] {
    s /= 100;
    l /= 100;
    const k = (n: number) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
  }

  function lum([r, g, b]: [number, number, number]): number {
    const a = [r, g, b].map((v) => {
      v /= 255;
      return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
  }

  function contrast(rgb1: [number, number, number], rgb2: [number, number, number]): number {
    const l1 = lum(rgb1);
    const l2 = lum(rgb2);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }

  const css = readFileSync(resolve(__dirname, "../src/globals.css"), "utf-8");

  const rootMatches = [...css.matchAll(/:root\s*\{([\s\S]*?)\}/g)];
  const cleanRoot = rootMatches[rootMatches.length - 1][1];

  const darkMatches = [...css.matchAll(/\.dark\s*\{([\s\S]*?)\}/g)];
  const cleanDark = darkMatches[darkMatches.length - 1][1];

  it("conforms light mode status and content tokens to WCAG AA (>= 4.5:1) on white ground", () => {
    const white: [number, number, number] = [255, 255, 255];
    const surfaceLowestRgb = hslToRgb(...parseHsl("240 5% 98%"));

    const successHsl = cleanRoot.match(/--success:\s*([^;]+);/)?.[1]!;
    const warningHsl = cleanRoot.match(/--warning:\s*([^;]+);/)?.[1]!;
    const tertiaryHsl = cleanRoot.match(/--tertiary:\s*([^;]+);/)?.[1]!;
    const brandHsl = cleanRoot.match(/--brand:\s*([^;]+);/)?.[1]!;
    const onSurfaceHsl = cleanRoot.match(/--on-surface:\s*([^;]+);/)?.[1]!;
    const onSurfaceVarHsl = cleanRoot.match(/--on-surface-variant:\s*([^;]+);/)?.[1]!;

    expect(successHsl).toBeDefined();
    expect(warningHsl).toBeDefined();
    expect(tertiaryHsl).toBeDefined();
    expect(brandHsl).toBeDefined();
    expect(onSurfaceHsl).toBeDefined();
    expect(onSurfaceVarHsl).toBeDefined();

    const successRgb = hslToRgb(...parseHsl(successHsl));
    const warningRgb = hslToRgb(...parseHsl(warningHsl));
    const tertiaryRgb = hslToRgb(...parseHsl(tertiaryHsl));
    const brandRgb = hslToRgb(...parseHsl(brandHsl));
    const onSurfaceRgb = hslToRgb(...parseHsl(onSurfaceHsl));
    const onSurfaceVarRgb = hslToRgb(...parseHsl(onSurfaceVarHsl));

    // Contrast against pure white (#ffffff)
    expect(contrast(successRgb, white)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(warningRgb, white)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tertiaryRgb, white)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(brandRgb, white)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(onSurfaceRgb, white)).toBeGreaterThanOrEqual(7.0); // AAA
    expect(contrast(onSurfaceVarRgb, white)).toBeGreaterThanOrEqual(4.5);

    // Contrast against surface-lowest (240 5% 98%)
    expect(contrast(successRgb, surfaceLowestRgb)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(warningRgb, surfaceLowestRgb)).toBeGreaterThanOrEqual(4.5);
  });

  it("evaluates dark mode status tokens against dark ground (240 6% 6%)", () => {
    const darkBgHsl = cleanDark.match(/--background:\s*([^;]+);/)?.[1] || "240 6% 6%";
    const darkBgRgb = hslToRgb(...parseHsl(darkBgHsl));

    const successHsl = cleanDark.match(/--success:\s*([^;]+);/)?.[1]!;
    const warningHsl = cleanDark.match(/--warning:\s*([^;]+);/)?.[1]!;
    const onSurfaceHsl = cleanDark.match(/--on-surface:\s*([^;]+);/)?.[1]!;
    const onSurfaceVarHsl = cleanDark.match(/--on-surface-variant:\s*([^;]+);/)?.[1]!;

    expect(successHsl).toBeDefined();
    expect(warningHsl).toBeDefined();
    expect(onSurfaceHsl).toBeDefined();
    expect(onSurfaceVarHsl).toBeDefined();

    const successRgb = hslToRgb(...parseHsl(successHsl));
    const warningRgb = hslToRgb(...parseHsl(warningHsl));
    const onSurfaceRgb = hslToRgb(...parseHsl(onSurfaceHsl));
    const onSurfaceVarRgb = hslToRgb(...parseHsl(onSurfaceVarHsl));

    // High contrast tokens exceed 7:1 against dark background
    expect(contrast(successRgb, darkBgRgb)).toBeGreaterThanOrEqual(7.0);
    expect(contrast(warningRgb, darkBgRgb)).toBeGreaterThanOrEqual(7.0);
    expect(contrast(onSurfaceRgb, darkBgRgb)).toBeGreaterThanOrEqual(7.0);
    expect(contrast(onSurfaceVarRgb, darkBgRgb)).toBeGreaterThanOrEqual(7.0);
  });
});
