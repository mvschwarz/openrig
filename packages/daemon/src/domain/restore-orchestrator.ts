import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";
import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { EventBus } from "./event-bus.js";
import type { SnapshotRepository } from "./snapshot-repository.js";
import type { SnapshotCapture } from "./snapshot-capture.js";
import type { CheckpointStore } from "./checkpoint-store.js";
import type { NodeLauncher } from "./node-launcher.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { ClaudeResumeAdapter } from "../adapters/claude-resume.js";
import type { CodexResumeAdapter } from "../adapters/codex-resume.js";
import type { TranscriptStore } from "./transcript-store.js";
import type {
  RestoreOutcome,
  RestoreRigResult,
  RestoreResult,
  RestoreValidationBlocker,
  RestoreNodeResult,
  SnapshotData,
  NodeWithBinding,
  Edge,
  Session,
  Checkpoint,
  RigServicesRecord,
} from "./types.js";

// Only these edge kinds constrain launch order
const LAUNCH_DEPENDENCY_KINDS = new Set(["delegates_to", "spawned_by"]);

export function rollupRestoreRigResult(nodes: RestoreNodeResult[]): RestoreRigResult {
  if (nodes.length === 0) return "failed";
  const successful = nodes.filter((node) => node.status !== "failed");
  if (successful.length === 0) return "failed";
  if (nodes.some((node) => node.status === "fresh" || node.status === "failed")) {
    return "partially_restored";
  }
  return "fully_restored";
}

interface RestoreOrchestratorDeps {
  db: Database.Database;
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  eventBus: EventBus;
  snapshotRepo: SnapshotRepository;
  snapshotCapture: SnapshotCapture;
  checkpointStore: CheckpointStore;
  nodeLauncher: NodeLauncher;
  tmuxAdapter: TmuxAdapter;
  claudeResume: ClaudeResumeAdapter;
  codexResume: CodexResumeAdapter;
  transcriptStore?: TranscriptStore;
  serviceOrchestrator?: import("./service-orchestrator.js").ServiceOrchestrator;
}

export class RestoreOrchestrator {
  readonly db: Database.Database;
  private activeRestores = new Set<string>();
  private rigRepo: RigRepository;
  private sessionRegistry: SessionRegistry;
  private eventBus: EventBus;
  private snapshotRepo: SnapshotRepository;
  private snapshotCapture: SnapshotCapture;
  private nodeLauncher: NodeLauncher;
  private tmuxAdapter: TmuxAdapter;
  private claudeResume: ClaudeResumeAdapter;
  private codexResume: CodexResumeAdapter;
  private transcriptStore: TranscriptStore | null;
  private serviceOrchestrator: import("./service-orchestrator.js").ServiceOrchestrator | null;

  constructor(deps: RestoreOrchestratorDeps) {
    if (deps.db !== deps.rigRepo.db) {
      throw new Error("RestoreOrchestrator: rigRepo must share the same db handle");
    }
    if (deps.db !== deps.sessionRegistry.db) {
      throw new Error("RestoreOrchestrator: sessionRegistry must share the same db handle");
    }
    if (deps.db !== deps.eventBus.db) {
      throw new Error("RestoreOrchestrator: eventBus must share the same db handle");
    }
    if (deps.db !== deps.snapshotRepo.db) {
      throw new Error("RestoreOrchestrator: snapshotRepo must share the same db handle");
    }
    if (deps.db !== deps.checkpointStore.db) {
      throw new Error("RestoreOrchestrator: checkpointStore must share the same db handle");
    }
    if (deps.db !== deps.snapshotCapture.db) {
      throw new Error("RestoreOrchestrator: snapshotCapture must share the same db handle");
    }
    if (deps.db !== deps.nodeLauncher.db) {
      throw new Error("RestoreOrchestrator: nodeLauncher must share the same db handle");
    }

    this.db = deps.db;
    this.rigRepo = deps.rigRepo;
    this.sessionRegistry = deps.sessionRegistry;
    this.eventBus = deps.eventBus;
    this.snapshotRepo = deps.snapshotRepo;
    this.snapshotCapture = deps.snapshotCapture;
    this.nodeLauncher = deps.nodeLauncher;
    this.tmuxAdapter = deps.tmuxAdapter;
    this.claudeResume = deps.claudeResume;
    this.codexResume = deps.codexResume;
    this.transcriptStore = deps.transcriptStore ?? null;
    this.serviceOrchestrator = deps.serviceOrchestrator ?? null;
  }

