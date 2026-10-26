import { autoGridCols } from "../cmux-layout-service.js";
import type { ComposedPane, ComposedView } from "./terminal-provider.js";

/** How one provider spells a grid's nodes. `across` puts `first` on the left, `down` puts it on top. */
export interface TileNodes<N> {
  tile(pane: ComposedPane): N;
  blank(): N;
  split(direction: "across" | "down", ratio: number, first: N, second: N): N;
}

export interface TileGrid<N> {
  root: N;
  /** Inert filler tiles that complete the rectangle; never reported as opened seats. */
  blanks: number;
  columns: number;
  rows: number;
}

/**
 * The equal grid for one page, shared by every provider that builds a layout tree. Explicit columns are capped
 * to the pane count; otherwise cols = ceil(sqrt(N)) and rows = ceil(N/cols), the UI TerminalLauncher shape.
 * Rows are equal `across` strips combined by equal `down` strips, and blanks pad the last row.
 */
export function buildTileGrid<N>(panes: ComposedPane[], columns: number | undefined, nodes: TileNodes<N>): TileGrid<N> {
  const cols = Math.min(columns ?? autoGridCols(panes.length), panes.length || 1);
  const rows = Math.ceil(panes.length / cols);
  const blanks = rows * cols - panes.length;
  const leaves = panes.map((pane) => nodes.tile(pane));
  for (let i = 0; i < blanks; i++) leaves.push(nodes.blank());
  // First-vs-rest at 1/N, then 1/(N-1): equal cells, where alternating 0.5 splits would not be.
  const strip = (items: N[], direction: "across" | "down"): N =>
    items.length === 1 ? items[0]! : nodes.split(direction, 1 / items.length, items[0]!, strip(items.slice(1), direction));
  const rowStrips: N[] = [];
  for (let r = 0; r < rows; r++) rowStrips.push(strip(leaves.slice(r * cols, (r + 1) * cols), "across"));
  return { root: strip(rowStrips, "down"), blanks, columns: cols, rows };
}

/** A named view's tab: its panes' names in reading order, such as "dashboard · operator". */
export function namedTabLabel(page: ComposedPane[]): string {
  return page.map((pane) => pane.label).join(" · ");
}

/**
 * The space and per-page labels for one open. The space is named for people: a named view's own label, the rig
 * name for a rig view, else the view id. Page labels embed the plan and launch token, so every open is a fresh,
 * distinct space; a named view's pages carry their panes' names instead.
 */
export function planTileLabels(view: ComposedView, launchToken: string, prefix = "openrig"): { space: string; pages: string[] } {
  const base = `${prefix}:${view.id}${view.planId ? `#${view.planId.slice(0, 16)}` : ""}#${launchToken}`;
  const space = view.spaceLabel ?? (view.id.startsWith("rig:") ? view.id.slice("rig:".length) : view.id);
  const pages = view.pages.map((page, index) =>
    view.spaceLabel ? namedTabLabel(page) : view.pages.length > 1 ? `${base}/${index + 1}` : base);
  return { space, pages };
}
