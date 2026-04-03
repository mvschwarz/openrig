import nodePath from "node:path";
import type Database from "better-sqlite3";
import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { EventBus } from "./event-bus.js";
import type { NodeLauncher } from "./node-launcher.js";
import type { RigSpecPreflight } from "./rigspec-preflight.js";
import { deriveCanonicalSessionName, validateSessionComponents } from "./session-name.js";
import { LegacyRigSpecSchema as RigSpecSchema } from "./rigspec-schema.js"; // TODO: AS-T08b — migrate to pod-aware RigSpec
import { LegacyRigSpecCodec as RigSpecCodec } from "./rigspec-codec.js"; // TODO: AS-T08b — migrate to pod-aware RigSpec
import type { LegacyRigSpec as RigSpec, LegacyRigSpecEdge as RigSpecEdge, InstantiateOutcome, InstantiateResult } from "./types.js"; // TODO: AS-T08b — migrate to pod-aware RigSpec

// Only these edge kinds constrain launch order
const LAUNCH_DEPENDENCY_KINDS = new Set(["delegates_to", "spawned_by"]);

interface RigInstantiatorDeps {
  db: Database.Database;
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  eventBus: EventBus;
  nodeLauncher: NodeLauncher;
  preflight: RigSpecPreflight;
  tmuxAdapter?: import("../adapters/tmux.js").TmuxAdapter;
}

export class RigInstantiator {
  readonly db: Database.Database;
  private rigRepo: RigRepository;
  private sessionRegistry: SessionRegistry;
  private eventBus: EventBus;
  private nodeLauncher: NodeLauncher;
  private preflight: RigSpecPreflight;
  private tmuxAdapter?: import("../adapters/tmux.js").TmuxAdapter;

  constructor(deps: RigInstantiatorDeps) {
    if (deps.db !== deps.rigRepo.db) {
      throw new Error("RigInstantiator: rigRepo must share the same db handle");
    }
    if (deps.db !== deps.sessionRegistry.db) {
      throw new Error("RigInstantiator: sessionRegistry must share the same db handle");
    }
    if (deps.db !== deps.eventBus.db) {
      throw new Error("RigInstantiator: eventBus must share the same db handle");
    }
    if (deps.db !== deps.nodeLauncher.db) {
      throw new Error("RigInstantiator: nodeLauncher must share the same db handle");
    }
    if (deps.db !== deps.preflight.db) {
      throw new Error("RigInstantiator: preflight must share the same db handle");
    }

    this.db = deps.db;
    this.rigRepo = deps.rigRepo;
    this.sessionRegistry = deps.sessionRegistry;
    this.eventBus = deps.eventBus;
    this.nodeLauncher = deps.nodeLauncher;
    this.preflight = deps.preflight;
    this.tmuxAdapter = deps.tmuxAdapter;
  }

