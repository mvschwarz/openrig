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
  RestoreResult,
  RestoreNodeResult,
  SnapshotData,
  NodeWithBinding,
  Edge,
  Session,
  Checkpoint,
} from "./types.js";

// Only these edge kinds constrain launch order
const LAUNCH_DEPENDENCY_KINDS = new Set(["delegates_to", "spawned_by"]);

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

    if (this.hasRunningSessions(rigId)) {
      return { ok: false, code: "rig_not_stopped", message: `Rig ${rigId} must be stopped before restore` };
    }

    // Per-rig concurrency lock
    if (this.activeRestores.has(rigId)) {
      return { ok: false, code: "restore_in_progress", message: `Restore already in progress for rig ${rigId}` };
    }
    this.activeRestores.add(rigId);

    try {
      // 2. Capture pre-restore snapshot BEFORE any mutations
      const preRestoreSnapshot = this.snapshotCapture.captureSnapshot(rigId, "pre_restore");

      // 3. Emit restore.started
      this.eventBus.emit({ type: "restore.started", rigId, snapshotId });

      // 4. Compute restore plan
      const plan = this.computeRestorePlan(snapshot.data);

      // 5. Execute restore with compensating pattern per node
      const nodeResults: RestoreNodeResult[] = [];
      const restoreWarnings: string[] = [];
      for (const entry of plan) {
        const result = await this.restoreNodeWithCompensation(entry, rigId, snapshotId, snapshot.data, opts, restoreWarnings);
        nodeResults.push(result);
      }

      const restoreResult: RestoreResult = {
        snapshotId,
        preRestoreSnapshotId: preRestoreSnapshot.id,
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

  private captureNodeState(nodeId: string, rigId: string): { binding: import("./types.js").Binding | null; sessions: { id: string; status: string }[] } {
    const binding = this.sessionRegistry.getBindingForNode(nodeId);
    const sessions = this.sessionRegistry.getSessionsForRig(rigId)
      .filter((s) => s.nodeId === nodeId && s.status !== "superseded" && s.status !== "exited")
      .map((s) => ({ id: s.id, status: s.status }));
    return { binding, sessions };
  }

  private hasRunningSessions(rigId: string): boolean {
    const latestByNode = new Map<string, Session>();
    for (const session of this.sessionRegistry.getSessionsForRig(rigId)) {
      latestByNode.set(session.nodeId, session);
    }
    return Array.from(latestByNode.values()).some((session) => session.status === "running");
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

    let baseStatus: RestoreNodeResult["status"] = "fresh";

    // Pod-aware nodes: resume via launchHarness (handled in startup orchestrator with skipHarnessLaunch: false)
    // Legacy nodes: resume via old claude-resume/codex-resume helpers
    const isPodAware = !!node.podId;

    if (restorePolicy === "resume_if_possible" && resumeType && resumeType !== "none" && !isPodAware) {
      // Legacy resume path
      if (!resumeToken) {
        return { nodeId: node.id, logicalId: node.logicalId, status: "failed", error: `Resume requested but no token available. Restore the node manually or launch fresh with: rigged up` };
      }
      const resumed = await this.attemptResume(sessionName, resumeType, resumeToken, node.cwd ?? "/");
      if (resumed) {
        baseStatus = "resumed";
      } else {
        return { nodeId: node.id, logicalId: node.logicalId, status: "failed", error: `Resume attempted but failed. Check the harness state manually or launch fresh with: rigged up` };
      }
    } else if (restorePolicy === "resume_if_possible" && isPodAware) {
      // Pod-aware restore must preserve the same honesty contract as legacy restore:
      // if resume was requested but continuity state is unavailable, fail loudly
      // instead of silently downgrading to a fresh launch with amnesia.
      if (!resumeToken) {
        return {
          nodeId: node.id,
          logicalId: node.logicalId,
          status: "failed",
          error: "Resume requested but no token available. Restore the node manually or launch fresh with: rigged up",
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
            const startupResult = await startupOrch.startNode({
              rigId,
              nodeId: node.id,
              sessionId: launchResult.session.id,
              binding: binding as import("./runtime-adapter.js").NodeBinding,
              adapter,
              plan,
              resolvedStartupFiles: filteredFiles,
              startupActions: startupCtx.startupActions,
              isRestore: true,
              skipHarnessLaunch: !isPodAware, // Pod-aware: use launchHarness with resumeToken. Legacy: old helpers already handled.
              resumeToken: isPodAware ? resumeToken ?? undefined : undefined,
              sessionName: sessionName,
            });
            if (startupResult.ok) {
              // Pod-aware nodes with resume token: startup used launchHarness with the token → resumed
              const finalStatus = (isPodAware && resumeToken) ? "resumed" : baseStatus;
              return { nodeId: node.id, logicalId: node.logicalId, status: finalStatus };
            }
            if (isPodAware && resumeToken) {
              return {
                nodeId: node.id,
                logicalId: node.logicalId,
                status: "failed",
                error: startupResult.errors.join("; "),
              };
            }
            warnings?.push(`Restore startup failed for ${node.logicalId}: ${startupResult.errors.join("; ")}`);
          } catch (err) {
            if (isPodAware && resumeToken) {
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

  private async attemptResume(
    sessionName: string,
    resumeType: string,
    resumeToken: string | null,
    cwd: string
  ): Promise<boolean> {
    if (this.claudeResume.canResume(resumeType, resumeToken)) {
      const result = await this.claudeResume.resume(sessionName, resumeType, resumeToken, cwd);
      return result.ok;
    }

    if (this.codexResume.canResume(resumeType, resumeToken)) {
      const result = await this.codexResume.resume(sessionName, resumeType, resumeToken, cwd);
      return result.ok;
    }

    return false;
  }

  private writeCheckpointFile(cwd: string, checkpoint: Checkpoint): boolean {
    try {
      const filePath = join(cwd, ".rigged-checkpoint.md");
      const content = [
        "# Rigged Checkpoint",
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
