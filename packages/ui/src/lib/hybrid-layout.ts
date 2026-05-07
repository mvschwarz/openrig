import dagre from "dagre";
import { Position, type Edge, type Node } from "@xyflow/react";

const PREFIX_DELIMITER = "::";

export const HYBRID_AGENT_WIDTH = 166;
export const HYBRID_AGENT_HEIGHT = 116;
export const HYBRID_POD_HEADER_HEIGHT = 38;
export const HYBRID_POD_PADDING_X = 28;
export const HYBRID_POD_PADDING_BOTTOM = 22;
export const HYBRID_POD_MIN_WIDTH = 188;
export const HYBRID_RIG_HEADER_HEIGHT = 78;
export const HYBRID_RIG_PADDING_X = 42;
export const HYBRID_RIG_PADDING_BOTTOM = 40;
export const HYBRID_RIG_MIN_WIDTH = 320;
export const HYBRID_COLLAPSED_RIG_WIDTH = 280;
export const HYBRID_COLLAPSED_RIG_HEIGHT = 118;
export const HYBRID_OUTER_MARGIN = 96;
export const HYBRID_OUTER_LANE_COUNT = 3;
export const HYBRID_CROSS_RIG_STROKE_DASH = "6 7";

interface LayoutItem {
  id: string;
  width: number;
  height: number;
}

interface LayoutEdge {
  source: string;
  target: string;
}

interface HybridRawNode extends Omit<Node, "data"> {
  data?: Record<string, unknown>;
  initialWidth?: number;
  initialHeight?: number;
}

interface HybridRawEdge extends Omit<Edge, "data" | "label"> {
  data?: Record<string, unknown>;
  label?: unknown;
}

interface PodLayout {
  node: HybridRawNode;
  width: number;
  height: number;
  position: { x: number; y: number };
  members: Array<{ node: HybridRawNode; position: { x: number; y: number } }>;
}

interface StandaloneLayout {
  node: HybridRawNode;
  width: number;
  height: number;
  position: { x: number; y: number };
}

export interface HybridRigLayoutInput {
  rigId: string;
  nodes: HybridRawNode[];
  edges: HybridRawEdge[];
  collapsed: boolean;
}

export interface HybridRigLayoutResult {
  nodes: Node[];
  edges: Edge[];
  width: number;
  height: number;
  podCount: number;
}

export interface HybridOuterRigInput {
  rigId: string;
  width: number;
  height: number;
}

export interface HybridOuterRigPosition extends HybridOuterRigInput {
  position: { x: number; y: number };
}

export function prefixedHybridNodeId(rigId: string, nodeId: string): string {
  return `${rigId}${PREFIX_DELIMITER}${nodeId}`;
}

export function unprefixedHybridNodeId(nodeId: string): { rigId: string | null; localId: string } {
  const index = nodeId.indexOf(PREFIX_DELIMITER);
  if (index < 0) return { rigId: null, localId: nodeId };
  return {
    rigId: nodeId.slice(0, index),
    localId: nodeId.slice(index + PREFIX_DELIMITER.length),
  };
}

export function isHybridPodNode(node: Pick<Node, "type">): boolean {
  return node.type === "podGroup" || node.type === "group";
}

export function getHybridEdgeStyle(kind: string | null | undefined, crossRig = false): Edge["style"] {
  if (crossRig) {
    return {
      stroke: "#a8a29e",
      strokeWidth: 1,
      strokeDasharray: HYBRID_CROSS_RIG_STROKE_DASH,
    };
  }
  if (kind === "pod-internal" || kind === "contains" || kind === "member") {
    return {
      stroke: "#44403c",
      strokeWidth: 1.5,
    };
  }
  return {
    stroke: "#78716c",
    strokeWidth: 1.5,
  };
}

