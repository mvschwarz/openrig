import { describe, expect, it } from "vitest";
import { createViewState } from "../src/state.js";
import { parseCommand } from "../src/grammar.js";
import { renderScreen } from "../src/render.js";
import { demoSnapshot } from "../src/demo-data.js";
import { createStyle, stripAnsi, detectColorMode } from "../src/theme.js";
import { stylizeLines } from "../src/stylize.js";

// Founder visual-polish directive: styling is a zero-width post-pass. The
// LOAD-BEARING invariant: stripAnsi(styled[i]) === plain[i] for EVERY line of
// EVERY view — color can never move a hit target, change a width, or shear a
// frame (the stable-frame guarantee stays proven).

const snap = demoSnapshot();

function screenFor(...commands: string[]) {
  const s = createViewState({ instanceId: "t", getSnapshot: () => snap });
  for (const c of commands) s.dispatch(parseCommand(c));
  return renderScreen(s.get(), snap, { cols: 140, rows: 34 });
}

const VIEWS: Array<[string, string[]]> = [
  ["topology table", ["rig openrig-build"]],
  ["topology overview", ["rig openrig-build", "tab overview"]],
  ["agent detail", ["agent dev50.driver"]],
  ["specs library", [":specs"]],
  ["rig spec", ["spec openrig-build-rig"]],
  ["agent spec", ["spec driver-agent"]],
  ["needs", [":needs"]],
  ["cross-nav running", ["running driver-agent"]],
  ["filtered", ["rig openrig-build", "/dev50"]],
  ["named error", ["agent nobody.here"]],
];

describe("stylize invariant: strip(styled) === plain, every view, every mode", () => {
  for (const mode of ["truecolor", "256", "16"] as const) {
    it(`holds in ${mode} mode across all views`, () => {
      const style = createStyle(mode);
      for (const [name, commands] of VIEWS) {
        const screen = screenFor(...commands);
        const styled = stylizeLines(screen, style);
        expect(styled.length, name).toBe(screen.lines.length);
        for (let i = 0; i < styled.length; i++) {
          expect(stripAnsi(styled[i]!), `${name} line ${i + 1} (${mode})`).toBe(screen.lines[i]!);
        }
      }
    });
  }

  it("none mode returns the plain lines untouched (NO_COLOR honesty)", () => {
    const screen = screenFor("rig openrig-build");
    expect(stylizeLines(screen, createStyle("none"))).toEqual(screen.lines);
  });
});

describe("treatment (mockup palette semantics)", () => {
  const style = createStyle("truecolor");

  it("colors STATUS semantically: active=ok-green, needs-attention=amber, unknown=dim", () => {
    const styled = stylizeLines(screenFor("rig openrig-build"), style).join("\n");
    expect(styled).toContain("\x1b[38;2;152;195;121mactive\x1b[0m");
    expect(styled).toContain("\x1b[38;2;230;181;110mneeds-attention\x1b[0m");
    expect(styled).toContain("\x1b[38;2;109;116;128munknown\x1b[0m");
  });

  it("paints selection as an inverse accent bar (visible highlight, not just a glyph)", () => {
    const styled = stylizeLines(screenFor(), style);
    const bar = styled.find((l) => l.includes("\x1b[1;7;38;2;77;189;178m"));
    expect(bar).toBeDefined();
    expect(stripAnsi(bar!)).toMatch(/^›/);
  });

  it("links/acts get the teal accent (term ▸, open ▸, tabs)", () => {
    const styled = stylizeLines(screenFor("rig openrig-build"), style).join("\n");
    expect(styled).toContain("\x1b[1;38;2;77;189;178mterm ▸\x1b[0m");
  });

  it("alert lines are amber with the open-link kept accent; hosts-down red", () => {
    const styled = stylizeLines(screenFor(":needs"), style).join("\n");
    expect(styled).toMatch(/\x1b\[38;2;230;181;110m\s*⚑/);
    expect(styled).toContain("\x1b[38;2;224;108;117m  ✖ remote-host");
  });

  it("chrome rules carry pane titles; hint bar and status line are styled", () => {
    const styled = stylizeLines(screenFor("rig openrig-build"), style);
    expect(stripAnsi(styled[1]!)).toMatch(/EXPLORER.*┬.*TOPOLOGY/);
    const hint = styled.find((l) => stripAnsi(l).includes("q quit"));
    expect(hint).toBeDefined();
    expect(hint).toContain("\x1b[");
  });

  it("16-color mode emits only basic SGR (no 38;2 / 38;5) — sane degradation", () => {
    const styled = stylizeLines(screenFor("rig openrig-build"), createStyle("16")).join("\n");
    expect(styled).not.toContain("38;2;");
    expect(styled).not.toContain("38;5;");
    expect(styled).toContain("\x1b[");
  });

  it("256 mode uses 38;5 indexed colors", () => {
    const styled = stylizeLines(screenFor("rig openrig-build"), createStyle("256")).join("\n");
    expect(styled).toContain("38;5;");
    expect(styled).not.toContain("38;2;");
  });
});

describe("color-mode detection", () => {
  it("honors NO_COLOR, dumb terms, COLORTERM and 256color TERM", () => {
    expect(detectColorMode({ NO_COLOR: "1", TERM: "xterm-256color" })).toBe("none");
    expect(detectColorMode({ TERM: "dumb" })).toBe("none");
    expect(detectColorMode({ TERM: "xterm-256color", COLORTERM: "truecolor" })).toBe("truecolor");
    expect(detectColorMode({ TERM: "xterm-256color" })).toBe("256");
    expect(detectColorMode({ TERM: "xterm" })).toBe("16");
  });
});
