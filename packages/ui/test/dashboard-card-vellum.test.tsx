// V0.3.1 dashboard showcase tests — updated 2026-05-14 for the vellum
// refactor. Dashboard.tsx is now a thin composition over the primitives
// in src/components/dashboard/vellum/, so the source-level assertions
// for routes / numerals / classification chrome moved out of
// Dashboard.tsx into the extracted files. This test verifies both
// layers: (a) Dashboard.tsx imports the right primitives + wires the
// right hooks, and (b) the extracted primitives carry the expected
// schematic vocabulary.

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// Hook mocks kept for future render-based tests; not used by the
// source-level assertions here.
vi.mock("../src/hooks/useRigSummary.js", () => ({
  useRigSummary: () => ({ data: [{ id: "r1", name: "test-rig", nodeCount: 4 }] }),
}));
vi.mock("../src/hooks/usePsEntries.js", () => ({
  usePsEntries: () => ({ data: [{ runningCount: 4 }] }),
}));
vi.mock("../src/hooks/useSpecLibrary.js", () => ({
  useSpecLibrary: () => ({ data: new Array(38).fill({}) }),
}));

const DASHBOARD_SRC = readFileSync(
  path.resolve(__dirname, "../src/components/dashboard/Dashboard.tsx"),
  "utf8",
);
const DESTINATIONS_LAYER_SRC = readFileSync(
  path.resolve(__dirname, "../src/components/dashboard/vellum/DestinationsLayer.tsx"),
  "utf8",
);
const TOP_LAYER_SRC = readFileSync(
  path.resolve(__dirname, "../src/components/dashboard/vellum/TopLayerContent.tsx"),
  "utf8",
);
const CARD_SRC = readFileSync(
  path.resolve(__dirname, "../src/components/dashboard/vellum/VellumDestinationCard.tsx"),
  "utf8",
);

describe("Dashboard (vellum refactor — thin composition)", () => {
  it("Dashboard.tsx is a thin composition over the vellum primitives", () => {
    // Imports from the vellum barrel — verifying single source of truth.
    expect(DASHBOARD_SRC).toContain('from "./vellum/index.js"');
    expect(DASHBOARD_SRC).toContain("BackLayerContent");
    expect(DASHBOARD_SRC).toContain("BackVellumSheet");
    expect(DASHBOARD_SRC).toContain("MidLayerContent");
    expect(DASHBOARD_SRC).toContain("TopLayerContent");
    expect(DASHBOARD_SRC).toContain("DestinationsLayer");
  });

  it("Dashboard.tsx wires real-data hooks for stats + library count", () => {
    expect(DASHBOARD_SRC).toContain("useRigSummary");
    expect(DASHBOARD_SRC).toContain("usePsEntries");
    expect(DASHBOARD_SRC).toContain("useSpecLibrary");
    expect(DASHBOARD_SRC).toContain("totalRigs");
    expect(DASHBOARD_SRC).toContain("totalAgents");
    expect(DASHBOARD_SRC).toContain("activeAgents");
    expect(DASHBOARD_SRC).toContain("librarySize");
    expect(DASHBOARD_SRC).toContain("hostname");
  });

  it("DestinationsLayer declares all 6 destination cards with correct routes", () => {
    const expectedRoutes = [
      "/topology",
      "/project",
      "/for-you",
      "/specs",
      "/search",
      "/settings",
    ];
    for (const route of expectedRoutes) {
      expect(DESTINATIONS_LAYER_SRC).toContain(`to="${route}"`);
    }
    // Each card carries a num prop (01–06) that becomes the dashboard-card
    // testid. Verify all 6 are present.
    for (const num of ["01", "02", "03", "04", "05", "06"]) {
      expect(DESTINATIONS_LAYER_SRC).toContain(`num="${num}"`);
    }
  });

  it("VellumDestinationCard renders the iter-15 numeral layout (production default)", () => {
    // Numeral layout = big stacked numeral (0¹ / 0²) on the left of
    // each card per the iter-15-clean reference visual. Other layouts
    // (schematic / headline / stat / coordinate) ship for spike
    // comparison but the production dashboard pins numeral.
    expect(DESTINATIONS_LAYER_SRC).toContain('layout="numeral"');
    expect(CARD_SRC).toContain("NumeralLayout");
    expect(CARD_SRC).toContain("CornerBracket");
    // Per-card surface uses the vellum vocabulary (translucent tint +
    // backdrop-blur).
    expect(CARD_SRC).toContain("backdrop-blur-[10px]");
    expect(CARD_SRC).toContain("bg-stone-100/45");
  });

  it("TopLayerContent carries the classification + WELCOME BACK chrome", () => {
    // Welcome hero with the (s*) annotation.
    expect(TOP_LAYER_SRC).toContain("Welcome back");
    expect(TOP_LAYER_SRC).toContain("(s*)");
    // Classification eyebrow strings.
    expect(TOP_LAYER_SRC).toContain("Operator");
    expect(TOP_LAYER_SRC).toContain("OpenRig · 0.3.1");
    expect(TOP_LAYER_SRC).toContain("Field Station");
    // Bottom-right printed mark.
    expect(TOP_LAYER_SRC).toContain("Eyes Everywhere");
    // Vellum vocabulary on the back sheet shows up via the eyebrow's
    // backdrop-blur strip.
    expect(TOP_LAYER_SRC).toContain("backdrop-blur-[6px]");
  });
});