  async instantiate(spec: RigSpec): Promise<InstantiateOutcome> {
    // 1. Validate
    const raw = RigSpecCodec.parse(RigSpecCodec.serialize(spec));
    const validation = RigSpecSchema.validate(raw);
    if (!validation.valid) {
      return { ok: false, code: "validation_failed", errors: validation.errors };
    }

    // 2. Preflight
    const preflightResult = await this.preflight.check(spec);
    if (!preflightResult.ready) {
      return { ok: false, code: "preflight_failed", errors: preflightResult.errors, warnings: preflightResult.warnings };
    }

    // 3. Compute launch order BEFORE materialization (detect cycles early)
    let launchOrder: string[];
    try {
      launchOrder = this.computeLaunchOrder(spec);
    } catch (err) {
      return {
        ok: false,
        code: "instantiate_error",
        message: err instanceof Error ? err.message : String(err),
      };
    }

    // 4. Atomic DB materialization: rig + nodes + edges
    let rigId: string;
    const nodeIdMap: Record<string, string> = {}; // logicalId -> DB id
    try {
      const txn = this.db.transaction(() => {
        const rig = this.rigRepo.createRig(spec.name);
        rigId = rig.id;

        for (const specNode of spec.nodes) {
          const node = this.rigRepo.addNode(rig.id, specNode.id, {
            role: specNode.role,
            runtime: specNode.runtime,
            model: specNode.model,
            cwd: specNode.cwd,
            surfaceHint: specNode.surfaceHint,
            workspace: specNode.workspace,
            restorePolicy: specNode.restorePolicy,
            packageRefs: specNode.packageRefs,
          });
          nodeIdMap[specNode.id] = node.id;
        }

        for (const specEdge of spec.edges) {
          this.rigRepo.addEdge(
            rig.id,
            nodeIdMap[specEdge.from]!,
            nodeIdMap[specEdge.to]!,
            specEdge.kind
          );
        }
      });
      txn();
    } catch (err) {
      return {
        ok: false,
        code: "instantiate_error",
        message: err instanceof Error ? err.message : String(err),
      };
    }

    // 5. Launch nodes in topological order
    const nodeResults: { logicalId: string; status: "launched" | "failed"; error?: string }[] = [];
    const launchedSessionNames: string[] = [];
    const instantiateWarnings: string[] = [];

    for (const logicalId of launchOrder) {
      const result = await this.nodeLauncher.launchNode(rigId!, logicalId);
      if (result.ok) {
        nodeResults.push({ logicalId, status: "launched" });
        launchedSessionNames.push(result.sessionName);
        if (result.warnings?.length) {
          instantiateWarnings.push(...result.warnings);
        }
      } else {
        nodeResults.push({ logicalId, status: "failed", error: result.message });
      }
    }

    // Check for total launch failure — kill orphan sessions and clean up the rig
    const allFailed = nodeResults.every((n) => n.status === "failed");
    if (allFailed && nodeResults.length > 0) {
      // Kill orphan tmux sessions (best-effort)
      if (this.tmuxAdapter) {
        for (const sessionName of launchedSessionNames) {
          try { await this.tmuxAdapter.killSession(sessionName); } catch { /* best-effort */ }
        }
      }
      try {
        this.rigRepo.deleteRig(rigId!);
      } catch {
        // Best-effort cleanup
      }
      return {
        ok: false,
        code: "instantiate_error",
        message: "all node launches failed",
      };
    }

    // 6. Propagate restorePolicy to session metadata (best-effort)
    try {
      for (const specNode of spec.nodes) {
        const restorePolicy = specNode.restorePolicy ?? "resume_if_possible";
        const sessions = this.sessionRegistry.getSessionsForRig(rigId!);
        const nodeDbId = nodeIdMap[specNode.id];
        const session = sessions.find((s) => s.nodeId === nodeDbId);
        if (session) {
          this.db.prepare("UPDATE sessions SET restore_policy = ? WHERE id = ?")
            .run(restorePolicy, session.id);
        }
      }
    } catch {
      // Best-effort: import succeeded even if restorePolicy propagation fails
    }

    // 6. Emit rig.imported (best-effort)
    try {
      this.eventBus.emit({
        type: "rig.imported",
        rigId: rigId!,
        specName: spec.name,
        specVersion: spec.version,
      });
    } catch {
      // Best-effort: import succeeded even if event persistence fails
    }

    return {
      ok: true,
      result: {
        rigId: rigId!,
        specName: spec.name,
        specVersion: spec.version,
        nodes: nodeResults,
        warnings: instantiateWarnings.length > 0 ? instantiateWarnings : undefined,
      },
    };
  }

  private computeLaunchOrder(spec: RigSpec): string[] {
    const nodes = spec.nodes;
    const edges = spec.edges;

    const inDegree: Record<string, number> = {};
    const adjacency: Record<string, string[]> = {};

    for (const node of nodes) {
      inDegree[node.id] = 0;
      adjacency[node.id] = [];
    }

    for (const edge of edges) {
      if (!LAUNCH_DEPENDENCY_KINDS.has(edge.kind)) continue;

      let from: string;
      let to: string;

      if (edge.kind === "delegates_to") {
        from = edge.from;
        to = edge.to;
      } else {
        // spawned_by: target (parent) before source (child)
        from = edge.to;
        to = edge.from;
      }

      if (adjacency[from]) {
        adjacency[from]!.push(to);
        inDegree[to] = (inDegree[to] ?? 0) + 1;
      }
    }

    // Topological sort with alphabetical tiebreaker
    const queue = Object.keys(inDegree)
      .filter((id) => inDegree[id] === 0)
      .sort();

    const order: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      order.push(current);

      const neighbors = (adjacency[current] ?? []).slice().sort();
      for (const neighbor of neighbors) {
        inDegree[neighbor] = (inDegree[neighbor] ?? 1) - 1;
        if ((inDegree[neighbor] ?? 0) === 0) {
          // Insert sorted
          let inserted = false;
          for (let i = 0; i < queue.length; i++) {
            if (queue[i]!.localeCompare(neighbor) > 0) {
              queue.splice(i, 0, neighbor);
              inserted = true;
              break;
            }
          }
          if (!inserted) queue.push(neighbor);
        }
      }
    }

    // Cycle detection: if not all nodes reached, there's a cycle
    if (order.length !== nodes.length) {
      const missing = nodes.filter((n) => !order.includes(n.id)).map((n) => n.id);
      throw new Error(`Dependency cycle detected among nodes: ${missing.join(", ")}`);
    }

    return order;
  }
}

// -- Pod-aware instantiator (AgentSpec reboot) --

import { RigSpecCodec as PodRigSpecCodec } from "./rigspec-codec.js";
import { RigSpecSchema as PodRigSpecSchema } from "./rigspec-schema.js";
import { rigPreflight } from "./rigspec-preflight.js";
import { resolveAgentRef, type AgentResolverFsOps } from "./agent-resolver.js";
import { resolveNodeConfig } from "./profile-resolver.js";
import { resolveStartup } from "./startup-resolver.js";
import { planProjection } from "./projection-planner.js";
import { StartupOrchestrator } from "./startup-orchestrator.js";
import { PodRepository } from "./pod-repository.js";
import type { RigSpec as PodRigSpec, RigSpecPod, RigSpecPodMember, StartupFile } from "./types.js";
import type { RuntimeAdapter, NodeBinding, ResolvedStartupFile } from "./runtime-adapter.js";
import { resolveConcreteHint } from "./runtime-adapter.js";
import type { TmuxAdapter } from "../adapters/tmux.js";

