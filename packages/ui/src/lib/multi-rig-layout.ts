// V1 polish slice Phase 5.2 P5.2-3 + P5.2-6 — multi-rig canvas helpers.
//
// Two responsibilities:
//   1. prefixRigData(rigId, nodes, edges): cross-rig node-ID prefixing
//      so the merged canvas satisfies react-flow's unique-ID requirement.
//      Each prefixed node carries `data.rigId` so downstream click
//      handlers read rigId from `node.data.rigId` (NOT closure).
//   2. packRigGroups(rigBounds, viewportWidth): outer offset packing.
//      Per-rig layout already happened via applyTreeLayout (or fixed
//      collapsed-card dimensions when not yet expanded); this helper
//      places each rig group at a grid offset in the host canvas.
//
// Layout strategy = option (a) per-rig + outer offset (per Phase 5.2
// ACK §2). Rationale: collapse stability — toggling rig N doesn't
// reflow rigs 1..N-1 because each rig's internal layout is independent
// and its outer offset is fixed by its grid slot.

const PREFIX_DELIMITER = "::";

export const COLLAPSED_RIG_WIDTH = 280;
export const COLLAPSED_RIG_HEIGHT = 120;
const RIG_GUTTER_X = 48;
const RIG_GUTTER_Y = 48;
/** Extra height the rig group adds above its expanded children
 *  (header + counts strip + padding). Used by expanded-bounds calc. */
export const RIG_HEADER_HEIGHT = 60;
export const RIG_PADDING = 16;

/** Prefix every node ID + edge endpoint with `${rigId}::` so the merged
 *  multi-rig graph has globally-unique IDs. Threads `data.rigId` onto
 *  every node so click handlers can read it without closure capture. */
export function prefixRigData<
  N extends { id: string; data?: Record<string, unknown> },
  E extends { id: string; source: string; target: string },
>(
  rigId: string,
  nodes: readonly N[],
  edges: readonly E[],
): { nodes: N[]; edges: E[] } {
  const prefixed = (id: string) => `${rigId}${PREFIX_DELIMITER}${id}`;
  return {
    nodes: nodes.map((n) => ({
      ...n,
      id: prefixed(n.id),
      // Some node shapes carry parentId for react-flow parent/child;
      // prefix that too if present.
      ...((n as unknown as { parentId?: string }).parentId
        ? { parentId: prefixed((n as unknown as { parentId: string }).parentId) }
        : {}),
      data: { ...(n.data ?? {}), rigId },
    })),
    edges: edges.map((e) => ({
      ...e,
      id: prefixed(e.id),
      source: prefixed(e.source),
      target: prefixed(e.target),
    })),
  };
}

/** Compute the bounding box of a set of laid-out nodes (per-rig
 *  expanded children) so the outer rig group can size correctly.
 *  Returns rig-internal-relative coordinates (the top-left node at
 *  origin); the outer offset is added by packRigGroups. */
export function computeBounds(
  nodes: ReadonlyArray<{ position: { x: number; y: number }; initialWidth?: number; initialHeight?: number }>,
): { width: number; height: number; minX: number; minY: number } {
  if (nodes.length === 0) {
    return { width: COLLAPSED_RIG_WIDTH, height: COLLAPSED_RIG_HEIGHT, minX: 0, minY: 0 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    const w = n.initialWidth ?? 240;
    const h = n.initialHeight ?? 160;
    minX = Math.min(minX, n.position.x);
    minY = Math.min(minY, n.position.y);
    maxX = Math.max(maxX, n.position.x + w);
    maxY = Math.max(maxY, n.position.y + h);
  }
  return {
    width: Math.max(maxX - minX + 2 * RIG_PADDING, COLLAPSED_RIG_WIDTH),
    height: maxY - minY + 2 * RIG_PADDING + RIG_HEADER_HEIGHT,
    minX,
    minY,
  };
}

export interface RigBounds {
  rigId: string;
  width: number;
  height: number;
}

export interface PackedRig {
  rigId: string;
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}

/** Pack rig groups in a grid given a viewport width. Each rig keeps its
 *  own (possibly-different-sized) bounds; the grid uses a max-width
 *  column tracker per row so wider rigs don't squeeze narrower ones.
 *  Simple greedy row-fill — sufficient for V1 fleet sizes. */
export function packRigGroups(
  rigs: readonly RigBounds[],
  viewportWidth: number,
): PackedRig[] {
  const packed: PackedRig[] = [];
  const minViewport = Math.max(viewportWidth, COLLAPSED_RIG_WIDTH + 2 * RIG_GUTTER_X);
  let cursorX = 0;
  let cursorY = 0;
  let rowMaxHeight = 0;
  for (const rig of rigs) {
    if (cursorX + rig.width > minViewport && cursorX > 0) {
      // Wrap to next row.
      cursorX = 0;
      cursorY += rowMaxHeight + RIG_GUTTER_Y;
      rowMaxHeight = 0;
    }
    packed.push({
      rigId: rig.rigId,
      offsetX: cursorX,
      offsetY: cursorY,
      width: rig.width,
      height: rig.height,
    });
    cursorX += rig.width + RIG_GUTTER_X;
    rowMaxHeight = Math.max(rowMaxHeight, rig.height);
  }
  return packed;
}
