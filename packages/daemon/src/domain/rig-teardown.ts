import type Database from "better-sqlite3";
import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import type { TmuxAdapter, SessionProbe } from "../adapters/tmux.js";
import type { SnapshotCapture } from "./snapshot-capture.js";
import type { EventBus } from "./event-bus.js";
import { RigNotFoundError } from "./errors.js";
import type { ResumeMetadataRefresher } from "./resume-metadata-refresher.js";
import fs from "node:fs";
import nodePath from "node:path";
import { removeManagedBlocksFromFile, DEFAULT_CLAUDE_MANAGED_BLOCK_FILE } from "./managed-blocks.js";
import { stopTranscriptRotation } from "./transcript-rotation.js";
import { findOtherSessionOwner } from "./session-owner.js";
import { cleanSeatSkills, seatSkillPaths } from "./seat-skill-storage.js";
import { settleAutomaticRestore } from "./existing-rig-restore.js";

export interface TeardownResult {
  rigId: string;
  sessionsKilled: number;
  snapshotId: string | null;
  deleted: boolean;
  deleteBlocked: boolean;
  alreadyStopped: boolean;
  errors: string[];
  /** OPR.0.7.0.13: team skill files left in seats' own storage because they were edited, or were never recorded as
   *  OpenRig's. Present only when something was kept. */
  keptSkills?: string[];
  /** Sessions of seats joined with `rig attach` as an external CLI, which down doesn't stop or check. Without --delete
   *  each keeps its claim as it was, whether or not the app still runs. Present only when there was one. */
  leftRunning?: string[];
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

/** Only a reported missing server permits a bootstrap; other unreadable/permission results do not. */
function isMissingTmuxServer(probe: SessionProbe): boolean {
  if (probe.state !== "transport_unavailable" || /permission denied|operation not permitted|EACCES|EPERM/i.test(probe.cause)) return false;
  return /no server running/i.test(probe.cause)
    || /(?:error connecting to|tmux-\d+)[^\n]*(?:No such file or directory|Connection refused)/i.test(probe.cause);
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
    // Daemon start may be restoring this rig (a kernel a reboot left down). A stop made meanwhile
    // waits, holding no lease, for that restore to return and then stops what it left, so the stop
    // wins either way; taking the leases first would bind to seats that restore then replaces.
    if (!guard || !ids.some(id => guard.ownsLifecycle(id))) await settleAutomaticRestore(this.db, rigId);
    if (guard && ids.some(id => !guard.ownsLifecycle(id))) return guard.lifecycle(ids, () => this.teardown(rigId, opts));
    const result: TeardownResult = {
      rigId, sessionsKilled: 0, snapshotId: null,
      deleted: false, deleteBlocked: false, alreadyStopped: false, errors: [],
    };
    const archived = this.db.prepare("SELECT archived_at FROM rigs WHERE id = ?").get(rigId) as { archived_at: string | null };
    // OPR.0.7.0.13: read the seats' storage keys now; a delete removes the node rows. Only a seat whose consumer is
    // confirmed gone has its skills cleaned (settledSkillSeats); the rest keep theirs.
    const skillSeats = rig.nodes.filter((node) => node.runtime === "claude-code" || node.runtime === "codex")
      .map((node) => ({ id: node.id, logicalId: node.logicalId, runtime: node.runtime as string }));
    // A live seat can create its guidance while teardown awaits tmux. Resolve
    // file identities only after those waits, immediately before each cleanup.
    const currentLiveGuidanceTargets = () => this.liveGuidanceTargets(rigId);

    // 2. Get latest session per node
    const liveSessions = this.getLatestLiveSessions(rigId);

    // 3. Check if already stopped
    if (liveSessions.length === 0) {
      // Additional intent is best-effort; keep down's existing result if it cannot be recorded.
      await this.recordAlreadyStoppedIntent(rigId).catch(() => {});
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
      // Read which seats are settled before a delete removes their session rows.
      const settled = this.settledSkillSeats(skillSeats);
      // Skip to delete if requested
      if (opts?.delete) {
        this.atomicDelete(rigId);
        result.deleted = true;
      } else {
        this.deps.eventBus.emit({ type: "rig.stopped", rigId });
      }
      this.cleanupSeatSkills(rigId, skillSeats, settled, result);
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
    const external = new Set<string>();
    for (const session of liveSessions) {
      // OpenRig neither launches nor stops a seat joined with `rig attach` as an external CLI, and it has no tmux session:
      // a missing one isn't a stop. Keep its claim, as the historical path below does for non-tmux bindings.
      if (this.deps.sessionRegistry.getBindingForNode(session.nodeId)?.attachmentType === "external_cli") {
        external.add(session.nodeId);
        (result.leftRunning ??= []).push(session.sessionName);
        continue;
      }
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
    // Stop live sessions before probing historical rows; bookkeeping must not fail down.
    await this.recordAlreadyStoppedIntent(rigId).catch(() => {});
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

    // Read which seats are settled before a delete removes their session rows.
    const settled = this.settledSkillSeats(skillSeats);
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

    this.cleanupSeatSkills(rigId, skillSeats, settled, result, external);
    return result;
  }

  /**
   * OPR.0.7.0.13: the seats whose consumer is confirmed gone: its latest session was confirmed stopped (this down killed
   * it or found it absent, or an earlier down did; both record the stop), or it never had a session. A running,
   * exited or detached row whose absence wasn't confirmed (a session still present, a probe unavailable or failing, no
   * probe at all) leaves the seat unsettled: a detached row doesn't prove the process is gone.
   */
  private settledSkillSeats(seats: ReadonlyArray<{ id: string }>): Set<string> {
    const settled = new Set<string>();
    const latest = this.db.prepare(`SELECT intentionally_stopped AS stopped FROM sessions WHERE node_id = ?
      ORDER BY created_at DESC, id DESC LIMIT 1`);
    for (const seat of seats) {
      try {
        const row = latest.get(seat.id) as { stopped: number } | undefined;
        if (!row || row.stopped === 1) settled.add(seat.id);
      } catch {}
    }
    return settled;
  }

  /** OPR.0.7.0.13: once a seat's consumer is confirmed gone, remove the unchanged skill files OpenRig wrote into its
   *  own storage and report what was kept. The records go only with the rig itself, so a restore can rebuild them. */
  private cleanupSeatSkills(rigId: string, seats: ReadonlyArray<{ id: string; logicalId: string; runtime: string }>, settled: ReadonlySet<string>, result: TeardownResult, external: ReadonlySet<string> = new Set()): void {
    const kept: string[] = [];
    for (const seat of seats) {
      // An external seat left running keeps its skills; leftRunning already says so.
      if (external.has(seat.id)) continue;
      if (!settled.has(seat.id)) {
        const paths = seatSkillPaths({ rigId, logicalId: seat.logicalId, runtime: seat.runtime });
        if (fs.existsSync(paths.root)) result.errors.push(`Seat skills for ${seat.logicalId} kept: its consumer isn't confirmed stopped`);
        continue;
      }
      try {
        const cleaned = cleanSeatSkills(seatSkillPaths({ rigId, logicalId: seat.logicalId, runtime: seat.runtime }), { dropRecords: result.deleted });
        kept.push(...cleaned.kept, ...cleaned.refused);
      } catch (err) {
        result.errors.push(`Seat skill cleanup for ${seat.logicalId}: ${(err as Error).message}`);
      }
    }
    if (kept.length > 0) result.keptSkills = kept;
  }

  /** Atomically record the supported stop and clear its binding. */
  private atomicNodeCleanup(session: Pick<LatestNodeSession, "sessionId" | "nodeId">): void {
    const tx = this.db.transaction(() => {
      this.deps.sessionRegistry.markIntentionallyStopped(session.sessionId);
      this.deps.sessionRegistry.clearBinding(session.nodeId);
    });
    tx();
  }

  /** An explicit down also covers already-detached seats, but neither a stale
   * row nor an unavailable probe proves that its session is absent. */
  private async recordAlreadyStoppedIntent(rigId: string): Promise<void> {
    const probe = this.deps.tmuxAdapter.probeSession;
    if (!probe) return;
    const eligible = this.db.prepare(`
      SELECT s.id, s.node_id, s.session_name FROM sessions s JOIN nodes n ON n.id = s.node_id
      WHERE n.rig_id = ? AND s.status IN ('exited', 'detached')
        AND s.intentionally_stopped = 0
        AND s.id = (SELECT latest.id FROM sessions latest WHERE latest.node_id = n.id
          ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1)
    `);
    for (const row of eligible.all(rigId) as Array<{ id: string; node_id: string; session_name: string }>) {
      const binding = this.deps.sessionRegistry.getBindingForNode(row.node_id);
      if (binding && (binding.attachmentType !== "tmux" || binding.tmuxSession !== row.session_name)) continue;
      const stillEligible = () => (eligible.all(rigId) as Array<{ id: string }>).some(current => current.id === row.id)
        && JSON.stringify(this.deps.sessionRegistry.getBindingForNode(row.node_id)) === JSON.stringify(binding);
      try {
        let observed = await probe.call(this.deps.tmuxAdapter, row.session_name);
        if (!stillEligible()) continue;
        if (isMissingTmuxServer(observed)) {
          // A reboot may have removed tmux's server/socket. Start only an empty server, then
          // demand positive session absence; transport_unavailable itself proves nothing.
          const started = await this.deps.tmuxAdapter.startServer();
          if (!stillEligible() || !started.ok) continue;
          observed = await probe.call(this.deps.tmuxAdapter, row.session_name);
          if (!stillEligible()) continue;
        }
        if (observed.state !== "absent") continue;
      } catch {
        continue;
      }
      this.db.transaction(() => {
        // Every await above can admit a new binding or latest session. Check again at the write.
        if (stillEligible()) {
          this.deps.sessionRegistry.markIntentionallyStopped(row.id);
          this.deps.sessionRegistry.clearBinding(row.node_id);
        }
      })();
    }
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