  async restore(snapshotId: string, opts?: {
    adapters?: Record<string, import("./runtime-adapter.js").RuntimeAdapter>;
    fsOps?: { exists(path: string): boolean };
  }): Promise<RestoreOutcome> {
    // 1. Load snapshot
    const snapshot = this.snapshotRepo.getSnapshot(snapshotId);
    if (!snapshot) {
      return { ok: false, code: "snapshot_not_found", message: `Snapshot ${snapshotId} not found` };
    }

    const rigId = snapshot.rigId;
    const rig = this.rigRepo.getRig(rigId);
    if (!rig) {
      return { ok: false, code: "rig_not_found", message: `Rig ${rigId} not found` };
    }

    // Classify DB-running sessions against tmux reality WITHOUT mutating DB.
    // This determines whether the rig is safe to restore before any state
    // changes occur — critical for pre_restore snapshot ordering (snapshot
    // must capture original DB state, not post-reconciliation state).
    const classification = await this.classifyRunningSessions(rigId);
    if (classification.live.length > 0 || classification.unknown.length > 0) {
      return { ok: false, code: "rig_not_stopped", message: `Rig ${rigId} has live sessions. Stop the rig with 'rig down' before restoring, or use the latest auto-pre-down snapshot.` };
    }

    // Per-rig concurrency lock
    if (this.activeRestores.has(rigId)) {
      return { ok: false, code: "restore_in_progress", message: `Restore already in progress for rig ${rigId}` };
    }
    this.activeRestores.add(rigId);

    try {
      const validation = this.validatePreRestore(snapshot.data, {
        fsOps: opts?.fsOps,
        servicesRecord: this.rigRepo.getServicesRecord(rigId),
      });
      if (validation.blockers.length > 0) {
        const result: RestoreResult = {
          snapshotId,
          preRestoreSnapshotId: null,
          rigResult: "not_attempted",
          nodes: [],
          warnings: validation.warnings,
          blockers: validation.blockers,
        };
        return {
          ok: false,
          code: "pre_restore_validation_failed",
          message: "Restore pre-validation failed; no restore mutation was attempted.",
          result,
        };
      }

      // 2. Capture pre-restore snapshot BEFORE any DB mutations —
      // DB still reflects original session state (running for stale sessions)
      const preRestoreSnapshot = this.snapshotCapture.captureSnapshot(rigId, "pre_restore");

      // 2b. NOW mark stale sessions as detached (safe: we've captured the
      // pre-restore snapshot and confirmed no live/unknown sessions remain)
      for (const sessionId of classification.stale) {
        this.sessionRegistry.markDetached(sessionId);
      }

      // 3. Emit restore.started
      this.eventBus.emit({ type: "restore.started", rigId, snapshotId });

      // 3b. Service gate: boot services before agent restore if this rig has services
      if (this.serviceOrchestrator) {
        const svcRecord = this.rigRepo.getServicesRecord(rigId);
        if (svcRecord) {
          const bootResult = await this.serviceOrchestrator.boot(rigId);
          if (!bootResult.ok) {
            this.eventBus.emit({ type: "restore.completed", rigId, snapshotId, result: { snapshotId, preRestoreSnapshotId: preRestoreSnapshot.id, rigResult: "failed", nodes: [], warnings: [`Service boot failed: ${bootResult.error}`] } });
            return { ok: false, code: "service_boot_failed", message: `Service boot failed before agent restore: ${bootResult.error}` };
          }
        }
      }

      // 4. Compute restore plan
      const plan = this.computeRestorePlan(snapshot.data);

      // 5. Execute restore with compensating pattern per node
      const nodeResults: RestoreNodeResult[] = [];
      const restoreWarnings: string[] = [...validation.warnings];
      for (const entry of plan) {
        const result = await this.restoreNodeWithCompensation(entry, rigId, snapshotId, snapshot.data, opts, restoreWarnings);
        nodeResults.push(result);
      }

      const restoreResult: RestoreResult = {
        snapshotId,
        preRestoreSnapshotId: preRestoreSnapshot.id,
        rigResult: rollupRestoreRigResult(nodeResults),
        nodes: nodeResults,
        warnings: restoreWarnings,
      };

      // 7. Emit restore.completed
      this.eventBus.emit({ type: "restore.completed", rigId, snapshotId, result: restoreResult });

      return { ok: true, result: restoreResult };
    } catch (err) {
      return {
        ok: false,
        code: "restore_error",
        message: err instanceof Error ? err.message : String(err),
      };
    } finally {
      this.activeRestores.delete(rigId);
    }
  }

