import type Database from "better-sqlite3";
import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { SnapshotCapture } from "./snapshot-capture.js";
import type { EventBus } from "./event-bus.js";
import { RigNotFoundError } from "./errors.js";
import type { ResumeMetadataRefresher } from "./resume-metadata-refresher.js";
import fs from "node:fs";
import nodePath from "node:path";
import { removeManagedBlocksFromFile, DEFAULT_CLAUDE_MANAGED_BLOCK_FILE } from "./managed-blocks.js";
import { stopTranscriptRotation } from "./transcript-rotation.js";
import { findOtherSessionOwner } from "./session-owner.js";

export interface TeardownResult {
  rigId: string;
  sessionsKilled: number;
  snapshotId: string | null;
  deleted: boolean;
  deleteBlocked: boolean;
  alreadyStopped: boolean;
  errors: string[];
}

interface TeardownOptions {
  delete?: boolean;
  /** Reserved for future graceful-stop support. Currently a no-op because
   *  tmux kill-session is already immediate — there is no graceful stop to skip. */
  force?: boolean;
  snapshot?: boolean;
}

interface TeardownDeps {
  db: Database.Database;
  rigRepo: RigRepository;
  sessionRegistry: SessionRegistry;
  tmuxAdapter: TmuxAdapter;
  snapshotCapture: SnapshotCapture;
  eventBus: EventBus;
  resumeMetadataRefresher?: ResumeMetadataRefresher;
  serviceOrchestrator?: import("./service-orchestrator.js").ServiceOrchestrator;
}

interface LatestNodeSession {
  nodeId: string;
  sessionId: string;
  sessionName: string;
  status: string;
  runtime: string | null;
  resumeType: string | null;
  resumeToken: string | null;
  cwd: string | null;
}

/**
 * Graceful rig shutdown. Kills tmux sessions, clears bindings, marks
 * sessions exited. Optionally snapshots before teardown, optionally
 * deletes rig record.
 */
export class RigTeardownOrchestrator {
  readonly db: Database.Database;
  private deps: TeardownDeps;

  constructor(deps: TeardownDeps) {
    if (deps.db !== deps.rigRepo.db) throw new Error("RigTeardownOrchestrator: rigRepo must share the same db handle");
    if (deps.db !== deps.sessionRegistry.db) throw new Error("RigTeardownOrchestrator: sessionRegistry must share the same db handle");
    if (deps.db !== deps.eventBus.db) throw new Error("RigTeardownOrchestrator: eventBus must share the same db handle");
    if (deps.db !== deps.snapshotCapture.db) throw new Error("RigTeardownOrchestrator: snapshotCapture must share the same db handle");
    this.db = deps.db;
    this.deps = deps;
  }

