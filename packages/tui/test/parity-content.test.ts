import { describe, expect, it } from "vitest";
import { computeExplorerRows, createViewState } from "../src/state.js";
import { parseCommand } from "../src/grammar.js";
import { decodeInput, resolveKeyAction, sgrClick } from "../src/input.js";
import { renderScreen } from "../src/render.js";
import { demoSnapshot } from "../src/demo-data.js";
import type { FleetSnapshot, Screen, ViewState, ViewStateStore } from "../src/types.js";

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

function syncedScreen(store: ViewStateStore, snapshot: FleetSnapshot = snap): Screen {
  let screen = renderScreen(store.get(), snapshot, { cols: 120, rows: 32 });
  store.dispatch({
    type: "layout",
    contentMaxOffset: screen.contentMaxOffset,
    contentTargetCount: screen.contentTargets.length,
  });
  screen = renderScreen(store.get(), snapshot, { cols: 120, rows: 32 });
  return screen;
}

function press(store: ViewStateStore, bytes: string, snapshot: FleetSnapshot = snap): void {
  const screen = syncedScreen(store, snapshot);
  const event = decodeInput(bytes)[0];
  if (!event || event.type !== "key") throw new Error("expected key event");
  const action = resolveKeyAction(event, store.get(), screen, computeExplorerRows(store.get(), snapshot).length);
  if (action) store.dispatch(action);
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
    const screen = renderScreen(s.get(), snap, { cols: 120, rows: 8 });
    s.dispatch({ type: "layout", contentMaxOffset: screen.contentMaxOffset, contentTargetCount: screen.contentTargets.length });
    const pageDown = decodeInput("\x1b[6~")[0];
    if (!pageDown || pageDown.type !== "key" || !("action" in pageDown)) throw new Error("PageDown was not decoded");
    s.dispatch(pageDown.action);
    expect(s.get().contentOffset).toBe(Math.min(10, screen.contentMaxOffset));
    expect(s.get().selection).toBe(selected);
  });

  it("raw right/down/Enter reaches content tabs, table rows, spec refs, and Needs links", () => {
    const structured: FleetSnapshot = {
      ...snap,
      specs: [{
        name: "openrig-build-rig",
        kind: "rig",
        format: "pod_aware",
        pods: [{ id: "dev50", members: [{ id: "guard", agentRef: "guard-agent", runtime: "codex" }], edges: [] }],
        graph: { nodes: [], edges: [] },
        raw: "name: openrig-build-rig",
      }, ...snap.specs.filter((spec) => spec.name !== "openrig-build-rig")],
    };

    const tab = createViewState({ instanceId: "tab", getSnapshot: () => structured });
    tab.dispatch(parseCommand("spec openrig-build-rig"));
    press(tab, "\x1b[C", structured);
    press(tab, "\r", structured);
    expect(tab.get().viewTab).toBe("topology");

    const row = fresh("row");
    row.dispatch(parseCommand("rig openrig-build"));
    press(row, "\x1b[C");
    let screen = syncedScreen(row);
    const rowTarget = screen.contentTargets.findIndex((target) => target.action.type === "drill" && target.action.resource === "agent" && target.action.name === "dev50.guard");
    for (let i = 0; i < rowTarget; i++) press(row, "\x1b[B");
    press(row, "\r");
    expect(row.get().drill.at(-1)).toEqual({ kind: "agent", name: "dev50.guard" });

    const ref = createViewState({ instanceId: "ref", getSnapshot: () => structured });
    ref.dispatch(parseCommand("spec openrig-build-rig"));
    press(ref, "\x1b[C", structured);
    screen = syncedScreen(ref, structured);
    const refTarget = screen.contentTargets.findIndex((target) => target.action.type === "drill" && target.action.resource === "spec" && target.action.name === "guard-agent");
    for (let i = 0; i < refTarget; i++) press(ref, "\x1b[B", structured);
    press(ref, "\r", structured);
    expect(ref.get().drill.at(-1)).toEqual({ kind: "spec", name: "guard-agent" });

    const needs = fresh("needs");
    needs.dispatch(parseCommand(":needs"));
    press(needs, "\x1b[C");
    press(needs, "\r");
    expect(needs.get().drill.at(-1)).toEqual({ kind: "agent", name: "dev50.guard" });
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
