// V1 attempt-3 Phase 5 P5-7 — Topology terminal grid (safe-N + pulsing-ring).
//
// Coverage:
//   - safe-N pagination: with > 12 seats, only 12 cards render by default;
//     "show all N" toggle reveals the rest.
//   - Pulsing-ring: active seats render with terminal-card-active class
//     (CSS keyframe is paint-only — pseudo-element-paint test contract
//     ritual #7; CSS-source-assertion guards the @keyframes rule).
//   - data-active attribute reflects activity state.
//   - Empty state when no seats.
//   - Pod scope filters by podName.
//
// Pseudo-element-paint contract: jsdom can't render @keyframes. The
// CSS-source-assertion test reads globals.css and asserts the
// @keyframes terminal-card-active-frames rule + .terminal-card-active
// selector are present — guards the at-a-glance scan signal from being
// silently removed in a refactor.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import path from "node:path";
import { TopologyTerminalView } from "../src/components/topology/TopologyTerminalView.js";
import type { NodeInventoryEntry } from "../src/hooks/useNodeInventory.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
});

afterEach(() => {
  cleanup();
});

function withQueryClient(ui: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

function makeSeat(opts: {
  rigId?: string;
  logicalId: string;
  pod?: string;
  active?: boolean;
  runtime?: string;
  contextUsedPercentage?: number;
  contextTotalInputTokens?: number;
  contextTotalOutputTokens?: number;
}): NodeInventoryEntry {
  return {
    rigId: opts.rigId ?? "rig-1",
    rigName: "test-rig",
    logicalId: opts.logicalId,
    podId: opts.pod ?? "default",
    podNamespace: opts.pod ?? "default",
    canonicalSessionName: `${opts.logicalId}@test-rig`,
    nodeKind: "agent",
    runtime: opts.runtime ?? "claude-code",
    sessionStatus: "running",
    startupStatus: "ready",
    restoreOutcome: "n-a",
    tmuxAttachCommand: null,
    resumeCommand: null,
    latestError: null,
    agentActivity: opts.active
      ? {
          state: "running",
          reason: "test",
          evidenceSource: "test",
          sampledAt: "2026-05-06T18:00:00Z",
        }
      : { state: "idle", reason: "test", evidenceSource: "test", sampledAt: "2026-05-06T18:00:00Z" },
    contextUsage: typeof opts.contextUsedPercentage === "number"
      ? {
          usedPercentage: opts.contextUsedPercentage,
          remainingPercentage: 100 - opts.contextUsedPercentage,
          contextWindowSize: 320000,
          availability: "known",
          sampledAt: "2026-05-09T10:00:00Z",
          fresh: true,
          totalInputTokens: opts.contextTotalInputTokens ?? null,
          totalOutputTokens: opts.contextTotalOutputTokens ?? null,
        }
      : undefined,
  };
}

function setupFetch(opts: {
  rigs?: Array<{ id: string; name: string }>;
  seatsByRig?: Record<string, NodeInventoryEntry[]>;
}) {
  mockFetch.mockImplementation(async (url: string) => {
    if (url.includes("/api/rigs/summary")) {
      return new Response(JSON.stringify(opts.rigs ?? []));
    }
    const m = url.match(/\/api\/rigs\/([^/]+)\/nodes/);
    if (m) {
      const rigId = decodeURIComponent(m[1]!);
      return new Response(JSON.stringify(opts.seatsByRig?.[rigId] ?? []));
    }
    // SessionPreviewPane fetches /api/preview/session/:name etc.
    return new Response(JSON.stringify({
      sessionName: "test", content: "", lines: 0, capturedAt: new Date().toISOString(),
    }));
  });
}

describe("TopologyTerminalView P5-7 grid", () => {
  it("rig scope: renders one card per seat under safe-N=12", async () => {
    const seats = [
      makeSeat({ logicalId: "orch.lead" }),
      makeSeat({ logicalId: "review.lead" }),
      makeSeat({ logicalId: "driver.impl", active: true }),
    ];
    setupFetch({ rigs: [{ id: "rig-1", name: "test-rig" }], seatsByRig: { "rig-1": seats } });
    const { findByTestId, container } = withQueryClient(
      <TopologyTerminalView scope="rig" rigId="rig-1" />,
    );
    expect(await findByTestId("topology-terminal-grid")).toBeTruthy();
    expect(await findByTestId("terminal-card-rig-1-orch.lead")).toBeTruthy();
    expect(await findByTestId("terminal-card-rig-1-driver.impl")).toBeTruthy();
    // Active seat carries data-active='true' AND the pulse class.
    const driverCard = container.querySelector(
      "[data-testid='terminal-card-rig-1-driver.impl']",
    );
    expect(driverCard?.getAttribute("data-active")).toBe("true");
    expect(driverCard?.className).toMatch(/terminal-card-active/);
    // Idle seat does NOT carry the pulse class.
    const idleCard = container.querySelector(
      "[data-testid='terminal-card-rig-1-orch.lead']",
    );
    expect(idleCard?.getAttribute("data-active")).toBe("false");
    expect(idleCard?.className ?? "").not.toMatch(/terminal-card-active/);
  });

  it("safe-N pagination: with > 12 seats, default shows 12; toggle reveals all", async () => {
    const seats: NodeInventoryEntry[] = [];
    for (let i = 0; i < 15; i++) {
      seats.push(makeSeat({ logicalId: `seat${i.toString().padStart(2, "0")}` }));
    }
    setupFetch({ rigs: [{ id: "rig-1", name: "test-rig" }], seatsByRig: { "rig-1": seats } });
    const { findByTestId, container } = withQueryClient(
      <TopologyTerminalView scope="rig" rigId="rig-1" />,
    );
    await findByTestId("topology-terminal-grid");
    // Default: 12 cards visible.
    expect(
      container.querySelectorAll("[data-testid^='terminal-card-rig-1-']").length,
    ).toBe(12);
    expect((await findByTestId("topology-terminal-count")).textContent).toContain("12 of 15");
    // Toggle: show all.
    const toggle = await findByTestId("topology-terminal-show-toggle");
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(
        container.querySelectorAll("[data-testid^='terminal-card-rig-1-']").length,
      ).toBe(15);
    });
  });

  it("pod scope filters seats by podName", async () => {
    const seats = [
      makeSeat({ logicalId: "orch.lead", pod: "orch" }),
      makeSeat({ logicalId: "driver.impl", pod: "implementation" }),
      makeSeat({ logicalId: "qa.codex", pod: "implementation" }),
    ];
    setupFetch({ rigs: [{ id: "rig-1", name: "test-rig" }], seatsByRig: { "rig-1": seats } });
    const { findByTestId, container } = withQueryClient(
      <TopologyTerminalView scope="pod" rigId="rig-1" podName="implementation" />,
    );
    await findByTestId("topology-terminal-grid");
    expect(container.querySelector("[data-testid='terminal-card-rig-1-orch.lead']")).toBeNull();
    expect(container.querySelector("[data-testid='terminal-card-rig-1-driver.impl']")).toBeTruthy();
    expect(container.querySelector("[data-testid='terminal-card-rig-1-qa.codex']")).toBeTruthy();
  });

  it("renders Codex context percentage and token total in terminal cards", async () => {
    const seats = [
      makeSeat({
        logicalId: "guard.codex",
        runtime: "codex",
        contextUsedPercentage: 21,
        contextTotalInputTokens: 54000,
        contextTotalOutputTokens: 615,
      }),
    ];
    setupFetch({ rigs: [{ id: "rig-1", name: "test-rig" }], seatsByRig: { "rig-1": seats } });
    const { findByTestId } = withQueryClient(
      <TopologyTerminalView scope="rig" rigId="rig-1" />,
    );
    const context = await findByTestId("terminal-card-context-rig-1-guard.codex");
    const tokens = await findByTestId("terminal-card-tokens-rig-1-guard.codex");
    expect(context.textContent).toBe("21%");
    expect(tokens.textContent).toBe("55k");
    expect(tokens.getAttribute("title")).toContain("Tokens: 54,615");
  });

  it("renders unknown context affordance when terminal cards have no sample", async () => {
    const seats = [makeSeat({ logicalId: "orch.lead" })];
    setupFetch({ rigs: [{ id: "rig-1", name: "test-rig" }], seatsByRig: { "rig-1": seats } });
    const { findByTestId } = withQueryClient(
      <TopologyTerminalView scope="rig" rigId="rig-1" />,
    );
    expect((await findByTestId("terminal-card-context-rig-1-orch.lead")).textContent).toBe("--");
    expect((await findByTestId("terminal-card-tokens-rig-1-orch.lead")).textContent).toBe("--");
  });

  it("empty state when scope has no agent seats", async () => {
    setupFetch({ rigs: [{ id: "rig-1", name: "test-rig" }], seatsByRig: { "rig-1": [] } });
    const { findByTestId } = withQueryClient(
      <TopologyTerminalView scope="rig" rigId="rig-1" />,
    );
    expect(await findByTestId("topology-terminal-empty")).toBeTruthy();
  });

  it("host scope with no rigs renders empty state", async () => {
    setupFetch({ rigs: [] });
    const { findByTestId } = withQueryClient(<TopologyTerminalView scope="host" />);
    expect(await findByTestId("topology-terminal-empty")).toBeTruthy();
  });
});

describe("globals.css pulsing-ring CSS contract (ritual #7 pseudo-element-paint)", () => {
  const cssPath = path.resolve(__dirname, "../src/globals.css");
  it("globals.css declares @keyframes terminal-card-active-frames", () => {
    const src = readFileSync(cssPath, "utf8");
    expect(src).toMatch(/@keyframes\s+terminal-card-active-frames/);
  });
  it("globals.css declares .terminal-card-active selector binding the keyframes", () => {
    const src = readFileSync(cssPath, "utf8");
    expect(src).toMatch(/\.terminal-card-active\s*\{[^}]*animation:\s*terminal-card-active-frames/);
  });
  it("globals.css honors prefers-reduced-motion for terminal-card-active", () => {
    const src = readFileSync(cssPath, "utf8");
    // Reduced-motion block must include .terminal-card-active so the pulse
    // animation is suppressed for users with motion-sensitivity preferences.
    const reducedMotion = src.match(/@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\}\s*\}/);
    expect(reducedMotion).not.toBeNull();
    expect(reducedMotion![0]).toMatch(/\.terminal-card-active/);
  });
});
