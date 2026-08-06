// REGISTRY I3 (ruling 64f1dbdf) — the fuzzy command palette over the ONE registry.
// PM pins: aliases FIRST-CLASS in fuzzy find (pin 5); context-unavailable rows render
// DIMMED-WITH-REASON, never hidden; palette-execute == direct-command BYTE-EQUAL
// (execution routes through parseCommand -> dispatch, the BR-9 one path).
import { describe, it, expect } from "vitest";
import { filterPalette, paletteExecuteLine, type PaletteRow } from "../src/commands/palette.js";
import { COMMAND_REGISTRY, type CommandEntry } from "../src/commands/registry.js";
import { parseCommand } from "../src/grammar.js";

describe("command palette (I3)", () => {
  it("fuzzy match ranks an ALIAS hit first-class: query 'g' surfaces graph at the top", () => {
    const rows = filterPalette("g", COMMAND_REGISTRY, "standard");
    expect(rows[0]!.entry.name).toBe("graph"); // via the real alias 'g'
  });

  it("empty query lists EVERY entry (the browse case)", () => {
    const rows = filterPalette("", COMMAND_REGISTRY, "standard");
    expect(rows.length).toBe(COMMAND_REGISTRY.length);
  });

  it("context-unavailable entries render dimmed-with-reason, NEVER hidden", () => {
    const foreign = { name: "restore-everything", aliases: [], args: "", description: "crash-cart primary",
      context: "crash-cart", sample: "restore-everything" } as unknown as CommandEntry;
    const rows = filterPalette("restore", [...COMMAND_REGISTRY, foreign], "standard");
    const row = rows.find((r: PaletteRow) => r.entry.name === "restore-everything");
    expect(row).toBeDefined(); // never hidden
    expect(row!.available).toBe(false);
    expect(row!.reason).toMatch(/crash-cart/); // the reason names the required context
  });

  it("'always' entries are available in any context", () => {
    const always = { name: "x-always", aliases: [], args: "", description: "d", context: "always", sample: "x-always" } as CommandEntry;
    const rows = filterPalette("x-always", [always], "crash-cart");
    expect(rows[0]!.available).toBe(true);
  });

  it("palette-execute is BYTE-EQUAL to direct typing: the execute line parses to the identical action", () => {
    const graph = COMMAND_REGISTRY.find((e) => e.name === "graph")!;
    const line = paletteExecuteLine(graph);
    expect(line.mode).toBe("execute"); // argless -> executes
    expect(parseCommand(line.line)).toEqual(parseCommand("graph")); // the SAME parse, same bytes
  });

  it("argful entries PRE-FILL the command bar instead of executing blind", () => {
    const style = COMMAND_REGISTRY.find((e) => e.name === "style")!;
    const line = paletteExecuteLine(style);
    expect(line.mode).toBe("prefill");
    expect(line.line).toBe("style ");
  });
});

// state-machine legs (dispatch-riding, PIN: palette state mutates ONLY via dispatch)
import { createViewState } from "../src/state.js";
import { demoSnapshot } from "../src/demo-data.js";

describe("palette state rides dispatch (I3)", () => {
  it("help/? opens via the grammar; query/move/close transition; execute path parses byte-equal", () => {
    const view = createViewState({ instanceId: "t", getSnapshot: () => demoSnapshot() });
    view.dispatch(parseCommand("?"));
    expect(view.get().palette).toEqual({ query: "", selection: 0 });
    view.dispatch({ type: "palette-query", query: "g" });
    expect(view.get().palette!.query).toBe("g");
    view.dispatch({ type: "palette-move", delta: 1 });
    expect(view.get().palette!.selection).toBe(1);
    view.dispatch({ type: "palette-close" });
    expect(view.get().palette).toBeNull();
    // byte-equal proof at the state level: executing graph via the palette line vs typing it
    const a = createViewState({ instanceId: "a", getSnapshot: () => demoSnapshot() });
    const b = createViewState({ instanceId: "b", getSnapshot: () => demoSnapshot() });
    a.dispatch(parseCommand(paletteExecuteLine(COMMAND_REGISTRY.find((e) => e.name === "graph")!).line));
    b.dispatch(parseCommand("graph"));
    expect(a.get().viewTab).toBe(b.get().viewTab);
  });
});
