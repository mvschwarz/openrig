// S19 VERIFICATION-CAPTURE ATOM — the charter's carried POSITIVE explorer-
// absence regression (planner-carried requirement; QA LOCKED-SCOPE-CLEAR at
// 5348bb66 required successor item 1): for CLAUDE, CODEX, and TERMINAL agent
// rows the explorer must affirmatively prove — in BOTH the plain layer and
// the compiled styled stream — that no runtime-mark glyph, mark token/
// background SGR, or spelled runtime word renders. Round-3 founder verdict of
// record: marks live on AGENT-DETAIL + TOPOLOGY cards ONLY.
//
// Every absence matcher is proven SENSITIVE by a control-positive: the SAME
// snapshot's agent-detail page must contain exactly the glyph/SGR the
// explorer row is required to lack — an absence assertion whose matcher can
// never fire is not a regression pin.
import { describe, it, expect } from "vitest";
import { createViewState } from "../src/state.js";
import { renderScreen } from "../src/render.js";
import { stylizeLines } from "../src/stylize.js";
import { createStyle, stripAnsi } from "../src/theme.js";
import type { FleetSnapshot } from "../src/types.js";

// names deliberately share no substring with any runtime word
const AGENTS = [
  { name: "alpha", runtime: "claude-code", status: "active" },
  { name: "beta", runtime: "codex", status: "idle" },
  { name: "gamma", runtime: "terminal", status: "unknown" },
] as const;

function snap(): FleetSnapshot {
  return {
    hosts: [{ name: "h", reachable: true, rigs: [{ name: "r", pods: [{ name: "p", agents: AGENTS.map((a) => ({
      name: a.name, runtime: a.runtime, spec: "", context: 12, tokens: null, status: a.status, live: true,
    })) }] }] }],
    specs: [], needs: [], humanQueueProbed: true, hostsDown: [], stream: [], readErrors: [],
  };
}

/** the mark-identity SGR classes (theme mark tokens, truecolor exact values) */
const MARK_SGR = {
  clawdBodyBg: "48;2;173;103;85", // clawd terracotta field  #ad6755
  clawdBodyFg: "38;2;173;103;85", // clawd body ink (downsample forms)
  clawdEyeFg: "38;2;24;24;24", // clawd eyes             #181818
  terminalCellBg: "48;2;12;10;9", // terminal mark dark cell
  markInkFg: "38;2;250;250;249", // codex `>_` light ink
  codexBlueFg: "38;2;104;103;170", // OFFICIAL sampled       #6867aa
} as const;
const MARK_GLYPHS = /[▘▝▖▗▚▞▐▌█▀▄╹]|>_/;
const RUNTIME_WORDS = /claude|codex|terminal|tty/i;

function explorerRowsFor(view: ReturnType<typeof createViewState>, s: FleetSnapshot) {
  const screen = renderScreen(view.get(), s, { cols: 140, rows: 34 });
  const styled = stylizeLines(screen, createStyle("truecolor"));
  styled.forEach((l, i) => expect(stripAnsi(l)).toBe(screen.lines[i])); // strip-invariant holds throughout
  return AGENTS.map((a) => {
    const idx = screen.lines.findIndex((l) => l.includes(a.name));
    expect(idx, `explorer row for ${a.name}`).toBeGreaterThan(0);
    // scope to the EXPLORER cell (left of the pane border) — the content pane
    // legitimately renders marks on drill pages
    const border = screen.lines[idx]!.indexOf("│");
    return { agent: a, plain: screen.lines[idx]!.slice(0, border), styledFull: styled[idx]! };
  });
}

describe("POSITIVE explorer-absence regression — claude/codex/terminal rows carry NO mark glyph, mark SGR, or runtime word", () => {
  const s = snap();
  const view = createViewState({ instanceId: "abs", getSnapshot: () => s });
  view.dispatch({ type: "drill", resource: "pod", name: "p", target: { host: "h", rig: "r" } }); // expands the pod → agent rows visible

  it("plain layer: every runtime's agent row is free of mark glyphs and spelled runtime words", () => {
    for (const { agent, plain } of explorerRowsFor(view, s)) {
      expect(plain, `${agent.runtime} row plain glyphs`).not.toMatch(MARK_GLYPHS);
      expect(plain, `${agent.runtime} row runtime word`).not.toMatch(RUNTIME_WORDS);
    }
  });

  it("styled stream: every runtime's agent row is free of ALL mark token/background SGR classes", () => {
    for (const { agent, styledFull } of explorerRowsFor(view, s)) {
      for (const [cls, sgr] of Object.entries(MARK_SGR))
        expect(styledFull, `${agent.runtime} row ${cls}`).not.toContain(sgr);
    }
  });

  it("CONTROL-POSITIVE: the same snapshot's agent-detail pages DO render each mark the explorer lacks (matcher sensitivity)", () => {
    const detail = (name: string): string => {
      const v = createViewState({ instanceId: `abs-${name}`, getSnapshot: () => s });
      v.dispatch({ type: "drill", resource: "agent", name, target: { host: "h", rig: "r", pod: "p" } });
      const screen = renderScreen(v.get(), s, { cols: 150, rows: 40 });
      return stylizeLines(screen, createStyle("truecolor")).join("\n");
    };
    const claude = detail("alpha");
    expect(claude).toMatch(/▘/); // clawd outer-left eye quadrant
    expect(claude).toContain(MARK_SGR.clawdEyeFg);
    expect(claude).toContain(MARK_SGR.clawdBodyBg);
    const codex = detail("beta");
    expect(stripAnsi(codex)).toContain(">_"); // codex ASCII prompt mark
    expect(codex).toContain(MARK_SGR.markInkFg);
    const term = detail("gamma");
    expect(stripAnsi(term)).toContain(">_");
    expect(term).toContain(MARK_SGR.terminalCellBg);
  });
});
