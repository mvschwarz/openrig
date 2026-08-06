import { describe, it, expect } from "vitest";
import { parseCommand } from "../src/grammar.js";
import { createViewState, emptySnapshot } from "../src/state.js";
import { renderScreen } from "../src/render.js";

// P10 — the topology-graph command-bar command (founder-caught). The graph VIEW exists (per-rig,
// honest-empty when no graph is served); this adds the first-class `graph` command to OPEN it + makes
// it discoverable, and confirms the honest-degraded rail (unavailable ⇒ an honest message, not a silent
// no-op) is surfaced.

describe("parseCommand — the `graph` command", () => {
  it("opens the graph view", () => {
    expect(parseCommand("graph")).toEqual({ type: "tab", tab: "graph" });
    expect(parseCommand("  graph  ")).toEqual({ type: "tab", tab: "graph" });
  });

  it("is discoverable in the command listing (unknown-command help names it)", () => {
    const err = parseCommand("zzz");
    expect(err.type).toBe("error");
    expect((err as { message: string }).message).toContain("graph");
  });
});

describe("graph view — honest-degraded when unavailable (not a silent no-op)", () => {
  it("shows an honest-empty message when the graph is unavailable in the current context", () => {
    const snap = emptySnapshot();
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch(parseCommand("graph")); // open the graph view via the command
    expect(view.get().viewTab).toBe("graph"); // the command opened the view — NOT a silent no-op
    const body = renderScreen(view.get(), snap, { cols: 120, rows: 32 }).lines.join("\n");
    // honest-degraded: every unavailable-state message names it as proven/honest-empty, "not fabricated".
    expect(body).toContain("fabricated");
  });
});
