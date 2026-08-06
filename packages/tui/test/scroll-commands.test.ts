import { describe, it, expect } from "vitest";
import { parseCommand } from "../src/grammar.js";
import { VERB_TABLE } from "../src/commands/registry.js";

// TUI scroll (ruling cfec754f Part 1) — :top / :bottom / :find as first-class COMMAND REGISTRY entries
// (not grammar special-cases — the P10 lesson). Registered as VERBS (top/bottom/find) because ':' is
// the section-jump prefix (dev50-planner collision flag): typed ':top' would parse as an unknown
// SECTION. top/bottom reuse content-scroll (the reducer clamps an extreme delta to the bound); find
// reuses the filter action. The registry parity suite auto-covers listing/dump/palette/socket.

describe("scroll commands — top / bottom / find (registry verbs)", () => {
  it("`top` scrolls to the top (content-scroll clamped to the top by the reducer)", () => {
    const a = parseCommand("top");
    expect(a.type).toBe("content-scroll");
    expect((a as { delta: number }).delta).toBeLessThan(0);
  });

  it("`bottom` scrolls to the bottom (content-scroll clamped to the max by the reducer)", () => {
    const a = parseCommand("bottom");
    expect(a.type).toBe("content-scroll");
    expect((a as { delta: number }).delta).toBeGreaterThan(0);
  });

  it("`find <text>` filters rows by text (same action as the / prefix)", () => {
    expect(parseCommand("find dev")).toEqual({ type: "filter", text: "dev" });
  });

  it("`find` with no text is a loud error (teaching message), never a silent no-op", () => {
    const a = parseCommand("find");
    expect(a.type).toBe("error");
    expect((a as { message: string }).message.toLowerCase()).toContain("find");
  });

  it("all three are registered in the verb table (first-class, discoverable)", () => {
    expect(VERB_TABLE.has("top")).toBe(true);
    expect(VERB_TABLE.has("bottom")).toBe(true);
    expect(VERB_TABLE.has("find")).toBe(true);
  });
});
