import type { CSSProperties } from "react";
import dagre from "dagre";

interface LayoutNode {
  id: string;
  type?: string;
  parentId?: string;
  position: { x: number; y: number };
  data?: { logicalId?: string };
  style?: CSSProperties;
  initialWidth?: number;
  initialHeight?: number;
  [key: string]: unknown;
}

interface LayoutEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  data?: { kind?: string };
  [key: string]: unknown;
}

interface LayoutEntity {
  id: string;
  kind: "group" | "standalone";
  node: LayoutNode;
  width: number;
  height: number;
  members: LayoutNode[];
}

const NODE_WIDTH = 240;
const NODE_HEIGHT = 160;
const MAX_POD_COLUMNS = 3;
const POD_MEMBER_GAP_X = 36;
const POD_MEMBER_GAP_Y = 32;
const POD_PADDING_X = 28;
const POD_PADDING_TOP = 52;
const POD_PADDING_BOTTOM = 28;
const ENTITY_GAP_X = 96;
const ENTITY_GAP_Y = 150;
const DISCONNECTED_ROW_COLUMNS = 2;
const HIERARCHY_EDGE_KINDS = new Set(["delegates_to", "spawned_by"]);

export function applyTreeLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[]
): LayoutNode[] {
  if (nodes.length <= 1) {
    return nodes;
  }

  const groupedNodeIds = new Set(
    nodes
      .filter((node) => node.type === "group")
      .map((node) => node.id)
  );

  const membersByGroup = new Map<string, LayoutNode[]>();
  for (const node of nodes) {
    if (typeof node.parentId !== "string" || !groupedNodeIds.has(node.parentId)) {
      continue;
    }

    if (!membersByGroup.has(node.parentId)) {
      membersByGroup.set(node.parentId, []);
    }
    membersByGroup.get(node.parentId)!.push(node);
  }

  const entities: LayoutEntity[] = [];
  const containerByNodeId = new Map<string, string>();

  for (const node of nodes) {
    if (node.type === "group") {
      const members = membersByGroup.get(node.id) ?? [];
      const { width, height } = measureGroup(members.length);
      entities.push({
        id: node.id,
        kind: "group",
        node,
        width,
        height,
        members,
      });

      containerByNodeId.set(node.id, node.id);
      for (const member of members) {
        containerByNodeId.set(member.id, node.id);
      }
      continue;
    }

    if (typeof node.parentId === "string" && groupedNodeIds.has(node.parentId)) {
      continue;
    }

    entities.push({
      id: node.id,
      kind: "standalone",
      node,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      members: [],
    });
    containerByNodeId.set(node.id, node.id);
  }

  if (entities.length === 0) {
    return nodes;
  }

  const layoutGraph = new dagre.graphlib.Graph();
  layoutGraph.setDefaultEdgeLabel(() => ({}));
  layoutGraph.setGraph({
    rankdir: "TB",
    align: "UL",
    nodesep: ENTITY_GAP_X,
    ranksep: ENTITY_GAP_Y,
    marginx: 0,
    marginy: 0,
  });

  for (const entity of entities) {
    layoutGraph.setNode(entity.id, { width: entity.width, height: entity.height });
  }

  const layoutEdges = selectLayoutEdges(edges, containerByNodeId);
  for (const edge of layoutEdges) {
    layoutGraph.setEdge(edge.source, edge.target);
  }

  dagre.layout(layoutGraph);
  const entityPositions = new Map<string, { x: number; y: number }>();
  for (const entity of entities) {
    const positioned = layoutGraph.node(entity.id);
    if (!positioned) {
      continue;
    }

    entityPositions.set(entity.id, {
      x: positioned.x - entity.width / 2,
      y: positioned.y - entity.height / 2,
    });
  }

  repositionDisconnectedEntities(entities, layoutEdges, entityPositions);

  const laidOutById = new Map<string, LayoutNode>();
  for (const node of nodes) {
    laidOutById.set(node.id, { ...node });
  }

  for (const entity of entities) {
    const positioned = entityPositions.get(entity.id);
    if (!positioned) {
      continue;
    }

    if (entity.kind === "standalone") {
      const standalone = laidOutById.get(entity.node.id)!;
      standalone.position = { x: positioned.x, y: positioned.y };
      continue;
    }

    const groupNode = laidOutById.get(entity.node.id)!;
    groupNode.position = { x: positioned.x, y: positioned.y };
    groupNode.initialWidth = entity.width;
    groupNode.initialHeight = entity.height;
    groupNode.style = {
      ...(groupNode.style ?? {}),
      width: entity.width,
      height: entity.height,
    };

    for (let index = 0; index < entity.members.length; index += 1) {
      const member = entity.members[index]!;
      const laidOutMember = laidOutById.get(member.id)!;
      laidOutMember.position = getMemberPosition(index);
    }
  }

  return nodes.map((node) => laidOutById.get(node.id) ?? node);
}

