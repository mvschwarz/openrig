// The Rig layout: OpenRig's own herdr-app layout file (`layouts/rig.json`), derived from the person's.
//
// Pure: base layout + views in, layout tree out.
//   - The person's `{tab:"active"}` block becomes child `main` of stack `rig-work`, headed by the `rig-strip` mod.
//     Everything else in their layout is kept as it is; their own file is never written.
//   - Each view is another child of that stack: an equal grid, `cols = ceil(√N)`, padded with `rig-pad` cells.
//     A live cell is a column: a 30 px `rig-cell-header` (the `<agent> · <slice>` title) over the viewer's terminal
//     block. A cell whose viewer ended is a `rig-ended` mod block, never a reference to a dead terminal (a dead
//     reference makes herdr collapse the layout).
//   - Cell ids are view + seat + op nonce, never positional: herdr keys the person's clicks by id, and a reused id
//     inherits a stale click.
//   - The strip's props carry the write's revision: the strip acknowledges a revision only once its own shown layout
//     carries it (herdr-app-acknowledgement).
import type { ComposedPane } from "./terminal-provider.js";

export type LayoutNode = {
  id?: string;
  type?: string;
  children?: LayoutNode[];
  content?: { tab?: string; terminal?: string; mod?: string; props?: unknown; [k: string]: unknown };
  [k: string]: unknown;
};

export const RIG_LAYOUT = "rig";
export const RIG_STACK = "rig-work";
export const RIG_MAIN = "main";
export const STRIP_HEIGHT = 34;
export const HEADER_HEIGHT = 30;

export interface RigCell {
  /** Unique, stable for this viewer instance: `<view>-<seat>-<nonce>`. */
  id: string;
  seat: string;
  title: string;
  detail?: string;
  /** The viewer terminal's core address; null for an ended cell. */
  terminal: string | null;
}

export interface RigView {
  id: string;
  name: string;
  cells: RigCell[];
  /** Fixed columns from the composed view; otherwise the auto-grid. */
  columns?: number;
}

/** The auto-grid: `cols = ceil(√N)`, enough rows for N. */
export function gridShape(n: number, columns?: number): { cols: number; rows: number } {
  const cols = Math.max(1, columns && columns > 0 ? Math.min(columns, Math.max(n, 1)) : Math.ceil(Math.sqrt(Math.max(n, 1))));
  return { cols, rows: Math.max(1, Math.ceil(n / cols)) };
}

/** A name herdr accepts as part of an id, from a seat name such as `dev.build@rig`. */
export function idPart(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "x";
}

export function cellId(viewId: string, seat: string, nonce: string): string {
  return `${viewId}-${idPart(seat)}-${nonce}`;
}

/** The title row of a cell, from the composed pane (`<agent> · <slice>`). */
export function cellFor(viewId: string, pane: Pick<ComposedPane, "seat" | "label" | "runtime">, nonce: string, terminal: string | null): RigCell {
  return { id: cellId(viewId, pane.seat, nonce), seat: pane.seat, title: pane.label, ...(pane.runtime ? { detail: pane.runtime } : {}), terminal };
}

function findParent(node: LayoutNode, pred: (n: LayoutNode) => boolean): { parent: LayoutNode; index: number } | null {
  const children = node.children ?? [];
  for (let i = 0; i < children.length; i++) {
    if (pred(children[i]!)) return { parent: node, index: i };
    const hit = findParent(children[i]!, pred);
    if (hit) return hit;
  }
  return null;
}

const isTabBlock = (n: LayoutNode) => n.type === "block" && n.content?.tab === "active";

/** Every terminal a layout tree shows in a block. */
export function referencedTerminals(node: unknown): string[] {
  const out: string[] = [];
  const walk = (n: unknown) => {
    if (!n || typeof n !== "object") return;
    const terminal = (n as LayoutNode).content?.terminal;
    if (typeof terminal === "string") out.push(terminal);
    for (const child of (n as LayoutNode).children ?? []) walk(child);
    const header = (n as { header?: unknown }).header;
    if (header) walk(header);
  };
  walk(node);
  return out;
}

export type DeriveResult = { ok: true; tree: LayoutNode } | { ok: false; code: "base_has_no_tab_block" | "base_is_rig_layout"; error: string };

/** The person's pane frame, for the view's cells: its paint (radius, background, border) and its focused border, a line.
 *  A layout node's own `focus` is a look (`{ border, background }`), not a line, so the line is never copied as is. */
function frameOf(tabBlock: LayoutNode): { gap: number; paint: Record<string, unknown>; focus?: unknown } {
  const frame = (tabBlock.content?.pane ?? {}) as Record<string, unknown>;
  const paint = Object.fromEntries(["radius", "background", "border"].filter(k => k in frame).map(k => [k, frame[k]]));
  return { gap: typeof frame.gap === "number" ? frame.gap : 6, paint, ...("focus" in frame ? { focus: frame.focus } : {}) };
}