  async teardown(rigId: string, opts?: TeardownOptions): Promise<TeardownResult> {
    // 1. Validate rig
    const rig = this.deps.rigRepo.getRig(rigId);
    if (!rig) throw new RigNotFoundError(rigId);

    const guard = this.deps.tmuxAdapter.deliveryGuard;
    const ids = rig.nodes.map(node => node.id);
    if (guard && ids.some(id => !guard.ownsLifecycle(id))) return guard.lifecycle(ids, () => this.teardown(rigId, opts));
    const result: TeardownResult = {
      rigId, sessionsKilled: 0, snapshotId: null,
      deleted: false, deleteBlocked: false, alreadyStopped: false, errors: [],
    };
    const archived = this.db.prepare("SELECT archived_at FROM rigs WHERE id = ?").get(rigId) as { archived_at: string | null };
    // A live seat can create its guidance while teardown awaits tmux. Resolve
    // file identities only after those waits, immediately before each cleanup.
    const currentLiveGuidanceTargets = () => this.liveGuidanceTargets(rigId);

    // 2. Get latest session per node
    const liveSessions = this.getLatestLiveSessions(rigId);

    // 3. Check if already stopped
    if (liveSessions.length === 0) {
      this.cleanupManagedGuidanceFiles(rigId, currentLiveGuidanceTargets());
      result.alreadyStopped = true;
      // Still tear down services even if no agent sessions are running
      if (this.deps.serviceOrchestrator) {
        try {
          const serviceResult = await this.deps.serviceOrchestrator.teardown(rigId);
          if (!serviceResult.ok) result.errors.push(`Service teardown warning: ${serviceResult.error}`);
          else if (serviceResult.kept) result.errors.push(serviceResult.kept);
        } catch (err) {
          result.errors.push(`Service teardown warning: ${(err as Error).message}`);
        }
      }
      // Skip to delete if requested
      if (opts?.delete) {
        this.atomicDelete(rigId);
        result.deleted = true;
      } else {
        this.deps.eventBus.emit({ type: "rig.stopped", rigId });
      }
      return result;
    }

    // 4. Auto-snapshot before teardown (always, best-effort)
    try {
      if (this.deps.resumeMetadataRefresher) {
        // A live namesake cannot supply resume metadata for an archived row.
        // Keep that row's own token in the snapshot, just as the kill below
        // leaves the other owner's session alone.
        const refreshableSessions = archived.archived_at === null ? liveSessions : liveSessions.filter(
          session => findOtherSessionOwner(this.db, session.sessionName, session.nodeId, { ignoreArchived: true }) === null,
        );
        await this.deps.resumeMetadataRefresher.refresh(refreshableSessions);
      }
    } catch (err) {
      result.errors.push(`Resume metadata refresh failed: ${(err as Error).message}`);
    }
    // Discovery is best-effort; preserve the durable ledger even if it fails.
    try {
      const snap = this.deps.snapshotCapture.captureSnapshot(rigId, "auto-pre-down");
      result.snapshotId = snap.id;
    } catch (err) {
      result.errors.push(`Snapshot failed: ${(err as Error).message}`);
      // Best-effort — teardown proceeds even if snapshot fails
    }

    // 5. Kill each live session
    let killFailures = 0;
    for (const session of liveSessions) {
      // An archived rig may retain a stale row for a name now owned by a live rig.
      // That name cannot identify the archived rig's tmux session for a kill.
      const ownedByAnotherRig = archived.archived_at !== null && findOtherSessionOwner(
        this.db, session.sessionName, session.nodeId, { ignoreArchived: true },
      ) !== null;
      let absent = ownedByAnotherRig;
      if (!absent && this.deps.tmuxAdapter.probeSession) {
        try {
          const probe = await this.deps.tmuxAdapter.probeSession(session.sessionName);
          absent = probe.state === "absent";
          if (probe.state !== "present" && !absent) {
            result.errors.push(`Could not confirm session '${session.sessionName}' is absent: ${probe.state === "transport_unavailable" ? probe.cause : probe.state}`);
            killFailures++;
            continue;
          }
        } catch (err) {
          result.errors.push(`Could not check session '${session.sessionName}': ${(err as Error).message}`);
          killFailures++;
          continue;
        }
      }
      const killResult = absent ? { ok: false, code: "session_not_found" } :
        await this.deps.tmuxAdapter.killSession(session.sessionName);

      const missingSession = (killResult as { code?: string; message?: string }).code === "session_not_found" &&
        !/no server running/i.test((killResult as { message?: string }).message ?? "");
      if (killResult.ok || missingSession) {
        // Stop capture only when termination is confirmed. A failed kill leaves
        // the session running. An archived namesake leaves the live owner's
        // rotation intact even when its stale row is removed.
        if (!ownedByAnotherRig) stopTranscriptRotation(session.sessionName);
        // Success or already gone — update DB atomically
        this.atomicNodeCleanup(session);
        this.cleanupManagedGuidanceFileForNode(rigId, session.runtime, session.cwd, currentLiveGuidanceTargets());
        if (killResult.ok) result.sessionsKilled++;
      } else {
        // Real kill failure — don't update this node
        result.errors.push(`Kill failed for session '${session.sessionName}': ${(killResult as { message?: string }).message ?? "unknown"}`);
        killFailures++;
      }
    }
    this.cleanupManagedGuidanceFiles(rigId, currentLiveGuidanceTargets());

    // 5b. Tear down services if they exist
    if (this.deps.serviceOrchestrator) {
      try {
        const serviceResult = await this.deps.serviceOrchestrator.teardown(rigId);
        if (!serviceResult.ok) result.errors.push(`Service teardown warning: ${serviceResult.error}`);
        else if (serviceResult.kept) result.errors.push(serviceResult.kept);
      } catch (err) {
        result.errors.push(`Service teardown warning: ${(err as Error).message}`);
        // Best-effort — rig teardown continues
      }
    }

    // 6. Delete if requested (blocked by kill failures)
    if (opts?.delete) {
      if (killFailures > 0) {
        result.errors.push("Rig deletion blocked: some sessions could not be killed");
        result.deleted = false;
        result.deleteBlocked = true;
      } else {
        try {
          this.atomicDelete(rigId);
          result.deleted = true;
        } catch (err) {
          result.errors.push(`Rig deletion failed: ${(err as Error).message}`);
          result.deleted = false;
        }
      }
    } else {
      // Emit stopped event
      this.deps.eventBus.emit({ type: "rig.stopped", rigId });
    }

    return result;
  }

