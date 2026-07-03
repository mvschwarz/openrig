// Dashboard source-level tests.
//
// OPR.0.4.1.14 — the Dashboard route is now the founder-LOCKED fidelity
// refresh: a paper-draft launcher grid + Field Environment + drafting footer
// built from ./vellum/fidelity-glyphs.js + the scoped ./dashboard-fidelity.css.
// The legacy big-numeral vellum primitives (DestinationsLayer / TopLayerContent
// / VellumDestinationCard / etc.) are NO LONGER used by the production
// dashboard — they are retained only for the /lab/vellum-lab design
// experiment. This test verifies (a) Dashboard.tsx composes the new fidelity
// surface + wires the right real-data hooks, and (b) the legacy primitives are
// still intact for the lab.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

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

describe("Dashboard (OPR.0.4.1.14 fidelity refresh)", () => {
  it("Dashboard.tsx composes the fidelity launcher surface", () => {
    // New fidelity primitives + scoped stylesheet.
    expect(DASHBOARD_SRC).toContain('from "./vellum/fidelity-glyphs.js"');
    expect(DASHBOARD_SRC).toContain('import "./dashboard-fidelity.css"');
    // Paper-draft surface + Field Environment + footer.
    expect(DASHBOARD_SRC).toContain("df-root");
    expect(DASHBOARD_SRC).toContain("FieldEnvironment");
    expect(DASHBOARD_SRC).toContain("DashboardFooter");
    // The legacy big-numeral layer composition is gone from the production
    // dashboard (moved to lab-only).
    expect(DASHBOARD_SRC).not.toContain("DestinationsLayer");
    expect(DASHBOARD_SRC).not.toContain("TopLayerContent");
  });

  it("Dashboard.tsx declares all 6 destinations with their routes (no behaviour change)", () => {
    for (const route of ["/topology", "/project", "/for-you", "/specs", "/search", "/settings"]) {
      expect(DASHBOARD_SRC).toContain(`to: "${route}"`);
    }
    for (const num of ["01", "02", "03", "04", "05", "06"]) {
      expect(DASHBOARD_SRC).toContain(`num: "${num}"`);
    }
  });

  it("Dashboard.tsx wires real-data hooks for the Field Environment", () => {
    // OPR.0.4.1.14 functional refinement: STATION/RIGS/AGENTS/OPERATOR were
    // already real; VERSION is the new real wire (running daemon version). The
    // active sub-count was dropped (AGENTS is a single live count per its row).
    expect(DASHBOARD_SRC).toContain("useRigSummary");
    expect(DASHBOARD_SRC).toContain("usePsEntries");
    expect(DASHBOARD_SRC).toContain("useSettings");
    expect(DASHBOARD_SRC).toContain("useDaemonVersion");
    expect(DASHBOARD_SRC).toContain("totalRigs");
    expect(DASHBOARD_SRC).toContain("totalAgents");
    expect(DASHBOARD_SRC).toContain("version");
    expect(DASHBOARD_SRC).toContain("hostname");
  });

  // ── Legacy vellum primitives — retained ONLY for /lab/vellum-lab ──────────
  it("legacy DestinationsLayer still declares all 6 routes (lab primitive intact)", () => {
    for (const route of ["/topology", "/project", "/for-you", "/specs", "/search", "/settings"]) {
      expect(DESTINATIONS_LAYER_SRC).toContain(`to="${route}"`);
    }
    for (const num of ["01", "02", "03", "04", "05", "06"]) {
      expect(DESTINATIONS_LAYER_SRC).toContain(`num="${num}"`);
    }
  });

  it("legacy VellumDestinationCard keeps the numeral layout (lab primitive intact)", () => {
    expect(DESTINATIONS_LAYER_SRC).toContain('layout="numeral"');
    expect(CARD_SRC).toContain("NumeralLayout");
    expect(CARD_SRC).toContain("CornerBracket");
    expect(CARD_SRC).toContain("backdrop-blur-[10px]");
    expect(CARD_SRC).toContain("bg-surface-low/45");
  });

  it("legacy TopLayerContent keeps its classification chrome (lab primitive intact)", () => {
    expect(TOP_LAYER_SRC).toContain("Welcome back");
    expect(TOP_LAYER_SRC).toContain("(s*)");
    expect(TOP_LAYER_SRC).toContain("Operator");
    expect(TOP_LAYER_SRC).toContain("Field Station");
    expect(TOP_LAYER_SRC).toContain("Eyes Everywhere");
    expect(TOP_LAYER_SRC).toContain("backdrop-blur-[6px]");
  });
});
