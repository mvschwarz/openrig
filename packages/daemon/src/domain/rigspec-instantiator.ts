import type Database from "better-sqlite3";
import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { EventBus } from "./event-bus.js";
import type { NodeLauncher } from "./node-launcher.js";
import type { RigSpecPreflight } from "./rigspec-preflight.js";
import { RigSpecSchema } from "./rigspec-schema.js";
import { RigSpecCodec } from "./rigspec-codec.js";
import type { RigSpec, RigSpecEdge, InstantiateOutcome, InstantiateResult } from "./types.js";

// Only these edge kinds constrain launch order
const LAUNCH_DEPENDENCY_KINDS = new Set(["delegates_to", "spawned_by"]);

interface RigInstantiatorDeps {
  db: Database.Database;
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  eventBus: EventBus;
  nodeLauncher: NodeLauncher;
  preflight: RigSpecPreflight;
}

export class RigInstantiator {
  readonly db: Database.Database;
  private rigRepo: RigRepository;
  private sessionRegistry: SessionRegistry;
  private eventBus: EventBus;
  private nodeLauncher: NodeLauncher;
  private preflight: RigSpecPreflight;

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

    for (const logicalId of launchOrder) {
      const result = await this.nodeLauncher.launchNode(rigId!, logicalId);
      if (result.ok) {
        nodeResults.push({ logicalId, status: "launched" });
      } else {
        nodeResults.push({ logicalId, status: "failed", error: result.message });
      }
    }

    // Check for total launch failure — clean up the rig
    const allFailed = nodeResults.every((n) => n.status === "failed");
    if (allFailed && nodeResults.length > 0) {
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