export function layoutHybridRig(input: HybridRigLayoutInput): HybridRigLayoutResult {
  if (input.collapsed) {
    return {
      nodes: [],
      edges: [],
      width: HYBRID_COLLAPSED_RIG_WIDTH,
      height: HYBRID_COLLAPSED_RIG_HEIGHT,
      podCount: 0,
    };
  }

  const podIds = new Set(input.nodes.filter(isHybridPodNode).map((node) => node.id));
  const membersByPod = new Map<string, HybridRawNode[]>();
  const standaloneNodes: HybridRawNode[] = [];

  for (const node of input.nodes) {
    if (isHybridPodNode(node)) continue;
    if (typeof node.parentId === "string" && podIds.has(node.parentId)) {
      if (!membersByPod.has(node.parentId)) membersByPod.set(node.parentId, []);
      membersByPod.get(node.parentId)!.push(node);
      continue;
    }
    standaloneNodes.push(node);
  }

  const podLayouts = input.nodes
    .filter(isHybridPodNode)
    .map((node) => layoutPod(node, membersByPod.get(node.id) ?? [], input.edges));
  const standaloneLayouts = standaloneNodes.map<StandaloneLayout>((node) => ({
    node,
    width: node.initialWidth ?? HYBRID_AGENT_WIDTH,
    height: node.initialHeight ?? HYBRID_AGENT_HEIGHT,
    position: { x: 0, y: 0 },
  }));

  const entityItems: LayoutItem[] = [
    ...podLayouts.map((pod) => ({ id: pod.node.id, width: pod.width, height: pod.height })),
    ...standaloneLayouts.map((layout) => ({ id: layout.node.id, width: layout.width, height: layout.height })),
  ];
  const entityByNode = buildEntityLookup(podLayouts, standaloneLayouts);
  const entityEdges = dedupeEdges(
    input.edges
      .map((edge) => {
        const source = entityByNode.get(edge.source);
        const target = entityByNode.get(edge.target);
        if (!source || !target || source === target) return null;
        return { source, target };
      })
      .filter((edge): edge is LayoutEdge => Boolean(edge)),
  );
  const entityCenters = layoutWithDagre(entityItems, entityEdges, "LR", {
    nodesep: 34,
    ranksep: 34,
  });
  const normalized = normalizeLayout(entityItems, entityCenters, {
    x: HYBRID_RIG_PADDING_X,
    y: HYBRID_RIG_HEADER_HEIGHT,
  });

  for (const pod of podLayouts) {
    pod.position = normalized.positions.get(pod.node.id) ?? {
      x: HYBRID_RIG_PADDING_X,
      y: HYBRID_RIG_HEADER_HEIGHT,
    };
  }
  for (const layout of standaloneLayouts) {
    layout.position = normalized.positions.get(layout.node.id) ?? {
      x: HYBRID_RIG_PADDING_X,
      y: HYBRID_RIG_HEADER_HEIGHT,
    };
  }

  const width = Math.max(HYBRID_RIG_MIN_WIDTH, normalized.width + HYBRID_RIG_PADDING_X * 2);
  const height = Math.max(
    HYBRID_COLLAPSED_RIG_HEIGHT,
    normalized.height + HYBRID_RIG_HEADER_HEIGHT + HYBRID_RIG_PADDING_BOTTOM,
  );
  const rigParentId = `rig-${input.rigId}`;
  const flowNodes: Node[] = [];

  for (const pod of podLayouts) {
    const podId = prefixedHybridNodeId(input.rigId, pod.node.id);
    flowNodes.push({
      ...pod.node,
      id: podId,
      type: "podGroup",
      parentId: rigParentId,
      extent: "parent",
      position: pod.position,
      data: { ...(pod.node.data ?? {}), rigId: input.rigId, agentCount: pod.members.length },
      style: { ...(pod.node.style ?? {}), width: pod.width, height: pod.height },
      draggable: false,
      zIndex: 1,
    });

    for (const member of pod.members) {
      flowNodes.push({
        ...member.node,
        id: prefixedHybridNodeId(input.rigId, member.node.id),
        type: "rigNode",
        parentId: podId,
        extent: "parent",
        position: member.position,
        data: { ...(member.node.data ?? {}), rigId: input.rigId },
        style: { ...(member.node.style ?? {}), width: HYBRID_AGENT_WIDTH, height: HYBRID_AGENT_HEIGHT },
        initialWidth: HYBRID_AGENT_WIDTH,
        initialHeight: HYBRID_AGENT_HEIGHT,
        sourcePosition: Position.Right,
        targetPosition: Position.Left,
        draggable: false,
        zIndex: 2,
      });
    }
  }

  for (const standalone of standaloneLayouts) {
    flowNodes.push({
      ...standalone.node,
      id: prefixedHybridNodeId(input.rigId, standalone.node.id),
      type: "rigNode",
      parentId: rigParentId,
      extent: "parent",
      position: standalone.position,
      data: { ...(standalone.node.data ?? {}), rigId: input.rigId },
      style: { ...(standalone.node.style ?? {}), width: HYBRID_AGENT_WIDTH, height: HYBRID_AGENT_HEIGHT },
      initialWidth: HYBRID_AGENT_WIDTH,
      initialHeight: HYBRID_AGENT_HEIGHT,
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      draggable: false,
      zIndex: 2,
    });
  }

  const flowEdges = input.edges.map((edge) => {
    const sourceRig = input.rigId;
    const targetRig = input.rigId;
    const edgeId = edge.id || `${edge.source}->${edge.target}`;
    const kind = typeof edge.data?.["kind"] === "string"
      ? edge.data["kind"]
        : typeof edge.label === "string"
          ? edge.label
          : null;
    const { label: rawLabel, ...edgeWithoutLabel } = edge;
    return {
      ...edgeWithoutLabel,
      id: prefixedHybridNodeId(input.rigId, edgeId),
      source: prefixedHybridNodeId(sourceRig, edge.source),
      target: prefixedHybridNodeId(targetRig, edge.target),
      label: typeof rawLabel === "string" ? rawLabel : undefined,
      type: edge.type ?? "default",
      selectable: false,
      focusable: false,
      interactionWidth: edge.interactionWidth ?? 10,
      style: {
        ...getHybridEdgeStyle(kind),
        ...(edge.style ?? {}),
      },
      data: { ...(edge.data ?? {}), kind },
    } satisfies Edge;
  });

  return {
    nodes: flowNodes,
    edges: flowEdges,
    width,
    height,
    podCount: podLayouts.length,
  };
}

