// V1 polish slice Phase 5.1 P5.1-1 + DRIFT P5.1-D2 — drawer-as-seat-detail
// retirement regression guard (negative-assertion ritual #8).
//
// Originally Phase 5 P5-4 negative-assertion that the legacy 'node' kind
// had been retired from DrawerSelection in favor of 'seat-detail'. At V1
// polish Phase 5.1 supersedes the seat-detail-as-drawer
// pattern entirely: graph + tree + table all navigate to the canonical
// /topology/seat/$rigId/$logicalId center page (LiveNodeDetails). The
// drawer surface is reserved for content viewers (qitem / file / sub-spec)
// per content-drawer.md L23-L34.
//
// This file converts the prior P5-4 negative-assertion into the broader
// P5.1-D2 retirement guard:
//   - NodeDetailPanel.tsx file does NOT exist
//   - SeatDetailViewer.tsx file does NOT exist
//   - SeatDetailTrigger.tsx file does NOT exist
//   - 'seat-detail' kind absent from DrawerSelection union
//   - 'node' kind absent from DrawerSelection union (preserved from P5-4)
//   - useNodeSelection function absent from AppShell (alias retired)
//   - RigGraph node click uses useNavigate (not setSelection / not
//     setSelectedNode)

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import path from "node:path";

const SRC = path.resolve(__dirname, "../src");
const SHARED_DETAIL_DRAWER_PATH = path.join(SRC, "components/SharedDetailDrawer.tsx");
const APP_SHELL_PATH = path.join(SRC, "components/AppShell.tsx");
const RIG_GRAPH_PATH = path.join(SRC, "components/RigGraph.tsx");
const NODE_DETAIL_PANEL_PATH = path.join(SRC, "components/NodeDetailPanel.tsx");
const SEAT_DETAIL_VIEWER_PATH = path.join(SRC, "components/drawer-viewers/SeatDetailViewer.tsx");
const SEAT_DETAIL_TRIGGER_PATH = path.join(SRC, "components/drawer-triggers/SeatDetailTrigger.tsx");

describe("P5.1-D2 retirement regression: drawer-as-seat-detail removed", () => {
  it("NodeDetailPanel.tsx file does NOT exist (component retired)", () => {
    expect(existsSync(NODE_DETAIL_PANEL_PATH)).toBe(false);
  });

  it("SeatDetailViewer.tsx file does NOT exist (drawer wrapper retired)", () => {
    expect(existsSync(SEAT_DETAIL_VIEWER_PATH)).toBe(false);
  });

  it("SeatDetailTrigger.tsx file does NOT exist (trigger primitive retired)", () => {
    expect(existsSync(SEAT_DETAIL_TRIGGER_PATH)).toBe(false);
  });

  it("DrawerSelection union does NOT contain 'seat-detail' kind", () => {
    const src = readFileSync(SHARED_DETAIL_DRAWER_PATH, "utf8");
    const unionMatch = src.match(/export type DrawerSelection =[\s\S]*?\| null;/);
    expect(unionMatch).not.toBeNull();
    const unionBlock = unionMatch![0];
    expect(unionBlock).not.toMatch(/\{\s*type:\s*["']seat-detail["']/);
  });

  it("DrawerSelection union does NOT contain legacy 'node' kind (P5-4 preserved)", () => {
    const src = readFileSync(SHARED_DETAIL_DRAWER_PATH, "utf8");
    const unionMatch = src.match(/export type DrawerSelection =[\s\S]*?\| null;/);
    const unionBlock = unionMatch![0];
    expect(unionBlock).not.toMatch(/\{\s*type:\s*["']node["']/);
  });

  it("SharedDetailDrawer routing has NO 'seat-detail' branch", () => {
    const src = readFileSync(SHARED_DETAIL_DRAWER_PATH, "utf8");
    expect(src).not.toMatch(/selection\.type\s*===\s*["']seat-detail["']/);
    expect(src).not.toMatch(/selection\.type\s*===\s*["']node["']/);
  });

  it("AppShell.tsx no longer exports useNodeSelection function (alias retired)", () => {
    const src = readFileSync(APP_SHELL_PATH, "utf8");
    // Strip comments first so historical mentions don't trigger.
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/[^\n]*\n/gm, "");
    expect(codeOnly).not.toMatch(/export\s+function\s+useNodeSelection\s*\(/);
  });

  it("RigGraph uses useNavigate (NOT setSelectedNode / NOT setSelection seat-detail)", () => {
    const src = readFileSync(RIG_GRAPH_PATH, "utf8");
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/[^\n]*\n/gm, "");
    // Positive: useNavigate import + call.
    expect(src).toMatch(/import\s*\{[^}]*useNavigate[^}]*\}\s*from\s*["']@tanstack\/react-router["']/);
    expect(codeOnly).toMatch(/useNavigate\s*\(\s*\)/);
    // Negative: setSelectedNode + 'seat-detail' setSelection patterns gone.
    expect(codeOnly).not.toMatch(/setSelectedNode/);
    expect(codeOnly).not.toMatch(/setSelection\s*\(\s*\{\s*type:\s*["']seat-detail["']/);
  });

  it("LiveNodeDetails.tsx renders the 5-tab body row (single canonical surface per DRIFT P5.1-D1)", () => {
    const src = readFileSync(path.join(SRC, "components/LiveNodeDetails.tsx"), "utf8");
    // Tab union literal carries all 5 canonical tab keys.
    expect(src).toMatch(/type\s+Tab\s*=\s*"identity"\s*\|\s*"agent-spec"\s*\|\s*"startup"\s*\|\s*"transcript"\s*\|\s*"terminal"/);
    // FileReferenceTrigger wraps startup files (P5.1-1a).
    expect(src).toMatch(/import\s*\{[^}]*FileReferenceTrigger[^}]*\}\s*from/);
    expect(src).toMatch(/<FileReferenceTrigger/);
  });

  it("SeatScopePage drops outer tabs and mounts LiveNodeDetails directly (DRIFT P5.1-D1)", () => {
    const src = readFileSync(path.join(SRC, "components/topology/ScopePages.tsx"), "utf8");
    // Locate the SeatScopePage function body specifically (not the
    // file-wide imports which still reference the SEAT_SCOPE_TABS
    // constant for other surfaces).
    const seatFn = src.match(/export function SeatScopePage\(\)\s*\{[\s\S]*?^}/m);
    expect(seatFn).not.toBeNull();
    const body = seatFn![0];
    // No outer ScopeShell tabsNav for seat scope; LiveNodeDetails mounts
    // as the page body.
    expect(body).not.toMatch(/SEAT_SCOPE_TABS/);
    expect(body).toMatch(/<LiveNodeDetails\s+rigId=/);
  });
});
