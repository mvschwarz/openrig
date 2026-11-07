import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createRootRoute,
  createRoute,
  createRouter,
  createMemoryHistory,
  RouterProvider,
} from "@tanstack/react-router";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactNode } from "react";

import { UndoToast } from "../src/components/for-you/UndoToast.js";
import { GettingStarted, GETTING_STARTED_DISMISSED_KEY } from "../src/components/dashboard/GettingStarted.js";
import { LaunchRecoveryModal } from "../src/components/LaunchRecoveryModal.js";
import { RigStatusControl } from "../src/components/RigStatusControl.js";

// Mock fetch for Query hooks
const mockFetch = vi.fn();
globalThis.fetch = mockFetch as unknown as typeof fetch;

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve({ ok: status < 400, status, json: async () => body } as Response);
}

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
}

function seedStandardCache(qc: QueryClient, overrides?: { ps?: unknown; library?: unknown; status?: unknown }) {
  qc.setQueryData(["hosts"], { ownName: "localhost", selected: "local", hosts: [] });
  qc.setQueryData(["ps", "local"], overrides?.ps ?? []);
  qc.setQueryData(["daemon", "health"], { status: "ok" });
  qc.setQueryData(["spec-library", "all", "local"], overrides?.library ?? [{ kind: "rig" }]);
  if (overrides?.status !== undefined) {
    qc.setQueryData(["rig", "rig-alpha", "status"], overrides.status);
  }
}

function renderWithHarness(ui: ReactNode, queryClient = createTestQueryClient()) {
  const rootRoute = createRootRoute({
    component: () => (
      <QueryClientProvider client={queryClient}>
        {ui}
      </QueryClientProvider>
    ),
  });
  const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: () => null });
  const stubRoute = (path: string) =>
    createRoute({ getParentRoute: () => rootRoute, path, component: () => null });
  const routeTree = rootRoute.addChildren([
    indexRoute,
    stubRoute("/specs"),
    stubRoute("/specs/rig"),
    stubRoute("/for-you"),
  ]);
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(<RouterProvider router={router as never} />);
}

function getAllClassNames(container: HTMLElement): string[] {
  const elements = container.querySelectorAll("*");
  const classes: string[] = [];
  container.classList.forEach((c) => classes.push(c));
  elements.forEach((el) => {
    el.classList.forEach((c) => classes.push(c));
  });
  return classes;
}

const SAMPLE_PLAN = {
  status: "plan",
  mode: "restore",
  rigId: "rig-alpha",
  rigName: "openrig-test-rig",
  snapshot: null,
  wouldCaptureCurrentState: true,
  mutated: false,
  nodes: [
    { logicalId: "seat-1", intendedAction: "resume-original", tokenState: "present", freshRequired: false },
    { logicalId: "seat-2", intendedAction: "awaiting-decision", tokenState: "missing", freshRequired: true, reason: "missing token" },
    { logicalId: "seat-3", intendedAction: "resume-original", tokenState: "stale", freshRequired: false },
  ],
};

const SAMPLE_STATUS_UP = {
  rigId: "rig-alpha",
  rigName: "openrig-test-rig",
  isKernel: false,
  status: "up" as const,
  seatsTotal: 3,
  seatsRunning: 3,
  recoverable: false,
  perSeat: [],
  src: ["ps: 3/3 running · lifecycle=running"],
};

const SAMPLE_STATUS_BLOCKED = {
  rigId: "rig-alpha",
  rigName: "openrig-test-rig",
  isKernel: false,
  status: "blocked" as const,
  seatsTotal: 3,
  seatsRunning: 0,
  recoverable: false,
  perSeat: [],
  src: ["ps: 0/3 running · lifecycle=recoverable", "restore-check: blocked"],
};

