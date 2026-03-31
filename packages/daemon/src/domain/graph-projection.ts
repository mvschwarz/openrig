import type { RigWithRelations, Session, Binding } from "./types.js";

export interface RigGraphInput extends RigWithRelations {
  sessions: Session[];
}

interface RFNodeData {
  logicalId: string;
  role: string | null;
  runtime: string | null;
  model: string | null;
  status: string | null;
  binding: Binding | null;
  nodeKind: "agent" | "infrastructure";
}

interface RFNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: RFNodeData;
}

interface RFEdge {
  id: string;
  source: string;
  target: string;
  label: string;
}

export interface ReactFlowGraph {
  nodes: RFNode[];
  edges: RFEdge[];
}

const VERTICAL_SPACING = 200;

export function projectRigToGraph(input: RigGraphInput): ReactFlowGraph {
  const { nodes: rigNodes, edges: rigEdges, sessions } = input;

  const nodes: RFNode[] = rigNodes.map((node, index) => {
    // Find latest session for this node by createdAt
    const nodeSessions = sessions
      .filter((s) => s.nodeId === node.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const latestSession = nodeSessions.length > 0
      ? nodeSessions[nodeSessions.length - 1]!
      : null;

    return {
      id: node.id,
      type: "rigNode",
      position: { x: 0, y: index * VERTICAL_SPACING },
      data: {
        logicalId: node.logicalId,
        role: node.role,
        runtime: node.runtime,
        model: node.model,
        status: latestSession ? latestSession.status : null,
        binding: node.binding,
        nodeKind: node.runtime === "terminal" ? "infrastructure" : "agent",
      },
    };
  });

  const edges: RFEdge[] = rigEdges.map((edge) => ({
    id: edge.id,
    source: edge.sourceId,
    target: edge.targetId,
    label: edge.kind,
  }));

  return { nodes, edges };
}