export function layoutHybridOuterRigs(rigs: readonly HybridOuterRigInput[]): HybridOuterRigPosition[] {
  const items = rigs.map((rig) => ({ id: rig.rigId, width: rig.width, height: rig.height }));
  const lanes: string[][] = Array.from({ length: HYBRID_OUTER_LANE_COUNT }, () => []);
  rigs.forEach((rig, index) => {
    lanes[index % lanes.length]!.push(rig.rigId);
  });
  const guideEdges: LayoutEdge[] = [];
  for (const lane of lanes) {
    for (let index = 0; index < lane.length - 1; index += 1) {
      guideEdges.push({ source: lane[index]!, target: lane[index + 1]! });
    }
  }

  const centers = layoutWithDagre(items, guideEdges, "TB", {
    nodesep: 68,
    ranksep: 62,
  });
  const normalized = normalizeLayout(items, centers, {
    x: HYBRID_OUTER_MARGIN,
    y: HYBRID_OUTER_MARGIN,
  });

  return rigs.map((rig) => ({
    ...rig,
    position: normalized.positions.get(rig.rigId) ?? {
      x: HYBRID_OUTER_MARGIN,
      y: HYBRID_OUTER_MARGIN,
    },
  }));
}

function layoutPod(node: HybridRawNode, members: HybridRawNode[], edges: HybridRawEdge[]): PodLayout {
  const items = members.map((member) => ({
    id: member.id,
    width: HYBRID_AGENT_WIDTH,
    height: HYBRID_AGENT_HEIGHT,
  }));
  const memberIds = new Set(members.map((member) => member.id));
  const internalEdges = edges.filter((edge) =>
    memberIds.has(edge.source) &&
    memberIds.has(edge.target)
  );
  const centers = layoutWithDagre(items, internalEdges, "TB", {
    nodesep: 16,
    ranksep: 16,
  });
  const normalized = normalizeLayout(items, centers, {
    x: HYBRID_POD_PADDING_X,
    y: HYBRID_POD_HEADER_HEIGHT,
  });
  const width = Math.max(HYBRID_POD_MIN_WIDTH, normalized.width + HYBRID_POD_PADDING_X * 2);
  const height = Math.max(
    HYBRID_POD_HEADER_HEIGHT + HYBRID_POD_PADDING_BOTTOM,
    normalized.height + HYBRID_POD_HEADER_HEIGHT + HYBRID_POD_PADDING_BOTTOM,
  );

  return {
    node,
    width,
    height,
    position: { x: 0, y: 0 },
    members: members.map((member) => ({
      node: member,
      position: normalized.positions.get(member.id) ?? {
        x: HYBRID_POD_PADDING_X,
        y: HYBRID_POD_HEADER_HEIGHT,
      },
    })),
  };
}

