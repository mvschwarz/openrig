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
    expect(staticBtn.className).toContain("bg-stone-950/60");
    expect(staticBtn.className).toContain("backdrop-blur-sm");
    // ... and is BORDERLESS (FR-2 floating plate, not a bordered box)
    expect(staticBtn.className).not.toContain("border");
    // the borderless + transparent compact-terminal variant is used (FR-1/FR-2)
    expect(screen.getByTestId("preview-a@r").getAttribute("data-variant")).toBe("compact-terminal");
  });

  it("FR-1: the LIVE terminal CONTENT carries its own translucent smoked tint (not the plate-dependent rgba(0,0,0,0))", () => {
    const s = src("../src/components/terminal/FocusedTerminal.tsx");
    expect(s).toContain('const SMOKED_TERMINAL_BACKGROUND = "rgba(12,10,9,0.6)"'); // stone-950 at ~0.6 alpha
    expect(s).toContain("viewport.style.backgroundColor = SMOKED_TERMINAL_BACKGROUND");
    expect(s).not.toContain('background: "rgba(0,0,0,0)"');
    expect(s).toContain('foreground: "#e0e0e0"'); // text stays OPAQUE (AC-4 legibility)
  });

  it("FR-3/FR-4: the popover sets the measured LIVE width + drops its redundant opaque bg (content self-tints)", () => {
    const s = src("../src/components/topology/TerminalPreviewPopover.tsx");
    expect(s).toContain("w-[880px]"); // the LIVE inner sizer (optimal width)
    // OPR.0.4.0.1 (rev1-r2 fix): the shell widens to fit the 880px live plate so
    // overflow-hidden no longer clips it (the prior fixed compact shell did).
    expect(s).toContain("w-[904px]");
    expect(s).not.toContain("w-[820px]");
    expect(s).not.toContain("bg-stone-950/65"); // dropped -> transparent-glassy
    expect(s).toContain("backdrop-blur-sm");
  });

  it("FR-5: the topology grid card mounts the TerminalPreviewPopover trigger, NOT a live-in-place ProgressiveTerminal", () => {
    const s = src("../src/components/topology/TopologyTerminalView.tsx");
    expect(s).toContain("TerminalPreviewPopover");
    expect(s).not.toContain('import { ProgressiveTerminal }');
  });
});