interface PodInstantiatorDeps {
  db: Database.Database;
  rigRepo: RigRepository;
  podRepo: PodRepository;
  sessionRegistry: SessionRegistry;
  eventBus: EventBus;
  nodeLauncher: NodeLauncher;
  startupOrchestrator: StartupOrchestrator;
  fsOps: AgentResolverFsOps;
  adapters: Record<string, RuntimeAdapter>;
  tmuxAdapter?: TmuxAdapter;
}

export interface MaterializeResult {
  rigId: string;
  specName: string;
  specVersion: string;
  nodes: Array<{ logicalId: string; status: "materialized" }>;
}

export type MaterializeOutcome =
  | { ok: true; result: MaterializeResult }
  | { ok: false; code: "validation_failed"; errors: string[] }
  | { ok: false; code: "preflight_failed"; errors: string[]; warnings: string[] }
  | { ok: false; code: "target_rig_not_found"; message: string }
  | { ok: false; code: "materialize_conflict"; message: string }
  | { ok: false; code: "materialize_error"; message: string };

/**
 * Pod-aware rig instantiator. Creates pods, nodes, edges, and runs
 * startup orchestration per node with resolved agent specs.
 */
export class PodRigInstantiator {
  readonly db: Database.Database;
  private deps: PodInstantiatorDeps;

  constructor(deps: PodInstantiatorDeps) {
    if (deps.db !== deps.rigRepo.db) throw new Error("PodRigInstantiator: rigRepo must share the same db handle");
    if (deps.db !== deps.sessionRegistry.db) throw new Error("PodRigInstantiator: sessionRegistry must share the same db handle");
    if (deps.db !== deps.eventBus.db) throw new Error("PodRigInstantiator: eventBus must share the same db handle");
    if (deps.db !== deps.nodeLauncher.db) throw new Error("PodRigInstantiator: nodeLauncher must share the same db handle");
    this.db = deps.db;
    this.deps = deps;
  }

