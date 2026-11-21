// A control socket that could not be bound is a fact about the session that stays true, so it is said
// in the status bar rather than only in a notice. That matters on the startup screen, which draws
// instead of the main view while a daemon is being reached and carries its own notice field, and after
// an action replaces the view notice.

import { describe, expect, it } from "vitest";
import { renderScreen } from "../src/render.js";
import { createViewState } from "../src/state.js";
import { demoSnapshot } from "../src/demo-data.js";
import type { StartupState } from "../src/startup.js";

const snap = demoSnapshot();

function view() {
  return createViewState({ instanceId: "status-line", getSnapshot: () => snap }).get();
}

function openStartup(): StartupState {
  return {
    connection: "probing", open: true, busy: false, page: "probe", target: "demo", home: "/tmp/home",
    notice: "", detail: "", expanded: false, selected: 0, scroll: 0, rigs: [],
  };
}

describe("the control-socket status line", () => {
  it("says the socket is unavailable, and keeps saying it once a notice would have been replaced", () => {
    const screen = renderScreen(view(), snap, { cols: 120, rows: 32, controlSocketUnavailable: true });
    expect(screen.lines.at(-1)).toContain("socket: unavailable");
    // No copy action: there is no bound path to copy.
    expect(screen.hitMap.some((hit) => hit.action?.type === "print-for-copy")).toBe(false);
  });

  it("appears on the startup screen too, which draws instead of the main view", () => {
    const screen = renderScreen(view(), snap, { cols: 120, rows: 32, controlSocketUnavailable: true, startup: openStartup() });
    expect(screen.lines.at(-1)).toContain("socket: unavailable");
  });

  it("stays out of the way when a socket is bound", () => {
    const screen = renderScreen(view(), snap, { cols: 120, rows: 32, controlSocketPath: "/tmp/tui.sock" });
    expect(screen.lines.at(-1)).toContain("socket: [copy] /tmp/tui.sock");
    expect(screen.lines.at(-1)).not.toContain("unavailable");
  });
});