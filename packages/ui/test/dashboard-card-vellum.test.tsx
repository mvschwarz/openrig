// Dashboard source-level tests.
//
// C10 (Dashboard v2) replaced the OPR.0.4.1.14 paper-draft launcher surface
// (fidelity-glyphs + Field Environment + drafting footer) with the
// needs-you / tiles / rigs / activity composition. Per rule 4, the three
// assertions below that encoded the OLD launcher copy/layout were rewritten
// to assert the new surface; the legacy vellum primitives stay intact for
// /lab/vellum-lab (unchanged tests at the bottom).

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

describe("Dashboard (C10 v2 composition)", () => {
  it("Dashboard.tsx composes the v2 needs-you surface (no vellum launcher)", () => {
    // C10: the vellum launcher decorations are gone from THIS component
    // (files stay for /lab/vellum-lab).
    expect(DASHBOARD_SRC).not.toContain('from "./vellum/fidelity-glyphs.js"');
    expect(DASHBOARD_SRC).not.toContain('import "./dashboard-fidelity.css"');
    expect(DASHBOARD_SRC).not.toContain("df-root");
    expect(DASHBOARD_SRC).not.toContain("DestinationsLayer");
    expect(DASHBOARD_SRC).not.toContain("TopLayerContent");
    // The new surface: needs-you + tiles + rigs + activity + host section.
    expect(DASHBOARD_SRC).toContain("dashboard-needs-you");
    expect(DASHBOARD_SRC).toContain("dashboard-rigs");
    expect(DASHBOARD_SRC).toContain("dashboard-activity");
    expect(DASHBOARD_SRC).toContain("dashboard-host-section");
    expect(DASHBOARD_SRC).toContain("KernelStatusCard");
  });

  it("Dashboard.tsx links to the v2 destinations (import / new rig / tiles)", () => {
    for (const route of ["/import", "/specs/rig", "/topology", "/for-you", "/agents", "/settings/status"]) {
      expect(DASHBOARD_SRC).toContain(`"${route}"`);
    }
  });

  it("Dashboard.tsx wires the v2 real-data hooks", () => {
    // C10: ps + attention + daemon health + activity feed (+ nodes via useAllAgents).
    expect(DASHBOARD_SRC).toContain("usePsEntries");
    expect(DASHBOARD_SRC).toContain("useAttentionItems");
    expect(DASHBOARD_SRC).toContain("useDaemonHealth");
    expect(DASHBOARD_SRC).toContain("useActivityFeed");
    expect(DASHBOARD_SRC).toContain("useFeedSubscriptions");
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
