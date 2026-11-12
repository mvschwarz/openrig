import { expect, it } from "vitest";
import { createViewState, emptySnapshot } from "../src/state.js";
import { terminalLines } from "../src/terminals/terminal-model.js";

it.each([true, false])("renders the selected daemon's native recovery shell independently of the TUI host (native=%s)", native => {
  const snap = emptySnapshot();
  const pane = { seat: "owned@fixture", label: "Owned", readOnly: true, paneCommand: "unused", recoveryCommand: native ? "& 'owned-tmux' 'attach' '-r' '-t' 'owned@fixture'" : "tmux attach -r -t 'owned@fixture'", ...(native ? { recoveryShell: "powershell" as const } : {}) };
  snap.terminals = { catalog: [], preview: { view: "fixture", provider: "herdr", planId: "owned", status: { available: false },
    composed: { id: "fixture", pages: [[pane]], opened: [pane], absent: [], degraded: [] }, grids: [{ columns: 1, rows: 1, blanks: 0 }] } };
  const view = createViewState({ instanceId: "owned", getSnapshot: () => snap });
  view.dispatch({ type: "terminal-preview", view: "fixture" });
  const text = terminalLines(view.get(), snap, 1000).map(line => line.text).join("\n");
  expect(text).toContain(`${native ? "Remove-Item Env:TMUX -ErrorAction SilentlyContinue; " : "env -u TMUX "}${pane.recoveryCommand}`);
  expect(text).not.toContain("env -u TMUX &");
});
