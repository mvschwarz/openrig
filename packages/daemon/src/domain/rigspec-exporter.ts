import { readClaudePermissionRules } from "./claude-permission-rules.js";
import { readClaudeAutoModeForLaunch } from "./claude-auto-mode.js";
import { readCodexMemberPermissions } from "./codex-member-permissions.js";
import { isLaunchWrapperRuntime } from "./launch-wrapper.js";
import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { PodRepository } from "./pod-repository.js";
import type {
  LegacyRigSpec, LegacyRigSpecNode, LegacyRigSpecEdge,
  RigSpec, RigSpecPod, RigSpecPodMember, RigSpecPodEdge, RigSpecCrossPodEdge,
} from "./types.js";
import { RigNotFoundError } from "./errors.js";
import { seatLaunchAdditionsForLaunch, seatLaunchAdditionsForNode } from "./seat-launch-additions.js";
import { isAbsolute, normalize } from "node:path";
import { validateSafePath } from "./path-safety.js";
import { SeatPoolSlotsRepository } from "./seat-pool-slots.js";
import { RigSpecCodec } from "./rigspec-codec.js";

/** The member-local id of a pod node: `impl` for `dev.impl`; a logical id without a pod is its own. */
function memberLocalId(logicalId: string): string {
  return logicalId.includes(".") ? logicalId.split(".").slice(1).join(".") : logicalId;
}