  private validatePreRestore(
    data: SnapshotData,
    opts: {
      fsOps?: { exists(path: string): boolean };
      servicesRecord?: RigServicesRecord | null;
    },
  ): { blockers: RestoreValidationBlocker[]; warnings: string[] } {
    const blockers: RestoreValidationBlocker[] = [];
    const warnings: string[] = [];
    const exists = opts.fsOps?.exists ?? (() => true);

    const add = (blocker: RestoreValidationBlocker) => blockers.push(blocker);
    const nodes = Array.isArray(data.nodes) ? data.nodes : null;
    const sessions = Array.isArray(data.sessions) ? data.sessions : null;
    const edges = Array.isArray(data.edges) ? data.edges : null;
    const checkpoints = data.checkpoints && typeof data.checkpoints === "object" ? data.checkpoints : null;

    if (!data.rig || typeof data.rig.id !== "string") {
      add({
        code: "invalid_snapshot_data",
        severity: "critical",
        target: "snapshot.rig",
        message: "Snapshot is missing the rig record needed for restore.",
        remediation: "Capture a new snapshot or restore from a structurally valid snapshot.",
      });
    }
    if (!nodes) {
      add({
        code: "invalid_snapshot_data",
        severity: "critical",
        target: "snapshot.nodes",
        message: "Snapshot is missing the node list needed for restore.",
        remediation: "Capture a new snapshot or restore from a structurally valid snapshot.",
      });
    }
    if (!sessions) {
      add({
        code: "invalid_snapshot_data",
        severity: "critical",
        target: "snapshot.sessions",
        message: "Snapshot is missing session records needed for restore.",
        remediation: "Capture a new snapshot or restore from a structurally valid snapshot.",
      });
    }
    if (!edges) {
      add({
        code: "invalid_snapshot_data",
        severity: "critical",
        target: "snapshot.edges",
        message: "Snapshot is missing topology edges needed for restore planning.",
        remediation: "Capture a new snapshot or restore from a structurally valid snapshot.",
      });
    }
    if (!checkpoints) {
      add({
        code: "invalid_snapshot_data",
        severity: "critical",
        target: "snapshot.checkpoints",
        message: "Snapshot is missing the checkpoint map needed for restore.",
        remediation: "Capture a new snapshot or restore from a structurally valid snapshot.",
      });
    }

    if (!nodes || !checkpoints) {
      return { blockers, warnings };
    }

    for (const node of nodes) {
      const checkpoint = checkpoints[node.id] ?? null;
      if (checkpoint && !node.cwd) {
        add({
          code: "checkpoint_missing_node_cwd",
          severity: "critical",
          nodeId: node.id,
          logicalId: node.logicalId,
          target: "checkpoint",
          message: `Checkpoint exists for ${node.logicalId}, but the node has no cwd to receive it.`,
          remediation: "Update the rig spec to include a cwd for this node, then capture a new snapshot or restore manually.",
        });
      }

      const startupCtx = data.nodeStartupContext?.[node.id] ?? null;
      if (!startupCtx) continue;

      for (const file of startupCtx.resolvedStartupFiles ?? []) {
        if (!file.required) {
          if (this.pathLike(file.absolutePath) && !exists(file.absolutePath)) {
            warnings.push(`Restore pre-validation: optional startup file missing for ${node.logicalId}: ${file.absolutePath}`);
          }
          continue;
        }
        if (this.pathLike(file.ownerRoot) && !exists(file.ownerRoot)) {
          add({
            code: "startup_owner_root_missing",
            severity: "critical",
            nodeId: node.id,
            logicalId: node.logicalId,
            target: file.path,
            path: file.ownerRoot,
            message: `Required startup file owner root is missing for ${node.logicalId}: ${file.ownerRoot}`,
            remediation: "Restore the agent/source root or capture a new snapshot with reachable startup context.",
          });
        }
        if (this.pathLike(file.absolutePath) && !exists(file.absolutePath)) {
          add({
            code: "required_startup_file_missing",
            severity: "critical",
            nodeId: node.id,
            logicalId: node.logicalId,
            target: file.path,
            path: file.absolutePath,
            message: `Required startup file is missing for ${node.logicalId}: ${file.absolutePath}`,
            remediation: "Restore the missing startup file or capture a new snapshot before retrying restore.",
          });
        }
      }

      for (const entry of startupCtx.projectionEntries ?? []) {
        if (this.pathLike(entry.sourcePath) && !exists(entry.sourcePath)) {
          add({
            code: "projection_source_missing",
            severity: "critical",
            nodeId: node.id,
            logicalId: node.logicalId,
            target: entry.effectiveId,
            path: entry.sourcePath,
            message: `Projection source root is missing for ${node.logicalId}: ${entry.sourcePath}`,
            remediation: "Restore the agent/source root that owns this projected resource or capture a new snapshot.",
          });
        }
        if (this.pathLike(entry.absolutePath) && !exists(entry.absolutePath)) {
          add({
            code: "projection_entry_missing",
            severity: "critical",
            nodeId: node.id,
            logicalId: node.logicalId,
            target: entry.effectiveId,
            path: entry.absolutePath,
            message: `Projection entry is missing for ${node.logicalId}: ${entry.absolutePath}`,
            remediation: "Restore the projected source artifact or capture a new snapshot before retrying restore.",
          });
        }
      }
    }

    const servicesRecord = opts.servicesRecord ?? null;
    if (servicesRecord) {
      if (this.pathLike(servicesRecord.rigRoot) && !exists(servicesRecord.rigRoot)) {
        add({
          code: "service_rig_root_missing",
          severity: "critical",
          target: "services.rigRoot",
          path: servicesRecord.rigRoot,
          message: `Service rig root is missing: ${servicesRecord.rigRoot}`,
          remediation: "Restore the service rig root or update the services record before retrying restore.",
        });
      }
      if (this.pathLike(servicesRecord.composeFile) && !exists(servicesRecord.composeFile)) {
        add({
          code: "service_compose_file_missing",
          severity: "critical",
          target: "services.composeFile",
          path: servicesRecord.composeFile,
          message: `Service compose file is missing: ${servicesRecord.composeFile}`,
          remediation: "Restore the compose file or update the services record before retrying restore.",
        });
      }
    }

    return { blockers, warnings };
  }

