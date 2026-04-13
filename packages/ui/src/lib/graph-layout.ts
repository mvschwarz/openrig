import type { CSSProperties } from "react";

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

function isPodContainer(node: LayoutNode): boolean {
  return node.type === "group" || node.type === "podGroup";
}

const NODE_WIDTH = 240;
const NODE_HEIGHT = 160;
const MAX_POD_COLUMNS = 3;
const POD_MEMBER_GAP_X = 36;
const POD_MEMBER_GAP_Y = 32;
const POD_PADDING_X = 28;
const POD_PADDING_TOP = 44;
const POD_PADDING_BOTTOM = 28;
const ENTITY_GAP_Y = 120;
const SINGLE_COLUMN_X = 0;
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
      .filter((node) => isPodContainer(node))
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
    if (isPodContainer(node)) {
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

  const layoutEdges = selectLayoutEdges(edges, containerByNodeId);
  const entityPositions = layoutSingleColumn(entities, layoutEdges);

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
      standalone.initialWidth = NODE_WIDTH;
      standalone.initialHeight = NODE_HEIGHT;
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
      background:
        "linear-gradient(180deg, rgba(84, 96, 115, 0.08) 0px, rgba(84, 96, 115, 0.08) 32px, rgba(255, 255, 255, 0.22) 32px, rgba(255, 255, 255, 0.22) 100%)",
      border: "1px dashed rgba(84, 96, 115, 0.45)",
      boxShadow: "0 0 0 1px rgba(84, 96, 115, 0.10)",
    };

    for (let index = 0; index < entity.members.length; index += 1) {
      const member = entity.members[index]!;
      const laidOutMember = laidOutById.get(member.id)!;
      laidOutMember.position = getMemberPosition(index);
      laidOutMember.initialWidth = NODE_WIDTH;
      laidOutMember.initialHeight = NODE_HEIGHT;
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

function layoutSingleColumn(
  entities: LayoutEntity[],
  edges: Array<{ source: string; target: string }>,
): Map<string, { x: number; y: number }> {
  const entityById = new Map(entities.map((entity) => [entity.id, entity]));
  const outgoing = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();
  const orderedIds: string[] = [];
  const visited = new Set<string>();

  for (const entity of entities) {
    outgoing.set(entity.id, new Set());
    indegree.set(entity.id, 0);
  }

  for (const edge of edges) {
    if (!entityById.has(edge.source) || !entityById.has(edge.target)) {
      continue;
    }
    if (outgoing.get(edge.source)!.has(edge.target)) {
      continue;
    }
    outgoing.get(edge.source)!.add(edge.target);
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  }

  const connectedRoots = entities
    .filter((entity) => (indegree.get(entity.id) ?? 0) === 0 && (outgoing.get(entity.id)?.size ?? 0) > 0)
    .map((entity) => entity.id)
    .sort((leftId, rightId) => compareEntities(leftId, rightId, outgoing, entities));
  const disconnectedRoots = entities
    .filter((entity) => (indegree.get(entity.id) ?? 0) === 0 && (outgoing.get(entity.id)?.size ?? 0) === 0)
    .map((entity) => entity.id)
    .sort((leftId, rightId) => compareEntities(leftId, rightId, outgoing, entities));

  const appendReadyIds = (seedIds: string[]) => {
    const remainingIndegree = new Map(indegree);
    const queue = [...seedIds];
    const queued = new Set(queue);

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      if (visited.has(currentId)) {
        continue;
      }

      visited.add(currentId);
      orderedIds.push(currentId);

      const childIds = Array.from(outgoing.get(currentId) ?? []).sort((leftId, rightId) =>
        compareEntities(leftId, rightId, outgoing, entities)
      );

      for (const childId of childIds) {
        remainingIndegree.set(childId, (remainingIndegree.get(childId) ?? 1) - 1);
      }

      const nextReadyIds = childIds.filter((childId) =>
        (remainingIndegree.get(childId) ?? 0) === 0 &&
        !visited.has(childId) &&
        !queued.has(childId)
      );

      for (const nextReadyId of nextReadyIds) {
        queue.push(nextReadyId);
        queued.add(nextReadyId);
      }
    }
  };

  appendReadyIds(connectedRoots);
  appendReadyIds(disconnectedRoots);

  const remainingIds = entities
    .map((entity) => entity.id)
    .filter((entityId) => !visited.has(entityId))
    .sort((leftId, rightId) => compareEntities(leftId, rightId, outgoing, entities));

  orderedIds.push(...remainingIds);

  const positions = new Map<string, { x: number; y: number }>();
  let nextY = 0;
  for (const entityId of orderedIds) {
    const entity = entityById.get(entityId);
    if (!entity) {
      continue;
    }
    positions.set(entity.id, {
      x: SINGLE_COLUMN_X,
      y: nextY,
    });
    nextY += entity.height + ENTITY_GAP_Y;
  }

  return positions;
}

function compareEntities(
  leftId: string,
  rightId: string,
  outgoing: Map<string, Set<string>>,
  entities: LayoutEntity[]
): number {
  const leftOut = outgoing.get(leftId)?.size ?? 0;
  const rightOut = outgoing.get(rightId)?.size ?? 0;
  if (leftOut !== rightOut) {
    return rightOut - leftOut;
  }

  return entities.findIndex((entity) => entity.id === leftId) - entities.findIndex((entity) => entity.id === rightId);
}
