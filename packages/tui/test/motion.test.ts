// ROUND-3 mr7 — the MOTION design language mechanics (sign-off = open item c;
// these pins cover the MECHANICS + discipline: reduced-motion everywhere,
// max ONE persistent animation per region, honest fallbacks).
import { describe, it, expect } from "vitest";
import { reducedMotion, spinnerFrame, flashActive, barCells } from "../src/motion.js";
import { createViewState } from "../src/state.js";
import { renderScreen } from "../src/render.js";
import { stylizeLines } from "../src/stylize.js";
import { createStyle, stripAnsi } from "../src/theme.js";
import { demoSnapshot } from "../src/demo-data.js";

describe("motion primitives", () => {
  it("reducedMotion honors the env kill-switch", () => {
    expect(reducedMotion({ OPENRIG_REDUCED_MOTION: "1" })).toBe(true);
    expect(reducedMotion({ REDUCED_MOTION: "1" })).toBe(true);
    expect(reducedMotion({})).toBe(false);
  });

  it("spinner: braille frames in truecolor/256, line frames at 16-color, STATIC dot under reduced motion", () => {
    expect(spinnerFrame(0, "truecolor", false)).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
    expect(spinnerFrame(1, "truecolor", false)).not.toBe(spinnerFrame(0, "truecolor", false)); // animates
    expect(spinnerFrame(0, "16", false)).toMatch(/[|\/\-\\]/); // 16-color fallback
    expect(spinnerFrame(5, "truecolor", true)).toBe("·"); // reduced: static, honest
  });

  it("flashActive is ONE-SHOT: true within the window, false after, never under reduced motion", () => {
    expect(flashActive(1000, 1300, 600, false)).toBe(true);
    expect(flashActive(1000, 1700, 600, false)).toBe(false);
    expect(flashActive(1000, 1300, 600, true)).toBe(false);
  });

  it("barCells renders REAL fractions only — null/NaN gives no bar, never a fabricated fill", () => {
    expect(barCells(0.5, 10)).toBe("█████░░░░░");
    expect(barCells(0, 10)).toBe("░░░░░░░░░░");
    expect(barCells(1, 10)).toBe("██████████");
    expect(barCells(null, 10)).toBe("");
    expect(barCells(Number.NaN, 10)).toBe("");
  });
});

describe("motion wiring + region discipline", () => {
  const snap = demoSnapshot();
  it("the needs-you ⚑ glyph carries the slow attention-pulse (blink) — the ONLY persistent motion in that region", () => {
    const s = createViewState({ instanceId: "m", getSnapshot: () => snap });
    s.dispatch({ type: "jump", section: "needs" });
    const screen = renderScreen(s.get(), snap, { cols: 140, rows: 34 });
    const styled = stylizeLines(screen, createStyle("truecolor"));
    const needsRow = styled.find((l) => stripAnsi(l).includes("⚑"))!;
    expect(needsRow, "pulse on the needs-you glyph").toMatch(/\x1b\[[0-9;]*5;[0-9;]*m⚑|\x1b\[5m⚑/);
    // discipline: the ⚑ is the only blinking cell on that row
    expect((needsRow.match(/\[[0-9;]*5;[0-9;]*m/g) ?? []).length).toBeLessThanOrEqual(1);
    styled.forEach((l, i) => expect(stripAnsi(l)).toBe(screen.lines[i]));
  });

  it("the detail context line shows a quiet DETERMINATE bar for the real ctx fraction (and none when unknown)", () => {
    const s = createViewState({ instanceId: "m2", getSnapshot: () => snap });
    s.dispatch({ type: "drill", resource: "agent", name: "dev50.driver", target: { host: "vm-host", rig: "openrig-build", pod: "dev50" } });
    const body = renderScreen(s.get(), snap, { cols: 150, rows: 40 }).lines.join("\n");
    expect(body).toMatch(/62% used[^\n]*[█░]{10}/); // driver ctx 62 → a real 10-cell bar
    const s2 = createViewState({ instanceId: "m3", getSnapshot: () => snap });
    s2.dispatch({ type: "drill", resource: "agent", name: "dev50.qa", target: { host: "vm-host", rig: "openrig-build", pod: "dev50" } });
    const body2 = renderScreen(s2.get(), snap, { cols: 150, rows: 40 }).lines.join("\n");
    expect(body2).not.toMatch(/— \(not yet known\)[^\n]*█/); // no fabricated bar
  });

  it("max ONE persistent animation in the command-bar region: exactly the cursor blink", () => {
    const s = createViewState({ instanceId: "m4", getSnapshot: () => snap });
    const screen = renderScreen(s.get(), snap, { cols: 140, rows: 34 }, "rig x");
    const styled = stylizeLines(screen, createStyle("truecolor"));
    expect((styled[0]!.match(/\[[0-9;]*5;[0-9;]*m|\[5m/g) ?? []).length).toBe(1);
  });
});