  private pathLike(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0 && (
      value.startsWith("/")
      || value.startsWith("./")
      || value.startsWith("../")
      || value.startsWith("~")
    );
  }

  private captureNodeState(nodeId: string, rigId: string): { binding: import("./types.js").Binding | null; sessions: { id: string; status: string }[] } {
    const binding = this.sessionRegistry.getBindingForNode(nodeId);
    const sessions = this.sessionRegistry.getSessionsForRig(rigId)
      .filter((s) => s.nodeId === nodeId && s.status !== "superseded" && s.status !== "exited")
      .map((s) => ({ id: s.id, status: s.status }));
    return { binding, sessions };
  }

  /**
   * Classify ALL DB-running sessions against tmux reality without mutating DB.
   * Scans every session (not just latest-per-node) to catch older live sessions
   * behind newer detached rows. Returns structured classification for the caller
   * to act on: live sessions block restore, stale sessions get marked detached
   * AFTER the pre_restore snapshot is captured, unknown sessions fail closed.
   */
  private async classifyRunningSessions(rigId: string): Promise<{
    live: string[];
    stale: string[];
    unknown: string[];
  }> {
    const live: string[] = [];
    const stale: string[] = [];
    const unknown: string[] = [];

    for (const session of this.sessionRegistry.getSessionsForRig(rigId)) {
      if (session.status !== "running") continue;
      try {
        const alive = await this.tmuxAdapter.hasSession(session.sessionName);
        if (alive) {
          live.push(session.id);
        } else {
          stale.push(session.id);
        }
      } catch {
        // tmux check failed — fail closed: classify as unknown so restore blocks
        unknown.push(session.id);
      }
    }

    return { live, stale, unknown };
  }

  private clearStaleState(nodeId: string, rigId: string): void {
    this.sessionRegistry.clearBinding(nodeId);
    const sessions = this.sessionRegistry.getSessionsForRig(rigId);
    for (const sess of sessions) {
      if (sess.nodeId === nodeId && sess.status !== "superseded" && sess.status !== "exited") {
        this.sessionRegistry.markSuperseded(sess.id);
      }
    }
  }

