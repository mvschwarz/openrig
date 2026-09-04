import type { RestoreExcludedNode, SnapshotData } from "./types.js";

export interface SnapshotRestoreTopology {
  intendedNodes: SnapshotData["nodes"];
  intendedRoster: Array<{ nodeId: string; logicalId: string }>;
  excludedNodes: RestoreExcludedNode[];
  invalidRosterIds: string[];
}

/** Resolve immutable attempt membership from the snapshot itself. Legacy
 * snapshots predate the roster and retain their former all-node behavior. */
export function resolveSnapshotRestoreTopology(data: SnapshotData): SnapshotRestoreTopology {
  const nodesById = new Map(data.nodes.map((node) => [node.id, node]));
  const roster = data.topologyRoster?.intendedNodeIds ?? data.nodes.map((node) => node.id);
  const uniqueRoster = [...new Set(roster)];
  const invalidRosterIds = uniqueRoster.filter((nodeId) => !nodesById.has(nodeId));
  const intendedIds = new Set(uniqueRoster.filter((nodeId) => nodesById.has(nodeId)));
  const intendedNodes = uniqueRoster.flatMap((nodeId) => {
    const node = nodesById.get(nodeId);
    return node ? [node] : [];
  });
  const excludedNodes = data.nodes
    .filter((node) => !intendedIds.has(node.id))
    .map((node) => ({
      nodeId: node.id,
      logicalId: node.logicalId,
      reason: "historical_not_in_intended_roster" as const,
    }));
  return {
    intendedNodes,
    intendedRoster: intendedNodes.map((node) => ({ nodeId: node.id, logicalId: node.logicalId })),
    excludedNodes,
    invalidRosterIds,
  };
}
