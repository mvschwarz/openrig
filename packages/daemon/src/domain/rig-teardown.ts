import type Database from "better-sqlite3";
import type { RigRepository } from "./rig-repository.js";
import type { SessionRegistry } from "./session-registry.js";
import { isMissingTmuxServer, probeShowsNoServer, type TmuxAdapter } from "../adapters/tmux.js";
import type { SnapshotCapture } from "./snapshot-capture.js";
import type { EventBus } from "./event-bus.js";
import { RigNotFoundError } from "./errors.js";
import type { ResumeMetadataRefresher } from "./resume-metadata-refresher.js";
import fs from "node:fs";
import nodePath from "node:path";
import { randomUUID } from "node:crypto";
import { removeManagedBlocksFromFile } from "./managed-blocks.js";
import { recordedGuidanceFile, seatGuidanceFile } from "./restore-guidance.js";
import { cleanupOwnedClaudeCwd } from "./claude-owned-settings.js";
import { stopTranscriptRotation } from "./transcript-rotation.js";
import { findOtherSessionOwner } from "./session-owner.js";
import { communityHarnessOf } from "./built-in-runtimes.js";
import { SEAT_SKILLS_BOOTSTRAP_BLOCK_ID, SEAT_SKILLS_BOOTSTRAP_LINE, cleanSeatSkills, seatSkillPaths } from "./seat-skill-storage.js";
import { settleAutomaticRestore } from "./existing-rig-restore.js";
import { resolveSeatKind, seatProcessOwner } from "./seat-kinds.js";
import { exitPaneRuntime, pinTerminal, runtimeExitStep, type RuntimeExitTiming } from "./runtime-exit.js";
import type { NativeProcessLister } from "./native-process-lineage.js";

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
  /** Managed guidance blocks left in a guidance file because a person edited them, as `<file>: <block id>`. Present
   *  only when something was kept. */
  keptGuidance?: string[];
  /** #875: files in a Claude seat's cwd that still hold OpenRig's additions because down couldn't safely change them
   *  (settings that don't parse, a collector that isn't the shipped one), as `<file>: <why>`. Present only when
   *  something was kept. */
  keptFiles?: string[];
  /** Claude seats whose latest launch recorded no folder (one started before launches recorded it), as
   *  `<session>: <saved folder>`: down can't tell whether it ran somewhere else. Present only when there was one. */
  launchFolderUnrecorded?: string[];
  /** Sessions of seats joined with `rig attach` as an external CLI, which down doesn't stop or check. Without --delete
   *  each keeps its claim as it was, whether or not the app still runs. Present only when there was one. */
  leftRunning?: string[];
  /** Sessions of community-harness seats whose pane was stopped. OpenRig stops only the pane; the harness's own
   *  processes (a gateway, say) may keep running, as its preset's limits say. Present only when there was one. */
  paneOnly?: string[];
  /** Sessions OpenRig didn't launch (joined with `rig attach --self`, adopted, bound or reconciled): down released each
   *  seat, as `rig unclaim` does, and left the session running as its owner's. A later down names a released session
   *  here too while it keeps the seat's skills for it. Present only when there was one. */
  released?: string[];
  /** #3901: what the step before the terminals close saw of each Claude Code or Codex seat's agent: `graceful`, it exited
   *  through its own shutdown (Claude Code on TERM, Codex through /exit) or no agent was left running; `forced`, it was
   *  seen to end on a signal it doesn't handle or on KILL after the window; `unverified`, its end wasn't seen (it couldn't
   *  be identified, its exit couldn't be checked, KILL wasn't sent, it was still running after KILL, or its pane's
   *  terminal had changed). `detail` says which, in a sentence. Each says only what this step saw: whether a terminal then
   *  closed is the stop's own result (`sessionsKilled`, `errors`). Absent with --force (the terminals close at once) and
   *  when no such seat was stopped. */
  runtimeExits?: Array<{ session: string; path: "graceful" | "forced" | "unverified"; detail: string }>;
}

