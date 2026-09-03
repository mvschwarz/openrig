import { describe, expect, it } from "vitest";
import { createViewState } from "../src/state.js";
import { parseCommand } from "../src/grammar.js";
import { renderScreen } from "../src/render.js";
import { demoSnapshot } from "../src/demo-data.js";
import { createStyle, stripAnsi } from "../src/theme.js";
import { stylizeLines } from "../src/stylize.js";
import type { FleetSnapshot } from "../src/types.js";

// Parallel-polish pins: visible pane focus, content selection bar, and the
// content library mirroring the explorer's folder grouping.

const snap = demoSnapshot();

describe("active-pane emphasis (k9s chrome)", () => {
  it("brackets the focused pane's title in the top rule", () => {
    const s = createViewState({ instanceId: "t", getSnapshot: () => snap });
    let screen = renderScreen(s.get(), snap, { cols: 140, rows: 34 });
    expect(screen.lines[1]).toContain("{ EXPLORER }");
    expect(screen.lines[1]).not.toContain("{ TOPOLOGY }");
    s.dispatch(parseCommand("rig openrig-build"));
    s.dispatch({ type: "focus", pane: "content" });
    screen = renderScreen(s.get(), snap, { cols: 140, rows: 34 });
    expect(screen.lines[1]).toContain("{ TOPOLOGY }");
    expect(screen.lines[1]).not.toContain("{ EXPLORER }");
  });
});

describe("content selection bar", () => {
  it("renders the focused content row as an inverse highlight bar (strip-invariant intact)", () => {
    const s = createViewState({ instanceId: "t", getSnapshot: () => snap });
    s.dispatch(parseCommand("rig openrig-build"));
    const pre = renderScreen(s.get(), snap, { cols: 140, rows: 34 });
    s.dispatch({ type: "layout", contentMaxOffset: pre.contentMaxOffset, contentTargetCount: pre.contentTargets.length });
    s.dispatch({ type: "focus", pane: "content" });
    const screen = renderScreen(s.get(), snap, { cols: 140, rows: 34 });
    const styled = stylizeLines(screen, createStyle("truecolor"));
    const barIndex = screen.lines.findIndex((l) => l.includes("┃›"));
    expect(barIndex).toBeGreaterThan(0);
    expect(styled[barIndex]).toContain("\x1b[1;38;2;111;168;255;48;2;34;52;82m›");
    for (let i = 0; i < styled.length; i++) expect(stripAnsi(styled[i]!)).toBe(screen.lines[i]!);
  });
});

describe("content library mirrors the explorer grouping", () => {
  const nsSnap: FleetSnapshot = {
    ...snap,
    specs: [
      { name: "rig-a", kind: "rig" },
      { name: "rev-1", kind: "agent", namespace: "review" },
      { name: "rev-2", kind: "agent", namespace: "review" },
    ],
  };

  it("collapses agent folders in the CONTENT pane too, honoring the same expansion state", () => {
    const s = createViewState({ instanceId: "t", getSnapshot: () => nsSnap });
    s.dispatch(parseCommand(":specs"));
    let lines = renderScreen(s.get(), nsSnap, { cols: 140, rows: 34 }).lines.join("\n");
    expect(lines).toContain("review/ (2)");
    expect(lines).not.toContain("rev-1");
    s.dispatch({ type: "toggle-expand", key: "folder:review" });
    lines = renderScreen(s.get(), nsSnap, { cols: 140, rows: 34 }).lines.join("\n");
    expect(lines).toContain("rev-1");
  });
});

describe("unfocused-pane cursor dims (pm-approved nit)", () => {
  it("explorer bar is accent when explorer focused, dim-inverse when content focused", () => {
    const s = createViewState({ instanceId: "t", getSnapshot: () => snap });
    s.dispatch(parseCommand("rig openrig-build"));
    let styled = stylizeLines(renderScreen(s.get(), snap, { cols: 140, rows: 34 }), createStyle("truecolor"));
    expect(styled.join("\n")).toContain("\x1b[1;38;2;111;168;255;48;2;34;52;82m▶");
    const pre = renderScreen(s.get(), snap, { cols: 140, rows: 34 });
    s.dispatch({ type: "layout", contentMaxOffset: pre.contentMaxOffset, contentTargetCount: pre.contentTargets.length });
    s.dispatch({ type: "focus", pane: "content" });
    const screen = renderScreen(s.get(), snap, { cols: 140, rows: 34 });
    styled = stylizeLines(screen, createStyle("truecolor"));
    const barIndex = screen.lines.findIndex((l) => /^▶/.test(l));
    expect(styled[barIndex]).toContain("\x1b[38;2;109;116;128;48;2;34;52;82m");
    for (let i = 0; i < styled.length; i++) expect(stripAnsi(styled[i]!)).toBe(screen.lines[i]!);
  });
});

describe("truncation reads as ellipsis, never a hard mid-word clip", () => {
  it("clips long explorer labels and long cells with …", () => {
    const s = createViewState({ instanceId: "t", getSnapshot: () => snap });
    const screen = renderScreen(s.get(), snap, { cols: 60, rows: 20 });
    const clipped = screen.lines.filter((l) => l.includes("…"));
    expect(clipped.length).toBeGreaterThan(0);
    for (const line of screen.lines) expect(line.length).toBeLessThanOrEqual(60);
  });
});
