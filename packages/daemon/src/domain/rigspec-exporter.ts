import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { PodRepository } from "./pod-repository.js";
import type {
  LegacyRigSpec, LegacyRigSpecNode, LegacyRigSpecEdge,
  RigSpec, RigSpecPod, RigSpecPodMember, RigSpecPodEdge, RigSpecCrossPodEdge,
} from "./types.js";
import { RigNotFoundError } from "./errors.js";

interface RigSpecExporterDeps {
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  podRepo?: PodRepository;
}

export class RigSpecExporter {
  readonly db: import("better-sqlite3").Database;
  private rigRepo: RigRepository;
  private sessionRegistry: SessionRegistry;
  private podRepo: PodRepository | null;

  constructor(deps: RigSpecExporterDeps) {
    if (deps.rigRepo.db !== deps.sessionRegistry.db) {
      throw new Error("RigSpecExporter: rigRepo and sessionRegistry must share the same db handle");
    }
    if (deps.podRepo && deps.rigRepo.db !== deps.podRepo.db) {
      throw new Error("RigSpecExporter: podRepo must share the same db handle");
    }
    this.db = deps.rigRepo.db;
    this.rigRepo = deps.rigRepo;
    this.sessionRegistry = deps.sessionRegistry;
    this.podRepo = deps.podRepo ?? null;
  }

  exportRig(rigId: string): LegacyRigSpec | RigSpec {
    const rig = this.rigRepo.getRig(rigId);
    if (!rig) {
      throw new RigNotFoundError(rigId);
    }

    // Detect pod-aware: any node has a non-null podId, or pods exist explicitly.
    const isPodAware = rig.nodes.some((n) => n.podId != null) || (this.podRepo?.getPodsForRig(rigId).length ?? 0) > 0;

    if (isPodAware && this.podRepo) {
      return this.exportPodAware(rigId, rig);
    }

    return this.exportLegacy(rigId, rig);
  }