interface TeardownOptions {
  delete?: boolean;
  /** Close the seats' terminals at once, without first letting each agent exit through its own shutdown (#3901). */
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
  /** The shipped Claude context collector. A cwd's copy is removed only while its bytes match this file. */
  claudeCollectorAssetPath?: string;
  /** Releases a claimed session's seat without stopping the session: `rig unclaim`'s own path. Absent: such a session
   *  goes through the marker-checked stop, as before. */
  releaseClaimedSession?: (sessionId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** #3901: the process table each agent's own exit is read from, and its bounded wait (tests); the OS's and 3 s by default. */
  listProcesses?: NativeProcessLister;
  runtimeExitTiming?: RuntimeExitTiming;
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
  communityHarness?: string | null;
  origin?: string | null;
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
      // A keep_alive seat's request can't wait for the probe below, which may prove nothing: the supervisor would bring
      // it back. A failure to record it doesn't stop the down, and is reported as the main path reports its own.
      try {
        this.db.transaction(() => this.requestDownedSeatsStop(rigId, randomUUID(), { keepAliveOnly: true }))();
      } catch (err) {
        result.errors.push(`Stop request could not be recorded for the keep_alive seats already down, so they may be relaunched: ${(err as Error).message}`);
      }
      await this.recordAlreadyStoppedIntent(rigId).catch(() => {});
      this.cleanupManagedGuidanceFiles(rigId, currentLiveGuidanceTargets(), result);
      this.cleanupClaudeCwds(rigId, result);
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
      const skillState = this.settledSkillSeats(skillSeats);
      // Skip to delete if requested
      if (opts?.delete) {
        this.atomicDelete(rigId);
        result.deleted = true;
      } else {
        this.deps.eventBus.emit({ type: "rig.stopped", rigId });
      }
      this.cleanupSeatSkills(rigId, skillSeats, skillState, result);
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

    // #2940: `rig down` means stay down, also for a seat it selected but hasn't reached yet, or if the daemon is lost
    // midway. Before the first kill, one transaction records the stop request on every launched session it selected,
    // and on each seat that is already down (requestDownedSeatsStop). External and claimed sessions are their owners'
    // and are left out. A kill that doesn't complete keeps the request; the next down, or the startup reconcile once
    // the session is gone, confirms it.
    const downAttempt = randomUUID();
    try {
      this.db.transaction(() => {
        for (const session of liveSessions) {
          if (session.origin === "claimed") continue;
          if (seatProcessOwner(resolveSeatKind(this.deps.sessionRegistry.getBindingForNode(session.nodeId)?.attachmentType)) === "external") continue;
          this.deps.sessionRegistry.requestStop(session.sessionId, downAttempt);
        }
        this.requestDownedSeatsStop(rigId, downAttempt);
      })();
    } catch (err) {
      // Without the request recorded, a kill followed by a lost daemon would read as a fall: nothing is stopped.
      result.errors.push(`Stop request could not be recorded before the kills, so nothing was stopped: ${(err as Error).message}`);
      return result;
    }

    // #3901: before the terminals close, each Claude Code or Codex seat's agent exits through its own shutdown (Claude Code
    // on TERM, Codex through /exit), all seats at once, each wait bounded, with KILL at the end of its window. Closing the
    // terminals below is still what stops everything, whatever happened here. --force skips this step.
    if (!opts?.force) {
      const exits = await this.exitSeatRuntimes(liveSessions, archived.archived_at !== null);
      if (exits.length > 0) result.runtimeExits = exits;
    }

    // 5. Kill each live session
    let killFailures = 0;
    const external = new Set<string>();
    const toRelease: LatestNodeSession[] = [];
    for (const session of liveSessions) {
      const disposition = this.downDisposition(session, archived.archived_at !== null);
      // OpenRig neither launches nor stops a seat joined with `rig attach` as an external CLI, and it has no tmux session:
      // a missing one isn't a stop. Keep its claim, as the historical path below does for non-tmux bindings.
      if (disposition === "external") {
        external.add(session.nodeId);
        (result.leftRunning ??= []).push(session.sessionName);
        continue;
      }
      const ownedByAnotherRig = disposition === "another_rig";
      // A claimed session is released, unless it's positively gone, after the file cleanups below have counted the seat
      // as still in use.
      const release = disposition === "release";
      let absent = ownedByAnotherRig;
      if (!absent && this.deps.tmuxAdapter.probeSession) {
        try {
          const probe = await this.deps.tmuxAdapter.probeSession(session.sessionName);
          // This is the daemon's own tmux namespace, as in the import guard; a missing socket file is not enough.
          absent = probe.state === "absent" || probeShowsNoServer(probe);
          if (probe.state !== "present" && !absent && !release) {
            result.errors.push(`Could not confirm session '${session.sessionName}' is absent: ${probe.state === "transport_unavailable" ? probe.cause : probe.state}`);
            killFailures++;
            continue;
          }
        } catch (err) {
          if (!release) {
            result.errors.push(`Could not check session '${session.sessionName}': ${(err as Error).message}`);
            killFailures++;
            continue;
          }
        }
      }
      if (release && !absent) {
        toRelease.push(session);
        continue;
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
        this.atomicNodeCleanup(session, { ownedByAnotherRig });
        this.cleanupManagedGuidanceFileForNode(rigId, session.runtime, session.cwd, currentLiveGuidanceTargets(), result, session.nodeId);
        if (killResult.ok) result.sessionsKilled++;
        if (killResult.ok && communityHarnessOf(session.communityHarness, session.runtime)) (result.paneOnly ??= []).push(session.sessionName);
      } else {
        // Real kill failure — don't update this node
        result.errors.push(`Kill failed for session '${session.sessionName}': ${(killResult as { message?: string }).message ?? "unknown"}`);
        killFailures++;
      }
    }
    // Stop live sessions before probing historical rows; bookkeeping must not fail down.
    await this.recordAlreadyStoppedIntent(rigId).catch(() => {});
    this.cleanupManagedGuidanceFiles(rigId, currentLiveGuidanceTargets(), result);
    this.cleanupClaudeCwds(rigId, result);

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

    for (const session of toRelease) {
      const released = await this.deps.releaseClaimedSession!(session.sessionId);
      if (released.ok) {
        external.add(session.nodeId);
        (result.released ??= []).push(session.sessionName);
      } else {
        result.errors.push(`Release failed for session '${session.sessionName}': ${released.error}`);
        killFailures++;
      }
    }

    // Read which seats are settled before a delete removes their session rows.
    const skillState = this.settledSkillSeats(skillSeats);
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

    this.cleanupSeatSkills(rigId, skillSeats, skillState, result, external);
    return result;
  }

