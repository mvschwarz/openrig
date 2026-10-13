import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { decodeInput, resolveKeyAction, resolveEscapeAction, resolveMouseAction } from "../src/input.js";
import { parseCommand } from "../src/grammar.js";
import type { Action } from "../src/types.js";

// Extract handleInput directly from main.ts using the existing testbed pattern.
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

function createHarness(initialInputLine = "") {
  const perform = vi.fn();
  const state = { palette: null, section: "topology", focusedPane: "explorer", selection: 0 };
  const lastScreen = {
    explorerWidth: 20,
    contentTargets: [],
    contentMaxOffset: 0,
    hitMap: [],
  };
  const context = {
    nativeAttached: false,
    inputRevision: 0,
    inputLine: initialInputLine,
    completion: null,
    startup: { state: { open: false }, interacted: vi.fn(), key: vi.fn() },
    lastScreen,
    view: { get: () => state, dispatch: vi.fn() },
    socket: { path: "owned.sock" },
    crashCartOpts: {},
    snapshot: {},
    computeExplorerRows: () => [{}, {}, {}],
    perform,
    draw: vi.fn(),
    resolveKeyAction,
    resolveEscapeAction,
    resolveMouseAction,
    parseCommand,
    commandContext: () => ({ state, snapshot: {} }),
  };
  const handle = vm.runInNewContext(native + "\nhandleInput", context) as (events: ReturnType<typeof decodeInput>) => void;
  return { handle, perform, context };
}

describe("Issue #883: TUI j/k navigation aliases when command line is empty", () => {
  it("treats 'j' as down arrow when inputLine is empty", () => {
    const { handle, perform, context } = createHarness("");
    handle(decodeInput("j"));
    expect(perform).toHaveBeenCalledExactlyOnceWith({
      type: "select",
      delta: 1,
      rowCount: 3,
    });
    expect(context.inputLine).toBe("");
  });

  it("treats 'k' as up arrow when inputLine is empty", () => {
    const { handle, perform, context } = createHarness("");
    handle(decodeInput("k"));
    expect(perform).toHaveBeenCalledExactlyOnceWith({
      type: "select",
      delta: -1,
      rowCount: 3,
    });
    expect(context.inputLine).toBe("");
  });

  it("keeps 'j' and 'k' as typed characters when inputLine already has text", () => {
    const { handle, perform, context } = createHarness("find ");
    handle(decodeInput("j"));
    expect(perform).not.toHaveBeenCalled();
    expect(context.inputLine).toBe("find j");

    handle(decodeInput("k"));
    expect(perform).not.toHaveBeenCalled();
    expect(context.inputLine).toBe("find jk");
  });
});
