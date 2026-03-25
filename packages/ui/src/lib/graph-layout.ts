/**
 * Client-side tree layout for React Flow graphs.
 * Takes the flat vertical column from the daemon and arranges
 * nodes in a hierarchical tree based on edge relationships.
 */

interface LayoutNode {
  id: string;
  position: { x: number; y: number };
  data?: { logicalId?: string };
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

const NODE_WIDTH = 240;
const NODE_HEIGHT = 160;
const H_SPACING = 300;
const V_SPACING = 240;

export function applyTreeLayout(
  nodes: LayoutNode[],
  edges: LayoutEdge[]
): LayoutNode[] {
  if (nodes.length <= 1) return nodes;

  // Build adjacency: parent → children (delegates_to, spawned_by edges)
  const children = new Map<string, string[]>();
  const hasParent = new Set<string>();

  for (const edge of edges) {
    const kind = edge.data?.kind ?? edge.label ?? "";
    if (kind === "delegates_to" || kind === "spawned_by") {
      if (!children.has(edge.source)) children.set(edge.source, []);
      children.get(edge.source)!.push(edge.target);
      hasParent.add(edge.target);
    }
  }

  // Find roots (nodes with no parent in the delegation tree)
  const roots = nodes.filter((n) => !hasParent.has(n.id));
  if (roots.length === 0) {
    // Cycle or no hierarchy — fall back to grid
    return applyGridLayout(nodes);
  }

  // BFS to assign layers
  const layer = new Map<string, number>();
  const queue: string[] = [];

  for (const root of roots) {
    layer.set(root.id, 0);
    queue.push(root.id);
  }

  while (queue.length > 0) {
    const nodeId = queue.shift()!;
    const currentLayer = layer.get(nodeId) ?? 0;
    for (const childId of children.get(nodeId) ?? []) {
      if (!layer.has(childId)) {
        layer.set(childId, currentLayer + 1);
        queue.push(childId);
      }
    }
  }

  // Assign any unvisited nodes
  for (const node of nodes) {
    if (!layer.has(node.id)) {
      layer.set(node.id, 0);
    }
  }

  // Group by layer
  const layers = new Map<number, LayoutNode[]>();
  for (const node of nodes) {
    const l = layer.get(node.id) ?? 0;
    if (!layers.has(l)) layers.set(l, []);
    layers.get(l)!.push(node);
  }

  // Position: center each layer horizontally
  const maxLayer = Math.max(...Array.from(layers.keys()));
  const result: LayoutNode[] = [];

  for (let l = 0; l <= maxLayer; l++) {
    const layerNodes = layers.get(l) ?? [];
    const layerWidth = layerNodes.length * H_SPACING;
    const startX = -layerWidth / 2 + H_SPACING / 2;

    for (let i = 0; i < layerNodes.length; i++) {
      result.push({
        ...layerNodes[i],
        position: {
          x: startX + i * H_SPACING,
          y: l * V_SPACING,
        },
      });
    }
  }

  return result;
}

function applyGridLayout(nodes: LayoutNode[]): LayoutNode[] {
  const cols = Math.ceil(Math.sqrt(nodes.length));
  return nodes.map((node, i) => ({
    ...node,
    position: {
      x: (i % cols) * H_SPACING,
      y: Math.floor(i / cols) * V_SPACING,
    },
  }));
}