  async materialize(
    rigSpecYaml: string,
    rigRoot: string,
    opts?: { targetRigId?: string },
  ): Promise<MaterializeOutcome> {
    let raw: unknown;
    try {
      raw = PodRigSpecCodec.parse(rigSpecYaml);
    } catch (err) {
      return { ok: false, code: "validation_failed", errors: [(err as Error).message] };
    }

    const targetRig = opts?.targetRigId ? this.deps.rigRepo.getRig(opts.targetRigId) : null;
    if (opts?.targetRigId && !targetRig) {
      return { ok: false, code: "target_rig_not_found", message: `Rig "${opts.targetRigId}" not found` };
    }

    const validation = PodRigSpecSchema.validate(raw, {
      externalQualifiedIds: targetRig?.nodes.map((node) => node.logicalId),
    });
    if (!validation.valid) {
      return { ok: false, code: "validation_failed", errors: validation.errors };
    }

    const rigSpec = PodRigSpecSchema.normalize(raw as Record<string, unknown>);
    const preflight = rigPreflight({
      rigSpecYaml,
      rigRoot,
      fsOps: this.deps.fsOps,
      rigNameOverride: targetRig?.rig.name,
      externalQualifiedIds: targetRig?.nodes.map((node) => node.logicalId),
    });
    if (!preflight.ready) {
      return { ok: false, code: "preflight_failed", errors: preflight.errors, warnings: preflight.warnings };
    }

    const persistedEvents: Array<ReturnType<EventBus["persistWithinTransaction"]>> = [];
    const nodeResults: Array<{ logicalId: string; status: "materialized" }> = [];

    try {
      let materializedRigId = opts?.targetRigId ?? "";
      const tx = this.db.transaction(() => {
        if (!materializedRigId) {
          const rig = this.deps.rigRepo.createRig(rigSpec.name);
          materializedRigId = rig.id;
          persistedEvents.push(this.deps.eventBus.persistWithinTransaction({ type: "rig.created", rigId: materializedRigId }));
        }

        const currentRig = this.deps.rigRepo.getRig(materializedRigId)!;
        const logicalIdToNodeId = new Map(currentRig.nodes.map((node) => [node.logicalId, node.id]));
        const existingPodIds = new Set(
          currentRig.nodes
            .map((node) => node.logicalId.includes(".") ? node.logicalId.split(".")[0]! : null)
            .filter((value): value is string => value !== null),
        );

        for (const pod of rigSpec.pods) {
          if (existingPodIds.has(pod.id)) {
            throw { code: "materialize_conflict", message: `Pod id '${pod.id}' already exists in rig '${currentRig.rig.name}'` };
          }
          for (const member of pod.members) {
            const qualifiedId = `${pod.id}.${member.id}`;
            if (logicalIdToNodeId.has(qualifiedId)) {
              throw { code: "materialize_conflict", message: `Logical ID '${qualifiedId}' already exists in rig '${currentRig.rig.name}'` };
            }
          }
        }

        const podIdMap: Record<string, string> = {};
        for (const pod of rigSpec.pods) {
          const podRecord = this.deps.podRepo.createPod(materializedRigId, pod.id, pod.label, {
            summary: pod.summary,
            continuityPolicyJson: pod.continuityPolicy ? JSON.stringify(pod.continuityPolicy) : undefined,
          });
          podIdMap[pod.id] = podRecord.id;
          persistedEvents.push(this.deps.eventBus.persistWithinTransaction({
            type: "pod.created",
            rigId: materializedRigId,
            podId: podRecord.id,
            namespace: podRecord.namespace,
            label: pod.label,
          }));

          for (const member of pod.members) {
            const qualifiedId = `${pod.id}.${member.id}`;
            const node = this.deps.rigRepo.addNode(materializedRigId, qualifiedId, {
              runtime: member.runtime,
              model: member.model,
              cwd: member.cwd,
              restorePolicy: member.restorePolicy,
              podId: podRecord.id,
              agentRef: member.agentRef,
              profile: member.profile,
              label: member.label,
            });
            logicalIdToNodeId.set(qualifiedId, node.id);
            nodeResults.push({ logicalId: qualifiedId, status: "materialized" });
            persistedEvents.push(this.deps.eventBus.persistWithinTransaction({
              type: "node.added",
              rigId: materializedRigId,
              nodeId: node.id,
              logicalId: qualifiedId,
            }));
          }
        }

        for (const pod of rigSpec.pods) {
          for (const edge of pod.edges) {
            const fromId = logicalIdToNodeId.get(`${pod.id}.${edge.from}`);
            const toId = logicalIdToNodeId.get(`${pod.id}.${edge.to}`);
            if (!fromId || !toId) {
              throw { code: "materialize_conflict", message: `Pod-local edge references missing node: ${pod.id}.${edge.from} -> ${pod.id}.${edge.to}` };
            }
            this.deps.rigRepo.addEdge(materializedRigId, fromId, toId, edge.kind);
          }
        }

        for (const edge of rigSpec.edges) {
          const fromId = logicalIdToNodeId.get(edge.from);
          const toId = logicalIdToNodeId.get(edge.to);
          if (!fromId || !toId) {
            throw { code: "materialize_conflict", message: `Cross-pod edge references missing node: ${edge.from} -> ${edge.to}` };
          }
          this.deps.rigRepo.addEdge(materializedRigId, fromId, toId, edge.kind);
        }

        persistedEvents.push(this.deps.eventBus.persistWithinTransaction({
          type: "rig.imported",
          rigId: materializedRigId,
          specName: rigSpec.name,
          specVersion: rigSpec.version,
        }));
      });

      tx();
      for (const event of persistedEvents) {
        this.deps.eventBus.notifySubscribers(event);
      }

      return {
        ok: true,
        result: {
          rigId: materializedRigId,
          specName: rigSpec.name,
          specVersion: rigSpec.version,
          nodes: nodeResults,
        },
      };
    } catch (err) {
      if (err && typeof err === "object" && "code" in err && "message" in err) {
        const typed = err as { code: string; message: string };
        if (typed.code === "materialize_conflict") {
          return { ok: false, code: "materialize_conflict", message: typed.message };
        }
      }
      return { ok: false, code: "materialize_error", message: err instanceof Error ? err.message : String(err) };
    }
  }

