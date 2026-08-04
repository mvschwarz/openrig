// SPIKE — deterministic hand-rolled layout for the boxed graph styles.
// Delegation depth ranks nodes into columns (Hatchet reads left→right);
// collaborators pull right of their source; escalates_to is a back-edge and
// never ranks. Everything is derived from the served projection only.
import type { GraphEdge, GraphNode, RigGraph } from "./graph-types.js";
import { statusGlyph, type StatusGlyph } from "./glyphs.js";

export interface PlacedNode {
  node: GraphNode;
  glyph: StatusGlyph;
  /** MEMBER-only display title (S19 MR1 — identity stays logicalId in every
   * zone/action; this is display only) */
  title: string;
  /** `● member  63%` and `runtime · ctx%` — the info INSIDE the node */
  nameLine: string;
  metaLine: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GraphContainer {
  kind: "rig" | "pod";
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GraphLayout {
  placed: PlacedNode[];
  byId: Map<string, PlacedNode>;
  edges: GraphEdge[];
  /** R2 HIGH-1: the LOCKED containment hierarchy — the rig container wraps
   * pod containers, pod containers wrap their member agent boxes; renderers
   * MUST draw them (agent-in-pod-in-rig is a visible contract, not metadata) */
  containers: GraphContainer[];
  width: number;
  height: number;
  /** MR8: true when the laid-out extent exceeds the viewport width — the
   * renderer MUST show the honest clipped-content indicator */
  clipped: boolean;
}

export function agentNodes(graph: RigGraph): GraphNode[] {
  return graph.nodes.filter((n) => n.type === "rigNode" && n.data.nodeKind === "agent");
}

export function nodeLines(node: GraphNode): { glyph: StatusGlyph; title: string; nameLine: string; metaLine: string } {
  const glyph = statusGlyph(node.data);
  const ctx = node.data.contextUsedPercentage;
  // S19 MR1 (§A1): the pod is named ONCE — by its container tab. The card
  // title is the MEMBER-only segment (a confirmed `${pod}.` prefix strips,
  // the navigator's rule; non-prefixed names display unchanged) and the meta
  // drops the pod suffix.
  const pod = node.data.podNamespace;
  const member = pod && node.data.logicalId.startsWith(`${pod}.`)
    ? node.data.logicalId.slice(pod.length + 1)
    : node.data.logicalId;
  const nameLine = `${glyph.glyph} ${member}${glyph.overlay ? `  ${glyph.overlay}` : ""}`;
  // honest-unknown: a null ctx renders "—", never a fabricated number
  const metaLine = `${node.data.runtime ?? "—"} · ${ctx == null ? "—" : `${Math.round(ctx)}%`}`;
  return { glyph, title: member, nameLine, metaLine };
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

const POD_GAP = 4;
const MARGIN_X = 1;

/** R2 HIGH-1 layout: pods are the clustering unit — each pod is a container
 * column holding its member agent boxes stacked vertically; pods order by the
 * min delegation rank of their members (delegation still reads left→right);
 * the rig container wraps everything. Ungrouped agents get a "(no pod)"
 * cluster so nothing served is ever dropped. */
export function layoutGraph(graph: RigGraph, maxWidth: number, rigName = ""): GraphLayout {
  const agents = agentNodes(graph);
  const rank = rankNodes(agents, graph.edges);
  const podLabel = new Map<string, string>(
    graph.nodes.filter((n) => n.type === "podGroup").map((n) => [n.id, n.data.podNamespace ?? n.data.logicalId]),
  );
  const pods = new Map<string, GraphNode[]>();
  for (const n of agents) {
    const key = (n.parentId && podLabel.get(n.parentId)) ?? n.data.podNamespace ?? "(no pod)";
    pods.set(key, [...(pods.get(key) ?? []), n]);
  }
  const podOrder = [...pods.entries()].sort(([an, a], [bn, b]) => {
    const ar = Math.min(...a.map((n) => rank.get(n.id) ?? 0));
    const br = Math.min(...b.map((n) => rank.get(n.id) ?? 0));
    return ar - br || an.localeCompare(bn);
  });

  const placed: PlacedNode[] = [];
  const byId = new Map<string, PlacedNode>();
  const containers: GraphContainer[] = [];
  const rigX = MARGIN_X;
  const rigY = 1;
  let podX = rigX + 2;
  let maxPodBottom = 0;
  for (const [podName, members] of podOrder) {
    const sorted = [...members].sort(
      (a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0) || a.data.logicalId.localeCompare(b.data.logicalId),
    );
    const podTop = rigY + 1;
    let y = podTop + 1;
    let podInnerW = Math.max(`▾ ${podName}`.length + 2, 8);
    for (const node of sorted) {
      const { glyph, title, nameLine, metaLine } = nodeLines(node);
      const w = Math.max(nameLine.length, metaLine.length) + 4;
      const p: PlacedNode = { node, glyph, title, nameLine, metaLine, x: podX + 2, y, w, h: 4 };
      placed.push(p);
      byId.set(node.id, p);
      y += p.h + 1;
      podInnerW = Math.max(podInnerW, w);
    }
    const podW = podInnerW + 4;
    const podH = y - podTop + 1;
    containers.push({ kind: "pod", name: podName, x: podX, y: podTop, w: podW, h: podH });
    maxPodBottom = Math.max(maxPodBottom, podTop + podH);
    podX += podW + POD_GAP;
  }
  const rigW = podX - POD_GAP + 2 - rigX;
  // two spare interior rows: the escalation under-route corridor (lanes 0-1)
  // must never land on the rig's own bottom border
  const rigH = maxPodBottom - rigY + 4;
  containers.unshift({ kind: "rig", name: rigName, x: rigX, y: rigY, w: rigW, h: rigH });

  const trueWidth = rigX + rigW + MARGIN_X;
  const width = Math.min(trueWidth, maxWidth);
  const height = rigY + rigH + 1;
  return { placed, byId, edges: graph.edges, containers, width, height, clipped: trueWidth > maxWidth };
}
