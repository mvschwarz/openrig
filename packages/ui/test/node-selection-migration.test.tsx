// V1 attempt-3 Phase 5 P5-4 — negative-assertion regression guard (ritual #8).
//
// The legacy 'node' kind was retired from DrawerSelection union in P5-4. The
// canonical 'seat-detail' kind (Phase 4) now covers all seat-detail surfaces
// (graph node click via useNodeSelection alias; Explorer seat-leaf click; any
// SeatDetailTrigger-wrapped surface). SeatDetailViewer wraps NodeDetailPanel
// inside the canonical 38rem drawer chrome — fixes the founder-noticed
// "graph node click → full-width panel with empty whitespace on left" bug
// that was caused by the legacy 'node' branch routing NodeDetailPanel
// directly past the drawer chrome's width-coupling.
//
// This test is the source-assertion guard against re-introduction of the
// 'node' discriminator (parallel to the P5-1 SC-20 source-assertion + the
// rig-graph pod-group negative-assertion already in place).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const SHARED_DETAIL_DRAWER_PATH = path.resolve(
  __dirname,
  "../src/components/SharedDetailDrawer.tsx",
);
const APP_SHELL_PATH = path.resolve(__dirname, "../src/components/AppShell.tsx");
const EXPLORER_PATH = path.resolve(__dirname, "../src/components/Explorer.tsx");

describe("P5-4: legacy 'node' kind retired from DrawerSelection (negative-assertion)", () => {
  it("SharedDetailDrawer.tsx DrawerSelection union does NOT contain 'node' kind", () => {
    const src = readFileSync(SHARED_DETAIL_DRAWER_PATH, "utf8");
    // Find the DrawerSelection union declaration block.
    const unionMatch = src.match(/export type DrawerSelection =[\s\S]*?\| null;/);
    expect(unionMatch).not.toBeNull();
    const unionBlock = unionMatch![0];
    // Negative-assertion: '{ type: "node"' must NOT appear in the union.
    expect(unionBlock).not.toMatch(/\{\s*type:\s*["']node["']/);
    // Positive companion: 'seat-detail' kind IS present (canonical surface).
    expect(unionBlock).toMatch(/\{\s*type:\s*["']seat-detail["']/);
  });

  it("SharedDetailDrawer.tsx routing does NOT branch on selection.type === 'node'", () => {
    const src = readFileSync(SHARED_DETAIL_DRAWER_PATH, "utf8");
    // Negative-assertion: legacy `if (selection.type === "node")` routing branch
    // must be gone (it routed directly to NodeDetailPanel past the drawer chrome).
    expect(src).not.toMatch(/selection\.type\s*===\s*["']node["']/);
    // Positive companion: 'seat-detail' branch still routes via SeatDetailViewer.
    expect(src).toMatch(/selection\.type\s*===\s*["']seat-detail["']/);
  });

  it("SharedDetailDrawer.tsx no longer imports NodeDetailPanel directly (uses SeatDetailViewer wrapper)", () => {
    const src = readFileSync(SHARED_DETAIL_DRAWER_PATH, "utf8");
    // After P5-4, NodeDetailPanel reaches drawer ONLY through SeatDetailViewer
    // (which is the canonical wrapper). SharedDetailDrawer.tsx imports
    // SeatDetailViewer, NOT NodeDetailPanel directly.
    expect(src).not.toMatch(/import\s*\{\s*NodeDetailPanel\s*\}\s*from\s*["']\.\/NodeDetailPanel\.js["']/);
    expect(src).toMatch(/import\s*\{\s*SeatDetailViewer\s*\}/);
  });

  it("AppShell.tsx useNodeSelection alias coerces to/from 'seat-detail' (NOT 'node')", () => {
    const src = readFileSync(APP_SHELL_PATH, "utf8");
    // Find useNodeSelection function block.
    const fnMatch = src.match(/export function useNodeSelection\(\)[\s\S]*?^\}/m);
    expect(fnMatch).not.toBeNull();
    const fnBlock = fnMatch![0];
    // Negative-assertion: legacy 'node' kind reads/writes are gone.
    expect(fnBlock).not.toMatch(/selection\??\.type\s*===\s*["']node["']/);
    expect(fnBlock).not.toMatch(/type:\s*["']node["']/);
    // Positive companion: alias now uses 'seat-detail'.
    expect(fnBlock).toMatch(/selection\??\.type\s*===\s*["']seat-detail["']/);
    expect(fnBlock).toMatch(/type:\s*["']seat-detail["']/);
  });

  it("Explorer.tsx seat-leaf selection state + onClick use 'seat-detail' kind (NOT 'node')", () => {
    const src = readFileSync(EXPLORER_PATH, "utf8");
    // The DrawerSelection 'node' kind appears in two distinct contexts in this
    // file:
    //   1) Pod-leaf seat selection (PodBranch + ungrouped pod fallback).
    //   2) Auto-expand predicate at the rig branch level.
    // All three should be migrated to 'seat-detail'.
    //
    // Negative-assertion (file-wide): no remaining `{ type: "node"` literal.
    // (DiscoveryPlacementTarget.kind === "node" is a SEPARATE namespace —
    // discovery placement, not DrawerSelection — and is allowed elsewhere; but
    // Explorer.tsx itself should not contain DrawerSelection's 'node' kind.)
    expect(src).not.toMatch(/\{\s*type:\s*["']node["']/);
    // selection?.type === "node" must be gone too.
    expect(src).not.toMatch(/selection\?\.type\s*===\s*["']node["']/);
    // Positive companion: 'seat-detail' is the new discriminator at all
    // 3 spots (count is at least 3; 2 onClick + 1 isSelected predicates).
    const seatDetailMatches = src.match(/["']seat-detail["']/g) ?? [];
    expect(seatDetailMatches.length).toBeGreaterThanOrEqual(3);
  });
});