  async instantiate(rigSpecYaml: string, rigRoot: string): Promise<InstantiateOutcome> {
    // 1. Parse + validate
    let rigSpec: PodRigSpec;
    try {
      const raw = PodRigSpecCodec.parse(rigSpecYaml);
      const validation = PodRigSpecSchema.validate(raw);
      if (!validation.valid) {
        return { ok: false, code: "validation_failed", errors: validation.errors };
      }
      rigSpec = PodRigSpecSchema.normalize(raw as Record<string, unknown>);
    } catch (err) {
      return { ok: false, code: "validation_failed", errors: [(err as Error).message] };
    }

    // 2. Preflight
    const preflight = rigPreflight({ rigSpecYaml, rigRoot, fsOps: this.deps.fsOps });
    if (!preflight.ready) {
      return { ok: false, code: "preflight_failed", errors: preflight.errors, warnings: preflight.warnings };
    }

    // 3. Create rig
    let rigId: string;
    try {
      const rig = this.deps.rigRepo.createRig(rigSpec.name);
      rigId = rig.id;
    } catch (err) {
      return { ok: false, code: "instantiate_error", message: (err as Error).message };
    }

    // 4. Compute launch order from edges (rejects cycles)
    let launchOrder: string[];
    try {
      launchOrder = this.computePodLaunchOrder(rigSpec);
    } catch (err) {
      return { ok: false, code: "cycle_error", message: (err as Error).message };
    }

    // 5. Create pods + nodes + edges, then launch in topological order
    const nodeResults: { logicalId: string; status: "launched" | "failed"; error?: string }[] = [];
    const nodeIdMap: Record<string, string> = {}; // "pod.member" -> node DB id
    const launchedSessionNames: string[] = []; // Track for orphan cleanup on total failure
    const podInstantiateWarnings: string[] = [];
    // Store per-member context for deferred launch
    const memberContext = new Map<string, { pod: typeof rigSpec.pods[0]; member: typeof rigSpec.pods[0]["members"][0]; podId: string; nodeId: string; resolveResult: any; configResult: any }>();

    // Phase 1: Create all pods and collect member entries
    const podIdMap: Record<string, string> = {}; // pod.id -> DB pod id
    const memberEntries: Array<{ pod: typeof rigSpec.pods[0]; member: typeof rigSpec.pods[0]["members"][0]; podId: string; qualifiedId: string }> = [];

    for (const pod of rigSpec.pods) {
      let podId: string;
      try {
        const podRecord = this.deps.podRepo.createPod(rigId, pod.id, pod.label, {
          summary: pod.summary,
          continuityPolicyJson: pod.continuityPolicy ? JSON.stringify(pod.continuityPolicy) : undefined,
        });
        podId = podRecord.id;
        podIdMap[pod.id] = podId;
      } catch (err) {
        nodeResults.push(...pod.members.map((m) => ({ logicalId: `${pod.id}.${m.id}`, status: "failed" as const, error: `Pod creation failed: ${(err as Error).message}` })));
        continue;
      }
      for (const member of pod.members) {
        memberEntries.push({ pod, member, podId, qualifiedId: `${pod.id}.${member.id}` });
      }
    }

    // Sort members by topological launch order
    const orderMap = new Map(launchOrder.map((id, i) => [id, i]));
    memberEntries.sort((a, b) => (orderMap.get(a.qualifiedId) ?? 999) - (orderMap.get(b.qualifiedId) ?? 999));

    // Phase 2: Process members in launch order
    for (const { pod, member, podId, qualifiedId } of memberEntries) {

        // Terminal fast-path: skip agent resolution and profile resolution
        if (member.agentRef === "builtin:terminal") {
          const termResult = await this.processTerminalMember(
            rigId, rigSpec, rigRoot, pod, member, podId, qualifiedId, nodeIdMap, launchedSessionNames, podInstantiateWarnings,
          );
          nodeResults.push(termResult);
          continue;
        }

        // Resolve agent ref
        const resolveResult = resolveAgentRef(member.agentRef, rigRoot, this.deps.fsOps);
        if (!resolveResult.ok) {
          const msg = resolveResult.code === "validation_failed"
            ? (resolveResult as { errors: string[] }).errors.join("; ")
            : (resolveResult as { error: string }).error;
          nodeResults.push({ logicalId: qualifiedId, status: "failed", error: msg });
          continue;
        }

        // Resolve node config (profile + precedence)
        const configResult = resolveNodeConfig({
          baseSpec: resolveResult.resolved,
          importedSpecs: resolveResult.imports,
          collisions: resolveResult.collisions,
          profileName: member.profile,
          member,
          pod,
          rig: rigSpec,
        });
        if (!configResult.ok) {
          nodeResults.push({ logicalId: qualifiedId, status: "failed", error: configResult.errors.join("; ") });
          continue;
        }

        // Create node
        let nodeId: string;
        try {
          const node = this.deps.rigRepo.addNode(rigId, qualifiedId, {
            runtime: member.runtime,
            model: member.model,
            cwd: member.cwd,
            restorePolicy: configResult.config.restorePolicy,
            podId,
            agentRef: member.agentRef,
            profile: member.profile,
            label: member.label,
            resolvedSpecName: configResult.config.resolvedSpecName,
            resolvedSpecVersion: configResult.config.resolvedSpecVersion,
            resolvedSpecHash: configResult.config.resolvedSpecHash,
          });
          nodeId = node.id;
          nodeIdMap[qualifiedId] = nodeId;
        } catch (err) {
          nodeResults.push({ logicalId: qualifiedId, status: "failed", error: (err as Error).message });
          continue;
        }

        // Validate session name components before launch
        const sessionNameErrors = validateSessionComponents(pod.id, member.id, rigSpec.name);
        if (sessionNameErrors.length > 0) {
          nodeResults.push({ logicalId: qualifiedId, status: "failed", error: sessionNameErrors.join("; ") });
          continue;
        }

        // Launch session with canonical name
        const canonicalSessionName = deriveCanonicalSessionName(pod.id, member.id, rigSpec.name);
        const launchResult = await this.deps.nodeLauncher.launchNode(rigId, qualifiedId, { sessionName: canonicalSessionName });
        if (!launchResult.ok) {
          nodeResults.push({ logicalId: qualifiedId, status: "failed", error: launchResult.message });
          continue;
        }
        launchedSessionNames.push(canonicalSessionName);
        if (launchResult.warnings?.length) {
          podInstantiateWarnings.push(...launchResult.warnings);
        }

        // Propagate narrowed restorePolicy to session row (restore-orchestrator reads it)
        try {
          this.db.prepare("UPDATE sessions SET restore_policy = ? WHERE id = ?")
            .run(configResult.config.restorePolicy, launchResult.session.id);
        } catch { /* best-effort */ }

        // Select adapter
        const adapter = this.deps.adapters[member.runtime];
        if (!adapter) {
          nodeResults.push({ logicalId: qualifiedId, status: "failed", error: `No adapter for runtime "${member.runtime}"` });
          continue;
        }

        // Plan projection
        const planResult = planProjection({
          config: configResult.config,
          collisions: resolveResult.collisions,
          fsOps: this.deps.fsOps,
        });
        if (!planResult.ok) {
          nodeResults.push({ logicalId: qualifiedId, status: "failed", error: planResult.errors.join("; ") });
          continue;
        }

        // Build resolved startup files with correct owner roots
        const resolvedFiles = this.buildResolvedStartupFiles(
          resolveResult.resolved.spec,
          resolveResult.resolved.sourcePath,
          resolveResult.resolved.spec.profiles[member.profile],
          rigSpec, rigRoot, pod, member,
        );

        // Build binding
        const binding: NodeBinding = {
          id: launchResult.ok ? launchResult.binding.id : "",
          nodeId,
          tmuxSession: launchResult.ok ? launchResult.binding.tmuxSession : null,
          tmuxWindow: null,
          tmuxPane: null,
          cmuxWorkspace: null,
          cmuxSurface: null,
          updatedAt: "",
          cwd: member.cwd,
        };

        // Run startup
        const startupResult = await this.deps.startupOrchestrator.startNode({
          rigId,
          nodeId,
          sessionId: launchResult.ok ? launchResult.session.id : "",
          binding,
          adapter,
          plan: planResult.plan,
          resolvedStartupFiles: resolvedFiles,
          startupActions: configResult.config.startup.actions,
          isRestore: false,
        });

        nodeResults.push({
          logicalId: qualifiedId,
          status: startupResult.ok ? "launched" : "failed",
          error: startupResult.ok ? undefined : startupResult.errors.join("; "),
        });
      }

    // Create pod-local edges (after all members created)
    for (const pod of rigSpec.pods) {
      for (const edge of pod.edges) {
        const fromId = nodeIdMap[`${pod.id}.${edge.from}`];
        const toId = nodeIdMap[`${pod.id}.${edge.to}`];
        if (fromId && toId) {
          try {
            this.deps.rigRepo.addEdge(rigId, fromId, toId, edge.kind);
          } catch { /* best-effort */ }
        }
      }
    }

    // Create cross-pod edges
    for (const edge of rigSpec.edges) {
      const fromId = nodeIdMap[edge.from];
      const toId = nodeIdMap[edge.to];
      if (fromId && toId) {
        try {
          this.deps.rigRepo.addEdge(rigId, fromId, toId, edge.kind);
        } catch { /* best-effort */ }
      }
    }

    // Check for total failure — kill orphan tmux sessions and clean up rig
    const allFailed = nodeResults.length > 0 && nodeResults.every((n) => n.status === "failed");
    if (allFailed) {
      // Kill orphan tmux sessions
      if (this.deps.tmuxAdapter) {
        for (const sessionName of launchedSessionNames) {
          try { await this.deps.tmuxAdapter.killSession(sessionName); } catch { /* best-effort */ }
        }
      }
      try { this.deps.rigRepo.deleteRig(rigId); } catch { /* best-effort */ }
      const details = nodeResults.map((n) => `${n.logicalId}: ${n.error ?? "unknown"}`).join("; ");
      return { ok: false, code: "instantiate_error", message: `all node launches/startups failed — ${details}` };
    }

    // Emit rig.imported
    try {
      this.deps.eventBus.emit({ type: "rig.imported", rigId, specName: rigSpec.name, specVersion: rigSpec.version });
    } catch { /* best-effort */ }

    return {
      ok: true,
      result: { rigId, specName: rigSpec.name, specVersion: rigSpec.version, nodes: nodeResults, warnings: podInstantiateWarnings.length > 0 ? podInstantiateWarnings : undefined },
    };
  }

