import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { launchNodeNotice } from "../src/daemon-client.js";
import { computeExplorerRows, createViewState, emptySnapshot } from "../src/state.js";
import type { FleetSnapshot, ViewStateStore } from "../src/types.js";

// Run the actual background re-anchor block from draw, not a copied select action.
// The row model and reducer remain real; no TUI, daemon, or native seat is launched.
const source = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const tree = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
let refresh: ts.IfStatement | undefined;
function visit(node: ts.Node): void {
  if (ts.isFunctionDeclaration(node) && node.name?.text === "draw") {
    refresh = node.body?.statements.find((statement): statement is ts.IfStatement =>
      ts.isIfStatement(statement) && statement.expression.getText(tree) === "live");
  }
  ts.forEachChild(node, visit);
}
visit(tree);
if (!refresh) throw new Error("The production background selection refresh was not found");
const native = ts.transpileModule(refresh.getText(tree), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function redraw(view: ViewStateStore, before: FleetSnapshot, after: FleetSnapshot): void {
  vm.runInNewContext(native, {
    view, snapshot: before, drawnSnapshot: before, drawnScope: "topology", drawnSettled: true,
    live: { snapshot: () => after, load: () => ({ settled: true }) },
    pageReadKey: () => "topology", computeExplorerRows,
  });
}

function snapshot(rigs: string[]): FleetSnapshot {
  return { ...emptySnapshot(), hosts: [{ name: "fixture", reachable: true, rigs: rigs.map(name => ({ name, pods: [] })) }] };
}

const warning = "Startup prompt still staged in worker@example; press Enter in that pane.";
function selected(before: FleetSnapshot) {
  const view = createViewState({ instanceId: "test", getSnapshot: () => before });
  const rows = computeExplorerRows(view.get(), before);
  const index = rows.findIndex(row => row.key === "rig:fixture/target");
  expect(index).toBeGreaterThanOrEqual(0);
  view.dispatch({ type: "select", index, rowCount: rows.length });
  view.dispatch({ type: "notice", message: launchNodeNotice("worker", { ok: true, warnings: [warning] }) });
  return view;
}

describe("startup guidance through background selection refresh", () => {
  it("keeps the warning when a newly observed rig moves the selected logical row", () => {
    const before = snapshot(["target"]), after = snapshot(["newly-observed", "target"]);
    const view = selected(before), previousIndex = view.get().selection;
    redraw(view, before, after);
    expect(view.get().selection).not.toBe(previousIndex);
    expect(computeExplorerRows(view.get(), after)[view.get().selection]?.key).toBe("rig:fixture/target");
    expect(view.get().notice).toContain(warning);
  });

  it("keeps the warning when the selected row disappears and refresh clamps the index", () => {
    const before = snapshot(["other", "target"]), after = snapshot([]);
    const view = selected(before), previousIndex = view.get().selection;
    redraw(view, before, after);
    expect(view.get().selection).toBeLessThan(previousIndex);
    expect(view.get().selection).toBe(Math.max(0, computeExplorerRows(view.get(), after).length - 1));
    expect(view.get().notice).toContain(warning);
  });

  it.each([{ delta: -1 }, { index: 0 }])("intentional selection %j still dismisses the warning", action => {
    const before = snapshot(["other", "target"]), view = selected(before);
    view.dispatch({ type: "select", ...action, rowCount: computeExplorerRows(view.get(), before).length });
    expect(view.get().notice).toBeNull();
  });
});
