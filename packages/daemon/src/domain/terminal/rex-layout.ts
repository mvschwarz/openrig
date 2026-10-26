import type { ComposedPane } from "./terminal-provider.js";
import { buildTileGrid, type TileGrid, type TileNodes } from "./tile-layout.js";

const TERMINAL_FLAVOR = "com.superlogical.terminal.shell";
export const REX_LABEL_LIMIT = 128;
/** A tile whose command fails this soon stays open showing the error; the shell's startup counts toward it. */
const FAILED_TILE_HOLD_MS = 10_000;

export type RexLayoutNode =
  | { block: { flavor: string; label: string; options: { command: string[]; exit?: { quick_exit_threshold_ms: number } } } }
  | { split: { direction: "horizontal" | "vertical"; ratio: number; before: RexLayoutNode; after: RexLayoutNode } };

/** Rex refuses a label over 128 characters or with a control character. */
export function rexLabel(label: string, limit = REX_LABEL_LIMIT): string {
  const chars = [...label.replace(/[\u0000-\u001f\u007f]/g, " ")];
  return chars.length <= limit ? chars.join("") : `${chars.slice(0, limit - 1).join("")}…`;
}

const block = (label: string, options: { command: string[]; exit?: { quick_exit_threshold_ms: number } }): RexLayoutNode =>
  ({ block: { flavor: TERMINAL_FLAVOR, label: rexLabel(label), options } });

/** Rex has no env option for a block, so the composed shell command runs through `sh -c` unchanged. */
const REX_TILE_NODES: TileNodes<RexLayoutNode> = {
  tile: (pane) => block(pane.label, { command: ["sh", "-c", pane.paneCommand], exit: { quick_exit_threshold_ms: FAILED_TILE_HOLD_MS } }),
  blank: () => block("", { command: ["sh"] }),
  split: (direction, ratio, before, after) => ({ split: { direction: direction === "across" ? "horizontal" : "vertical", ratio, before, after } }),
};

export function buildRexGrid(panes: ComposedPane[], columns?: number): TileGrid<RexLayoutNode> {
  return buildTileGrid(panes, columns, REX_TILE_NODES);
}