function buildEntityLookup(pods: PodLayout[], standalone: StandaloneLayout[]): Map<string, string> {
  const lookup = new Map<string, string>();
  for (const pod of pods) {
    lookup.set(pod.node.id, pod.node.id);
    for (const member of pod.members) {
      lookup.set(member.node.id, pod.node.id);
    }
  }
  for (const layout of standalone) {
    lookup.set(layout.node.id, layout.node.id);
  }
  return lookup;
}

function dedupeEdges(edges: LayoutEdge[]): LayoutEdge[] {
  const seen = new Set<string>();
  const result: LayoutEdge[] = [];
  for (const edge of edges) {
    const key = `${edge.source}->${edge.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(edge);
  }
  return result;
}

function layoutWithDagre(
  items: LayoutItem[],
  edges: LayoutEdge[],
  rankdir: "TB" | "LR",
  options: { nodesep: number; ranksep: number },
): Map<string, { x: number; y: number }> {
  const graph = new dagre.graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({
    rankdir,
    nodesep: options.nodesep,
    ranksep: options.ranksep,
    marginx: 0,
    marginy: 0,
  });

  for (const item of items) {
    graph.setNode(item.id, { width: item.width, height: item.height });
  }
  const itemIds = new Set(items.map((item) => item.id));
  for (const edge of edges) {
    if (!itemIds.has(edge.source) || !itemIds.has(edge.target) || edge.source === edge.target) {
      continue;
    }
    graph.setEdge(edge.source, edge.target);
  }

  dagre.layout(graph);

  const positions = new Map<string, { x: number; y: number }>();
  for (const item of items) {
    const node = graph.node(item.id) as { x: number; y: number } | undefined;
    positions.set(item.id, node ?? { x: 0, y: 0 });
  }
  return positions;
}

function normalizeLayout(
  items: LayoutItem[],
  centers: Map<string, { x: number; y: number }>,
  offset: { x: number; y: number },
): {
  positions: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
} {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const item of items) {
    const center = centers.get(item.id) ?? { x: 0, y: 0 };
    minX = Math.min(minX, center.x - item.width / 2);
    minY = Math.min(minY, center.y - item.height / 2);
    maxX = Math.max(maxX, center.x + item.width / 2);
    maxY = Math.max(maxY, center.y + item.height / 2);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return { positions: new Map(), width: 0, height: 0 };
  }

  const positions = new Map<string, { x: number; y: number }>();
  for (const item of items) {
    const center = centers.get(item.id) ?? { x: 0, y: 0 };
    positions.set(item.id, {
      x: offset.x + center.x - item.width / 2 - minX,
      y: offset.y + center.y - item.height / 2 - minY,
    });
  }

  return {
    positions,
    width: maxX - minX,
    height: maxY - minY,
  };
}

export const __test_internals = {
  layoutWithDagre,
  normalizeLayout,
  dedupeEdges,
};
