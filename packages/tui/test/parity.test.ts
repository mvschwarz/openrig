import { describe, expect, it } from "vitest";
import { createViewState } from "../src/state.js";
import { parseCommand } from "../src/grammar.js";
import { decodeInput, sgrClick } from "../src/input.js";
import { renderScreen } from "../src/render.js";
import { demoSnapshot } from "../src/demo-data.js";
import type { ViewState } from "../src/types.js";

// PIN 1: command / mouse / keyboard are adapters over ONE dispatch. Parity is
// proven by reaching the IDENTICAL state through each input kind.

const snap = demoSnapshot();

function fresh(id: string) {
  return createViewState({ instanceId: id, getSnapshot: () => snap });
}

function comparable(state: ViewState) {
  const { instanceId: _i, sections: _s, ...rest } = state;
  return rest;
}

describe("parity by construction (FR-7 / PIN 1)", () => {
  it("command vs mouse click on the explorer reach identical state", () => {
    const byCommand = fresh("cmd");
    const byMouse = fresh("ui");

    byCommand.dispatch(parseCommand(":specs"));

    const screen = renderScreen(byMouse.get(), snap, { cols: 100, rows: 30 });
    const target = screen.hitMap.find((h) => h.action.type === "jump" && h.action.section === "specs");
    expect(target).toBeDefined();
    const click = decodeInput(sgrClick(target!.x1, target!.y)).find((e) => e.type === "mouse");
    expect(click).toBeDefined();
    if (click?.type !== "mouse") throw new Error("unreachable");
    const hit = screen.hitMap.find((h) => h.y === click.y && click.x >= h.x1 && click.x <= h.x2);
    expect(hit).toBeDefined();
    byMouse.dispatch(hit!.action);

    expect(comparable(byMouse.get())).toEqual(comparable(byCommand.get()));
  });

  it("command vs keyboard (arrows + enter) reach identical state", () => {
    const byCommand = fresh("cmd");
    const byKeys = fresh("kbd");

    byCommand.dispatch(parseCommand("rig openrig-build"));

    const screen = renderScreen(byKeys.get(), snap, { cols: 100, rows: 30 });
    const rigIndex = screen.explorerRows.findIndex((r) => r.action.type === "drill" && r.action.resource === "rig");
    expect(rigIndex).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < rigIndex; i++)
      for (const ev of decodeInput("\x1b[B"))
        if (ev.type === "key" && "action" in ev) byKeys.dispatch(ev.action);
    const enter = decodeInput("\r")[0];
    if (enter && enter.type === "key" && "action" in enter) byKeys.dispatch(enter.action);

    expect(comparable(byKeys.get())).toEqual(comparable(byCommand.get()));
  });

  it("renders the agents table with fixed-width columns and right-aligned numerics (honest-unknown as —)", () => {
    const s = fresh("t");
    s.dispatch(parseCommand("rig openrig-build"));
    const screen = renderScreen(s.get(), snap, { cols: 140, rows: 30 });
    const header = screen.lines.find((l) => l.includes("SEAT") && l.includes("STATE"));
    expect(header).toBeDefined();
    const rows = screen.lines.filter((l) => l.includes("term ▸") && /\b(working|idle|needs you|unknown)\b/.test(l));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) {
      expect(row).toMatch(/(?:\d+%[\u25aa▫]{3}|—)\s+(?:working|idle|needs you|unknown)/);
    }
  });

  it("keeps STATUS verbatim from the snapshot — never fabricated (PIN 2 render leg)", () => {
    const s = fresh("t");
    s.dispatch(parseCommand("rig openrig-build"));
    const screen = renderScreen(s.get(), snap, { cols: 140, rows: 30 });
    const qaRow = screen.lines.find((l) => /\? qa\s/.test(l));
    expect(qaRow).toBeDefined();
    expect(qaRow).toMatch(/unknown/);
    const deadRow = screen.lines.find((l) => /\b(?:◐ )?lead\s/.test(l));
    expect(deadRow).toMatch(/needs you/);
  });
});
