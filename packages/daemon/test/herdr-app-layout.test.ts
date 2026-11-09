import { describe, it, expect } from "vitest";
import { cellId, deriveRigLayout, gridShape, referencedTerminals, viewRows, type LayoutNode, type RigView } from "../src/domain/terminal/herdr-app-layout.js";

// A person's layout shaped like herdr's shipped `main`: a sidebar, then a column with the tab bar and the tab block,
// and a hidden single-child side panel (the shape herdr's collapse damages).
const BASE: LayoutNode = {
  id: "root", type: "row", preview: "layouts/main.svg",
  children: [
    { id: "sidebar", type: "block", size: { px: 260 }, content: { mod: "workspace-chrome" } },
    { id: "work", type: "column", size: { weight: 1 }, children: [
      { id: "tabbar", type: "block", size: { px: 36 }, content: { mod: "tabs" } },
      { id: "tabs", type: "block", size: { weight: 1 }, min: 200, content: { tab: "active", pane: { gap: 4, radius: 8, border: { width: 1, color: "border" } } } },
    ] },
    { id: "panel", type: "column", hidden: true, min: 240, children: [{ id: "panel-body", type: "stack", active: "files", children: [] }] },
  ],
};

const view = (id: string, n: number, opts: Partial<RigView> = {}): RigView => ({
  id, name: `View ${id}`,
  cells: Array.from({ length: n }, (_, i) => ({ id: cellId(id, `dev.s${i}@rig`, `n${i}`), seat: `dev.s${i}@rig`, title: `dev.s${i} · S1`, terminal: `t${10 + i}` })),
  ...opts,
});

function stackOf(tree: LayoutNode): LayoutNode {
  const find = (n: LayoutNode): LayoutNode | null => n.id === "rig-work" ? n : (n.children ?? []).map(find).find(Boolean) ?? null;
  return find(tree)!;
}

describe("gridShape", () => {
  it("is the equal auto-grid cols = ceil(√N)", () => {
    expect([1, 2, 3, 4, 5, 9, 10, 16].map((n) => gridShape(n))).toEqual([
      { cols: 1, rows: 1 }, { cols: 2, rows: 1 }, { cols: 2, rows: 2 }, { cols: 2, rows: 2 },
      { cols: 3, rows: 2 }, { cols: 3, rows: 3 }, { cols: 4, rows: 3 }, { cols: 4, rows: 4 },
    ]);
    expect(gridShape(5, 2)).toEqual({ cols: 2, rows: 3 });
  });
});

