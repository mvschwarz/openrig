import { describe, expect, it } from "vitest";
import { createViewState } from "../src/state.js";
import { parseCommand } from "../src/grammar.js";
import { renderScreen } from "../src/render.js";
import { demoSnapshot } from "../src/demo-data.js";

// QA blocker 1: ACTIONS must be a real lifecycle path, not a false affordance.
// The two acts map to the ONLY existing write contracts (web parity):
// open-terminal → POST /api/terminal/open {view}; run → the per-seat launch route.

const snap = demoSnapshot();

function drilledScreen() {
  const s = createViewState({ instanceId: "t", getSnapshot: () => snap });
  s.dispatch(parseCommand("rig openrig-build"));
  return { store: s, screen: renderScreen(s.get(), snap, { cols: 140, rows: 32 }) };
}

function hitAt(screen: ReturnType<typeof renderScreen>, x: number, y: number) {
  return screen.hitMap.find((h) => h.y === y && x >= h.x1 && x <= h.x2);
}

describe("ACTIONS column = real drive-structure acts (BR-9)", () => {
  it("running row offers ONLY term ▸ (no per-seat run contract exists → no false run affordance)", () => {
    const { screen } = drilledScreen();
    const rowIdx = screen.lines.findIndex((l) => l.includes("dev50.driver"));
    const row = screen.lines[rowIdx]!;
    expect(row).toMatch(/term ▸/);
    expect(row).not.toMatch(/run ▸/);
  });

  it("non-running row offers run ▸ wired to the existing per-seat launch contract", () => {
    const { screen } = drilledScreen();
    const rowIdx = screen.lines.findIndex((l) => l.includes("dev50.qa"));
    const row = screen.lines[rowIdx]!;
    const x = row.indexOf("run ▸") + 1;
    const hit = hitAt(screen, x, rowIdx + 1);
    expect(hit?.action).toEqual({ type: "act", act: "run", rigId: "openrig-build", agent: "dev50.qa" });
  });

  it("term ▸ zone dispatches open-terminal for the row's pod; clicking elsewhere still drills", () => {
    const { screen } = drilledScreen();
    const rowIdx = screen.lines.findIndex((l) => l.includes("dev50.guard"));
    const row = screen.lines[rowIdx]!;
    const termHit = hitAt(screen, row.indexOf("term ▸") + 1, rowIdx + 1);
    expect(termHit?.action).toEqual({ type: "act", act: "open-terminal", view: "pod:openrig-build/dev50" });
    const cellHit = hitAt(screen, row.indexOf("codex") + 1, rowIdx + 1);
    expect(cellHit?.action).toEqual({
      type: "drill",
      resource: "agent",
      name: "dev50.guard",
      target: { host: "vm-host", rig: "openrig-build", pod: "dev50" },
    });
  });

  it("acts NEVER mutate the view-state; the outcome arrives as a notice (PIN 1 intact)", () => {
    const s = createViewState({ instanceId: "t", getSnapshot: () => snap });
    s.dispatch(parseCommand("rig openrig-build"));
    const before = s.get();
    s.dispatch({ type: "act", act: "open-terminal", view: "pod:openrig-build/dev50" });
    expect(s.get()).toMatchObject({ section: before.section, drill: before.drill, selection: before.selection });
    s.dispatch({ type: "notice", message: "terminal opened: pod:dev50" });
    expect(s.get().notice).toBe("terminal opened: pod:dev50");
    const screen = renderScreen(s.get(), snap, { cols: 140, rows: 32 });
    expect(screen.lines.at(-1) ?? screen.lines.join("")).toBeDefined();
    expect(screen.lines.some((l) => l.includes("terminal opened: pod:dev50"))).toBe(true);
  });

  it("agent detail shows the served attach command verbatim and a term act (web parity)", () => {
    const s = createViewState({ instanceId: "t", getSnapshot: () => snap });
    s.dispatch(parseCommand("agent dev50.driver"));
    const screen = renderScreen(s.get(), snap, { cols: 140, rows: 32 });
    expect(screen.lines.some((l) => l.includes("attach: "))).toBe(true);
    const termLine = screen.lines.findIndex((l) => l.includes("term ▸"));
    const hit = hitAt(screen, 40, termLine + 1);
    expect(hit?.action).toEqual({ type: "act", act: "open-terminal", view: "pod:openrig-build/dev50" });
  });

  it("the grammar carries NO act verbs — acts are click-surfaces only; socket stays observe/navigate", () => {
    for (const cmd of ["run openrig-build", "term dev50", "up openrig-build", "open-terminal pod:dev50"]) {
      const parsed = parseCommand(cmd);
      // "run" etc. are not resources/verbs; anything not the safe core is a named error
      expect(parsed.type, cmd).toBe("error");
    }
  });
});