function selectLayoutEdges(
  edges: LayoutEdge[],
  containerByNodeId: Map<string, string>
): Array<{ source: string; target: string }> {
  const hierarchyEdges = buildContainerEdges(
    edges.filter((edge) => HIERARCHY_EDGE_KINDS.has(getEdgeKind(edge))),
    containerByNodeId
  );

  if (hierarchyEdges.length > 0) {
    return hierarchyEdges;
  }

  return buildContainerEdges(edges, containerByNodeId);
}

function buildContainerEdges(
  edges: LayoutEdge[],
  containerByNodeId: Map<string, string>
): Array<{ source: string; target: string }> {
  const uniqueEdges = new Map<string, { source: string; target: string }>();

  for (const edge of edges) {
    const source = containerByNodeId.get(edge.source);
    const target = containerByNodeId.get(edge.target);

    if (!source || !target || source === target) {
      continue;
    }

    const key = `${source}->${target}`;
    if (!uniqueEdges.has(key)) {
      uniqueEdges.set(key, { source, target });
    }
  }

  return Array.from(uniqueEdges.values());
}

function measureGroup(memberCount: number): { width: number; height: number } {
  const count = Math.max(memberCount, 1);
  const columns = Math.min(count, MAX_POD_COLUMNS);
  const rows = Math.ceil(count / MAX_POD_COLUMNS);
  const contentWidth = columns * NODE_WIDTH + Math.max(columns - 1, 0) * POD_MEMBER_GAP_X;
  const contentHeight = rows * NODE_HEIGHT + Math.max(rows - 1, 0) * POD_MEMBER_GAP_Y;

  return {
    width: contentWidth + POD_PADDING_X * 2,
    height: contentHeight + POD_PADDING_TOP + POD_PADDING_BOTTOM,
  };
}

function getMemberPosition(index: number): { x: number; y: number } {
  const column = index % MAX_POD_COLUMNS;
  const row = Math.floor(index / MAX_POD_COLUMNS);

  return {
    x: POD_PADDING_X + column * (NODE_WIDTH + POD_MEMBER_GAP_X),
    y: POD_PADDING_TOP + row * (NODE_HEIGHT + POD_MEMBER_GAP_Y),
  };
}

function getEdgeKind(edge: LayoutEdge): string {
  return edge.data?.kind ?? edge.label ?? "";
}

function repositionDisconnectedEntities(
  entities: LayoutEntity[],
  edges: Array<{ source: string; target: string }>,
  entityPositions: Map<string, { x: number; y: number }>
): void {
  const connected = new Set<string>();
  for (const edge of edges) {
    connected.add(edge.source);
    connected.add(edge.target);
  }

  if (connected.size === 0) {
    return;
  }

  const disconnected = entities.filter((entity) => !connected.has(entity.id));
  if (disconnected.length === 0) {
    return;
  }

  const connectedEntities = entities.filter((entity) => connected.has(entity.id));
  const connectedBottom = Math.max(
    ...connectedEntities.map((entity) => {
      const position = entityPositions.get(entity.id)!;
      return position.y + entity.height;
    })
  );
  const connectedCenter = average(
    connectedEntities.map((entity) => {
      const position = entityPositions.get(entity.id)!;
      return position.x + entity.width / 2;
    })
  );

  let nextTop = connectedBottom + ENTITY_GAP_Y;
  for (let index = 0; index < disconnected.length; index += DISCONNECTED_ROW_COLUMNS) {
    const row = disconnected.slice(index, index + DISCONNECTED_ROW_COLUMNS);
    const rowWidth = row.reduce((sum, entity) => sum + entity.width, 0) +
      Math.max(row.length - 1, 0) * ENTITY_GAP_X;
    const rowHeight = Math.max(...row.map((entity) => entity.height));
    let currentLeft = connectedCenter - rowWidth / 2;

    for (const entity of row) {
      entityPositions.set(entity.id, {
        x: currentLeft,
        y: nextTop,
      });
      currentLeft += entity.width + ENTITY_GAP_X;
    }

    nextTop += rowHeight + ENTITY_GAP_Y;
  }
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}
