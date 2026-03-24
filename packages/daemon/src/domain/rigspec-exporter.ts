import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { RigSpec, RigSpecNode, RigSpecEdge } from "./types.js";
import { RigNotFoundError } from "./errors.js";

interface RigSpecExporterDeps {
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
}

export class RigSpecExporter {
  private rigRepo: RigRepository;
  private sessionRegistry: SessionRegistry;

  constructor(deps: RigSpecExporterDeps) {
    if (deps.rigRepo.db !== deps.sessionRegistry.db) {
      throw new Error("RigSpecExporter: rigRepo and sessionRegistry must share the same db handle");
    }
    this.rigRepo = deps.rigRepo;
    this.sessionRegistry = deps.sessionRegistry;
  }

  exportRig(rigId: string): RigSpec {
    const rig = this.rigRepo.getRig(rigId);
    if (!rig) {
      throw new RigNotFoundError(rigId);
    }

    // Get all sessions for restorePolicy lookup
    const sessions = this.sessionRegistry.getSessionsForRig(rigId);

    // Build a map: nodeId (DB PK) -> logical_id
    const idToLogical = new Map(rig.nodes.map((n) => [n.id, n.logicalId]));

    const nodes: RigSpecNode[] = rig.nodes.map((node) => {
      // Find latest session's restorePolicy for this node
      const nodeSessions = sessions
        .filter((s) => s.nodeId === node.id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const latestSession = nodeSessions.length > 0
        ? nodeSessions[nodeSessions.length - 1]!
        : null;

      const restorePolicy = latestSession?.restorePolicy
        ?? node.restorePolicy
        ?? undefined;

      if (!node.runtime) {
        throw new Error(`Cannot export node '${node.logicalId}': runtime is required but missing`);
      }

      const specNode: RigSpecNode = {
        id: node.logicalId,
        runtime: node.runtime,
      };

      if (node.role) specNode.role = node.role;
      if (node.model) specNode.model = node.model;
      if (node.cwd) specNode.cwd = node.cwd;
      if (node.surfaceHint) specNode.surfaceHint = node.surfaceHint;
      if (node.workspace) specNode.workspace = node.workspace;
      if (restorePolicy) specNode.restorePolicy = restorePolicy;
      if (node.packageRefs && node.packageRefs.length > 0) specNode.packageRefs = node.packageRefs;

      return specNode;
    });

    const edges: RigSpecEdge[] = rig.edges.map((edge) => ({
      from: idToLogical.get(edge.sourceId) ?? edge.sourceId,
      to: idToLogical.get(edge.targetId) ?? edge.targetId,
      kind: edge.kind,
    }));

    return {
      schemaVersion: 1,
      name: rig.rig.name,
      version: "0.1.0",
      nodes,
      edges,
    };
  }
}