/** A node's restore policy: its latest session's (by creation, then id), else the node's own. */
function restorePolicyOf(sessions: ReadonlyArray<{ nodeId: string; createdAt: string; id: string; restorePolicy?: string | null }>,
  node: { id: string; restorePolicy?: string | null }): string | undefined {
  const nodeSessions = sessions
    .filter((s) => s.nodeId === node.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const latest = nodeSessions.length > 0 ? nodeSessions[nodeSessions.length - 1]! : null;
  return latest?.restorePolicy ?? node.restorePolicy ?? undefined;
}

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
  private poolSlots: SeatPoolSlotsRepository;

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
    this.poolSlots = new SeatPoolSlotsRepository(this.db);
  }

  /** #3395: the rig as an export sees it. A seat pool's agents (every phase, `drained` included) are clones the pool
   *  adds and drains on its own, so neither they nor an edge that touches one are part of the declared rig. The export
   *  and every "not carried" list read through here, so none of them names a pool agent. */
  private exportableNodes(rigId: string): import("./types.js").RigWithRelations | null {
    const rig = this.rigRepo.getRig(rigId);
    if (!rig) return null;
    const pool = new Set(this.poolSlots.poolAgentNodeIds(rigId));
    if (pool.size === 0) return rig;
    return {
      ...rig,
      nodes: rig.nodes.filter((node) => !pool.has(node.id)),
      edges: rig.edges.filter((edge) => !pool.has(edge.sourceId) && (Boolean(edge.targetRef) || !pool.has(edge.targetId))),
    };
  }

  /** #3395: the edges an export leaves out because they touch a seat pool agent, as `from`, `to` and `kind`, sorted.
   *  The pool's own add creates no edge, so such an edge was added by hand; it is named rather than dropped silently. */
  poolEdgesNotCarried(rigId: string): Array<{ from: string; to: string; kind: string }> {
    const rig = this.rigRepo.getRig(rigId);
    if (!rig) return [];
    const pool = new Set(this.poolSlots.poolAgentNodeIds(rigId));
    if (pool.size === 0) return [];
    const logical = new Map(rig.nodes.map((node) => [node.id, node.logicalId]));
    return rig.edges
      .filter((edge) => pool.has(edge.sourceId) || (!edge.targetRef && pool.has(edge.targetId)))
      .map((edge) => ({
        from: logical.get(edge.sourceId) ?? edge.sourceId,
        to: edge.targetRef ?? logical.get(edge.targetId) ?? edge.targetId,
        kind: edge.kind,
      }))
      .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind));
  }

  /** #3395: model seats whose stored `pool` block can't be read. The export leaves the block out of that seat, exports
   *  the rest of the rig, and keeps the stored value as it is. */
  poolNotCarried(rigId: string): string[] {
    return (this.exportableNodes(rigId)?.nodes ?? [])
      .filter((node) => { const pool = this.rigRepo.getNodePool(node.id); return pool !== undefined && "error" in pool; })
      .map((node) => node.logicalId).sort();
  }

  /** OPR.0.7.0.9 — seats whose launch additions (agent file, appended prompt file, plugin folders) an export doesn't
   *  carry: the node records the seat's copies, not the spec's paths, so they must be named rather than dropped silently. */
  launchAdditionsNotCarried(rigId: string): string[] {
    const rig = this.exportableNodes(rigId);
    if (!rig) return [];
    return rig.nodes.filter((node) => {
      const additions = seatLaunchAdditionsForNode(this.db, node.id);
      return !!additions && (!!additions.agent || !!additions.appendSystemPromptFile || additions.pluginDirs.length > 0);
    }).map((node) => node.logicalId).sort();
  }

  /** Member declarations that cannot be honestly represented by this rig's single export root. */
  memberStartupNotCarried(rigId: string): Array<{ logicalId: string; reason: "source unavailable" | "different source root" }> {
    const rig = this.exportableNodes(rigId);
    if (!rig) return [];
    return rig.nodes.filter(node => node.podId !== null).flatMap(node => {
      const result = this.memberStartupSource(rigId, node);
      return result.reason ? [{ logicalId: node.logicalId, reason: result.reason }] : [];
    }).sort((a, b) => a.logicalId.localeCompare(b.logicalId));
  }

  /** The seat's member as its rig spec authored it: from its launch recipe, or, before a first launch creates one, from
   *  its one materialized source. */
  private authoredMember(rigId: string, node: import("./types.js").NodeWithBinding):
    { root: string; member: RigSpecPodMember } | null {
    const recipe = this.rigRepo.getNodeLaunchRecipe(node.id);
    // A materialized seat can be exported before its first launch creates a recipe.
    const materialized = this.rigRepo.getRigStartupLayers(rigId)?.materializedSources?.filter(source => source.nodeIds.includes(node.id)) ?? [];
    if (!recipe && materialized.length !== 1) return null;
    const source = recipe ? { root: recipe.rigRoot, spec: recipe.rigSpec } : materialized[0]!;
    // A malformed retained materialization cannot authorize exporting its contents.
    if (!source.spec || !Array.isArray(source.spec.pods) || typeof source.root !== "string") return null;
    const [podId, memberId] = node.logicalId.split(".");
    const pods = source.spec.pods.filter(pod => pod && pod.id === podId);
    const members = pods.length === 1 && Array.isArray(pods[0]!.members) ? pods[0]!.members.filter(member => member && member.id === memberId) : [];
    return members.length === 1 ? { root: source.root, member: members[0]! } : null;
  }

  /**
   * The member's own startup and whether its files resolve from `root`. The rig export compares against the rig's one
   * stored root; a seat pool agent compares against its model's launch root, the root its add is given (#3395).
   */
  private memberStartupSource(rigId: string, node: import("./types.js").NodeWithBinding, against: "export root" | "launch root" = "export root"): {
    startup?: import("./types.js").StartupBlock; reason?: "source unavailable" | "different source root"; declared?: true;
  } {
    const authored = this.authoredMember(rigId, node);
    if (!authored) return { reason: "source unavailable" };
    const startup = authored.member.startup;
    if (!startup) return {};
    if (!Array.isArray(startup.files) || !Array.isArray(startup.actions)
      || startup.files.some(file => !file || validateSafePath(file.path, "member startup"))) return { reason: "source unavailable", declared: true };
    const root = against === "export root" ? this.rigRepo.getRigStartupLayers(rigId)?.root : this.rigRepo.getNodeLaunchRecipe(node.id)?.rigRoot;
    // The wire format has one rig root and prohibits absolute/traversing startup paths.
    // Do not silently resolve a second source's files against the first source.
    // Without a stored original root, a non-portable legacy declaration cannot
    // honestly be exported as if its files resolved from the output folder.
    if (startup.files.length && (!root || !isAbsolute(authored.root) || !isAbsolute(root)
      || normalize(authored.root) !== normalize(root))) return { reason: "different source root", declared: true };
    return { startup };
  }

  /** Name dormant Claude MCP choices omitted from declarations for another runtime. */
  claudeMcpNotCarried(rigId: string): string[] {
    const rig = this.exportableNodes(rigId);
    return (rig?.nodes ?? [])
      .filter((node) => node.runtime !== "claude-code" && node.claudeMcp === "none")
      .map((node) => node.logicalId).sort();
  }

  /** Claude seats whose saved claude_auto_mode can't be read; the export leaves the block out. */
  claudeAutoModeNotCarried(rigId: string): string[] {
    return (this.exportableNodes(rigId)?.nodes ?? [])
      .filter((node) => node.runtime === "claude-code" && this.savedAutoMode(node.id).unreadable)
      .map((node) => node.logicalId).sort();
  }

  /** #3253: seats whose stored process_limits can't be read. The export leaves the field out of that seat, exports the
   *  rest of the rig, and keeps the stored value as it is. */
  processLimitsNotCarried(rigId: string): string[] {
    return (this.exportableNodes(rigId)?.nodes ?? [])
      .filter((node) => node.processLimitsError !== undefined)
      .map((node) => node.logicalId).sort();
  }

  private savedAutoMode(nodeId: string): { block?: import("./claude-auto-mode.js").ClaudeAutoMode; unreadable?: boolean } {
    const choice = readClaudeAutoModeForLaunch(this.rigRepo.db, nodeId);
    return choice === undefined ? {} : "unreadable" in choice ? { unreadable: true } : { block: choice };
  }

  exportRig(rigId: string): LegacyRigSpec | RigSpec {
    const rig = this.exportableNodes(rigId);
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
      if (node.effort) specNode.effort = node.effort;
      if (node.advisor) specNode.advisor = node.advisor;
      if (node.runtime === "claude-code" && node.claudeMcp) specNode.claudeMcp = node.claudeMcp;
      const rules = node.runtime === "claude-code" ? readClaudePermissionRules(this.db, node.id) : undefined;
      if (rules !== undefined) specNode.claudePermissions = rules;
      const autoMode = node.runtime === "claude-code" ? this.savedAutoMode(node.id).block : undefined;
      if (autoMode !== undefined) specNode.claudeAutoMode = autoMode;
      if (node.runtime === "claude-code" && node.claudeTokenRef && !node.accountHome && node.claudeTokenRef.kind !== "api-key") specNode.claudeTokenRef = node.claudeTokenRef;
      const envelope = node.runtime === "codex" ? readCodexMemberPermissions(this.db, node.id) : undefined;
      if (envelope !== undefined) specNode.codexPermissions = envelope;
      if (isLaunchWrapperRuntime(node.runtime) && node.launchWrapper?.length) specNode.launchWrapper = node.launchWrapper;
      // An unreadable stored limit has no processLimits here; processLimitsNotCarried names it.
      if (node.processLimits) specNode.processLimits = { ...node.processLimits };
      if (node.runtime === "claude-code" && node.statuslineThrottle) specNode.statuslineThrottle = node.statuslineThrottle;
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
      const to = edge.targetRef ?? idToLogical.get(edge.targetId);
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

  /**
   * #3395: one node as the pod-aware export writes its member: every launch setting the node records, its `pool` block
   * when it is a seat pool's model, and its restore policy (the latest session's, else the node's). The rig export
   * builds each member here, and the seat pool builds an agent's fragment from its model here, so a launch setting
   * added later reaches both.
   */
  exportedMemberFromNode(rigId: string, nodeId: string): RigSpecPodMember {
    const node = this.rigRepo.getRig(rigId)?.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) throw new Error(`Cannot export node '${nodeId}': no such node in rig '${rigId}'`);
    return this.memberFromNode(rigId, node, restorePolicyOf(this.sessionRegistry.getSessionsForRig(rigId), node));
  }

  /**
   * #3395: the same member in the spec's own keys (`agent_ref`, `claude_mcp`, ...), the fragment a pod member add takes.
   * It goes through the rig codec's own serializer (a one-pod spec written and read back), so it has exactly the keys
   * the export writes. Unlike the rig export, the member's startup resolves from the node's own launch root, the root
   * the add is given; a declared startup that can't is an error.
   */
  exportedRawMemberFromNode(rigId: string, nodeId: string): Record<string, unknown> {
    const node = this.rigRepo.getRig(rigId)?.nodes.find((candidate) => candidate.id === nodeId);
    if (!node) throw new Error(`Cannot export node '${nodeId}': no such node in rig '${rigId}'`);
    const member = this.memberFromNode(rigId, node, restorePolicyOf(this.sessionRegistry.getSessionsForRig(rigId), node), "launch root");
    const spec: RigSpec = { version: "0.2", name: "member", pods: [{ id: "pod", label: "pod", members: [member], edges: [] }], edges: [] };
    const written = RigSpecCodec.parse(RigSpecCodec.serialize(spec)) as { pods: Array<{ members: Array<Record<string, unknown>> }> };
    return written.pods[0]!.members[0]!;
  }

  private memberFromNode(
    rigId: string, node: import("./types.js").NodeWithBinding, restorePolicy: string | undefined,
    startupFrom: "export root" | "launch root" = "export root",
  ): RigSpecPodMember {
    if (!node.runtime) {
      throw new Error(`Cannot export node '${node.logicalId}': runtime is required but missing`);
    }
    const member: RigSpecPodMember = {
      id: memberLocalId(node.logicalId),
      agentRef: node.agentRef ?? "",
      profile: node.profile ?? "default",
      runtime: node.runtime,
      cwd: node.cwd ?? ".",
    };
    if (node.label) member.label = node.label;
    if (node.codexConfigProfile) member.codexConfigProfile = node.codexConfigProfile;
    if (node.model) member.model = node.model;
    if (node.effort) member.effort = node.effort;
    if (node.advisor) member.advisor = node.advisor;
    if (node.runtime === "claude-code" && node.claudeMcp) member.claudeMcp = node.claudeMcp;
    if (isLaunchWrapperRuntime(node.runtime) && node.launchWrapper?.length) member.launchWrapper = node.launchWrapper;
    // An unreadable stored limit has no processLimits here; processLimitsNotCarried names it.
    if (node.processLimits) member.processLimits = { ...node.processLimits };
    if (node.runtime === "claude-code" && node.statuslineThrottle) member.statuslineThrottle = node.statuslineThrottle;
    // #2044: unlike the copied files, a seat's plugin channels are names the record keeps as the spec gave them, so
    // an export carries the ones its launch passes.
    const channels = node.runtime === "claude-code" ? seatLaunchAdditionsForLaunch(this.rigRepo.db, node.id).additions?.pluginChannels : undefined;
    if (channels?.length) member.pluginChannels = channels;
    // OPR.0.4.6.FAC1: a declared seat role exports with the pod
    // member (round-trip fidelity — export→import keeps the role).
    if (node.role) member.role = node.role;
    // OPR.0.4.8.3 Seam B: the seat's RAW permission_policy ref round-trips
    // (export truth = the ref, never the resolved provenance).
    if (node.permissionPolicy) member.permissionPolicy = node.permissionPolicy;
    const rules = node.runtime === "claude-code" ? readClaudePermissionRules(this.rigRepo.db, node.id) : undefined;
    if (rules !== undefined) member.claudePermissions = rules;
    const autoMode = node.runtime === "claude-code" ? this.savedAutoMode(node.id).block : undefined;
    if (autoMode !== undefined) member.claudeAutoMode = autoMode;
    if (node.runtime === "claude-code" && node.claudeTokenRef && !node.accountHome && node.claudeTokenRef.kind !== "api-key") member.claudeTokenRef = node.claudeTokenRef;
    const envelope = node.runtime === "codex" ? readCodexMemberPermissions(this.rigRepo.db, node.id) : undefined;
    if (envelope !== undefined) member.codexPermissions = envelope;
    if (node.env) member.env = node.env;
    if (node.sessionSource) member.sessionSource = node.sessionSource;
    const ownStartup = this.memberStartupSource(rigId, node, startupFrom);
    // A pool agent's member startup resolves from its model's launch root. A declared startup that can't be read or
    // carried from there is an error, never a silent drop: the add would launch an agent without it. The export names
    // it instead. With no spec source to read (no launch recipe, or one the repository can't read), the startup can't be
    // known and stays out, as in the export.
    if (startupFrom === "launch root" && ownStartup.declared) {
      throw new Error(`the member startup can't be read or its files resolved from the model's launch root`);
    }
    if (ownStartup.startup) member.startup = ownStartup.startup;
    // #3395: a usable stored block exports with its model; one that can't be read is left out and named by poolNotCarried.
    const pool = this.rigRepo.getNodePool(node.id);
    if (pool !== undefined && "spec" in pool) member.pool = pool.spec;
    if (restorePolicy) member.restorePolicy = restorePolicy;
    // #2940: the seat's resolved keep_alive, written when on, so an export of a rig without it is unchanged. Off is
    // written only when the member itself said so, in the spec last applied to it (kept in its recipe): re-imported
    // without it, its agent spec could turn it back on.
    if (node.keepAlive) member.keepAlive = true;
    else if (this.authoredMember(rigId, node)?.member.keepAlive === false) member.keepAlive = false;
    return member;
  }

  private exportPodAware(rigId: string, rig: import("./types.js").RigWithRelations): RigSpec {
    const pods = this.podRepo!.getPodsForRig(rigId);
    const sessions = this.sessionRegistry.getSessionsForRig(rigId);
    const startupLayers = this.rigRepo.getRigStartupLayers(rigId);

    // Build maps for lookups
    // logicalId is "podSpecId.memberLocalId" — extract both parts
    const idToLogical = new Map(rig.nodes.map((n) => [n.id, n.logicalId]));
    const idToMemberLocal = new Map(rig.nodes.map((n) => [n.id, memberLocalId(n.logicalId)]));
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
    const getRestorePolicy = (nodeId: string): string | undefined => restorePolicyOf(sessions, idToNode.get(nodeId)!);

    // Build pod specs
    const podSpecs: RigSpecPod[] = pods.map((pod) => {
      const podNodes = nodesByPod.get(pod.id) ?? [];
      const memberNodeIds = new Set(podNodes.map((n) => n.id));

      const members: RigSpecPodMember[] = podNodes.map((node) => this.memberFromNode(rigId, node, getRestorePolicy(node.id)));

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
      const podFiles = startupLayers?.podStartupFiles?.[pod.namespace];
      const podActions = startupLayers?.podStartupActions?.[pod.namespace];
      if ((Array.isArray(podFiles) && podFiles.length > 0) || (Array.isArray(podActions) && podActions.length > 0)) {
        podSpec.startup = { files: Array.isArray(podFiles) ? podFiles : [], actions: Array.isArray(podActions) ? podActions : [] };
      }
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
        return Boolean(e.targetRef) || (srcPod && tgtPod && srcPod !== tgtPod);
      })
      .map((e) => ({
        kind: e.kind,
        from: idToLogical.get(e.sourceId)!,
        to: e.targetRef ?? idToLogical.get(e.targetId)!,
      }));

    // OPR.0.4.8.3 Seam B: rig-level permission_policy is a RIG-ROW field (not derivable
    // from the spec re-emit) — explicit repository read, emitted only when set.
    const rigPermissionPolicy = this.rigRepo.getRigPermissionPolicy(rigId);
    const workspace = this.rigRepo.getRigWorkspace(rigId);
    const rigEnv = this.rigRepo.getRigEnv(rigId);
    // #25: the selected Claude managed-block file is also a rig-row field.
    const claudeManagedBlockFile = this.rigRepo.getRigClaudeManagedBlockFile(rigId);
    // #1631: culture_file and rig-level startup block round-trip through export.
    const cultureFile = startupLayers?.cultureFile;
    const startup = startupLayers?.startup;

    return {
      version: "0.2",
      name: rig.rig.name,
      ...(cultureFile ? { cultureFile } : {}),
      ...(rigPermissionPolicy ? { permissionPolicy: rigPermissionPolicy } : {}),
      ...(this.rigRepo.getRigNonInterruptive(rigId) ? { nonInterruptive: true } : {}),
      ...(this.rigRepo.getRigSeatSlice(rigId) ? { seatSlice: "rig" as const } : {}),
      ...(rigEnv ? { env: rigEnv } : {}),
      ...(claudeManagedBlockFile ? { managedBlocks: { "claude-code": claudeManagedBlockFile } } : {}),
      ...(startupLayers?.defaultOnboardingPack !== undefined ? { defaultOnboardingPack: startupLayers.defaultOnboardingPack } : {}),
      ...(workspace ? { workspace } : {}),
      ...(startup ? { startup } : {}),
      pods: podSpecs,
      edges: crossPodEdges,
    };
  }
}
