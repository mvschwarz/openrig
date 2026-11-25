import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { decodeInput, resolveMouseAction } from "../src/input.js";
import { isBoundSocketCopy } from "../src/socket-copy.js";
import { renderScreen } from "../src/render.js";
import { createViewState } from "../src/state.js";
import { demoSnapshot } from "../src/demo-data.js";
import type { Action } from "../src/types.js";

// Exercise the actual nested input executor without booting a TUI or launching seats.
// Only its external action/launch boundary and rendering state are controlled here.
const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
let executor: ts.FunctionDeclaration | undefined;
function visit(node: ts.Node): void {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "handleInput") executor = node;
  ts.forEachChild(node, visit);
}
visit(tree);
if (!executor) throw new Error("The production input executor was not found");
const native = ts.transpileModule(executor.getText(tree), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function dispatch(button: number, action: Action, startupOpen = false, boundSocketPath = "owned.sock") {
  const perform = vi.fn();
  const key = vi.fn(async () => {});
  const state = { palette: null, section: "topology" };
  const context = {
    nativeAttached: false, inputRevision: 0, inputLine: "", completion: null,
    startup: { state: { open: startupOpen }, interacted: vi.fn(), key },
    lastScreen: { explorerWidth: 20, hitMap: [{ x1: 1, x2: 10, y: 3, action }] },
    view: { get: () => state }, socket: { path: boundSocketPath },
    crashCartOpts: {}, snapshot: {}, computeExplorerRows: () => [],
    // The real one, not a stub: handleInput compares the action's value with the bound path, and a stub
    // would let a wrong comparison pass here.
    perform, draw: vi.fn(), resolveMouseAction, isBoundSocketCopy,
  };
  const handle = vm.runInNewContext(native + "\nhandleInput", context) as (events: ReturnType<typeof decodeInput>) => void;
  handle(decodeInput(`\x1b[<${button};5;3M`));
  return { perform, key };
}

const snap = demoSnapshot();

const open: Action = { type: "act", act: "open-terminal", view: "rig:example" };
const start: Action = { type: "startup", key: "enter" };
const copy: Action = { type: "print-for-copy", label: "Socket", value: "owned.sock" };

describe("primary-button hit-map activation", () => {
  it.each([1, 2])("does not run an Open action on button %i", button => {
    expect(dispatch(button, open).perform).not.toHaveBeenCalled();
  });
  it.each([1, 2, 64, 65])("does not launch from startup on button %i", button => {
    expect(dispatch(button, start, true).key).not.toHaveBeenCalled();
  });
  it.each([1, 2])("does not enter copy mode on button %i", button => {
    expect(dispatch(button, copy).perform).not.toHaveBeenCalled();
  });
  it.each([0, 4, 8, 16])("preserves primary press with modifier bits %i", button => {
    expect(dispatch(button, open).perform).toHaveBeenCalledExactlyOnceWith(open);
  });
  it.each([64, 65, 68, 80])("keeps normal wheel routing for button %i", button => {
    expect(dispatch(button, open).perform).toHaveBeenCalledExactlyOnceWith({ type: "select", delta: button & 1 ? 3 : -3, rowCount: 0 });
  });
  it("preserves primary startup activation", () => {
    expect(dispatch(0, start, true).key).toHaveBeenCalledExactlyOnceWith("enter");
  });
  it("preserves primary copy activation", () => {
    expect(dispatch(0, copy).perform).toHaveBeenCalledExactlyOnceWith(copy);
  });

  it("copies a socket row whose displayed path differs from the bound one, and startup keeps its hands off", () => {
    // The row shows a cleaned path; the action carries the bound one. With startup open, its handler is
    // the one that would otherwise take a status-row click, so this is the case that made the value
    // have to stay raw.
    const hostile = `/tmp/o\u001b]0;pwned\u0007x.sock`;
    const screen = renderScreen(
      createViewState({ instanceId: "click", getSnapshot: () => snap }).get(),
      snap,
      { cols: 120, rows: 32, controlSocketPath: hostile },
    );
    const action = screen.hitMap.find((hit) => hit.action?.type === "print-for-copy")?.action as Action;
    expect(action).toBeDefined();
    expect(screen.lines.at(-1)).not.toContain("\u001b");

    const result = dispatch(0, action, true, hostile);
    expect(result.perform).toHaveBeenCalledExactlyOnceWith(action);
    expect(result.key).not.toHaveBeenCalled();
  });
});