  /** Atomically mark session exited + clear binding + persist event */
  private atomicNodeCleanup(session: LatestNodeSession): void {
    const tx = this.db.transaction(() => {
      this.deps.sessionRegistry.updateStatus(session.sessionId, "exited");
      this.deps.sessionRegistry.clearBinding(session.nodeId);
    });
    tx();
  }

  /** Atomically delete rig + persist rig.deleted event */
  private atomicDelete(rigId: string): void {
    let persistedSeq = 0;
    let persistedAt = "";
    const tx = this.db.transaction(() => {
      const event = this.deps.eventBus.persistWithinTransaction({ type: "rig.deleted", rigId });
      persistedSeq = event.seq;
      persistedAt = event.createdAt;
      this.deps.rigRepo.deleteRig(rigId);
    });
    tx();
    this.deps.eventBus.notifySubscribers({
      type: "rig.deleted", rigId, seq: persistedSeq, createdAt: persistedAt,
    });
  }

  /** Get latest session per node, filtered to live statuses.
   *  OPR.0.4.3.20 FR-4 — delegates to the shared SessionRegistry method so the
   *  teardown pre-down path and the periodic/manual snapshot refresh share ONE query. */
  private getLatestLiveSessions(rigId: string): LatestNodeSession[] {
    return this.deps.sessionRegistry.getLatestLiveSessions(rigId);
  }

  private liveGuidanceTargets(rigId: string): Set<string> {
    const rows = this.db.prepare(`
      SELECT n.rig_id, n.runtime, n.cwd FROM nodes n
      JOIN rigs r ON r.id = n.rig_id
      WHERE r.archived_at IS NULL AND r.id <> ? AND n.cwd IS NOT NULL
    `).all(rigId) as Array<{ rig_id: string; runtime: string | null; cwd: string }>;
    const targets = new Set<string>();
    for (const row of rows) {
      const target = this.guidanceTargetPath(row.rig_id, row.runtime, row.cwd);
      if (target) targets.add(this.guidancePathKey(target));
    }
    // A failed kill or inconclusive probe leaves this rig's session live.
    // Its file may also be shared with a sibling that stopped successfully.
    for (const session of this.getLatestLiveSessions(rigId)) {
      const target = this.guidanceTargetPath(rigId, session.runtime, session.cwd);
      if (target) targets.add(this.guidancePathKey(target));
    }
    return targets;
  }

  private cleanupManagedGuidanceFiles(rigId: string, liveGuidanceTargets: ReadonlySet<string>): void {
    const rows = this.db.prepare(`
      SELECT DISTINCT runtime, cwd
      FROM nodes
      WHERE rig_id = ?
    `).all(rigId) as Array<{ runtime: string | null; cwd: string | null }>;
    for (const row of rows) {
      this.cleanupManagedGuidanceFileForNode(rigId, row.runtime, row.cwd, liveGuidanceTargets);
    }
  }

  private guidanceTargetPath(rigId: string, runtime: string | null, cwd: string | null): string | null {
    if (!runtime || !cwd) {
      return null;
    }
    // #25: clean only the rig's selected Claude file; the other file is never touched.
    return runtime === "claude-code"
      ? nodePath.join(cwd, this.deps.rigRepo.getRigClaudeManagedBlockFile(rigId) ?? DEFAULT_CLAUDE_MANAGED_BLOCK_FILE)
      : runtime === "codex"
        ? nodePath.join(cwd, "AGENTS.md")
        : null;
  }

  private guidancePathKey(path: string): string {
    const resolved = nodePath.resolve(path);
    try {
      const real = fs.realpathSync.native(resolved);
      const stat = fs.statSync(real);
      // File identity covers symlinks, hard links, and case aliases on a
      // case-insensitive volume without assuming all volumes behave alike.
      if (stat.ino !== 0) return `file:${stat.dev}:${stat.ino}`;
      return `path:${process.platform === "win32" ? real.toLowerCase() : real}`;
    } catch {
      // Cleanup is a no-op for a missing file; keep a stable path key for it.
      return `path:${process.platform === "win32" ? resolved.toLowerCase() : resolved}`;
    }
  }

  private cleanupManagedGuidanceFileForNode(rigId: string, runtime: string | null, cwd: string | null, liveGuidanceTargets: ReadonlySet<string>): void {
    const targetPath = this.guidanceTargetPath(rigId, runtime, cwd);
    if (!targetPath) {
      return;
    }
    if (liveGuidanceTargets.has(this.guidancePathKey(targetPath))) return;
    removeManagedBlocksFromFile({
      exists: (path) => fs.existsSync(path),
      readFile: (path) => fs.readFileSync(path, "utf-8"),
      writeFile: (path, content) => fs.writeFileSync(path, content, "utf-8"),
      deleteFile: (path) => fs.unlinkSync(path),
    }, targetPath);
  }
}
