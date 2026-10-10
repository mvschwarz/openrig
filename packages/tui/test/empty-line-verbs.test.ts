import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { decodeInput, resolveKeyAction, resolveEscapeAction, resolveMouseAction } from "../src/input.js";
import { parseCommand } from "../src/grammar.js";
import { VERB_TABLE } from "../src/commands/registry.js";

// Agents drive the TUI by typing commands, so a single-key accelerator on an empty command line must never take
// the first letter of a registered verb (`f` once took feed's and find's). Runs the production handleInput, as
// jk-navigation.test.ts does.
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

function createHarness(view: { section: string; scopesSelected?: boolean }) {
  const perform = vi.fn();
  const dispatch = vi.fn();
  const state = { palette: null, focusedPane: "explorer", selection: 0, ...view };
  const context = {
    nativeAttached: false,
    inputRevision: 0,
    inputLine: "",
    completion: null,
    startup: { state: { open: false }, interacted: vi.fn(), key: vi.fn() },
    lastScreen: { explorerWidth: 20, contentTargets: [], contentMaxOffset: 0, hitMap: [] },
    view: { get: () => state, dispatch },
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
  return { handle, perform, dispatch, context };
}

// `?` is both the palette key and the help verb's alias: the key runs that same command.
const VERBS = [...VERB_TABLE.keys()].filter((verb) => verb !== "?");

describe("registered verbs type in full on an empty command line", () => {
  it.each([
    { section: "topology" },
    { section: "scopes", scopesSelected: true },
  ])("in $section, every verb reaches the command line and no accelerator fires", (view) => {
    for (const verb of VERBS) {
      const { handle, perform, dispatch, context } = createHarness(view);
      handle(decodeInput(`${verb} x`));
      expect(context.inputLine, verb).toBe(`${verb} x`);
      expect(perform, verb).not.toHaveBeenCalled();
      expect(dispatch, verb).not.toHaveBeenCalled();
    }
  });

  it("F toggles the footer on an empty line; f starts a command", () => {
    const upper = createHarness({ section: "topology" });
    upper.handle(decodeInput("F"));
    expect(upper.dispatch).toHaveBeenCalledExactlyOnceWith({ type: "footer" });
    expect(upper.context.inputLine).toBe("");

    const lower = createHarness({ section: "topology" });
    lower.handle(decodeInput("f"));
    expect(lower.dispatch).not.toHaveBeenCalled();
    expect(lower.context.inputLine).toBe("f");
  });

  it("M and N run reqs and narrative in a selected Scopes view", () => {
    const { handle, perform } = createHarness({ section: "scopes", scopesSelected: true });
    handle(decodeInput("M"));
    handle(decodeInput("N"));
    expect(perform.mock.calls).toEqual([[{ type: "scopes-reqs" }], [{ type: "scopes-narrative" }]]);
  });
});
