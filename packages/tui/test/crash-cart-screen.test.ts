import { describe, it, expect } from "vitest";
import { renderCrashCartScreen } from "../src/crash-cart/render-crash-cart.js";
import { demoCrashCartModel } from "../src/crash-cart/crash-cart-model.js";
import { stylizeLines } from "../src/stylize.js";
import { createStyle, stripAnsi } from "../src/theme.js";

// Crash-cart C3 (SUB-3b) — renderCrashCartScreen wraps the cockpit view into a full-width Screen
// (no explorer split), with a benign line 0 (stylize special-cases index 0) so the header paints via
// the full-width segRows branch. Verified THROUGH stylize (post-SGR), not on the pre-stylize Screen.

describe("renderCrashCartScreen — full-width cockpit Screen", () => {
  const screen = renderCrashCartScreen(demoCrashCartModel(), { cols: 120, rows: 32 });
  const body = screen.lines.join("\n");

  it("keeps line 0 benign and renders the mock sections into full-width lines", () => {
    expect(screen.lines[0]).toBe("");
    expect(body).toContain("◌ daemon not running");
    expect(body).toContain("FOUND ON THIS HOST");
    expect(body).toContain(" ▦ openrig-pm    13 seats · last active 08:11 · 7 sessions resumable");
    expect(body).toContain("WHERE WORK STOPPED (from the durable ledgers)");
    expect(body).toContain("⏎ RESTORE EVERYTHING");
  });

  it("pads (short) content rows to cols and carries segRows for the painted rows", () => {
    const foundRow = screen.lines.findIndex((l) => l.startsWith("FOUND ON THIS HOST"));
    expect(foundRow).toBeGreaterThan(0); // not line 0
    expect(screen.lines[foundRow]!.length).toBe(120); // short line padded to cols
    expect(screen.segRows?.[foundRow + 1]).toBeTruthy(); // 1-based row key
    // the header line is present and not on line 0 (padded/left as-is; never truncated → invariant safe)
    expect(screen.lines.findIndex((l) => l.startsWith("◌ daemon not running"))).toBeGreaterThan(0);
  });

  it("through stylize: the RESTORE row paints an accent background; strip-invariant holds", () => {
    const styled = stylizeLines(screen, createStyle("truecolor"));
    styled.forEach((l, i) => expect(stripAnsi(l)).toBe(screen.lines[i]));
    const restoreIdx = screen.lines.findIndex((l) => l.includes("RESTORE EVERYTHING"));
    expect(styled[restoreIdx]).toMatch(/48;2;/); // accent bg painted full-width (would no-op pre-branch)
  });

  it("through stylize: the daemon-down glyph line carries a warn foreground", () => {
    const styled = stylizeLines(screen, createStyle("truecolor"));
    const hdr = screen.lines.findIndex((l) => l.startsWith("◌ daemon not running"));
    expect(styled[hdr]).toMatch(/38;2;/);
  });
});