describe("deriveRigLayout", () => {
  it("puts the person's tab block in OpenRig's stack and leaves the rest of their layout, and their file's tree, untouched", () => {
    const before = structuredClone(BASE);
    const derived = deriveRigLayout(BASE, [view("rv-a", 3)], { revision: "r-1" });
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;
    expect(BASE).toEqual(before);
    const tree = derived.tree;
    expect(tree.preview).toBeUndefined();
    expect((tree.children![0] as LayoutNode).id).toBe("sidebar");
    expect(tree.children![2]).toEqual(BASE.children![2]); // the hidden panel wrapper is kept as written
    const stack = stackOf(tree);
    expect(stack).toMatchObject({ type: "stack", active: "tabs", size: { weight: 1 }, min: 200,
      header: { height: 34, content: { mod: "rig-strip", props: { stack: "rig-work", main: "tabs", revision: "r-1" } } } });
    const main = stack.children![0]!;
    expect(main).toMatchObject({ id: "tabs", content: { tab: "active" } });
    expect(main.size).toBeUndefined(); // the stack carries the size now
  });

  it("lays each view out as an equal grid, padded, a title row over every live cell", () => {
    const derived = deriveRigLayout(BASE, [view("rv-a", 3)], { revision: "r-1" });
    if (!derived.ok) throw new Error(derived.error);
    const grid = stackOf(derived.tree).children![1]!;
    expect(grid).toMatchObject({ id: "rv-a", type: "column", gap: 4, padding: 4 });
    expect(grid.children!.map((row) => row.children!.length)).toEqual([2, 2]);
    const cells = grid.children!.flatMap((row) => row.children!);
    expect(cells.every((c) => (c.size as { weight: number }).weight === 1)).toBe(true);
    expect(cells.every((c) => c.radius === 8)).toBe(true); // the person's pane frame
    expect(cells[3]).toMatchObject({ type: "block", content: { mod: "rig-pad" } });
    expect(cells[0]).toMatchObject({ type: "column", children: [
      { size: { px: 30 }, content: { mod: "rig-cell-header", props: { title: "dev.s0 · S1", seat: "dev.s0@rig" } } },
      { content: { terminal: "t10" } },
    ] });
  });

  it("frames each live cell's terminal block with the pane border and herdr's focus look, so a focused cell shows its ring", () => {
    // herdr's shipped frame: `focus` is a line here, but on a layout node it is a look ({ border, background }).
    const framed = structuredClone(BASE);
    const tabs = (framed.children![1]!.children![1]!.content as { pane: Record<string, unknown> }).pane;
    tabs.focus = { width: 1, color: "accent" };
    const derived = deriveRigLayout(framed, [view("rv-a", 3)], { revision: "r-1" });
    if (!derived.ok) throw new Error(derived.error);
    const cells = stackOf(derived.tree).children![1]!.children!.flatMap((row) => row.children!);
    const [header, terminal] = cells[0]!.children!;
    // herdr-app draws a node's focus look only on the focused chrome terminal block itself.
    expect(terminal).toMatchObject({ content: { terminal: "t10" }, border: { width: 1, color: "border" }, focus: { border: { width: 1, color: "accent" } } });
    // The same border width unfocused, so focusing never resizes the terminal; the card keeps radius, not a second border.
    expect(cells[0]).toMatchObject({ type: "column", radius: 8 });
    expect(cells[0]!.border).toBeUndefined();
    expect(cells[0]!.focus).toBeUndefined();
    expect(header!.focus).toBeUndefined();
    // A pad cell is framed like a pane, and never gets the line where a look belongs.
    expect(cells[3]).toMatchObject({ content: { mod: "rig-pad" }, border: { width: 1, color: "border" } });
    expect(cells[3]!.focus).toBeUndefined();
  });

  it("writes an ended viewer as a rig-ended cell, never a reference to its dead terminal", () => {
    const v = view("rv-a", 2);
    v.cells[1]!.terminal = null;
    const derived = deriveRigLayout(BASE, [v], { revision: "r-2" });
    if (!derived.ok) throw new Error(derived.error);
    expect(referencedTerminals(derived.tree)).toEqual(["t10"]);
    const cells = stackOf(derived.tree).children![1]!.children!.flatMap((r) => r.children!);
    expect(cells[1]).toMatchObject({ id: v.cells[1]!.id, content: { mod: "rig-ended", props: { title: "dev.s1 · S1" } } });
    expect(viewRows(v)).toEqual([["t10", null]]);
  });

  it("gives every cell an id unique to its view, seat and op, so a new cell never inherits an old cell's clicks", () => {
    const a = view("rv-a", 4);
    const again = { ...view("rv-a", 4), cells: view("rv-a", 4).cells.map((c, i) => ({ ...c, id: cellId("rv-a", c.seat, `m${i}`) })) };
    const ids = (v: RigView) => { const d = deriveRigLayout(BASE, [v], { revision: "r" }); if (!d.ok) throw new Error(); return JSON.stringify(d.tree).match(/"id":"rv-a-[^"]+"/g)!; };
    expect(new Set(ids(a)).size).toBe(ids(a).length);
    expect(ids(a).filter((id) => ids(again).includes(id)).filter((id) => !/-r\d"|-pad\d"/.test(id))).toEqual([]);
    expect(cellId("rv-a", "dev.build@my-rig", "ab12")).toBe("rv-a-dev-build-my-rig-ab12");
  });

  it("never moves the stack's active child: the person's choice of view is their click, not the file's", () => {
    const one = deriveRigLayout(BASE, [view("rv-a", 1)], { revision: "r-1" });
    const two = deriveRigLayout(BASE, [view("rv-a", 1), view("rv-b", 2)], { revision: "r-2" });
    if (!one.ok || !two.ok) throw new Error();
    expect(stackOf(one.tree).active).toBe("tabs");
    expect(stackOf(two.tree).active).toBe("tabs");
    expect(stackOf(two.tree).header).toMatchObject({ content: { props: { views: [
      { id: "rv-a", name: "View rv-a", rows: [["t10"]] },
      { id: "rv-b", name: "View rv-b", rows: [["t10", "t11"]] },
    ] } } });
  });

  it("refuses a base without a tab block, and the Rig layout itself as a base", () => {
    expect(deriveRigLayout({ id: "root", type: "row", children: [{ id: "x", type: "block", content: { mod: "files" } }] }, [], { revision: "r" }))
      .toMatchObject({ ok: false, code: "base_has_no_tab_block" });
    const rig = deriveRigLayout(BASE, [], { revision: "r" });
    if (!rig.ok) throw new Error();
    expect(deriveRigLayout(rig.tree, [], { revision: "r2" })).toMatchObject({ ok: false, code: "base_is_rig_layout" });
  });
});