describe("Milestone 1 Empirical Challenge: Clean Theme Tokens & Cascade", () => {
  beforeEach(() => {
    mockFetch.mockReset();
    window.localStorage.clear();
    window.localStorage.removeItem(GETTING_STARTED_DISMISSED_KEY);
    document.documentElement.classList.remove("dark");
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    window.localStorage.removeItem(GETTING_STARTED_DISMISSED_KEY);
    document.documentElement.classList.remove("dark");
  });

  // =========================================================================
  // DIMENSION 1: Hardcoded stone-* and white artifact elimination across modes
  // =========================================================================
  describe("Dimension 1: Zero Fixed Stone / White Artifacts in DOM Across Light & Dark Modes", () => {
    const FORBIDDEN_CLASS_PATTERNS = [
      /\bstone-\d+\b/,
      /\bborder-stone-\d+\b/,
      /\bbg-stone-\d+\b/,
      /\btext-stone-\d+\b/,
      /\bring-stone-\d+\b/,
      /\bbg-white\b(?!\/0)/,
      /\bborder-white\b/,
    ];

    function assertNoForbiddenClasses(classes: string[], componentName: string, mode: string) {
      for (const cls of classes) {
        for (const pattern of FORBIDDEN_CLASS_PATTERNS) {
          expect(
            pattern.test(cls),
            `Found forbidden hardcoded class "${cls}" in ${componentName} under ${mode} mode`,
          ).toBe(false);
        }
      }
    }

    it.each(["light", "dark"])("UndoToast renders without stone/white artifacts under %s mode", (mode) => {
      if (mode === "dark") document.documentElement.classList.add("dark");
      const { container } = render(
        <UndoToast label="Item archived" onUndo={() => {}} onExpire={() => {}} durationMs={5000} />,
      );
      const classes = getAllClassNames(container);
      assertNoForbiddenClasses(classes, "UndoToast", mode);

      const toast = screen.getByTestId("undo-toast");
      expect(toast.className).toContain("bg-surface-high");
      expect(toast.className).toContain("border-outline-variant");
      expect(toast.className).toContain("text-on-surface");

      const btn = screen.getByTestId("undo-toast-button");
      expect(btn.className).toContain("border-outline");
      expect(btn.className).toContain("text-on-surface");
    });

    it.each(["light", "dark"])("GettingStarted renders without stone/white artifacts under %s mode", async (mode) => {
      if (mode === "dark") document.documentElement.classList.add("dark");
      const qc = createTestQueryClient();
      seedStandardCache(qc);

      const { container } = renderWithHarness(<GettingStarted />, qc);
      const card = await screen.findByTestId("getting-started");
      expect(card).toBeTruthy();

      const classes = getAllClassNames(container);
      assertNoForbiddenClasses(classes, "GettingStarted", mode);

      // Verify semantic tokens
      expect(card.querySelector(".bg-surface-lowest")).toBeTruthy();
      expect(card.querySelector(".text-on-surface")).toBeTruthy();

      // Check mark uses semantic text-brand-foreground (not hardcoded text-white)
      const checks = card.querySelectorAll("span[aria-hidden='true']");
      expect(checks.length).toBe(4);
      const doneCheck = checks[0];
      expect(doneCheck.className).toContain("bg-brand");
      expect(doneCheck.className).toContain("text-brand-foreground");
      expect(doneCheck.className).not.toContain("text-white");
    });

    it.each(["light", "dark"])("LaunchRecoveryModal renders without stone/white artifacts under %s mode", async (mode) => {
      if (mode === "dark") document.documentElement.classList.add("dark");
      mockFetch.mockImplementation((url: unknown) => {
        if (String(url).includes("/launch-plan")) return jsonResponse(SAMPLE_PLAN);
        return jsonResponse({});
      });

      const { baseElement } = renderWithHarness(
        <LaunchRecoveryModal rigId="rig-alpha" rigName="Test Rig" open onOpenChange={() => {}} />,
      );

      await screen.findByTestId("launch-recovery-modal");
      await screen.findByTestId("launch-plan-table");

      // Scan baseElement since Radix renders modal in Portal outside root container
      const classes = getAllClassNames(baseElement);
      assertNoForbiddenClasses(classes, "LaunchRecoveryModal", mode);

      // Verify Clean tokens in PolicyOption buttons
      const restoreOpt = screen.getByTestId("launch-policy-restore-original");
      expect(restoreOpt.className).toContain("border-outline");
      expect(restoreOpt.className).toContain("bg-surface-high");
      expect(restoreOpt.className).toContain("text-on-surface");

      const freshOpt = screen.getByTestId("launch-policy-fresh");
      // freshOpt has warn={true} and !selected -> cn merges border-tertiary/50 over border-outline-variant
      expect(freshOpt.className).toContain("border-tertiary/50");
      expect(freshOpt.className).toContain("bg-surface-lowest");
      expect(freshOpt.className).toContain("text-on-surface");
    });

    it.each(["light", "dark"])("RigStatusControl renders without stone/white artifacts under %s mode", async (mode) => {
      if (mode === "dark") document.documentElement.classList.add("dark");
      mockFetch.mockImplementation((url: unknown) => {
        if (String(url).includes("/status")) return jsonResponse(SAMPLE_STATUS_BLOCKED);
        return jsonResponse({});
      });

      const qc = createTestQueryClient();
      seedStandardCache(qc, { status: SAMPLE_STATUS_BLOCKED });

      const { container } = renderWithHarness(<RigStatusControl rigId="rig-alpha" rigName="Test Rig" />, qc);

      await screen.findByTestId("rig-status-control-rig-alpha");
      const classes = getAllClassNames(container);
      assertNoForbiddenClasses(classes, "RigStatusControl", mode);

      const control = screen.getByTestId("rig-status-control-rig-alpha");
      expect(control.className).toContain("border-outline-variant");
      expect(control.className).toContain("bg-surface-lowest");
    });
  });

  // =========================================================================
  // DIMENSION 2: WCAG 2.1 AA Contrast Ratio Verification in Light and Dark Modes
  // =========================================================================
  describe("Dimension 2: Rigorous WCAG 2.1 AA Contrast Ratios in Light and Dark Modes", () => {
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

    function getRelativeLuminance([r, g, b]: [number, number, number]): number {
      const a = [r, g, b].map((v) => {
        v /= 255;
        return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
    }

    function calculateContrastRatio(color1: [number, number, number], color2: [number, number, number]): number {
      const l1 = getRelativeLuminance(color1);
      const l2 = getRelativeLuminance(color2);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    }

    const globalsCss = readFileSync(resolve(__dirname, "../src/globals.css"), "utf-8");
    const rootMatches = [...globalsCss.matchAll(/:root\s*\{([\s\S]*?)\}/g)];
    const cleanRootCss = rootMatches[rootMatches.length - 1][1];

    const darkMatches = [...globalsCss.matchAll(/\.dark\s*\{([\s\S]*?)\}/g)];
    const cleanDarkCss = darkMatches[darkMatches.length - 1][1];

    function extractToken(css: string, token: string): [number, number, number] {
      const reg = new RegExp(`${token}:\\s*([^;]+);`);
      const match = css.match(reg);
      if (!match) throw new Error(`Token ${token} not found in CSS block`);
      return hslToRgb(...parseHsl(match[1]));
    }

    it("Light Mode: status tokens, ink, and brand meet WCAG AA (>= 4.5:1) against surface", () => {
      const bg = extractToken(cleanRootCss, "--surface-container-lowest");
      const onSurface = extractToken(cleanRootCss, "--on-surface");
      const onSurfaceVariant = extractToken(cleanRootCss, "--on-surface-variant");
      const success = extractToken(cleanRootCss, "--success");
      const warning = extractToken(cleanRootCss, "--warning");
      const tertiary = extractToken(cleanRootCss, "--tertiary");
      const brand = extractToken(cleanRootCss, "--brand");
      const brandFg = extractToken(cleanRootCss, "--brand-foreground");

      const onSurfaceContrast = calculateContrastRatio(onSurface, bg);
      const onSurfaceVariantContrast = calculateContrastRatio(onSurfaceVariant, bg);
      const successContrast = calculateContrastRatio(success, bg);
      const warningContrast = calculateContrastRatio(warning, bg);
      const tertiaryContrast = calculateContrastRatio(tertiary, bg);
      const brandBadgeContrast = calculateContrastRatio(brandFg, brand);

      expect(onSurfaceContrast, `Light on-surface contrast ${onSurfaceContrast.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      expect(onSurfaceVariantContrast, `Light on-surface-variant contrast ${onSurfaceVariantContrast.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      expect(successContrast, `Light success contrast ${successContrast.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      expect(warningContrast, `Light warning contrast ${warningContrast.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      expect(tertiaryContrast, `Light tertiary contrast ${tertiaryContrast.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      expect(brandBadgeContrast, `Brand badge text contrast ${brandBadgeContrast.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    });

    it("Dark Mode: status tokens, ink, and secondary meet WCAG AA (>= 4.5:1) against dark surface", () => {
      const darkBg = extractToken(cleanDarkCss, "--surface-container-lowest");
      const darkOnSurface = extractToken(cleanDarkCss, "--on-surface");
      const darkOnSurfaceVariant = extractToken(cleanDarkCss, "--on-surface-variant");
      const darkSuccess = extractToken(cleanDarkCss, "--success");
      const darkWarning = extractToken(cleanDarkCss, "--warning");
      const darkTertiary = extractToken(cleanDarkCss, "--tertiary");

      const darkOnSurfaceContrast = calculateContrastRatio(darkOnSurface, darkBg);
      const darkOnSurfaceVariantContrast = calculateContrastRatio(darkOnSurfaceVariant, darkBg);
      const darkSuccessContrast = calculateContrastRatio(darkSuccess, darkBg);
      const darkWarningContrast = calculateContrastRatio(darkWarning, darkBg);
      const darkTertiaryContrast = calculateContrastRatio(darkTertiary, darkBg);

      expect(darkOnSurfaceContrast, `Dark on-surface contrast ${darkOnSurfaceContrast.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      expect(darkOnSurfaceVariantContrast, `Dark on-surface-variant contrast ${darkOnSurfaceVariantContrast.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      expect(darkSuccessContrast, `Dark success contrast ${darkSuccessContrast.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      expect(darkWarningContrast, `Dark warning contrast ${darkWarningContrast.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      expect(darkTertiaryContrast, `Dark tertiary contrast ${darkTertiaryContrast.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    });

    it("Elevated surfaces maintain contrast across light and dark modes", () => {
      const lightHigh = extractToken(cleanRootCss, "--surface-container-high");
      const lightOnSurface = extractToken(cleanRootCss, "--on-surface");
      const darkHigh = extractToken(cleanDarkCss, "--surface-container-high");
      const darkOnSurface = extractToken(cleanDarkCss, "--on-surface");

      const lightElevatedContrast = calculateContrastRatio(lightOnSurface, lightHigh);
      const darkElevatedContrast = calculateContrastRatio(darkOnSurface, darkHigh);

      expect(lightElevatedContrast).toBeGreaterThanOrEqual(4.5);
      expect(darkElevatedContrast).toBeGreaterThanOrEqual(4.5);
    });
  });

  // =========================================================================
  // DIMENSION 3: Stress Testing under Rapid Prop Mutations & Concurrency
  // =========================================================================
  describe("Dimension 3: Rapid Prop Mutations, Edge Inputs & Concurrency Guards", () => {
    it("UndoToast: survives rapid prop mutations, extreme strings, and concurrent timer triggers", () => {
      vi.useFakeTimers();
      const onUndo = vi.fn();
      const onExpire = vi.fn();

      const { rerender } = render(
        <UndoToast label="Initial" onUndo={onUndo} onExpire={onExpire} durationMs={3000} />,
      );

      // Stress: rapid sequential rerenders with varied and extreme labels
      const testLabels = [
        "",
        "Short",
        "A".repeat(2000), // Huge string
        "🚀 Emoji Rig Status 💥",
        "<script>alert('xss')</script>",
        "Line\nBreak\tTabs",
        "Special chars: & < > \" ' / \\",
      ];

      for (let i = 0; i < 50; i++) {
        const label = testLabels[i % testLabels.length];
        rerender(
          <UndoToast
            label={label}
            onUndo={onUndo}
            onExpire={onExpire}
            durationMs={i % 2 === 0 ? 5000 : 1000}
          />,
        );
      }

      // Concurrency guard: click undo at the exact boundary of timer expiration
      const btn = screen.getByTestId("undo-toast-button");
      fireEvent.click(btn);
      act(() => {
        vi.advanceTimersByTime(5000);
      });

      // consumedRef must ensure onUndo fired exactly once and onExpire NEVER fired
      expect(onUndo).toHaveBeenCalledTimes(1);
      expect(onExpire).not.toHaveBeenCalled();

      vi.useRealTimers();
    });

    it("UndoToast: handles 0ms and negative durationMs gracefully without throwing", () => {
      vi.useFakeTimers();
      const onExpire = vi.fn();

      const { rerender } = render(
        <UndoToast label="Fast" onUndo={() => {}} onExpire={onExpire} durationMs={0} />,
      );
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(onExpire).toHaveBeenCalledTimes(1);

      rerender(<UndoToast label="Negative" onUndo={() => {}} onExpire={onExpire} durationMs={-100} />);
      vi.useRealTimers();
    });

    it("GettingStarted: survives rapid query cache transitions and storage state flapping", async () => {
      const qc = createTestQueryClient();
      seedStandardCache(qc);
      renderWithHarness(<GettingStarted />, qc);

      // Rapidly toggle ps entries between empty array, null, multiple rigs
      for (let i = 0; i < 30; i++) {
        act(() => {
          if (i % 3 === 0) qc.setQueryData(["ps", "local"], []);
          else if (i % 3 === 1) qc.setQueryData(["ps", "local"], [{ rigId: `rig-${i}`, name: `rig-${i}` }]);
          else qc.setQueryData(["ps", "local"], null);
        });
      }

      // Settle on valid empty ps
      act(() => {
        qc.setQueryData(["ps", "local"], []);
      });

      const card = await screen.findByTestId("getting-started");
      expect(card).toBeTruthy();

      // Dismiss button click
      const dismissBtn = screen.getByText("Dismiss");
      fireEvent.click(dismissBtn);
      expect(window.localStorage.getItem(GETTING_STARTED_DISMISSED_KEY)).toBe("1");
      expect(screen.queryByTestId("getting-started")).toBeNull();
    });

    it("LaunchRecoveryModal: survives 50 rapid open/close cycles and policy toggling", async () => {
      mockFetch.mockImplementation((url: unknown) => {
        if (String(url).includes("/launch-plan")) return jsonResponse(SAMPLE_PLAN);
        return jsonResponse({});
      });

      const qc = createTestQueryClient();
      function ModalWrapper({ open, rigId, rigName }: { open: boolean; rigId: string; rigName: string }) {
        return (
          <QueryClientProvider client={qc}>
            <LaunchRecoveryModal rigId={rigId} rigName={rigName} open={open} onOpenChange={() => {}} />
          </QueryClientProvider>
        );
      }

      let isOpen = false;
      const { rerender } = render(<ModalWrapper open={isOpen} rigId="rig-alpha" rigName="Alpha" />);

      // Rapid open/close flapping
      for (let i = 0; i < 20; i++) {
        isOpen = i % 2 === 0;
        rerender(
          <ModalWrapper
            open={isOpen}
            rigId={i % 3 === 0 ? "rig-alpha" : `rig-${i}`}
            rigName={`Rig ${i}`}
          />,
        );
      }

      // Settle on open
      rerender(<ModalWrapper open={true} rigId="rig-alpha" rigName="Alpha" />);

      await screen.findByTestId("launch-recovery-modal");
      await screen.findByTestId("launch-plan-table");

      // Rapid policy toggling between restore-original and fresh
      const freshBtn = screen.getByTestId("launch-policy-fresh");
      const restoreBtn = screen.getByTestId("launch-policy-restore-original");

      for (let i = 0; i < 20; i++) {
        fireEvent.click(i % 2 === 0 ? freshBtn : restoreBtn);
      }

      // Verify no runtime exceptions occurred
      expect(screen.getByTestId("launch-recovery-modal")).toBeTruthy();
    });

    it("LaunchRecoveryModal: gracefully handles network failure / 500 error from launch-plan", async () => {
      mockFetch.mockImplementation((url: unknown) => {
        if (String(url).includes("/launch-plan")) {
          return Promise.resolve({
            ok: false,
            status: 500,
            json: async () => ({ message: "Internal server error" }),
          } as Response);
        }
        return jsonResponse({});
      });

      renderWithHarness(
        <LaunchRecoveryModal rigId="rig-alpha" rigName="Alpha" open={true} onOpenChange={() => {}} />,
      );

      await screen.findByTestId("launch-recovery-modal");
      const errorMsg = await screen.findByTestId("launch-plan-error");
      expect(errorMsg.textContent).toContain("Could not fetch plan");
    });

    it("RigStatusControl: survives rapid status mutations and malformed payload resilience", async () => {
      const qc = createTestQueryClient();
      function StatusWrapper({ rigId, rigName }: { rigId: string; rigName: string }) {
        return (
          <QueryClientProvider client={qc}>
            <RigStatusControl rigId={rigId} rigName={rigName} />
          </QueryClientProvider>
        );
      }

      const { rerender } = render(<StatusWrapper rigId="rig-alpha" rigName="Alpha" />);

      // Loading state check
      expect(screen.getByText("Loading rig status…")).toBeTruthy();

      // Stress: rapid mutation through various statuses and malformed objects
      const statusStates = [
        SAMPLE_STATUS_UP,
        SAMPLE_STATUS_BLOCKED,
        { ...SAMPLE_STATUS_UP, status: "partial" as const, seatsRunning: 1 },
        { ...SAMPLE_STATUS_UP, status: "down" as const, seatsRunning: 0 },
        { rigName: "Broken", src: "not an array" }, // Malformed
        null, // Null response
        {}, // Empty object
        SAMPLE_STATUS_UP,
      ];

      for (const st of statusStates) {
        act(() => {
          qc.setQueryData(["rig", "rig-alpha", "status"], st);
        });
        rerender(<StatusWrapper rigId="rig-alpha" rigName="Alpha" />);
      }

      // Settle on valid status
      act(() => {
        qc.setQueryData(["rig", "rig-alpha", "status"], SAMPLE_STATUS_UP);
      });

      await screen.findByTestId("rig-status-control-rig-alpha");
      const primaryBtn = screen.getByTestId("rig-primary-action-rig-alpha");
      expect(primaryBtn.textContent).toContain("Running");
    });
  });

  // =========================================================================
  // DIMENSION 4: Dynamic Dark Mode Switching Stress Harness
  // =========================================================================
  describe("Dimension 4: Dynamic Theme Switching Stress Loop", () => {
    it("renders tokenized components concurrently and toggles .dark 100 times without runtime errors", async () => {
      mockFetch.mockImplementation((url: unknown) => {
        if (String(url).includes("/status")) return jsonResponse(SAMPLE_STATUS_UP);
        if (String(url).includes("/launch-plan")) return jsonResponse(SAMPLE_PLAN);
        if (String(url).includes("/api/ps")) return jsonResponse([]);
        if (String(url).includes("/specs/library")) return jsonResponse([]);
        return jsonResponse({});
      });

      const qc = createTestQueryClient();
      seedStandardCache(qc, { status: SAMPLE_STATUS_UP });

      renderWithHarness(
        <div data-testid="stress-harness" className="space-y-4">
          <UndoToast label="Toast Message" onUndo={() => {}} onExpire={() => {}} durationMs={10000} />
          <GettingStarted />
          <RigStatusControl rigId="rig-alpha" rigName="Alpha" />
          <LaunchRecoveryModal rigId="rig-alpha" rigName="Alpha" open={true} onOpenChange={() => {}} />
        </div>,
        qc,
      );

      // Verify all components rendered
      expect(await screen.findByTestId("undo-toast")).toBeTruthy();
      expect(await screen.findByTestId("getting-started")).toBeTruthy();
      expect(await screen.findByTestId("rig-status-control-rig-alpha")).toBeTruthy();
      expect(await screen.findByTestId("launch-recovery-modal")).toBeTruthy();

      // Stress: rapid .dark class toggling on root element
      for (let i = 0; i < 100; i++) {
        if (i % 2 === 0) {
          document.documentElement.classList.add("dark");
        } else {
          document.documentElement.classList.remove("dark");
        }
      }

      // Final check: DOM remains consistent and no error occurred
      expect(screen.getByTestId("undo-toast")).toBeTruthy();
      expect(screen.getByTestId("getting-started")).toBeTruthy();
      expect(screen.getByTestId("rig-status-control-rig-alpha")).toBeTruthy();
      expect(screen.getByTestId("launch-recovery-modal")).toBeTruthy();
    });
  });
});
