// SPIKE — deterministic hand-rolled layout for the boxed graph styles.
// Delegation depth ranks nodes into columns (Hatchet reads left→right);
// collaborators pull right of their source; escalates_to is a back-edge and
// never ranks. Everything is derived from the served projection only.
import type { GraphEdge, GraphNode, RigGraph } from "./graph-types.js";
import { statusGlyph, type StatusGlyph } from "./glyphs.js";

export interface PlacedNode {
  node: GraphNode;
  glyph: StatusGlyph;
  /** `● name  63%` and `runtime · ctx% · pod` — the info INSIDE the node */
  nameLine: string;
  metaLine: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GraphLayout {
  placed: PlacedNode[];
  byId: Map<string, PlacedNode>;
  edges: GraphEdge[];
  width: number;
  height: number;
}

export function agentNodes(graph: RigGraph): GraphNode[] {
  return graph.nodes.filter((n) => n.type === "rigNode" && n.data.nodeKind === "agent");
}

export function nodeLines(node: GraphNode): { glyph: StatusGlyph; nameLine: string; metaLine: string } {
  const glyph = statusGlyph(node.data);
  const ctx = node.data.contextUsedPercentage;
  const nameLine = `${glyph.glyph} ${node.data.logicalId}${glyph.overlay ? `  ${glyph.overlay}` : ""}`;
  // honest-unknown: a null ctx renders "—", never a fabricated number
  const metaLine = `${node.data.runtime ?? "—"} · ${ctx == null ? "—" : `${Math.round(ctx)}%`} · ${node.data.podNamespace ?? "—"}`;
  return { glyph, nameLine, metaLine };
}

function rankNodes(agents: GraphNode[], edges: GraphEdge[]): Map<string, number> {
  const rank = new Map<string, number>();
  const delegates = edges.filter((e) => e.label === "delegates_to");
  const hasIncoming = new Set(delegates.map((e) => e.target));
  const roots = agents.filter((n) => !hasIncoming.has(n.id));
  for (const root of roots) rank.set(root.id, 0);
  // relax delegation depth (fixture-scale graphs; bounded passes)
  for (let pass = 0; pass < agents.length; pass++) {
    let changed = false;
    for (const e of delegates) {
      const from = rank.get(e.source);
      if (from == null) continue;
      const proposed = from + 1;
      if ((rank.get(e.target) ?? -1) < proposed) {
        rank.set(e.target, proposed);
        changed = true;
      }
    }
    if (!changed) break;
  }
  // collaborators sit one column RIGHT of their partner (the mockup reading:
  // lead → driver ═ qa) — applies to nodes that are not delegation targets
  // themselves, even if the root-default provisionally ranked them 0
  for (const e of edges.filter((x) => x.label === "collaborates_with")) {
    const from = rank.get(e.source);
    const targetIsDelegate = delegates.some((d) => d.target === e.target);
    const targetDelegates = delegates.some((d) => d.source === e.target);
    if (from != null && !targetIsDelegate && !targetDelegates) rank.set(e.target, from + 1);
  }
  for (const n of agents) if (!rank.has(n.id)) rank.set(n.id, 0);
  return rank;
}

const COL_GAP = 8;
const ROW_GAP = 1;
const MARGIN_X = 2;
const MARGIN_Y = 1;

export function layoutGraph(graph: RigGraph, maxWidth: number): GraphLayout {
  const agents = agentNodes(graph);
  const rank = rankNodes(agents, graph.edges);
  const columns = new Map<number, GraphNode[]>();
  for (const n of agents) {
    const r = rank.get(n.id) ?? 0;
    columns.set(r, [...(columns.get(r) ?? []), n]);
  }
  const placed: PlacedNode[] = [];
  const byId = new Map<string, PlacedNode>();
  let x = MARGIN_X;
  for (const r of [...columns.keys()].sort((a, b) => a - b)) {
    const col = columns.get(r)!.sort((a, b) => {
      // delegation sources read top-left (the mockup's lead position)
      const aDelegates = graph.edges.some((e) => e.label === "delegates_to" && e.source === a.id) ? 0 : 1;
      const bDelegates = graph.edges.some((e) => e.label === "delegates_to" && e.source === b.id) ? 0 : 1;
      return aDelegates - bDelegates
        || (a.data.podNamespace ?? "").localeCompare(b.data.podNamespace ?? "")
        || a.data.logicalId.localeCompare(b.data.logicalId);
    });
    let y = MARGIN_Y;
    let colWidth = 0;
    for (const node of col) {
      const { glyph, nameLine, metaLine } = nodeLines(node);
      const w = Math.max(nameLine.length, metaLine.length) + 4; // borders + 1-cell padding
      const p: PlacedNode = { node, glyph, nameLine, metaLine, x, y, w, h: 4 };
      placed.push(p);
      byId.set(node.id, p);
      y += p.h + ROW_GAP * 2;
      colWidth = Math.max(colWidth, w);
    }
    x += colWidth + COL_GAP;
  }
  const width = Math.min(Math.max(...placed.map((p) => p.x + p.w), 0) + MARGIN_X, maxWidth);
  const height = Math.max(...placed.map((p) => p.y + p.h), 0) + MARGIN_Y;
  return { placed, byId, edges: graph.edges, width, height };
}
