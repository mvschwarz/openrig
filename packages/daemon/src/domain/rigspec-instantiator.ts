import nodePath from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { assembleBundle } from "./context-packs/bundle-assembler.js";
import type { ContextPackEntry } from "./context-packs/context-pack-types.js";
import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { EventBus } from "./event-bus.js";
import type { NodeLauncher } from "./node-launcher.js";
import type { RigSpecPreflight } from "./rigspec-preflight.js";
import { deriveCanonicalSessionName, validateSessionComponents } from "./session-name.js";
import { LegacyRigSpecSchema as RigSpecSchema } from "./rigspec-schema.js"; // TODO: AS-T08b — migrate to pod-aware RigSpec
import { LegacyRigSpecCodec as RigSpecCodec } from "./rigspec-codec.js"; // TODO: AS-T08b — migrate to pod-aware RigSpec
import type { LegacyRigSpec as RigSpec, LegacyRigSpecEdge as RigSpecEdge, InstantiateOutcome, InstantiateResult } from "./types.js"; // TODO: AS-T08b — migrate to pod-aware RigSpec
import { resolveLaunchCwd } from "./cwd-resolution.js";

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
import { planProjection, type ProjectionPlan } from "./projection-planner.js";
import { StartupOrchestrator } from "./startup-orchestrator.js";
import { PodRepository } from "./pod-repository.js";
import type { RigSpec as PodRigSpec, RigSpecPod, RigSpecPodMember, StartupAction, StartupFile } from "./types.js";
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
  /** PL-014 Item 6: optional context-pack library so AgentSpec
   *  startup_files entries with `kind: context_pack` can resolve to
   *  the pack's assembled bundle. Optional — when absent, context_pack
   *  startup files surface a structured error at instantiation time. */
  contextPackLibrary?: import("./context-packs/context-pack-library-service.js").ContextPackLibraryService;
  /** PL-016 Item 4: optional agent-image library so AgentSpec
   *  session_source: mode: agent_image entries can resolve to the
   *  image's resume token. Optional — when absent, agent_image session
   *  source surfaces a structured error at instantiation time. */
  agentImageLibrary?: import("./agent-images/agent-image-library-service.js").AgentImageLibraryService;
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

export interface LaunchMaterializedNodeResult {
  logicalId: string;
  nodeId: string;
  status: "launched" | "failed";
  error?: string;
  sessionName?: string;
}