  /**
   * OPR.0.7.0.13: the seats whose consumer is confirmed gone: its latest session was confirmed stopped (this down killed
   * it or found it absent, or an earlier down did; both record the stop), or it never had a session. A running,
   * exited or detached row whose absence wasn't confirmed (a session still present, a probe unavailable or failing, no
   * probe at all) leaves the seat unsettled: a detached row doesn't prove the process is gone. So does any released
   * session (claimed, then detached) whose stop isn't recorded, latest or not: it may still run and hold the seat's
   * skill catalog. A seat held only by such sessions (its latest is recorded stopped or is one of them) maps to their
   * names in `heldByReleased`.
   */
  private settledSkillSeats(seats: ReadonlyArray<{ id: string }>): { settled: Set<string>; heldByReleased: Map<string, string[]> } {
    const settled = new Set<string>();
    const heldByReleased = new Map<string, string[]>();
    // #2940: confirmed, not only requested: a pending stop's session may still be running and using its skills. A request
    // still carrying its attempt is pending, also on a row that already read exited or superseded when it was recorded.
    const latest = this.db.prepare(`SELECT s.id, (s.intentionally_stopped = 1 AND s.stop_attempt IS NULL AND s.status IN ('exited', 'superseded')
        AND NOT EXISTS (SELECT 1 FROM bindings b WHERE b.node_id = s.node_id)) AS stopped
      FROM sessions s WHERE s.node_id = ? ORDER BY s.created_at DESC, s.id DESC LIMIT 1`);
    const released = this.db.prepare(`SELECT id, session_name AS name FROM sessions WHERE node_id = ? AND origin = 'claimed'
      AND status = 'detached' AND intentionally_stopped = 0 ORDER BY created_at, id`);
    for (const seat of seats) {
      try {
        const row = latest.get(seat.id) as { id: string; stopped: number } | undefined;
        const held = released.all(seat.id) as Array<{ id: string; name: string }>;
        const latestSettled = !row || row.stopped === 1;
        if (held.length === 0) {
          if (latestSettled) settled.add(seat.id);
        } else if (latestSettled || held.some((session) => session.id === row?.id)) {
          heldByReleased.set(seat.id, held.map((session) => session.name));
        }
      } catch {}
    }
    return { settled, heldByReleased };
  }