function cellNode(cell: RigCell | null, padId: string, paint: Record<string, unknown>, focus?: unknown): LayoutNode {
  if (!cell) return { id: padId, type: "block", size: { weight: 1 }, content: { mod: "rig-pad" }, ...paint };
  if (cell.terminal === null) {
    return { id: cell.id, type: "block", size: { weight: 1 }, content: { mod: "rig-ended", props: { title: cell.title } }, ...paint };
  }
  // The border, and the focused border, go on the terminal block: herdr-app draws a node's focus look only on the
  // focused terminal block itself (a chrome terminal's ancestors aren't on its focus path). The unfocused border keeps
  // the same width, so focusing a cell never resizes its terminal.
  const { border, ...card } = paint;
  return {
    id: cell.id, type: "column", size: { weight: 1 }, ...card,
    children: [
      { id: `${cell.id}-h`, type: "block", size: { px: HEADER_HEIGHT },
        content: { mod: "rig-cell-header", props: { title: cell.title, detail: cell.detail ?? "", seat: cell.seat } } },
      { id: `${cell.id}-x`, type: "block", content: { terminal: cell.terminal },
        ...(border ? { border } : {}), ...(focus ? { focus: { border: focus } } : {}) },
    ],
  };
}

/** One view as an equal, padded grid. */
export function viewGrid(view: RigView, gap: number, paint: Record<string, unknown> = {}, focus?: unknown): LayoutNode {
  const { cols, rows } = gridShape(view.cells.length, view.columns);
  const cells: (RigCell | null)[] = [...view.cells, ...Array<null>(rows * cols - view.cells.length).fill(null)];
  return {
    id: view.id, type: "column", gap, padding: gap,
    children: Array.from({ length: rows }, (_, r) => ({
      id: `${view.id}-r${r}`, type: "row", gap, size: { weight: 1 },
      children: Array.from({ length: cols }, (_, c) => cellNode(cells[r * cols + c] ?? null, `${view.id}-pad${r * cols + c}`, paint, focus)),
    })),
  };
}

/** The live terminals of a view by grid position (null for pad and ended cells): the strip moves between them. */
export function viewRows(view: RigView): (string | null)[][] {
  const { cols, rows } = gridShape(view.cells.length, view.columns);
  return Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => view.cells[r * cols + c]?.terminal ?? null));
}

export interface StripProps {
  stack: string;
  main: string;
  revision: string;
  views: Array<{ id: string; name: string; rows: (string | null)[][] }>;
}

/**
 * Derive the Rig layout. `base` is the person's layout tree as read from its file; it is not modified.
 * The stack's file `active` is always the person's tabs: herdr lets a file edit beat a click on the same field, so a
 * changing `active` would pull the person out of the view they chose. An explicit open shows its view with
 * `layout.select`, which is the person's click state, and every later rewrite leaves it alone.
 */
export function deriveRigLayout(base: LayoutNode, views: readonly RigView[], opts: { revision: string }): DeriveResult {
  const tree = structuredClone(base) as LayoutNode;
  if (findParent(tree, n => n.id === RIG_STACK)) return { ok: false, code: "base_is_rig_layout", error: "The base layout already holds OpenRig's Rig stack; derive from the person's own layout." };
  const hit = isTabBlock(tree) ? null : findParent(tree, isTabBlock);
  if (!hit) return { ok: false, code: "base_has_no_tab_block", error: "The base layout has no {\"tab\":\"active\"} block for OpenRig's views to sit beside." };
  const tabBlock = hit.parent.children![hit.index]!;
  const { gap, paint, focus } = frameOf(tabBlock);
  // The person's tab block keeps its own id (their clicks on it stay theirs); `main` only when it has none.
  const mainId = typeof tabBlock.id === "string" && tabBlock.id ? tabBlock.id : RIG_MAIN;
  const main: LayoutNode = { ...tabBlock, id: mainId };
  const strip: StripProps = {
    stack: RIG_STACK, main: mainId, revision: opts.revision,
    views: views.map(v => ({ id: v.id, name: v.name, rows: viewRows(v) })),
  };
  const stack: LayoutNode = {
    id: RIG_STACK, type: "stack", active: mainId,
    header: { content: { mod: "rig-strip", props: strip }, height: STRIP_HEIGHT },
    children: [main, ...views.map(v => viewGrid(v, gap, paint, focus))],
  };
  for (const key of ["size", "min", "max"] as const) {
    if (key in main) { stack[key] = main[key]; delete main[key]; }
  }
  hit.parent.children![hit.index] = stack;
  delete tree.preview;
  delete tree.cloned_from;
  return { ok: true, tree };
}
