import { describe, expect, it } from "vitest";
import { createViewState } from "../src/state.js";
import { parseCommand } from "../src/grammar.js";
import { decodeInput, sgrClick } from "../src/input.js";
import { renderScreen } from "../src/render.js";
import { demoSnapshot } from "../src/demo-data.js";
import type { ViewState, ViewStateStore } from "../src/types.js";

// Phase-3 parity hardening: CONTENT-pane surfaces are hit targets too.
// Hit-target realism: these tests click coordinates on the rendered SURFACE
// (a visible table cell, a spec member line), not a labeled control.

const snap = demoSnapshot();

function fresh(id: string): ViewStateStore {
  return createViewState({ instanceId: id, getSnapshot: () => snap });
}

function comparable(state: ViewState) {
  const { instanceId: _i, sections: _s, ...rest } = state;
  return rest;
}

function clickAt(store: ViewStateStore, x: number, y: number): boolean {
  const screen = renderScreen(store.get(), snap, { cols: 120, rows: 32 });
  const click = decodeInput(sgrClick(x, y)).find((e) => e.type === "mouse");
  if (click?.type !== "mouse") throw new Error("no mouse event decoded");
  const hit = screen.hitMap.find((h) => h.y === click.y && click.x >= h.x1 && click.x <= h.x2);
  if (!hit) return false;
  store.dispatch(hit.action);
  return true;
}

function findContentLine(store: ViewStateStore, match: RegExp): { y: number; text: string } {
  const screen = renderScreen(store.get(), snap, { cols: 120, rows: 32 });
  const idx = screen.lines.findIndex((l) => match.test(l));
  if (idx < 0) throw new Error(`no rendered line matches ${match}`);
  return { y: idx + 1, text: screen.lines[idx]! };
}

describe("content-pane parity (Phase 3): click the surface, not a control", () => {
  it("clicking a table row's STATUS cell opens the agent — identical to the command", () => {
    const byCommand = fresh("cmd");
    const byMouse = fresh("ui");
    byCommand.dispatch(parseCommand("agent dev50.guard"));

    byMouse.dispatch(parseCommand("rig openrig-build"));
    const row = findContentLine(byMouse, /dev50\.guard.*idle/);
    // click INSIDE the STATUS cell text (a non-label visible cell, far from the AGENT column)
    const statusX = row.text.indexOf("idle") + 1;
    expect(clickAt(byMouse, statusX, row.y)).toBe(true);
    expect(comparable(byMouse.get())).toEqual(comparable(byCommand.get()));
  });

  it("clicking a rig-spec member line opens that agent spec — identical to the command", () => {
    const byCommand = fresh("cmd");
    const byMouse = fresh("ui");
    byCommand.dispatch(parseCommand("spec guard-agent"));

    byMouse.dispatch(parseCommand("spec openrig-build-rig"));
    const member = findContentLine(byMouse, /▪ guard-agent/);
    expect(clickAt(byMouse, member.text.indexOf("guard-agent") + 3, member.y)).toBe(true);
    expect(comparable(byMouse.get())).toEqual(comparable(byCommand.get()));
  });

  it("clicking the tabs line toggles TABLE→OVERVIEW — identical to `tab overview`", () => {
    const byCommand = fresh("cmd");
    const byMouse = fresh("ui");
    byCommand.dispatch(parseCommand("rig openrig-build"));
    byCommand.dispatch(parseCommand("tab overview"));

    byMouse.dispatch(parseCommand("rig openrig-build"));
    const tabs = findContentLine(byMouse, /TABLE.*OVERVIEW/);
    expect(clickAt(byMouse, tabs.text.indexOf("OVERVIEW") + 1, tabs.y)).toBe(true);
    expect(byMouse.get().viewTab).toBe("overview");
    expect(comparable(byMouse.get())).toEqual(comparable(byCommand.get()));
    // and the overview renders pods, not the table header
    const screen = renderScreen(byMouse.get(), snap, { cols: 120, rows: 32 });
    expect(screen.lines.some((l) => l.includes("2 pods"))).toBe(true);
  });

  it("clicking a Needs-You item OPENS (navigates to) the agent — the only in-TUI action (B3)", () => {
    const byMouse = fresh("ui");
    byMouse.dispatch(parseCommand(":needs"));
    const item = findContentLine(byMouse, /⚑ stuck/);
    expect(clickAt(byMouse, item.text.indexOf("stuck") + 1, item.y)).toBe(true);
    expect(byMouse.get().section).toBe("topology");
    expect(byMouse.get().drill.at(-1)).toEqual({ kind: "agent", name: "dev50.guard" });
  });

  it("renders NO resolve/reply affordance anywhere (B3: those are Studio's)", () => {
    const s = fresh("t");
    for (const cmd of [":topology", "rig openrig-build", ":specs", "spec openrig-build-rig", ":needs"]) {
      s.dispatch(parseCommand(cmd));
      const screen = renderScreen(s.get(), snap, { cols: 120, rows: 32 });
      expect(screen.lines.join("\n")).not.toMatch(/resolve|reply/i);
    }
  });

  it("drilling resets the view tab to TABLE (FR-3 default)", () => {
    const s = fresh("t");
    s.dispatch(parseCommand("rig openrig-build"));
    s.dispatch(parseCommand("tab overview"));
    s.dispatch(parseCommand("agent dev50.driver"));
    expect(s.get().viewTab).toBe("table");
  });

  it("PageDown scrolls content without moving the Explorer selection", () => {
    const s = fresh("t");
    const selected = s.get().selection;
    const pageDown = decodeInput("\x1b[6~")[0];
    if (!pageDown || pageDown.type !== "key" || !("action" in pageDown)) throw new Error("PageDown was not decoded");
    s.dispatch(pageDown.action);
    expect(s.get().contentOffset).toBe(10);
    expect(s.get().selection).toBe(selected);
  });
});

describe("rig-stream footer (FR-10): ambient, toggleable, never a view", () => {
  it("renders the latest stream item when ON and hides when toggled OFF", () => {
    const s = fresh("t");
    let screen = renderScreen(s.get(), snap, { cols: 120, rows: 32 });
    expect(screen.lines.some((l) => l.includes("≋") && l.includes("provider re-auth completed"))).toBe(true);
    s.dispatch({ type: "footer" });
    screen = renderScreen(s.get(), snap, { cols: 120, rows: 32 });
    expect(screen.lines.some((l) => l.includes("≋"))).toBe(false);
  });

  it("is not navigable: no section, no grammar verb, no hit target", () => {
    const s = fresh("t");
    expect(s.get().sections.some((sec) => sec.name.includes("stream"))).toBe(false);
    expect(parseCommand(":stream").type).toBe("error");
    const screen = renderScreen(s.get(), snap, { cols: 120, rows: 32 });
    const footerY = screen.lines.findIndex((l) => l.includes("≋")) + 1;
    expect(screen.hitMap.some((h) => h.y === footerY)).toBe(false);
  });
});
