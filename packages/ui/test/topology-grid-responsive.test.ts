// OPR.0.4.0.39 FR-2/3/4 - source guards for the topology terminal grid:
// responsive 1/2/3-col, the legibility-floored CSS scale-down, and tightened
// padding. Source-guards (the exact visual result is QA-screenshot-validated).
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const RAW = fs.readFileSync(
  path.resolve(import.meta.dirname, "../src/components/topology/TopologyTerminalView.tsx"),
  "utf-8",
);
// Source-guard on CODE, not comments: strip /* */ (incl JSX {/* */}) and // line
// comments so a comment that legitimately NAMES a removed token (e.g. "no separate
// TerminalPreviewPopover trigger", "no overflow-hidden") does not trip the negative
// assertions below.
const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("TopologyTerminalView grid (OPR.0.4.0.39 FR-2/3/4)", () => {
  it("FR-2 (founder: 2 columns MAXIMUM): 1-col narrow / 2-col wider, NO 3-col", () => {
    expect(SRC).toContain("grid-cols-1");
    expect(SRC).toContain("md:grid-cols-2");
    // 3-col was dropped - at 3-across the scaled 120-col terminal is too small to
    // read; 2-col keeps each cell wide enough for legible terminals.
    expect(SRC).not.toContain("grid-cols-3");
  });

  it("FR-3: fit-width is delegated to the shared scaler (ProgressiveTerminal -> ScaleToFitTerminal), not a hardcoded grid scale", () => {
    // The grid must NOT hardcode a per-breakpoint CSS scale anymore; ProgressiveTerminal
    // wraps both static + live in ScaleToFitTerminal, which measures the fixed 120-col
    // block and scales it to fit each cell width (fit-width, never clip).
    expect(SRC).not.toContain("origin-top-left");
    expect(SRC).not.toContain("xl:scale-90");
    const PROG = fs.readFileSync(
      path.resolve(import.meta.dirname, "../src/components/terminal/ProgressiveTerminal.tsx"),
      "utf-8",
    );
    expect(PROG).toContain("ScaleToFitTerminal");
  });

  it("FR-4: NO white card wrapper + tightened padding/gaps (founder spec-correction)", () => {
    expect(SRC).toContain("p-1.5");
    expect(SRC).toContain("gap-1.5");
    // the white card wrapper is REMOVED entirely (bg-white/40 was too contrasty),
    // not merely retuned; the looser gap-3 grid gap is gone too.
    expect(SRC).not.toContain("bg-white/40");
    expect(SRC).not.toContain("gap-3");
  });

  it("FR-1/FR-6: the static IS the in-place click-to-live target (ProgressiveTerminal), no separate popover trigger", () => {
    expect(SRC).toContain("ProgressiveTerminal");
    // the grid no longer reaches live via a separate expand-out popover trigger.
    expect(SRC).not.toContain("TerminalPreviewPopover");
  });
});
