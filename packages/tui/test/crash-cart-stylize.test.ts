import { describe, it, expect } from "vitest";
import type { Screen } from "../src/types.js";
import { stylizeLines } from "../src/stylize.js";
import { createStyle, stripAnsi } from "../src/theme.js";

// Crash-cart C3 (SUB-3b) — stylize must paint segRows on FULL-WIDTH rows too. The split-pane branch
// paints segs only when a `│` sits at EXPL_W; a full-width cockpit row (no sidebar) would otherwise
// fall to paintContent and DROP the segs' tokens/bg — the bold-only paint no-op class. This pins the
// additive full-width paint branch: the segs render (post-stylize SGR) AND the strip-invariant holds.

function fullWidthScreen(): Screen {
  return {
    // line 0 is benign (stylize special-cases index 0); content carries segs from index 1.
    lines: ["", "◌ daemon not running zzz", " ⏎ RESTORE EVERYTHING xyz "],
    segRows: {
      2: [{ text: "◌ daemon not running zzz", token: "warn" }],
      3: [{ text: " ⏎ RESTORE EVERYTHING xyz ", bg: "accent" }],
    },
    hitMap: [],
    contentTargets: [],
    contentMaxOffset: 0,
    explorerRows: [],
  };
}

describe("stylizeLines — full-width segRows paint branch", () => {
  const screen = fullWidthScreen();
  const styled = stylizeLines(screen, createStyle("truecolor"));

  it("preserves the strip-invariant on every line (stripAnsi(styled) === plain)", () => {
    styled.forEach((l, i) => expect(stripAnsi(l)).toBe(screen.lines[i]));
  });

  it("paints the accent background on the full-width selected row (48;2; — paintContent never would)", () => {
    expect(styled[2]).toMatch(/48;2;/);
  });

  it("paints the warn token as a truecolor foreground on the full-width row", () => {
    expect(styled[1]).toMatch(/38;2;/);
  });
});