  /** OPR.0.7.0.13: once a seat's consumer is confirmed gone, remove the unchanged skill files OpenRig wrote into its
   *  own storage and report what was kept. The records go only with the rig itself, so a restore can rebuild them. */
  private cleanupSeatSkills(rigId: string, seats: ReadonlyArray<{ id: string; logicalId: string; runtime: string }>, { settled, heldByReleased }: { settled: ReadonlySet<string>; heldByReleased: ReadonlyMap<string, string[]> }, result: TeardownResult, external: ReadonlySet<string> = new Set()): void {
    const kept: string[] = [];
    for (const seat of seats) {
      // An external seat left running keeps its skills; leftRunning already says so.
      if (external.has(seat.id)) continue;
      if (!settled.has(seat.id)) {
        const paths = seatSkillPaths({ rigId, logicalId: seat.logicalId, runtime: seat.runtime });
        if (!fs.existsSync(paths.root)) continue;
        const held = heldByReleased.get(seat.id);
        if (!held) {
          result.errors.push(`Seat skills for ${seat.logicalId} kept: its consumer isn't confirmed stopped`);
          continue;
        }
        // Only released sessions hold it: each is its owner's, so its skills are kept and released names it, as the
        // down that released it did.
        for (const name of held) if (!result.released?.includes(name)) (result.released ??= []).push(name);
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

  /** Atomically record the supported stop and clear its binding. The stop event is skipped for
   *  an archived rig's stale row whose name a live rig now owns (#3173 round 5): the transcript
   *  subscriber stops rotation by session name alone, so the shared-name event would end a live
   *  seat's capture — and a stale row needs no cold-start attribution. */
  private atomicNodeCleanup(session: Pick<LatestNodeSession, "sessionId" | "nodeId" | "sessionName">, opts?: { ownedByAnotherRig?: boolean }): void {
    const tx = this.db.transaction(() => {
      this.deps.sessionRegistry.markIntentionallyStopped(session.sessionId);
      if (!opts?.ownedByAnotherRig) {
        const node = this.db.prepare("SELECT rig_id FROM nodes WHERE id = ?").get(session.nodeId) as { rig_id: string };
        this.deps.eventBus.persistWithinTransaction({ type: "session.stopped", rigId: node.rig_id,
          nodeId: session.nodeId, sessionId: session.sessionId, sessionName: session.sessionName,
          operator: "rig-teardown", reason: "rig_down" });
      }
      this.deps.sessionRegistry.clearBinding(session.nodeId);
    });
    tx();
  }

  /** #2940: a seat that is already down stays down too. Its latest launched session (detached when it fell, superseded
   * when a relaunch attempt was rolled back, or exited without a stop) gets the request, keeping its status, before
   * anything else, so neither a daemon lost midway nor a probe that proves nothing lets keep_alive bring it back.
   * Claimed and external sessions are their owners'. recordAlreadyStoppedIntent confirms the stop later. With
   * keepAliveOnly (a down with nothing live to kill), only keep_alive seats get it ahead of the probe; the others keep
   * waiting for the probe's proof, as before. A request on an exited or superseded row is pending, not a confirmed stop,
   * until that probe proves the session absent. */
  private requestDownedSeatsStop(rigId: string, attemptId: string, opts?: { keepAliveOnly?: boolean }): void {
    const downed = this.db.prepare(`
      SELECT s.id, s.node_id, s.status, ${this.hasKeepAliveColumn() ? "n.keep_alive" : "0"} AS keep_alive
      FROM sessions s JOIN nodes n ON n.id = s.node_id
      WHERE n.rig_id = ? AND s.status IN ('detached', 'superseded', 'exited') AND s.origin = 'launched'
        AND s.intentionally_stopped = 0
        AND s.id = (SELECT latest.id FROM sessions latest WHERE latest.node_id = n.id
          ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1)
    `).all(rigId) as Array<{ id: string; node_id: string; status: string; keep_alive: number | null }>;
    for (const row of downed) {
      if (opts?.keepAliveOnly && row.keep_alive !== 1) continue;
      // A seat without keep_alive can't be relaunched behind the down, so only its detached row is requested here; its
      // exited or superseded row keeps waiting for the probe's proof of absence (recordAlreadyStoppedIntent), as before.
      if (row.keep_alive !== 1 && row.status !== "detached") continue;
      if (seatProcessOwner(resolveSeatKind(this.deps.sessionRegistry.getBindingForNode(row.node_id)?.attachmentType)) === "external") continue;
      this.deps.sessionRegistry.requestStop(row.id, attemptId);
    }
  }

  private hasKeepAliveColumn(): boolean {
    return this.db.prepare("PRAGMA table_info(nodes)").all().some((row) => (row as { name?: string }).name === "keep_alive");
  }

  /** An explicit down also covers already-detached seats, and a failed start's rolled-back (superseded) session,
   * but neither a stale row nor an unavailable probe proves that its session is absent. A requested stop that isn't
   * confirmed yet (its attempt still set, its status still detached, or its binding still there) is checked again. */
  private async recordAlreadyStoppedIntent(rigId: string): Promise<void> {
    const probe = this.deps.tmuxAdapter.probeSession;
    if (!probe) return;
    const eligible = this.db.prepare(`
      SELECT s.id, s.node_id, s.session_name, s.status FROM sessions s JOIN nodes n ON n.id = s.node_id
      WHERE n.rig_id = ? AND s.status IN ('exited', 'detached', 'superseded')
        AND (s.intentionally_stopped = 0 OR s.stop_attempt IS NOT NULL OR s.status = 'detached'
          OR EXISTS (SELECT 1 FROM bindings b WHERE b.node_id = n.id)
          OR EXISTS (
            SELECT 1 FROM events e WHERE e.node_id = s.node_id AND e.type = 'session.stopped'
              AND json_extract(e.payload, '$.sessionId') = s.id
              AND json_extract(e.payload, '$.operator') = 'daemon:seat-reaper'
              AND json_extract(e.payload, '$.reason') = 'idle_reap'
              AND e.seq = (SELECT MAX(last.seq) FROM events last
                WHERE last.node_id = s.node_id AND last.type = 'session.stopped')
          ))
        AND s.id = (SELECT latest.id FROM sessions latest WHERE latest.node_id = n.id
          ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1)
    `);
    for (const row of eligible.all(rigId) as Array<{ id: string; node_id: string; session_name: string; status: string }>) {
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
          // A superseded row stays superseded: restore skips it and keeps reading the seat's own history.
          if (row.status === "superseded") this.deps.sessionRegistry.recordStopIntent(row.id);
          else this.deps.sessionRegistry.markIntentionallyStopped(row.id);
          this.deps.eventBus.persistWithinTransaction({ type: "session.stopped", rigId,
            nodeId: row.node_id, sessionId: row.id, sessionName: row.session_name,
            operator: "rig-teardown", reason: "rig_down" });
          this.deps.sessionRegistry.clearBinding(row.node_id);
        }
      })();
    }
    // A released session that's no longer its seat's latest (the seat bound or launched another since) stays its
    // owner's until tmux reports it absent; then its stop is recorded. The seat's binding belongs to its latest
    // session, so it's left alone, and the row keeps its status.
    const earlier = this.db.prepare(`
      SELECT s.id, s.session_name FROM sessions s JOIN nodes n ON n.id = s.node_id
      WHERE n.rig_id = ? AND s.origin = 'claimed' AND s.status = 'detached' AND s.intentionally_stopped = 0
        AND s.id <> (SELECT latest.id FROM sessions latest WHERE latest.node_id = n.id
          ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1)
    `).all(rigId) as Array<{ id: string; session_name: string }>;
    for (const row of earlier) {
      try {
        let observed = await probe.call(this.deps.tmuxAdapter, row.session_name);
        if (isMissingTmuxServer(observed)) {
          if (!(await this.deps.tmuxAdapter.startServer()).ok) continue;
          observed = await probe.call(this.deps.tmuxAdapter, row.session_name);
        }
        if (observed.state === "absent") this.deps.sessionRegistry.recordStopIntent(row.id);
      } catch {
        // Unknown: the session stays in use.
      }
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

  /** Which way `rig down` ends a live session: `external` (joined with `rig attach` as an external CLI: left running),
   *  `another_rig` (an archived rig's stale row for a name a live rig owns now: recorded stopped, never killed),
   *  `release` (a session OpenRig didn't launch: released as `rig unclaim` does) or `stop` (the marker-checked kill). The
   *  kill loop and #3901's exit step read it from here, so the exit step only ever reaches a session the kill would end. */
  private downDisposition(session: LatestNodeSession, archivedRig: boolean): "external" | "another_rig" | "release" | "stop" {
    if (seatProcessOwner(resolveSeatKind(this.deps.sessionRegistry.getBindingForNode(session.nodeId)?.attachmentType)) === "external") return "external";
    // An archived rig may retain a stale row for a name now owned by a live rig. That name cannot identify the archived
    // rig's tmux session for a kill.
    if (archivedRig && findOtherSessionOwner(this.db, session.sessionName, session.nodeId, { ignoreArchived: true }) !== null) return "another_rig";
    // A session OpenRig didn't launch (origin claimed: joined with rig attach --self, adopted, bound or reconciled) is its
    // owner's, whatever marker it carries, so down never stops it. Without the release path (older wiring), it goes
    // through the marker-checked stop, as before.
    if (session.origin === "claimed" && this.deps.releaseClaimedSession !== undefined) return "release";
    return "stop";
  }

  /** #3901: let each seat's agent exit through its own shutdown before its terminal closes. Only a session the kill below
   *  would end is touched (downDisposition), with the proof the kill itself uses (killSession): the pane's session, read
   *  with its immutable id and its tmux server (pid and start time) in one read, carries the seat's OpenRig marker, read
   *  by that id, and each signal and typed input after is held to that session and server. An entry says only what this step saw of the
   *  agent; whether its terminal then closed is the kill's own result (sessionsKilled, errors). A failure here never
   *  stops the down. */
  private async exitSeatRuntimes(sessions: LatestNodeSession[], archivedRig: boolean): Promise<NonNullable<TeardownResult["runtimeExits"]>> {
    const tmux = this.deps.tmuxAdapter;
    if (typeof tmux.signalPaneRuntime !== "function" || typeof tmux.paneTerminal !== "function") return [];
    const timing = this.deps.runtimeExitTiming ?? { pollMs: 100, timeoutMs: 3_000, sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) };
    const exits = await Promise.all(sessions.map(async (session): Promise<NonNullable<TeardownResult["runtimeExits"]>[number] | null> => {
      if (!runtimeExitStep(session.runtime) || this.downDisposition(session, archivedRig) !== "stop") return null;
      const binding = this.deps.sessionRegistry.getBindingForNode(session.nodeId);
      if (!binding?.tmuxPane || binding.tmuxSession !== session.sessionName) return null;
      try {
        // An unreadable terminal or marker (a session already gone, say) leaves the seat to the stop below, which reports it.
        const terminal = await tmux.paneTerminal(binding.tmuxPane);
        if (!terminal || terminal.sessionName !== session.sessionName) return null;
        const marker = await tmux.getSessionEnv(terminal.sessionId, "OPENRIG_NODE_ID").catch(() => null);
        if (marker !== session.nodeId) return null;
        const outcome = await exitPaneRuntime(tmux, { pane: binding.tmuxPane, inputTarget: tmux.deliveryGuard ? session.nodeId : binding.tmuxPane,
          runtime: session.runtime, pin: pinTerminal(tmux, terminal) }, timing, this.deps.listProcesses);
        if (!outcome) return null;
        const at = { session: session.sessionName };
        if (outcome.state === "exited") return { ...at, path: outcome.path, detail: outcome.detail };
        if (outcome.state === "no_runtime") return { ...at, path: "graceful", detail: outcome.detail };
        // Not identified, not verified, still running after KILL, or its terminal changed: this step didn't see it end.
        return { ...at, path: "unverified", detail: outcome.detail };
      } catch (err) {
        return { session: session.sessionName, path: "unverified", detail: `Its agent's own exit couldn't be run: ${(err as Error).message}` };
      }
    }));
    return exits.filter((exit): exit is NonNullable<typeof exit> => exit !== null);
  }

  /** Get latest session per node, filtered to live statuses.
   *  OPR.0.4.3.20 FR-4 — delegates to the shared SessionRegistry method so the
   *  teardown pre-down path and the periodic/manual snapshot refresh share ONE query. */
  private getLatestLiveSessions(rigId: string): LatestNodeSession[] {
    return this.deps.sessionRegistry.getLatestLiveSessions(rigId);
  }

  /** This rig's seats whose files may still be in use: each live session, each released one, each seat whose latest
   *  session reads detached, with or without a stop request (#2940: a request isn't a confirmed stop), and each seat
   *  whose latest session's stop is still pending, whatever it reads (a request recorded on a row that already read
   *  exited or superseded). A released session (claimed, then detached by rig unclaim or down) is its owner's and may
   *  still be running, whether or not it's still its seat's latest. A detached latest session, or one whose stop is
   *  pending, may still be running too (this server didn't show it gone), as settledSkillSeats also holds. Their folders
   *  stay in use until recordAlreadyStoppedIntent sees tmux report the session absent and records the stop. */
  private seatsInUse(rigId: string): Array<Pick<LatestNodeSession, "nodeId" | "runtime" | "cwd"> & { launchedCwd: string | null }> {
    const released = this.db.prepare(`
      SELECT n.id AS nodeId, n.runtime, n.cwd, s.id AS sessionId FROM nodes n JOIN sessions s ON s.node_id = n.id
      WHERE n.rig_id = ?
        AND ((s.status = 'detached' AND s.origin = 'claimed' AND s.intentionally_stopped = 0)
          OR (s.id = (SELECT latest.id FROM sessions latest WHERE latest.node_id = n.id
                ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1)
            AND (s.status = 'detached' OR (s.stop_attempt IS NOT NULL AND s.status NOT IN ('running', 'idle', 'unknown')))))
    `).all(rigId) as Array<Pick<LatestNodeSession, "nodeId" | "runtime" | "cwd" | "sessionId">>;
    return [...this.getLatestLiveSessions(rigId), ...released]
      .map((session) => ({ ...session, launchedCwd: this.launchedCwdOf(session.sessionId) }));
  }

  /** The folder a session was launched in, as its launch recorded it; null when none was (a database from before the
   *  record, or a session OpenRig didn't launch). */
  private launchedCwdOf(sessionId: string): string | null {
    try {
      return (this.db.prepare("SELECT launched_cwd FROM sessions WHERE id = ?").get(sessionId) as { launched_cwd: string | null } | undefined)?.launched_cwd ?? null;
    } catch { return null; }
  }

  private liveGuidanceTargets(rigId: string): Set<string> {
    const rows = this.db.prepare(`
      SELECT n.id, n.rig_id, n.runtime, n.cwd FROM nodes n
      JOIN rigs r ON r.id = n.rig_id
      WHERE r.archived_at IS NULL AND r.id <> ? AND n.cwd IS NOT NULL
    `).all(rigId) as Array<{ id: string; rig_id: string; runtime: string | null; cwd: string }>;
    const targets = new Set<string>();
    for (const row of rows) {
      const target = this.guidanceTargetPath(row.rig_id, row.runtime, row.cwd, row.id);
      if (target) targets.add(this.guidancePathKey(target));
    }
    // A failed kill or inconclusive probe leaves this rig's session live, and a released one stays its owner's.
    // Its file may also be shared with a sibling that stopped successfully.
    for (const session of this.seatsInUse(rigId)) {
      const target = this.guidanceTargetPath(rigId, session.runtime, session.cwd, session.nodeId);
      if (target) targets.add(this.guidancePathKey(target));
    }
    return targets;
  }

  private cleanupManagedGuidanceFiles(rigId: string, liveGuidanceTargets: ReadonlySet<string>, result: TeardownResult): void {
    const rows = this.db.prepare(`
      SELECT id, runtime, cwd
      FROM nodes
      WHERE rig_id = ?
    `).all(rigId) as Array<{ id: string; runtime: string | null; cwd: string | null }>;
    for (const row of rows) {
      this.cleanupManagedGuidanceFileForNode(rigId, row.runtime, row.cwd, liveGuidanceTargets, result, row.id);
    }
  }

  /** #875: take OpenRig's Claude collector, status line and relay hooks back out of each of this rig's Claude cwds that
   *  no seat still uses, and report what had to be kept. */
  private cleanupClaudeCwds(rigId: string, result: TeardownResult): void {
    const rows = this.db.prepare(`
      SELECT DISTINCT cwd FROM nodes WHERE rig_id = ? AND runtime = 'claude-code' AND cwd IS NOT NULL
    `).all(rigId) as Array<{ cwd: string }>;
    // Each saved folder, and each folder a launch of this rig's Claude seats recorded: a run's own `--cwd` (#3347) too.
    const cwds = [...rows.map((row) => row.cwd), ...this.launchedClaudeCwds(rigId)];
    this.reportUnrecordedLaunchFolders(rigId, result);
    if (cwds.length === 0) return;
    const inUse = this.claudeTargetsInUse(rigId);
    const done = new Set<string>();
    for (const cwd of cwds) {
      const key = this.guidancePathKey(cwd);
      if (inUse.has(key) || done.has(key)) continue;
      done.add(key); // one cleanup per directory, however many of this rig's seats name it
      try {
        const isShared = (path: string) => inUse.has(this.guidancePathKey(path));
        for (const entry of cleanupOwnedClaudeCwd(cwd, this.deps.claudeCollectorAssetPath, isShared)) {
          if (!result.keptFiles?.includes(entry)) (result.keptFiles ??= []).push(entry);
        }
      } catch (err) {
        result.errors.push(`Claude settings cleanup in ${cwd}: ${(err as Error).message}`);
      }
    }
  }

  /** The folders this rig's Claude sessions recorded as launched in. A database from before the record has none. */
  private launchedClaudeCwds(rigId: string): string[] {
    try {
      return (this.db.prepare(`
        SELECT DISTINCT s.launched_cwd AS cwd FROM sessions s JOIN nodes n ON n.id = s.node_id
        WHERE n.rig_id = ? AND n.runtime = 'claude-code' AND s.launched_cwd IS NOT NULL
      `).all(rigId) as Array<{ cwd: string }>).map((row) => row.cwd);
    } catch { return []; }
  }

  /** A Claude seat whose latest session OpenRig launched without recording its folder (before the record) may have run
   *  elsewhere than its saved folder; down names it rather than guess. A database from before the record names none. */
  private reportUnrecordedLaunchFolders(rigId: string, result: TeardownResult): void {
    let rows: Array<{ sessionName: string; cwd: string | null }>;
    try {
      rows = this.db.prepare(`
        SELECT s.session_name AS sessionName, n.cwd FROM nodes n JOIN sessions s ON s.node_id = n.id
        WHERE n.rig_id = ? AND n.runtime = 'claude-code' AND s.launched_cwd IS NULL AND COALESCE(s.origin, '') <> 'claimed'
          AND s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = n.id ORDER BY s2.created_at DESC, s2.id DESC LIMIT 1)
      `).all(rigId) as Array<{ sessionName: string; cwd: string | null }>;
    } catch { return; }
    for (const row of rows) {
      const entry = `${row.sessionName}: ${row.cwd ?? "no saved folder"}`;
      if (!result.launchFolderUnrecorded?.includes(entry)) (result.launchFolderUnrecorded ??= []).push(entry);
    }
  }

  /** What a Claude seat may still use, by the same rule as guidance files: the cwd of a Claude seat of any other rig that
   *  isn't archived, or of one of this rig's Claude seats still live (a failed stop, an inconclusive probe, an attached
   *  CLI) or released and not seen gone. Each cwd's settings file, collector, `.claude` and `.openrig` are keyed by
   *  their own identity too, so a target another directory reaches through a symlink or a hardlink counts as in use. */
  private claudeTargetsInUse(rigId: string): Set<string> {
    const rows = this.db.prepare(`
      SELECT n.cwd FROM nodes n
      JOIN rigs r ON r.id = n.rig_id
      WHERE r.archived_at IS NULL AND r.id <> ? AND n.runtime = 'claude-code' AND n.cwd IS NOT NULL
    `).all(rigId) as Array<{ cwd: string }>;
    const cwds = rows.map((row) => row.cwd);
    // Where another rig's Claude seat last launched, and where this rig's still-live seats were launched: a run's own
    // `--cwd` counts as theirs, like a saved folder.
    try {
      cwds.push(...(this.db.prepare(`
        SELECT s.launched_cwd AS cwd FROM nodes n JOIN rigs r ON r.id = n.rig_id JOIN sessions s ON s.node_id = n.id
        WHERE r.archived_at IS NULL AND r.id <> ? AND n.runtime = 'claude-code' AND s.launched_cwd IS NOT NULL
          AND s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = n.id ORDER BY s2.created_at DESC, s2.id DESC LIMIT 1)
      `).all(rigId) as Array<{ cwd: string }>).map((row) => row.cwd));
    } catch { /* a database from before the record */ }
    for (const session of this.seatsInUse(rigId)) {
      if (session.runtime !== "claude-code") continue;
      if (session.cwd) cwds.push(session.cwd);
      if (session.launchedCwd) cwds.push(session.launchedCwd);
    }
    const keys = new Set<string>();
    for (const cwd of cwds) {
      for (const target of [".", ".claude", nodePath.join(".claude", "settings.local.json"), ".openrig", nodePath.join(".openrig", "context-collector.cjs")]) {
        keys.add(this.guidancePathKey(nodePath.join(cwd, target)));
      }
    }
    return keys;
  }

  /** The file a seat reads its managed guidance from: the one its last launch recorded (#875), else the rule's. */
  private guidanceTargetPath(rigId: string, runtime: string | null, cwd: string | null, nodeId?: string | null): string | null {
    if (!runtime || !cwd) {
      return null;
    }
    // #25: clean only the rig's selected Claude file; the other file is never touched.
    return seatGuidanceFile(runtime, cwd, this.deps.rigRepo.getRigClaudeManagedBlockFile(rigId), recordedGuidanceFile(this.db, nodeId));
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

  /** Takes OpenRig's unedited blocks out of the file the seat's launch recorded and out of the rule's file, where an
   *  older launch of the same seat wrote them (#875): a recorded file never leaves blocks behind in the repository. */
  private cleanupManagedGuidanceFileForNode(rigId: string, runtime: string | null, cwd: string | null, liveGuidanceTargets: ReadonlySet<string>, result: TeardownResult, nodeId?: string | null): void {
    const targets = new Set([this.guidanceTargetPath(rigId, runtime, cwd, nodeId), this.guidanceTargetPath(rigId, runtime, cwd)]);
    for (const targetPath of targets) {
      if (targetPath) this.cleanupManagedGuidanceFile(targetPath, liveGuidanceTargets, result);
    }
  }

  private cleanupManagedGuidanceFile(targetPath: string, liveGuidanceTargets: ReadonlySet<string>, result: TeardownResult): void {
    if (liveGuidanceTargets.has(this.guidancePathKey(targetPath))) return;
    // The seat-skills line's block is removed only while it still holds the line; a person's edit is kept and reported.
    const { keptEdited } = removeManagedBlocksFromFile({
      exists: (path) => fs.existsSync(path),
      readFile: (path) => fs.readFileSync(path, "utf-8"),
      writeFile: (path, content) => fs.writeFileSync(path, content, "utf-8"),
      deleteFile: (path) => fs.unlinkSync(path),
    }, targetPath, { [SEAT_SKILLS_BOOTSTRAP_BLOCK_ID]: SEAT_SKILLS_BOOTSTRAP_LINE });
    for (const id of keptEdited) {
      const entry = `${targetPath}: ${id}`;
      if (!result.keptGuidance?.includes(entry)) (result.keptGuidance ??= []).push(entry);
    }
  }
}
