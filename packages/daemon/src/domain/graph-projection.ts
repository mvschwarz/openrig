import type { RigWithRelations, Session, Binding, Pod } from "./types.js";

export interface RigGraphInput extends RigWithRelations {
  sessions: Session[];
  pods?: Pod[];
}

interface RFNodeData {
  logicalId: string;
  podLabel?: string | null;
  podNamespace?: string | null;
  rigId: string;
  role: string | null;
  runtime: string | null;
  model: string | null;
  status: string | null;
  binding: Binding | null;
  nodeKind: "agent" | "infrastructure";
  startupStatus: "pending" | "ready" | "failed" | null;
  canonicalSessionName: string | null;
  podId: string | null;
  restoreOutcome: string;
  resumeToken?: string | null;
  resolvedSpecName: string | null;
  profile: string | null;
  edgeCount: number;
}

interface RFNode {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: RFNodeData;
  parentId?: string;
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

export interface InventoryOverlay {
  logicalId: string;
  startupStatus: "pending" | "ready" | "failed" | null;
  canonicalSessionName: string | null;
  restoreOutcome: string;
}

export function projectRigToGraph(input: RigGraphInput, inventoryOverlay?: InventoryOverlay[]): ReactFlowGraph {
  const { nodes: rigNodes, edges: rigEdges, sessions, pods = [] } = input;
  const overlayMap = new Map((inventoryOverlay ?? []).map((o) => [o.logicalId, o]));
  const podLabelById = new Map(pods.map((pod) => [pod.id, pod.label]));
  const podNamespaceById = new Map(pods.map((pod) => [pod.id, pod.namespace]));

  // Collect unique pods for group nodes
  const podNodes = new Map<string, string[]>(); // podId → node IDs

  const nodes: RFNode[] = rigNodes.map((node, index) => {
    // Find latest session for this node by ULID ordering (max session.id)
    const nodeSessions = sessions.filter((s) => s.nodeId === node.id);
    const latestSession = nodeSessions.length > 0
      ? nodeSessions.reduce((latest, s) => s.id > latest.id ? s : latest)
      : null;

    const overlay = overlayMap.get(node.logicalId);
    const effectiveStartupStatus = latestSession?.status === "running"
      ? (overlay?.startupStatus ?? (latestSession.startupStatus as RFNodeData["startupStatus"]) ?? null)
      : null;

    // Track pods
    if (node.podId) {
      if (!podNodes.has(node.podId)) podNodes.set(node.podId, []);
      podNodes.get(node.podId)!.push(node.id);
    }

    return {
      id: node.id,
      type: "rigNode",
      position: { x: 0, y: index * VERTICAL_SPACING },
      parentId: node.podId ? `pod-${node.podId}` : undefined,
      data: {
        logicalId: node.logicalId,
        podLabel: node.podId ? (podLabelById.get(node.podId) ?? null) : null,
        podNamespace: node.podId ? (podNamespaceById.get(node.podId) ?? null) : null,
        rigId: node.rigId,
        role: node.role,
        runtime: node.runtime,
        model: node.model,
        status: latestSession ? latestSession.status : null,
        binding: node.binding,
        nodeKind: node.runtime === "terminal" ? "infrastructure" : "agent",
        startupStatus: effectiveStartupStatus,
        canonicalSessionName: overlay?.canonicalSessionName ?? latestSession?.sessionName ?? null,
        podId: node.podId ?? null,
        restoreOutcome: overlay?.restoreOutcome ?? "n-a",
        resumeToken: latestSession?.resumeToken ?? null,
        resolvedSpecName: node.resolvedSpecName ?? null,
        profile: node.profile ?? null,
        edgeCount: rigEdges.filter((e) => e.sourceId === node.id || e.targetId === node.id).length,
      },
    };
  });

  // Create pod group nodes
  const groupNodes: RFNode[] = [];
  for (const [podId] of podNodes) {
    groupNodes.push({
      id: `pod-${podId}`,
      type: "podGroup",
      position: { x: 0, y: 0 },
      data: {
        logicalId: podNamespaceById.get(podId) ?? podId,
        podLabel: podLabelById.get(podId) ?? podId,
        podNamespace: podNamespaceById.get(podId) ?? podId,
        rigId: input.rig.id,
        role: null,
        runtime: null,
        model: null,
        status: null,
        binding: null,
        nodeKind: "agent",
        startupStatus: null,
        canonicalSessionName: null,
        podId,
        restoreOutcome: "n-a",
        resumeToken: null,
        resolvedSpecName: null,
        profile: null,
        edgeCount: 0,
      },
    });
  }

  const edges: RFEdge[] = rigEdges.map((edge) => ({
    id: edge.id,
    source: edge.sourceId,
    target: edge.targetId,
    label: edge.kind,
  }));

  return { nodes: [...groupNodes, ...nodes], edges };
}