  private restoreNodeState(nodeId: string, priorState: { binding: import("./types.js").Binding | null; sessions: { id: string; status: string }[] }): void {
    // Restore prior binding
    if (priorState.binding) {
      this.sessionRegistry.updateBinding(nodeId, {
        tmuxSession: priorState.binding.tmuxSession ?? undefined,
        tmuxWindow: priorState.binding.tmuxWindow ?? undefined,
        tmuxPane: priorState.binding.tmuxPane ?? undefined,
        cmuxWorkspace: priorState.binding.cmuxWorkspace ?? undefined,
        cmuxSurface: priorState.binding.cmuxSurface ?? undefined,
      });
    }
    // Restore prior session statuses
    for (const sess of priorState.sessions) {
      this.sessionRegistry.updateStatus(sess.id, sess.status);
    }
  }

  private computeRestorePlan(data: SnapshotData): PlanEntry[] {
    const nodes = data.nodes;
    const edges = data.edges;

    // Build adjacency for launch-dependency edges only
    // For delegates_to: source must launch before target
    // For spawned_by: target must launch before source
    const nodeIds = nodes.map((n) => n.id);
    const inDegree: Record<string, number> = {};
    const adjacency: Record<string, string[]> = {};

    for (const id of nodeIds) {
      inDegree[id] = 0;
      adjacency[id] = [];
    }

    for (const edge of edges) {
      if (!LAUNCH_DEPENDENCY_KINDS.has(edge.kind)) continue;

      let from: string;
      let to: string;

      if (edge.kind === "delegates_to") {
        from = edge.sourceId;
        to = edge.targetId;
      } else {
        // spawned_by: target (parent) must launch before source (child)
        from = edge.targetId;
        to = edge.sourceId;
      }

      if (adjacency[from] && inDegree[to] !== undefined) {
        adjacency[from]!.push(to);
        inDegree[to] = (inDegree[to] ?? 0) + 1;
      }
    }

    // Topological sort with alphabetical tiebreaker by logical_id
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const queue = nodeIds
      .filter((id) => (inDegree[id] ?? 0) === 0)
      .sort((a, b) => {
        const na = nodeById.get(a)!.logicalId;
        const nb = nodeById.get(b)!.logicalId;
        return na.localeCompare(nb);
      });

    const order: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift()!;
      order.push(current);

      const neighbors = (adjacency[current] ?? []).slice().sort((a, b) => {
        const na = nodeById.get(a)!.logicalId;
        const nb = nodeById.get(b)!.logicalId;
        return na.localeCompare(nb);
      });

      for (const neighbor of neighbors) {
        inDegree[neighbor] = (inDegree[neighbor] ?? 1) - 1;
        if ((inDegree[neighbor] ?? 0) === 0) {
          // Insert in sorted position
          const logicalId = nodeById.get(neighbor)!.logicalId;
          let inserted = false;
          for (let i = 0; i < queue.length; i++) {
            if (nodeById.get(queue[i]!)!.logicalId.localeCompare(logicalId) > 0) {
              queue.splice(i, 0, neighbor);
              inserted = true;
              break;
            }
          }
          if (!inserted) queue.push(neighbor);
        }
      }
    }