export type LaunchMaterializedOutcome =
  | { ok: true; result: { nodes: LaunchMaterializedNodeResult[]; warnings?: string[] } }
  | { ok: false; code: "validation_failed"; errors: string[] }
  | { ok: false; code: "target_rig_not_found"; message: string };

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
    opts?: { targetRigId?: string; suppressSummaryEvent?: boolean; cwdOverride?: string },
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
      cwdOverride: opts?.cwdOverride,
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

        // PL-007: persist the rig's typed workspace block when declared.
        if (rigSpec.workspace) {
          this.deps.rigRepo.setRigWorkspace(materializedRigId, rigSpec.workspace);
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
            const effectiveCwd = resolveLaunchCwd(member.cwd, rigRoot, opts?.cwdOverride);
            const node = this.deps.rigRepo.addNode(materializedRigId, qualifiedId, {
              runtime: member.runtime,
              model: member.model,
              codexConfigProfile: member.codexConfigProfile,
              cwd: effectiveCwd,
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

        if (!opts?.suppressSummaryEvent) {
          persistedEvents.push(this.deps.eventBus.persistWithinTransaction({
            type: "rig.imported",
            rigId: materializedRigId,
            specName: rigSpec.name,
            specVersion: rigSpec.version,
          }));
        }
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

  async launchMaterialized(
    rigSpecYaml: string,
    rigRoot: string,
    targetRigId: string,
  ): Promise<LaunchMaterializedOutcome> {
    let raw: unknown;
    try {
      raw = PodRigSpecCodec.parse(rigSpecYaml);
    } catch (err) {
      return { ok: false, code: "validation_failed", errors: [(err as Error).message] };
    }

    const targetRig = this.deps.rigRepo.getRig(targetRigId);
    if (!targetRig) {
      return { ok: false, code: "target_rig_not_found", message: `Rig "${targetRigId}" not found` };
    }

    const validation = PodRigSpecSchema.validate(raw, {
      externalQualifiedIds: targetRig.nodes.map((node) => node.logicalId),
    });
    if (!validation.valid) {
      return { ok: false, code: "validation_failed", errors: validation.errors };
    }

    const rigSpec = PodRigSpecSchema.normalize(raw as Record<string, unknown>);
    const launchOrder = this.computePodLaunchOrder(rigSpec);
    const podWarnings: string[] = [];
    const nodeResults: LaunchMaterializedNodeResult[] = [];

    for (const logicalId of launchOrder) {
      const memberContext = this.findMemberContext(rigSpec, logicalId);
      if (!memberContext) {
        nodeResults.push({
          logicalId,
          nodeId: "",
          status: "failed",
          error: `Unable to resolve member definition for "${logicalId}"`,
        });
        continue;
      }

      const node = this.deps.rigRepo.getRig(targetRigId)?.nodes.find((entry) => entry.logicalId === logicalId);
      if (!node) {
        nodeResults.push({
          logicalId,
          nodeId: "",
          status: "failed",
          error: `Node "${logicalId}" not found after materialization`,
        });
        continue;
      }

      const launched = memberContext.member.agentRef === "builtin:terminal"
        ? await this.launchExistingTerminalMember({
            rigId: targetRigId,
            rigSpec,
            rigRoot,
            pod: memberContext.pod,
            member: memberContext.member,
            qualifiedId: logicalId,
            nodeId: node.id,
          })
        : await this.launchExistingAgentMember({
            rigId: targetRigId,
            rigSpec,
            rigRoot,
            pod: memberContext.pod,
            member: memberContext.member,
            qualifiedId: logicalId,
            nodeId: node.id,
          });

      if (launched.warnings?.length) {
        podWarnings.push(...launched.warnings);
      }

      nodeResults.push({
        logicalId,
        nodeId: node.id,
        status: launched.status,
        error: launched.error,
        sessionName: launched.sessionName,
      });
    }

    return {
      ok: true,
      result: {
        nodes: nodeResults,
        warnings: podWarnings.length > 0 ? podWarnings : undefined,
      },
    };
  }

  async instantiate(rigSpecYaml: string, rigRoot: string, opts?: { cwdOverride?: string; prelaunchHook?: (rigId: string) => Promise<{ ok: true } | { ok: false; code: string; message: string }> }): Promise<InstantiateOutcome> {
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
    const preflight = rigPreflight({ rigSpecYaml, rigRoot, cwdOverride: opts?.cwdOverride, fsOps: this.deps.fsOps });
    if (!preflight.ready) {
      return { ok: false, code: "preflight_failed", errors: preflight.errors, warnings: preflight.warnings };
    }

    // 3. Create rig
    let rigId: string;
    try {
      const rig = this.deps.rigRepo.createRig(rigSpec.name);
      rigId = rig.id;
      // PL-007: persist typed workspace block (when declared) on the rig
      // record. Whoami / node-inventory read it via getRigWorkspace().
      if (rigSpec.workspace) {
        this.deps.rigRepo.setRigWorkspace(rigId, rigSpec.workspace);
      }
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

    // Prelaunch hook: service gate runs after topology setup, before any node launch
    if (opts?.prelaunchHook) {
      const hookResult = await opts.prelaunchHook(rigId);
      if (!hookResult.ok) {
        return { ok: false, code: "service_boot_failed", message: hookResult.message };
      }
    }

    // Phase 2: Process members in launch order
    for (const { pod, member, podId, qualifiedId } of memberEntries) {

        // Terminal fast-path: skip agent resolution and profile resolution
        if (member.agentRef === "builtin:terminal") {
          const termResult = await this.processTerminalMember(
            rigId, rigSpec, rigRoot, pod, member, podId, qualifiedId, nodeIdMap, launchedSessionNames, podInstantiateWarnings, opts?.cwdOverride,
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
          specRoot: rigRoot,
          cwdOverride: opts?.cwdOverride,
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
            codexConfigProfile: member.codexConfigProfile,
            cwd: configResult.config.cwd,
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

        const launched = await this.launchExistingAgentMember({
          rigId,
          rigSpec,
          rigRoot,
          cwdOverride: opts?.cwdOverride,
          pod,
          member,
          qualifiedId,
          nodeId,
          resolveResult,
          configResult,
        });
        if (launched.sessionName) {
          launchedSessionNames.push(launched.sessionName);
        }
        if (launched.warnings?.length) {
          podInstantiateWarnings.push(...launched.warnings);
        }
        nodeResults.push({
          logicalId: qualifiedId,
          status: launched.status,
          error: launched.error,
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
      if (adjacency[from] && adjacency[to]) {
        adjacency[from]!.push(to);
        inDegree[to] = (inDegree[to] ?? 0) + 1;
      }
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
    cwdOverride?: string,
  ): Promise<{ logicalId: string; status: "launched" | "failed"; error?: string }> {
    const effectiveCwd = resolveLaunchCwd(member.cwd, rigRoot, cwdOverride);
    // Create node with sentinel values
    let nodeId: string;
    try {
      const node = this.deps.rigRepo.addNode(rigId, qualifiedId, {
        runtime: member.runtime,
        model: member.model,
        cwd: effectiveCwd,
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

    const launched = await this.launchExistingTerminalMember({
      rigId,
      rigSpec,
      rigRoot,
      cwdOverride,
      pod,
      member,
      qualifiedId,
      nodeId,
    });
    if (launched.sessionName) {
      launchedSessionNames.push(launched.sessionName);
    }
    if (launched.warnings?.length) {
      warnings.push(...launched.warnings);
    }
    return {
      logicalId: qualifiedId,
      status: launched.status,
      error: launched.error,
    };
  }

  private findMemberContext(
    rigSpec: PodRigSpec,
    qualifiedId: string,
  ): { pod: RigSpecPod; member: RigSpecPodMember } | null {
    const [podId, memberId] = qualifiedId.split(".", 2);
    if (!podId || !memberId) return null;
    const pod = rigSpec.pods.find((entry) => entry.id === podId);
    const member = pod?.members.find((entry) => entry.id === memberId);
    return pod && member ? { pod, member } : null;
  }

  private async launchExistingAgentMember(input: {
    rigId: string;
    rigSpec: PodRigSpec;
    rigRoot: string;
    pod: RigSpecPod;
    member: RigSpecPodMember;
    qualifiedId: string;
    nodeId: string;
    cwdOverride?: string;
    resolveResult?: ReturnType<typeof resolveAgentRef> extends infer T ? T : never;
    configResult?: ReturnType<typeof resolveNodeConfig> extends infer T ? T : never;
  }): Promise<{ status: "launched" | "failed"; error?: string; sessionName?: string; warnings?: string[] }> {
    const resolveResult = input.resolveResult ?? resolveAgentRef(input.member.agentRef, input.rigRoot, this.deps.fsOps);
    if (!resolveResult.ok) {
      const msg = resolveResult.code === "validation_failed"
        ? (resolveResult as { errors: string[] }).errors.join("; ")
        : (resolveResult as { error: string }).error;
      return { status: "failed", error: msg };
    }

    const configResult = input.configResult ?? resolveNodeConfig({
      baseSpec: resolveResult.resolved,
      importedSpecs: resolveResult.imports,
      collisions: resolveResult.collisions,
      profileName: input.member.profile,
      specRoot: input.rigRoot,
      cwdOverride: input.cwdOverride,
      member: input.member,
      pod: input.pod,
      rig: input.rigSpec,
    });
    if (!configResult.ok) {
      return { status: "failed", error: configResult.errors.join("; ") };
    }

    this.updateNodeResolvedConfig(input.nodeId, configResult.config);

    const sessionNameErrors = validateSessionComponents(input.pod.id, input.member.id, input.rigSpec.name);
    if (sessionNameErrors.length > 0) {
      return { status: "failed", error: sessionNameErrors.join("; ") };
    }

    const canonicalSessionName = deriveCanonicalSessionName(input.pod.id, input.member.id, input.rigSpec.name);
    const launchResult = await this.deps.nodeLauncher.launchNode(input.rigId, input.qualifiedId, { sessionName: canonicalSessionName });
    if (!launchResult.ok) {
      return { status: "failed", error: launchResult.message };
    }

    try {
      this.db.prepare("UPDATE sessions SET restore_policy = ? WHERE id = ?")
        .run(configResult.config.restorePolicy, launchResult.session.id);
    } catch { /* best-effort */ }

    const adapter = this.deps.adapters[input.member.runtime];
    if (!adapter) {
      return { status: "failed", error: `No adapter for runtime "${input.member.runtime}"`, sessionName: canonicalSessionName, warnings: launchResult.warnings };
    }

    const planResult = planProjection({
      config: configResult.config,
      collisions: resolveResult.collisions,
      fsOps: this.deps.fsOps,
    });
    if (!planResult.ok) {
      return { status: "failed", error: planResult.errors.join("; "), sessionName: canonicalSessionName, warnings: launchResult.warnings };
    }

    const resolvedFiles = this.buildResolvedStartupFiles(
      resolveResult.resolved.spec,
      resolveResult.resolved.sourcePath,
      resolveResult.resolved.spec.profiles[input.member.profile],
      input.rigSpec,
      input.rigRoot,
      input.pod,
      input.member,
    );
    const dedupedResolvedFiles = this.dedupeProjectedManagedStartupFiles(planResult.plan, resolvedFiles);

    const binding: NodeBinding = {
      id: launchResult.binding.id,
      nodeId: input.nodeId,
      tmuxSession: launchResult.binding.tmuxSession,
      tmuxWindow: null,
      tmuxPane: null,
      cmuxWorkspace: null,
      cmuxSurface: null,
      updatedAt: "",
      cwd: configResult.config.cwd,
      model: configResult.config.model,
      codexConfigProfile: input.member.codexConfigProfile,
    };

    // session_source dispatch: fork (native runtime fork) vs rebuild (artifact-
    // injected fresh launch) vs agent_image (PL-016 Item 4: dispatch through
    // fork using the image's resume token). Mutually exclusive on a member.
    let forkSourceOpt: { forkSource: { kind: "native_id" | "artifact_path" | "name" | "last"; value?: string } } | undefined;
    let rebuildArtifactsOpt: { rebuildArtifacts: import("./runtime-adapter.js").ResolvedStartupFile[] } | undefined;
    // PL-016 hardening v0+1 (review-lead live e2e finding 4): the
    // consumed image id + library handle stash so the post-launch block
    // can bump fork_count only on startupResult.ok===true (lastUsedAt
    // already bumped optimistically in the dispatch branch).
    let consumedAgentImageId: string | undefined;
    let consumedAgentImageLibrary: import("./agent-images/agent-image-library-service.js").AgentImageLibraryService | undefined;
    if (input.member.sessionSource?.mode === "fork") {
      const ref = input.member.sessionSource.ref;
      forkSourceOpt = {
        forkSource: {
          kind: ref.kind,
          ...(ref.value !== undefined ? { value: ref.value } : {}),
        },
      };
    } else if (input.member.sessionSource?.mode === "rebuild") {
      const { resolveRebuildArtifacts } = await import("./session-source-rebuild-resolver.js");
      const resolved = resolveRebuildArtifacts(input.member.sessionSource);
      if (!resolved.ok) {
        return { status: "failed", error: resolved.error, sessionName: canonicalSessionName };
      }
      rebuildArtifactsOpt = { rebuildArtifacts: resolved.files };
    } else if (input.member.sessionSource?.mode === "agent_image") {
      // PL-016 Item 4: agent_image → resolve via library + dispatch
      // through the native-fork code path so nativeResumeProbe
      // semantics are preserved (architecture.md § Resume honesty).
      const library = this.deps.agentImageLibrary;
      if (!library) {
        return {
          status: "failed",
          error: `session_source: mode: agent_image requires the daemon AgentImageLibraryService to be wired; restart the daemon or check ~/.openrig/agent-images/ exists.`,
          sessionName: canonicalSessionName,
        };
      }
      const ref = input.member.sessionSource.ref;
      const version = ref.version ?? "1";
      const image = library.getByNameVersion(ref.value, version);
      if (!image) {
        return {
          status: "failed",
          error: `Agent image '${ref.value}' v${version} not found in library. Run 'rig agent-image list' to see what's installed.`,
          sessionName: canonicalSessionName,
        };
      }
      if (image.runtime !== input.member.runtime) {
        return {
          status: "failed",
          error: `Agent image '${ref.value}' v${version} runtime '${image.runtime}' does not match member '${input.member.id}' runtime '${input.member.runtime}'.`,
          sessionName: canonicalSessionName,
        };
      }
      forkSourceOpt = {
        forkSource: { kind: "native_id", value: image.sourceResumeToken },
      };
      // PL-016 hardening v0+1 (review-lead live e2e finding 4, 2026-05-04):
      // pre-launch bump of lastUsedAt only — records the operator's
      // INTENT to consume the image. forkCount increments later, gated
      // on startupResult.ok===true (see post-startNode block below).
      // Best-effort: stat-write failures don't abort launch.
      try {
        library.recordConsumption(image.id, { incrementForkCount: false });
      } catch (err) {
        console.warn(`[openrig] agent-image stats update failed for ${image.id}: ${(err as Error).message}`);
      }
      // Stash the consumed image for the post-launch fork-count bump.
      consumedAgentImageId = image.id;
      consumedAgentImageLibrary = library;
    }

    // Agent Starter resolver dispatch (Agent Starter v1 vertical M2). When
    // `member.starterRef` is set, resolve the named registry entry into a
    // `ResolvedStartupFile[]` that prepends ahead of the member's per-agent
    // and per-pod startup files (the new STARTER layer at the front of the
    // layer chain). The resolver THROWS on a failed credential scan, missing
    // registry entry, or malformed YAML; on any throw we abort the launch
    // BEFORE `startNode` runs (no STARTER layer added; no adapter
    // `deliverStartup` called) — load-bearing credential-safety contract per
    // M1 R1 finding 2.
    let starterArtifacts: import("./runtime-adapter.js").ResolvedStartupFile[] | undefined;
    if (input.member.starterRef) {
      const { AgentStarterResolver } = await import("./agent-starter-resolver.js");
      const resolver = new AgentStarterResolver();
      try {
        const resolved = resolver.resolveStarter(input.member.starterRef.name);
        starterArtifacts = resolved.files;
      } catch (err) {
        return {
          status: "failed",
          error: `Agent Starter resolver failed: ${(err as Error).message}`,
          sessionName: canonicalSessionName,
          warnings: launchResult.warnings,
        };
      }
    }

    // STARTER layer (artifact-seeded fresh-launch context; precedes per-agent
    // and per-pod layers). Prepended to dedupedResolvedFiles so the existing
    // `startupOrchestrator.startNode` consumes the combined chain via the
    // existing `resolvedStartupFiles` input — NO new orchestrator branch.
    const finalResolvedStartupFiles = starterArtifacts
      ? [...starterArtifacts, ...dedupedResolvedFiles]
      : dedupedResolvedFiles;

    const startupResult = await this.deps.startupOrchestrator.startNode({
      rigId: input.rigId,
      nodeId: input.nodeId,
      sessionId: launchResult.session.id,
      binding,
      adapter,
      plan: planResult.plan,
      resolvedStartupFiles: finalResolvedStartupFiles,
      startupActions: [
        ...configResult.config.startup.actions,
        this.buildSessionIdentityAction({
          rigName: input.rigSpec.name,
          pod: input.pod,
          member: input.member,
          runtime: input.member.runtime,
          sessionName: canonicalSessionName,
          resolvedSpecName: configResult.config.resolvedSpecName,
        }),
      ],
      isRestore: false,
      ...(forkSourceOpt ?? {}),
      ...(rebuildArtifactsOpt ?? {}),
    });

    // PL-016 hardening v0+1 (review-lead live e2e finding 4, 2026-05-04):
    // bump fork_count only on launch success. lastUsedAt already
    // updated optimistically in the agent_image dispatch branch above.
    if (startupResult.ok && consumedAgentImageId && consumedAgentImageLibrary) {
      try {
        consumedAgentImageLibrary.recordConsumption(consumedAgentImageId, { incrementForkCount: true });
      } catch (err) {
        console.warn(`[openrig] agent-image fork_count bump failed for ${consumedAgentImageId}: ${(err as Error).message}`);
      }
    }

    return {
      status: startupResult.ok ? "launched" : "failed",
      error: startupResult.ok ? undefined : startupResult.errors.join("; "),
      sessionName: canonicalSessionName,
      warnings: launchResult.warnings,
    };
  }

  private async launchExistingTerminalMember(input: {
    rigId: string;
    rigSpec: PodRigSpec;
    rigRoot: string;
    pod: RigSpecPod;
    member: RigSpecPodMember;
    qualifiedId: string;
    nodeId: string;
    cwdOverride?: string;
  }): Promise<{ status: "launched" | "failed"; error?: string; sessionName?: string; warnings?: string[] }> {
    const effectiveCwd = resolveLaunchCwd(input.member.cwd, input.rigRoot, input.cwdOverride);
    const sessionNameErrors = validateSessionComponents(input.pod.id, input.member.id, input.rigSpec.name);
    if (sessionNameErrors.length > 0) {
      return { status: "failed", error: sessionNameErrors.join("; ") };
    }

    const canonicalSessionName = deriveCanonicalSessionName(input.pod.id, input.member.id, input.rigSpec.name);
    const launchResult = await this.deps.nodeLauncher.launchNode(input.rigId, input.qualifiedId, { sessionName: canonicalSessionName });
    if (!launchResult.ok) {
      return { status: "failed", error: launchResult.message };
    }

    try {
      this.db.prepare("UPDATE nodes SET restore_policy = ? WHERE id = ?")
        .run("checkpoint_only", input.nodeId);
    } catch { /* best-effort */ }

    try {
      this.db.prepare("UPDATE sessions SET restore_policy = ? WHERE id = ?")
        .run("checkpoint_only", launchResult.session.id);
    } catch { /* best-effort */ }

    const startup = resolveStartup({
      specStartup: { files: [], actions: [] },
      profileStartup: undefined,
      rigCultureFile: input.rigSpec.cultureFile,
      rigStartup: input.rigSpec.startup,
      podStartup: input.pod.startup,
      memberStartup: input.member.startup,
      operatorStartup: undefined,
    });
    const resolvedFiles = this.buildTerminalResolvedStartupFiles(input.rigSpec, input.rigRoot, input.pod, input.member);
    const binding: NodeBinding = {
      id: launchResult.binding.id,
      nodeId: input.nodeId,
      tmuxSession: launchResult.binding.tmuxSession,
      tmuxWindow: null,
      tmuxPane: null,
      cmuxWorkspace: null,
      cmuxSurface: null,
      updatedAt: "",
      cwd: effectiveCwd,
    };
    const adapter = this.deps.adapters["terminal"];
    if (!adapter) {
      return { status: "failed", error: 'No adapter for runtime "terminal"', sessionName: canonicalSessionName, warnings: launchResult.warnings };
    }

    const emptyPlan = {
      entries: [],
      diagnostics: [],
      conflicts: [],
      noOps: [],
      runtime: "terminal",
      cwd: effectiveCwd,
    };

    const startupResult = await this.deps.startupOrchestrator.startNode({
      rigId: input.rigId,
      nodeId: input.nodeId,
      sessionId: launchResult.session.id,
      binding,
      adapter,
      plan: emptyPlan as any,
      resolvedStartupFiles: resolvedFiles,
      startupActions: startup.actions,
      isRestore: false,
    });

    return {
      status: startupResult.ok ? "launched" : "failed",
      error: startupResult.ok ? undefined : startupResult.errors.join("; "),
      sessionName: canonicalSessionName,
      warnings: launchResult.warnings,
    };
  }

  private updateNodeResolvedConfig(
    nodeId: string,
    config: {
      restorePolicy: string;
      resolvedSpecName: string;
      resolvedSpecVersion: string;
      resolvedSpecHash: string;
    },
  ): void {
    try {
      this.db.prepare(
        `UPDATE nodes
         SET restore_policy = ?,
             resolved_spec_name = ?,
             resolved_spec_version = ?,
             resolved_spec_hash = ?
         WHERE id = ?`
      ).run(
        config.restorePolicy,
        config.resolvedSpecName,
        config.resolvedSpecVersion,
        config.resolvedSpecHash,
        nodeId,
      );
    } catch {
      /* best-effort */
    }
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

    this.expandContextPacks(files, rigRoot);
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

    // 7. Built-in OpenRig onboarding overlay (appended last, does not replace agent guidance)
    const onboardingPath = nodePath.resolve(import.meta.dirname, "../../assets/guidance/openrig-start.md");
    files.push({
      path: "openrig-start.md",
      absolutePath: onboardingPath,
      ownerRoot: nodePath.resolve(import.meta.dirname, "../../assets"),
      deliveryHint: "guidance_merge",
      required: false,
      appliesOn: ["fresh_start", "restore"],
    });

    this.expandContextPacks(files, rigRoot);
    return this.resolveAutoHints(files);
  }

  /**
   * PL-014 Item 6: expand any startup_files entries with `kind:
   * "context_pack"` into a real file on disk + adjust the
   * ResolvedStartupFile entry to point to it. Operates in place.
   *
   * Strategy:
   *   1. Look up the pack via the daemon-side ContextPackLibraryService.
   *   2. Assemble the pack into a single coherent paste-ready string.
   *   3. Write the bundle to <rigRoot>/.openrig/resolved-context-packs/
   *      <name>-<version>.md.
   *   4. Replace the entry's path/absolutePath/ownerRoot with that
   *      written path so the rest of the pipeline (resolveAutoHints +
   *      adapter.deliverStartup) treats it as a normal file.
   *
   * Throws on missing pack or absent library service so the
   * materialize path surfaces the failure honestly.
   */
  private expandContextPacks(files: ResolvedStartupFile[], rigRoot: string): void {
    const library = this.deps.contextPackLibrary;
    const targetDir = nodePath.join(rigRoot, ".openrig", "resolved-context-packs");
    let madeDir = false;
    for (let i = 0; i < files.length; i++) {
      const f = files[i] as ResolvedStartupFile & {
        kind?: "file" | "context_pack";
        contextPackName?: string;
        contextPackVersion?: string;
      };
      if (f.kind !== "context_pack") continue;
      if (!library) {
        throw new Error(
          `startup_files entry references kind: context_pack '${f.contextPackName ?? "(missing-name)"}' v${f.contextPackVersion ?? "1"}, but the daemon ContextPackLibraryService is not wired.`,
        );
      }
      const name = f.contextPackName;
      const version = f.contextPackVersion ?? "1";
      if (!name) {
        throw new Error(`startup_files entry kind: context_pack is missing 'name'`);
      }
      const pack = library.getByNameVersion(name, version);
      if (!pack) {
        throw new Error(
          `Context pack '${name}' v${version} not found in library. Run 'rig context-pack list' to see what's installed.`,
        );
      }
      const bundle = assembleBundle({ packEntry: pack as ContextPackEntry });
      if (!madeDir) {
        mkdirSync(targetDir, { recursive: true });
        madeDir = true;
      }
      const targetPath = nodePath.join(targetDir, `${name}-${version}.md`);
      writeFileSync(targetPath, bundle.text, "utf-8");
      files[i] = {
        ...f,
        kind: "file",
        path: nodePath.relative(rigRoot, targetPath),
        absolutePath: targetPath,
        ownerRoot: rigRoot,
        deliveryHint: f.deliveryHint === "auto" ? "send_text" : f.deliveryHint,
        contextPackName: undefined,
        contextPackVersion: undefined,
      };
    }
  }

  private dedupeProjectedManagedStartupFiles(
    plan: ProjectionPlan,
    files: ResolvedStartupFile[],
  ): ResolvedStartupFile[] {
    const projectedManagedGuidancePaths = new Set(
      plan.entries
        .filter((entry) => entry.category === "guidance" && entry.mergeStrategy === "managed_block")
        .map((entry) => entry.absolutePath),
    );
    return files.filter((file) => {
      if (file.deliveryHint !== "guidance_merge") {
        return true;
      }
      return !projectedManagedGuidancePaths.has(file.absolutePath);
    });
  }

  private buildSessionIdentityAction(input: {
    rigName: string;
    pod: RigSpecPod;
    member: RigSpecPodMember;
    runtime: string;
    sessionName: string;
    resolvedSpecName?: string | null;
  }): StartupAction {
    const lines = [
      input.sessionName,
      "OpenRig session identity:",
      `- rig: ${input.rigName}`,
      `- pod: ${input.pod.id}`,
      `- pod_label: ${input.pod.label}`,
      `- member: ${input.member.id}`,
      input.member.label ? `- member_label: ${input.member.label}` : null,
      `- logical_id: ${input.pod.id}.${input.member.id}`,
      input.resolvedSpecName ? `- agent_spec: ${input.resolvedSpecName}` : null,
      `- runtime: ${input.runtime}`,
      `- session: ${input.sessionName}`,
      "This is your startup identity hint. For durable identity recovery after compaction, run:",
      "  rig whoami --json",
      "That command returns your full topology context: rig, pod, peers, edges, and transcript path.",
    ].filter((line): line is string => Boolean(line));

    return {
      type: "send_text",
      value: lines.join("\n"),
      phase: "after_ready",
      appliesOn: ["fresh_start", "restore"],
      idempotent: true,
      builtin: "session_identity",
    };
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