  private computePodLaunchOrder(rigSpec: PodRigSpec): string[] {
    const LAUNCH_DEP_KINDS = new Set(["delegates_to", "spawned_by"]);
    const allIds: string[] = [];
    const inDegree: Record<string, number> = {};
    const adjacency: Record<string, string[]> = {};

    // Collect all qualified member ids
    for (const pod of rigSpec.pods) {
      for (const member of pod.members) {
        const qid = `${pod.id}.${member.id}`;
        allIds.push(qid);
        inDegree[qid] = 0;
        adjacency[qid] = [];
      }
    }

    // Build adjacency from pod-local edges (qualify them) and cross-pod edges (already qualified)
    for (const pod of rigSpec.pods) {
      for (const edge of pod.edges) {
        if (!LAUNCH_DEP_KINDS.has(edge.kind)) continue;
        const from = `${pod.id}.${edge.kind === "delegates_to" ? edge.from : edge.to}`;
        const to = `${pod.id}.${edge.kind === "delegates_to" ? edge.to : edge.from}`;
        if (adjacency[from]) { adjacency[from]!.push(to); inDegree[to] = (inDegree[to] ?? 0) + 1; }
      }
    }
    for (const edge of rigSpec.edges) {
      if (!LAUNCH_DEP_KINDS.has(edge.kind)) continue;
      const from = edge.kind === "delegates_to" ? edge.from : edge.to;
      const to = edge.kind === "delegates_to" ? edge.to : edge.from;
      if (adjacency[from]) { adjacency[from]!.push(to); inDegree[to] = (inDegree[to] ?? 0) + 1; }
    }

    // Topological sort with alphabetical tiebreaker
    const queue = allIds.filter((id) => inDegree[id] === 0).sort();
    const order: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      order.push(current);
      for (const neighbor of (adjacency[current] ?? []).sort()) {
        inDegree[neighbor]! -= 1;
        if (inDegree[neighbor] === 0) {
          let inserted = false;
          for (let i = 0; i < queue.length; i++) {
            if (queue[i]!.localeCompare(neighbor) > 0) { queue.splice(i, 0, neighbor); inserted = true; break; }
          }
          if (!inserted) queue.push(neighbor);
        }
      }
    }

