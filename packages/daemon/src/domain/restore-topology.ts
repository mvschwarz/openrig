import type { RestoreExcludedNode, RestoreNodeResult, SnapshotData } from "./types.js";

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

/** Bind outcomes to intended IDs, accepting a recreated node only through its recorded correspondence. Names alone
 *  never create a match. An ambiguous correspondence cannot establish an outcome or strict recovery proof. */
export function restoreOutcomesByIntendedNode(
  roster: ReadonlyArray<{ nodeId: string; logicalId: string }>, nodes: ReadonlyArray<RestoreNodeResult>,
): Map<string, RestoreNodeResult> {
  const intended = new Map(roster.filter(node => typeof node?.nodeId === "string").map(node => [node.nodeId, node]));
  const candidates = nodes.flatMap(node => {
    if (typeof node?.nodeId !== "string") return [];
    const id = node.intendedNodeId ?? node.nodeId;
    const member = intended.get(id);
    if (!member || (node.intendedNodeId !== undefined && (typeof node.intendedNodeId !== "string" || node.logicalId !== member.logicalId))) return [];
    return [{ id, node }];
  });
  const savedCounts = new Map<string, number>(), liveCounts = new Map<string, number>();
  for (const { id, node } of candidates) {
    savedCounts.set(id, (savedCounts.get(id) ?? 0) + 1);
    liveCounts.set(node.nodeId, (liveCounts.get(node.nodeId) ?? 0) + 1);
  }
  return new Map(candidates.filter(({ id, node }) => savedCounts.get(id) === 1 && liveCounts.get(node.nodeId) === 1)
    .map(({ id, node }) => [id, node]));
}