  private exportLegacy(rigId: string, rig: import("./types.js").RigWithRelations): LegacyRigSpec {
    // Get all sessions for restorePolicy lookup
    const sessions = this.sessionRegistry.getSessionsForRig(rigId);

    // Build a map: nodeId (DB PK) -> logical_id
    const idToLogical = new Map(rig.nodes.map((n) => [n.id, n.logicalId]));

    const nodes: LegacyRigSpecNode[] = rig.nodes.map((node) => {
      // Find latest session's restorePolicy for this node
      const nodeSessions = sessions
        .filter((s) => s.nodeId === node.id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      const latestSession = nodeSessions.length > 0
        ? nodeSessions[nodeSessions.length - 1]!
        : null;

      const restorePolicy = latestSession?.restorePolicy
        ?? node.restorePolicy
        ?? undefined;

      if (!node.runtime) {
        throw new Error(`Cannot export node '${node.logicalId}': runtime is required but missing`);
      }

      const specNode: LegacyRigSpecNode = {
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

    const edges: LegacyRigSpecEdge[] = rig.edges.map((edge) => {
      const from = idToLogical.get(edge.sourceId);
      if (!from) {
        throw new Error(`Cannot export edge: unmapped source node ID '${edge.sourceId}'`);
      }
      const to = idToLogical.get(edge.targetId);
      if (!to) {
        throw new Error(`Cannot export edge: unmapped target node ID '${edge.targetId}'`);
      }
      return { from, to, kind: edge.kind };
    });

    return {
      schemaVersion: 1,
      name: rig.rig.name,
      version: "0.1.0",
      nodes,
      edges,
    };
  }

  private exportPodAware(rigId: string, rig: import("./types.js").RigWithRelations): RigSpec {
    const pods = this.podRepo!.getPodsForRig(rigId);
    const sessions = this.sessionRegistry.getSessionsForRig(rigId);

    // Build maps for lookups
    // logicalId is "podSpecId.memberLocalId" — extract both parts
    const idToLogical = new Map(rig.nodes.map((n) => [n.id, n.logicalId]));
    const idToMemberLocal = new Map(rig.nodes.map((n) => [n.id, n.logicalId.includes(".") ? n.logicalId.split(".").slice(1).join(".") : n.logicalId]));
    const idToNode = new Map(rig.nodes.map((n) => [n.id, n]));
    const nodeIdToPodId = new Map(rig.nodes.map((n) => [n.id, n.podId]));

    // Group nodes by podId
    const nodesByPod = new Map<string, typeof rig.nodes>();
    for (const node of rig.nodes) {
      if (node.podId) {
        const list = nodesByPod.get(node.podId) ?? [];
        list.push(node);
        nodesByPod.set(node.podId, list);
      }
    }

    // Helper: get restorePolicy for a node
    const getRestorePolicy = (nodeId: string): string | undefined => {
      const nodeSessions = sessions
        .filter((s) => s.nodeId === nodeId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      const latest = nodeSessions.length > 0 ? nodeSessions[nodeSessions.length - 1]! : null;
      return latest?.restorePolicy ?? idToNode.get(nodeId)?.restorePolicy ?? undefined;
    };

    // Build pod specs
    const podSpecs: RigSpecPod[] = pods.map((pod) => {
      const podNodes = nodesByPod.get(pod.id) ?? [];
      const memberNodeIds = new Set(podNodes.map((n) => n.id));

      const members: RigSpecPodMember[] = podNodes.map((node) => {
        if (!node.runtime) {
          throw new Error(`Cannot export node '${node.logicalId}': runtime is required but missing`);
        }
        const member: RigSpecPodMember = {
          id: idToMemberLocal.get(node.id) ?? node.logicalId,
          agentRef: node.agentRef ?? "",
          profile: node.profile ?? "default",
          runtime: node.runtime,
          cwd: node.cwd ?? ".",
        };
        if (node.label) member.label = node.label;
        if (node.codexConfigProfile) member.codexConfigProfile = node.codexConfigProfile;
        if (node.model) member.model = node.model;
        const rp = getRestorePolicy(node.id);
        if (rp) member.restorePolicy = rp;
        return member;
      });

      // Pod-local edges: both endpoints are in this pod
      const podEdges: RigSpecPodEdge[] = rig.edges
        .filter((e) => memberNodeIds.has(e.sourceId) && memberNodeIds.has(e.targetId))
        .map((e) => ({
          kind: e.kind,
          from: idToMemberLocal.get(e.sourceId)!,
          to: idToMemberLocal.get(e.targetId)!,
        }));

      // Derive pod spec id from the first member's logicalId prefix (e.g., "dev" from "dev.impl")
      const podSpecId = pod.namespace;
      const podSpec: RigSpecPod = {
        id: podSpecId,
        label: pod.label,
        members,
        edges: podEdges,
      };
      if (pod.summary) podSpec.summary = pod.summary;
      if (pod.continuityPolicyJson) {
        try {
          podSpec.continuityPolicy = JSON.parse(pod.continuityPolicyJson);
        } catch { /* skip if invalid JSON */ }
      }
      return podSpec;
    });

    // Cross-pod edges: endpoints in different pods
    // logicalId is already "podSpecId.memberLocalId" — use directly as qualified ref
    const crossPodEdges: RigSpecCrossPodEdge[] = rig.edges
      .filter((e) => {
        const srcPod = nodeIdToPodId.get(e.sourceId);
        const tgtPod = nodeIdToPodId.get(e.targetId);
        return srcPod && tgtPod && srcPod !== tgtPod;
      })
      .map((e) => ({
        kind: e.kind,
        from: idToLogical.get(e.sourceId)!,
        to: idToLogical.get(e.targetId)!,
      }));

    return {
      version: "0.2",
      name: rig.rig.name,
      pods: podSpecs,
      edges: crossPodEdges,
    };
  }
}
