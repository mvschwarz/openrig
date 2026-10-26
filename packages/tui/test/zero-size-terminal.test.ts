import { describe, expect, it } from "vitest";
import { createViewState } from "../src/state.js";
import { parseCommand } from "../src/grammar.js";
import { drawableSize, renderScreen } from "../src/render.js";
import { demoSnapshot } from "../src/demo-data.js";

// A terminal can report 0 rows or columns (a detached, headless or just-resizing pane). The TUI's draw loop skips that
// frame instead of rendering into it: rendering at 0 rows crashed on the command-focus blink's first line (0.7.2).
describe("a zero-size terminal is not drawable yet", () => {
  it("refuses 0 rows, 0 columns, or both", () => {
    expect(drawableSize(140, 0)).toBeNull();
    expect(drawableSize(0, 40)).toBeNull();
    expect(drawableSize(0, 0)).toBeNull();
  });

  it("draws at a reported size, and keeps the defaults when none is reported", () => {
    expect(drawableSize(140, 40)).toEqual({ cols: 140, rows: 40 });
    expect(drawableSize(undefined, undefined)).toEqual({ cols: 120, rows: 32 });
  });

  it("renders every size it accepts, down to one row or one column", () => {
    const snap = demoSnapshot();
    const home = createViewState({ instanceId: "t", getSnapshot: () => snap });
    const drilled = createViewState({ instanceId: "t", getSnapshot: () => snap });
    drilled.dispatch(parseCommand("rig openrig-build"));
    for (const view of [home, drilled]) {
      for (const [cols, rows] of [[1, 1], [140, 1], [1, 40]] as const) {
        const size = drawableSize(cols, rows)!;
        // nowMs 2500 is the blink's hidden phase, which reads the first line.
        expect(renderScreen(view.get(), snap, { ...size, nowMs: 2500 }).lines.length).toBeGreaterThan(0);
      }
    }
  });
});
