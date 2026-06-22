// OPR.0.4.0.1 terminal STYLING polish: the smoked-glass CONTENT (live + static) +
// borderless + measured LIVE width + FR-5 grid expand-out. The bare-surface smoke
// must come from the SHARED layer (ProgressiveTerminal static plate + FocusedTerminal
// bg), not only the popover/shell plate -- so it reaches the truly-bare surfaces.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import path from "node:path";

vi.mock("../src/components/preview/SessionPreviewPane.js", () => ({
  SessionPreviewPane: ({ sessionName, variant }: { sessionName: string; variant?: string }) => (
    <div data-testid={`preview-${sessionName}`} data-variant={variant ?? "default"}>static preview</div>
  ),
}));
vi.mock("../src/components/terminal/FocusedTerminal.js", () => ({
  FocusedTerminal: ({ sessionName }: { sessionName: string }) => (
    <div data-testid={`live-${sessionName}`}>live terminal</div>
  ),
}));

import { ProgressiveTerminal } from "../src/components/terminal/ProgressiveTerminal.js";
import {
  LiveTerminalProvider,
  __resetFallbackRegistryForTests,
} from "../src/components/terminal/LiveTerminalProvider.js";

beforeEach(() => {
  cleanup();
  __resetFallbackRegistryForTests();
});

const src = (rel: string) => readFileSync(path.join(import.meta.dirname, rel), "utf8");

describe("OPR.0.4.0.1 terminal styling polish", () => {
  it("FR-1/FR-2: the static preview carries a BORDERLESS smoked-glass plate + the compact-terminal variant", () => {
    render(
      <LiveTerminalProvider cap={2}>
        <ProgressiveTerminal sessionName="a@r" terminalKey="k:a" testIdPrefix="t" />
      </LiveTerminalProvider>,
    );
    const staticBtn = screen.getByTestId("t-static");
    // the bare-surface static view carries its OWN smoked-glass plate (FR-4) ...
    expect(staticBtn.className).toContain("bg-stone-950/85");
    expect(staticBtn.className).toContain("backdrop-blur-sm");
    // ... and is BORDERLESS (FR-2 floating plate, not a bordered box)
    expect(staticBtn.className).not.toContain("border");
    // the borderless + transparent compact-terminal variant is used (FR-1/FR-2)
    expect(screen.getByTestId("preview-a@r").getAttribute("data-variant")).toBe("compact-terminal");
  });

  it("FR-1: the LIVE terminal keeps an opaque xterm render surface so erase/redraw is cursor-safe", () => {
    const s = src("../src/components/terminal/FocusedTerminal.tsx");
    // OPR.0.4.0.39: the geometry constants moved to terminal-geometry.ts (the single
    // source of truth shared by the static<->live mirror). FocusedTerminal imports +
    // uses them; the opaque / 120x40 / lineHeight-1 contract is unchanged.
    const geo = src("../src/components/terminal/terminal-geometry.ts");
    expect(geo).toContain('export const LIVE_TERMINAL_RENDER_BACKGROUND = "#0c0a09"');
    expect(geo).toContain("export const LIVE_TERMINAL_COLS = 90");
    expect(geo).toContain("export const LIVE_TERMINAL_ROWS = 27");
    expect(geo).toContain("export const LIVE_TERMINAL_LINE_HEIGHT = 1");
    expect(s).toContain('from "./terminal-geometry.js"');
    expect(s).toContain("cols: LIVE_TERMINAL_COLS");
    expect(s).toContain("rows: LIVE_TERMINAL_ROWS");
    expect(s).toContain("lineHeight: LIVE_TERMINAL_LINE_HEIGHT");
    expect(s).toContain("applyOpaqueTerminalBackground(containerRef.current!)");
    expect(s).toContain("scrollTerminalViewportToPrompt(containerRef.current!)");
    expect(s).toContain("term.scrollToBottom();");
    expect(s).toContain('querySelector<HTMLElement>("textarea.xterm-helper-textarea")');
    expect(s).toContain("const desiredScrollTop = cursorBottom - container.clientHeight + lineHeight * 3");
    expect(s).toContain("container.scrollTop = Math.min(maxScrollTop, Math.max(0, desiredScrollTop))");
    expect(s).toContain("term.focus();");
    expect(s).toContain("allowTransparency: false");
    expect(s).not.toContain("allowTransparency: true");
    expect(s).not.toContain("FitAddon");
    expect(s).not.toContain("fitAddon.fit");
    expect(s).not.toContain('background: "rgba(0,0,0,0)"');
    expect(s).toContain('foreground: "#e0e0e0"'); // text stays OPAQUE (AC-4 legibility)
  });

  it("OPR.0.4.0.39 (founder spec): the popover sizes to the canonical geometry (w-max shell, LIVE_TERMINAL_COLS-ch inner), no hardcoded plate width, no redundant opaque bg", () => {
    const s = src("../src/components/topology/TerminalPreviewPopover.tsx");
    // The shell sizes to its content (w-max) and the inner is the canonical geometry
    // width (LIVE_TERMINAL_COLS ch) - tracks the column count, no reshape, no loose
    // empty width, no hardcoded 880/904 plate.
    expect(s).toContain("w-max");
    expect(s).toContain("LIVE_TERMINAL_COLS");
    expect(s).not.toContain("w-[880px]");
    expect(s).not.toContain("w-[904px]");
    expect(s).not.toContain("bg-stone-950/65"); // live wrapper supplies the plate
    expect(s).toContain("backdrop-blur-sm");
  });

  it("OPR.0.4.0.39 (founder spec, REVERSES slice-01 FR-5): the topology grid card mounts the in-place ProgressiveTerminal, NOT the TerminalPreviewPopover trigger", () => {
    // Founder live-review reversed the popover-expand-out for the grid (and all
    // surfaces): the static IS the in-place click-to-live target.
    const s = src("../src/components/topology/TopologyTerminalView.tsx");
    expect(s).toContain("import { ProgressiveTerminal }");
    expect(s).not.toContain("TerminalPreviewPopover");
  });
});