    // Cycle detection: if any nodes remain unvisited, the graph has a cycle
    if (order.length < allIds.length) {
      const cycled = allIds.filter((id) => !order.includes(id));
      throw new Error(`Dependency cycle detected among nodes: ${cycled.join(", ")}`);
    }

    return order;
  }

  private async processTerminalMember(
    rigId: string,
    rigSpec: PodRigSpec,
    rigRoot: string,
    pod: PodRigSpec["pods"][0],
    member: RigSpecPodMember,
    podId: string,
    qualifiedId: string,
    nodeIdMap: Record<string, string>,
    launchedSessionNames: string[],
    warnings: string[],
  ): Promise<{ logicalId: string; status: "launched" | "failed"; error?: string }> {
    // Create node with sentinel values
    let nodeId: string;
    try {
      const node = this.deps.rigRepo.addNode(rigId, qualifiedId, {
        runtime: member.runtime,
        model: member.model,
        cwd: member.cwd,
        restorePolicy: "checkpoint_only",
        podId,
        agentRef: member.agentRef,
        profile: member.profile,
        label: member.label,
      });
      nodeId = node.id;
      nodeIdMap[qualifiedId] = nodeId;
    } catch (err) {
      return { logicalId: qualifiedId, status: "failed", error: (err as Error).message };
    }

    // Validate session name components
    const sessionNameErrors = validateSessionComponents(pod.id, member.id, rigSpec.name);
    if (sessionNameErrors.length > 0) {
      return { logicalId: qualifiedId, status: "failed", error: sessionNameErrors.join("; ") };
    }

    // Launch session
    const canonicalSessionName = deriveCanonicalSessionName(pod.id, member.id, rigSpec.name);
    const launchResult = await this.deps.nodeLauncher.launchNode(rigId, qualifiedId, { sessionName: canonicalSessionName });
    if (!launchResult.ok) {
      return { logicalId: qualifiedId, status: "failed", error: launchResult.message };
    }
    launchedSessionNames.push(canonicalSessionName);
    if (launchResult.warnings?.length) {
      warnings.push(...launchResult.warnings);
    }

    // Propagate restore_policy to session row (restore-orchestrator reads session.restorePolicy)
    try {
      this.db.prepare("UPDATE sessions SET restore_policy = ? WHERE id = ?")
        .run("checkpoint_only", launchResult.session.id);
    } catch { /* best-effort */ }

    // Assemble startup layers (empty agent base + profile, keep rig/pod/member)
    const startup = resolveStartup({
      specStartup: { files: [], actions: [] },
      profileStartup: undefined,
      rigCultureFile: rigSpec.cultureFile,
      rigStartup: rigSpec.startup,
      podStartup: pod.startup,
      memberStartup: member.startup,
      operatorStartup: undefined,
    });

    // Build resolved startup files for rig/pod/member layers (skip agent/profile)
    const resolvedFiles = this.buildTerminalResolvedStartupFiles(rigSpec, rigRoot, pod, member);

    // Build binding
    const binding: NodeBinding = {
      id: launchResult.ok ? launchResult.binding.id : "",
      nodeId,
      tmuxSession: launchResult.ok ? launchResult.binding.tmuxSession : null,
      tmuxWindow: null,
      tmuxPane: null,
      cmuxWorkspace: null,
      cmuxSurface: null,
      updatedAt: "",
      cwd: member.cwd,
    };

    // Select terminal adapter
    const adapter = this.deps.adapters["terminal"];
    if (!adapter) {
      return { logicalId: qualifiedId, status: "failed", error: 'No adapter for runtime "terminal"' };
    }

    // Empty projection plan for terminal nodes
    const emptyPlan = {
      entries: [],
      diagnostics: [],
      conflicts: [],
      noOps: [],
      runtime: "terminal",
      cwd: member.cwd,
    };

    // Run startup (terminal adapter no-ops project/deliver/checkReady; send_text actions execute)
    const startupResult = await this.deps.startupOrchestrator.startNode({
      rigId,
      nodeId,
      sessionId: launchResult.ok ? launchResult.session.id : "",
      binding,
      adapter,
      plan: emptyPlan as any,
      resolvedStartupFiles: resolvedFiles,
      startupActions: startup.actions,
      isRestore: false,
    });

    return {
      logicalId: qualifiedId,
      status: startupResult.ok ? "launched" : "failed",
      error: startupResult.ok ? undefined : startupResult.errors.join("; "),
    };
  }

  private buildTerminalResolvedStartupFiles(
    rigSpec: PodRigSpec,
    rigRoot: string,
    pod: RigSpecPod,
    member: RigSpecPodMember,
  ): ResolvedStartupFile[] {
    const files: ResolvedStartupFile[] = [];

    // Skip layers 1-2 (agent base, profile) — terminal nodes have no agent spec
    // Layer 3: Rig culture file
    if (rigSpec.cultureFile) {
      files.push({
        path: rigSpec.cultureFile,
        absolutePath: nodePath.resolve(rigRoot, rigSpec.cultureFile),
        ownerRoot: rigRoot,
        deliveryHint: "auto",
        required: true,
        appliesOn: ["fresh_start", "restore"],
      });
    }
    // Layer 4: Rig startup
    if (rigSpec.startup) {
      for (const f of rigSpec.startup.files) {
        files.push({ ...f, absolutePath: nodePath.resolve(rigRoot, f.path), ownerRoot: rigRoot });
      }
    }
    // Layer 5: Pod startup
    if (pod.startup) {
      for (const f of pod.startup.files) {
        files.push({ ...f, absolutePath: nodePath.resolve(rigRoot, f.path), ownerRoot: rigRoot });
      }
    }
    // Layer 6: Member startup
    if (member.startup) {
      for (const f of member.startup.files) {
        files.push({ ...f, absolutePath: nodePath.resolve(rigRoot, f.path), ownerRoot: rigRoot });
      }
    }

    return this.resolveAutoHints(files);
  }

  private buildResolvedStartupFiles(
    agentSpec: { startup: { files: StartupFile[] } },
    agentSourcePath: string,
    profile: { startup?: { files: StartupFile[] } } | undefined,
    rigSpec: PodRigSpec,
    rigRoot: string,
    pod: RigSpecPod,
    member: RigSpecPodMember,
  ): ResolvedStartupFile[] {
    const files: ResolvedStartupFile[] = [];
    // nodePath imported at top level (ESM)

    // 1. Agent base startup
    for (const f of agentSpec.startup.files) {
      files.push({ ...f, absolutePath: nodePath.resolve(agentSourcePath, f.path), ownerRoot: agentSourcePath });
    }
    // 2. Profile startup
    if (profile?.startup) {
      for (const f of profile.startup.files) {
        files.push({ ...f, absolutePath: nodePath.resolve(agentSourcePath, f.path), ownerRoot: agentSourcePath });
      }
    }
    // 3. Rig culture file
    if (rigSpec.cultureFile) {
      files.push({
        path: rigSpec.cultureFile,
        absolutePath: nodePath.resolve(rigRoot, rigSpec.cultureFile),
        ownerRoot: rigRoot,
        deliveryHint: "auto",
        required: true,
        appliesOn: ["fresh_start", "restore"],
      });
    }
    // 4. Rig startup
    if (rigSpec.startup) {
      for (const f of rigSpec.startup.files) {
        files.push({ ...f, absolutePath: nodePath.resolve(rigRoot, f.path), ownerRoot: rigRoot });
      }
    }
    // 5. Pod startup
    if (pod.startup) {
      for (const f of pod.startup.files) {
        files.push({ ...f, absolutePath: nodePath.resolve(rigRoot, f.path), ownerRoot: rigRoot });
      }
    }
    // 6. Member startup
    if (member.startup) {
      for (const f of member.startup.files) {
        files.push({ ...f, absolutePath: nodePath.resolve(rigRoot, f.path), ownerRoot: rigRoot });
      }
    }

    return this.resolveAutoHints(files);
  }

  /**
   * Resolve any remaining 'auto' delivery hints to concrete hints at plan time.
   * Uses the shared resolveConcreteHint resolver (single source of truth).
   * After this, no file should have deliveryHint === 'auto'.
   */
  private resolveAutoHints(files: ResolvedStartupFile[]): ResolvedStartupFile[] {
    return files.map((f) => {
      if (f.deliveryHint !== "auto") return f;
      try {
        const content = this.deps.fsOps.readFile(f.absolutePath);
        return { ...f, deliveryHint: resolveConcreteHint(f.path, content) };
      } catch {
        // If file can't be read, default to send_text (safest — delivered after harness ready)
        return { ...f, deliveryHint: "send_text" as const };
      }
    });
  }
}