    return order.map((id) => ({
      node: nodeById.get(id)!,
    }));
  }

  private async restoreNodeWithCompensation(
    entry: PlanEntry,
    rigId: string,
    snapshotId: string,
    data: SnapshotData,
    opts?: { adapters?: Record<string, import("./runtime-adapter.js").RuntimeAdapter>; fsOps?: { exists(path: string): boolean } },
    warnings?: string[],
  ): Promise<RestoreNodeResult> {
    const node = entry.node;
    const nodeId = node.id;

    // Consult live continuity state BEFORE clearing stale state
    if (node.podId) {
      const continuityRow = this.db.prepare(
        "SELECT status FROM continuity_state WHERE pod_id = ? AND node_id = ?"
      ).get(node.podId, nodeId) as { status: string } | undefined;
      if (continuityRow) {
        if (continuityRow.status === "restoring") {
          warnings?.push(`Node ${node.logicalId}: continuity state is 'restoring', skipping`);
          return { nodeId, logicalId: node.logicalId, status: "fresh" };
        }
        if (continuityRow.status === "degraded") {
          warnings?.push(`Node ${node.logicalId}: continuity state is 'degraded', proceeding with caution`);
        }
      }
    }

    // Capture prior state for compensation
    const priorState = this.captureNodeState(nodeId, rigId);

    // Clear stale state so NodeLauncher doesn't see already_bound
    this.clearStaleState(nodeId, rigId);

    // Derive canonical session name for pod-aware nodes
    const rig = this.rigRepo.getRig(rigId);
    let launchOpts: { sessionName?: string } | undefined;
    let expectedSessionName: string | undefined;
    if (node.podId && rig) {
      // Pod-aware: derive {pod}-{member}@{rigName} from node identity
      const parts = node.logicalId.split(".");
      if (parts.length >= 2) {
        const podPart = parts[0]!;
        const memberPart = parts.slice(1).join(".");
        const { deriveCanonicalSessionName, deriveSessionName } = await import("./session-name.js");
        expectedSessionName = deriveCanonicalSessionName(podPart, memberPart, rig.rig.name);
        launchOpts = { sessionName: expectedSessionName };
      }
    }
    if (!expectedSessionName && rig) {
      const { deriveSessionName } = await import("./session-name.js");
      expectedSessionName = deriveSessionName(rig.rig.name, node.logicalId);
    }

    // Write transcript boundary marker BEFORE launch (before pipe-pane attaches)
    // so the marker appears before any post-restore terminal output.
    // Uses "restore attempt" language — honest even if launch subsequently fails.
    if (this.transcriptStore?.enabled && rig && expectedSessionName) {
      const markerOk = this.transcriptStore.writeBoundaryMarker(
        rig.rig.name,
        expectedSessionName,
        `restore attempt from snapshot ${snapshotId}`,
      );
      if (!markerOk) {
        warnings?.push(`Transcript boundary marker failed for ${expectedSessionName}`);
      }
    }

    // Attempt launch — compensate ONLY if launch itself fails
    const launchResult = await this.nodeLauncher.launchNode(rigId, node.logicalId, launchOpts);
    if (!launchResult.ok) {
      // Launch failed — restore prior state (compensating action)
      this.restoreNodeState(nodeId, priorState);
      return {
        nodeId,
        logicalId: node.logicalId,
        status: "failed",
        error: launchResult.message,
      };
    }

    // Launch succeeded — do NOT compensate on post-launch failures
    // (the new session/binding are now the current state)

    // Propagate launch warnings (includes transcript attach failures)
    if (launchResult.warnings?.length) {
      warnings?.push(...launchResult.warnings);
    }

    return this.postLaunchRestore(entry, rigId, data, launchResult.sessionName, launchResult, opts, warnings);
  }

  private async postLaunchRestore(
    entry: PlanEntry,
    rigId: string,
    data: SnapshotData,
    sessionName: string,
    launchResult?: { ok: true; sessionName: string; session: import("./types.js").Session; binding: import("./types.js").Binding },
    opts?: { adapters?: Record<string, import("./runtime-adapter.js").RuntimeAdapter>; fsOps?: { exists(path: string): boolean } },
    warnings?: string[],
  ): Promise<RestoreNodeResult> {
    const node = entry.node;
    // Find the NEWEST session for this node. ULIDs are monotonic, so latest = max id.
    const nodeSessions = data.sessions.filter((s) => s.nodeId === node.id);
    const session = nodeSessions.length > 0
      ? nodeSessions.reduce((latest, s) => s.id > latest.id ? s : latest)
      : null;
    const checkpoint = data.checkpoints[node.id] ?? null;

    // Check restore policy
    const restorePolicy = session?.restorePolicy ?? "resume_if_possible";
    const resumeType = session?.resumeType ?? null;
    const resumeToken = session?.resumeToken ?? null;
    const resumeRequested = restorePolicy === "resume_if_possible" && !!resumeType && resumeType !== "none";

    let baseStatus: RestoreNodeResult["status"] = "fresh";

    // Pod-aware nodes: resume via launchHarness (handled in startup orchestrator with skipHarnessLaunch: false)
    // Legacy nodes: resume via old claude-resume/codex-resume helpers
    const isPodAware = !!node.podId;

    if (resumeRequested && !isPodAware) {
      // Legacy resume path
      if (!resumeToken) {
        return { nodeId: node.id, logicalId: node.logicalId, status: "failed", error: `Resume requested but no token available. Restore the node manually or launch fresh explicitly.` };
      } else {
        const resumeOutcome = await this.attemptResume(sessionName, resumeType, resumeToken, node.cwd ?? "/");
        if (resumeOutcome === "resumed") {
          baseStatus = "resumed";
        } else {
          return { nodeId: node.id, logicalId: node.logicalId, status: "failed", error: `Resume attempted but failed. Check the harness state manually or launch fresh explicitly.` };
        }
      }
    } else if (resumeRequested && isPodAware) {
      // Pod-aware restore must preserve the same honesty contract as legacy restore:
      // if resume was requested but continuity state is unavailable, fail loudly
      // instead of silently downgrading to a fresh launch with amnesia.
      if (!resumeToken) {
        return {
          nodeId: node.id,
          logicalId: node.logicalId,
          status: "failed",
          error: "Resume requested but no token available. Restore the node manually or launch fresh explicitly.",
        };
      }
    }

    // Checkpoint delivery (if not already resumed)
    if (baseStatus !== "resumed" && checkpoint) {
      if (!node.cwd) {
        return { nodeId: node.id, logicalId: node.logicalId, status: "failed", error: "Checkpoint available but node has no cwd" };
      }
      const written = this.writeCheckpointFile(node.cwd, checkpoint);
      if (written) {
        baseStatus = "rebuilt";
      } else {
        return { nodeId: node.id, logicalId: node.logicalId, status: "failed", error: "Checkpoint file write failed" };
      }
    }

    // Attempt restore-safe startup replay if context available
    if (data.nodeStartupContext && opts?.adapters && launchResult) {
      const startupCtx = data.nodeStartupContext[node.id];
      if (startupCtx) {
        const adapter = opts.adapters[startupCtx.runtime];
        if (adapter) {
          // Prefilter: check which files/entries still exist
          const existsFn = opts.fsOps?.exists ?? (() => true);
          const filteredEntries = startupCtx.projectionEntries.filter((e) => {
            if (!existsFn(e.absolutePath)) {
              warnings?.push(`Restore: missing projection entry ${e.absolutePath} (skipped)`);
              return false;
            }
            return true;
          });
          const filteredFiles = startupCtx.resolvedStartupFiles.filter((f) => {
            if (!existsFn(f.absolutePath)) {
              if (f.required) {
                warnings?.push(`Restore: missing REQUIRED startup file ${f.absolutePath}`);
                return false; // will cause failure below
              }
              warnings?.push(`Restore: missing optional startup file ${f.absolutePath} (skipped)`);
              return false;
            }
            return true;
          });

          // Check if any required files were dropped
          const missingRequired = startupCtx.resolvedStartupFiles.filter((f) => f.required && !existsFn(f.absolutePath));
          if (missingRequired.length > 0) {
            return { nodeId: node.id, logicalId: node.logicalId, status: "failed", error: `Missing required startup files: ${missingRequired.map((f) => f.path).join(", ")}` };
          }

          // Build fresh projection plan (all safe_projection)
          const plan: import("./projection-planner.js").ProjectionPlan = {
            runtime: startupCtx.runtime,
            cwd: node.cwd ?? ".",
            entries: filteredEntries.map((e) => ({
              ...e,
              classification: "safe_projection" as const,
              category: e.category as import("./projection-planner.js").ProjectionEntry["category"],
              mergeStrategy: e.mergeStrategy as import("./projection-planner.js").ProjectionEntry["mergeStrategy"],
            })),
            startup: { files: filteredFiles as import("./types.js").StartupFile[], actions: startupCtx.startupActions },
            conflicts: [],
            noOps: [],
            diagnostics: [],
          };

          const binding = {
            ...launchResult.binding,
            cwd: node.cwd ?? ".",
          };

          try {
            const { StartupOrchestrator } = await import("./startup-orchestrator.js");
            const startupOrch = new StartupOrchestrator({ db: this.db, sessionRegistry: this.sessionRegistry, eventBus: this.eventBus, tmuxAdapter: this.tmuxAdapter });
            const replayAsRestore = baseStatus !== "fresh";
            const shouldLaunchHarness = isPodAware;
            const startupResult = await startupOrch.startNode({
              rigId,
              nodeId: node.id,
              sessionId: launchResult.session.id,
              binding: binding as import("./runtime-adapter.js").NodeBinding,
              adapter,
              plan,
              resolvedStartupFiles: filteredFiles,
              startupActions: startupCtx.startupActions,
              isRestore: replayAsRestore,
              skipHarnessLaunch: !shouldLaunchHarness,
              resumeToken: (isPodAware && resumeRequested) ? resumeToken ?? undefined : undefined,
              sessionName: sessionName,
              allowFreshFallback: !(isPodAware && resumeRequested),
            });
            if (startupResult.ok) {
              const nativeContinuityProved = isPodAware
                && resumeRequested
                && this.launchedSessionMatchesSnapshotResume(launchResult.session.id, resumeType, resumeToken);
              if (isPodAware && resumeRequested && startupResult.continuityOutcome === "fresh" && !nativeContinuityProved) {
                return {
                  nodeId: node.id,
                  logicalId: node.logicalId,
                  status: "failed",
                  error: "Resume attempted but runtime reported fresh continuity. Launch fresh explicitly if that degradation is acceptable.",
                };
              }
              const finalStatus = (isPodAware && resumeRequested)
                ? ((startupResult.continuityOutcome === "resumed" || nativeContinuityProved) ? "resumed" : baseStatus)
                : baseStatus;
              return { nodeId: node.id, logicalId: node.logicalId, status: finalStatus };
            }
            if (isPodAware && resumeRequested) {
              return {
                nodeId: node.id,
                logicalId: node.logicalId,
                status: "failed",
                error: startupResult.errors.join("; "),
              };
            }
            warnings?.push(`Restore startup failed for ${node.logicalId}: ${startupResult.errors.join("; ")}`);
          } catch (err) {
            if (isPodAware && resumeRequested) {
              return {
                nodeId: node.id,
                logicalId: node.logicalId,
                status: "failed",
                error: `Restore startup error: ${(err as Error).message}`,
              };
            }
            warnings?.push(`Restore startup error for ${node.logicalId}: ${(err as Error).message}`);
          }
        }
      }
    }

    return { nodeId: node.id, logicalId: node.logicalId, status: baseStatus };
  }

  private launchedSessionMatchesSnapshotResume(
    sessionId: string,
    resumeType: string | null,
    resumeToken: string | null,
  ): boolean {
    if (!resumeType || !resumeToken) return false;
    const row = this.db.prepare("SELECT resume_type, resume_token FROM sessions WHERE id = ?").get(sessionId) as
      | { resume_type: string | null; resume_token: string | null }
      | undefined;
    if (!row?.resume_type || !row.resume_token) return false;
    return row.resume_type === resumeType && row.resume_token === resumeToken;
  }

  private async attemptResume(
    sessionName: string,
    resumeType: string,
    resumeToken: string | null,
    cwd: string
  ): Promise<"resumed" | "retry_fresh" | "failed"> {
    if (this.claudeResume.canResume(resumeType, resumeToken)) {
      const result = await this.claudeResume.resume(sessionName, resumeType, resumeToken, cwd);
      if (result.ok) return "resumed";
      return result.code === "retry_fresh" ? "retry_fresh" : "failed";
    }

    if (this.codexResume.canResume(resumeType, resumeToken)) {
      const result = await this.codexResume.resume(sessionName, resumeType, resumeToken, cwd);
      return result.ok ? "resumed" : "failed";
    }

    return "failed";
  }

  private writeCheckpointFile(cwd: string, checkpoint: Checkpoint): boolean {
    try {
      const filePath = join(cwd, ".rigged-checkpoint.md");
      const content = [
        "# OpenRig Checkpoint",
        "",
        `## Summary`,
        checkpoint.summary,
        "",
        checkpoint.currentTask ? `## Current Task\n${checkpoint.currentTask}\n` : "",
        checkpoint.nextStep ? `## Next Step\n${checkpoint.nextStep}\n` : "",
        checkpoint.blockedOn ? `## Blocked On\n${checkpoint.blockedOn}\n` : "",
        checkpoint.keyArtifacts.length > 0
          ? `## Key Artifacts\n${checkpoint.keyArtifacts.map((a) => `- ${a}`).join("\n")}\n`
          : "",
      ]
        .filter(Boolean)
        .join("\n");

      writeFileSync(filePath, content, "utf-8");
      return true;
    } catch {
      return false;
    }
  }
}

interface PlanEntry {
  node: NodeWithBinding;
}
