import path from "node:path";
import type { SnapshotData, RestoreValidationBlocker, RigServicesRecord } from "./types.js";
import { resolveSnapshotRestoreTopology } from "./restore-topology.js";
import { resolveActiveSnapshotSession } from "./active-occupant.js";
import { effectiveRestorePolicy } from "./restore-policy.js";
import { reanchorBuiltinStartupFile, reanchorShippedProjectionEntry } from "./builtin-startup-files.js";
import { compareConversations, describeSharedConversation, describeUnavailable, type ConversationSeat } from "./shared-conversation.js";

/** Pre-restore blockers that concern one seat's own startup content: they hold only that seat, and only if restore launches it. */
export const SEAT_STARTUP_BLOCKERS = new Set(["required_startup_file_missing", "startup_owner_root_missing"]);

// Shared read-only validation. Keep restore's refusal order and replay eligibility here.
export function validatePreRestore(
  data: SnapshotData,
  opts: {
    fsOps?: { exists(path: string): boolean };
    servicesRecord?: RigServicesRecord | null;
    freshLogicalIds?: string[];
    /** The runtime each seat has now, by logical id. A seat not listed is read as its saved runtime. */
    currentRuntimes?: Record<string, string | null | undefined>;
    /** Current explicit seat selections; a missing key is unknown, null is an explicit absence. */
    currentCodexProfiles?: Record<string, string | null>;
    /** This run's `--cwd` (already resolved): every seat launches and receives its checkpoint there instead. */
    cwdOverride?: string;
    /** The current recorded session status of each seat, by logical id (the node inventory's sessionStatus): how the
     *  shared-conversation report names the seats it would resume. A seat not listed is "unknown"; without the map, the
     *  snapshot's own record. */
    currentStatuses?: Record<string, string | null | undefined>;
    /** Seats kept attached to an external CLI: restore does not launch them, so they are not among the seats it
     *  resumes (restore compares them as agents outside it). */
    attachedLogicalIds?: string[];
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

  const topology = resolveSnapshotRestoreTopology(data);
  for (const invalidNodeId of topology.invalidRosterIds) {
    add({
      code: "invalid_topology_roster",
      severity: "critical",
      nodeId: invalidNodeId,
      target: "snapshot.topologyRoster",
      message: `Intended topology roster names node ${invalidNodeId}, which is absent from snapshot.nodes.`,
      remediation: "Capture a new snapshot from the authoritative materialized topology.",
    });
  }

  for (const node of topology.intendedNodes) {
    if (node.runtime === "codex" && node.codexConfigProfile
      && opts.currentRuntimes?.[node.logicalId] === "codex"
      && opts.currentCodexProfiles && Object.hasOwn(opts.currentCodexProfiles, node.logicalId)
      && opts.currentCodexProfiles[node.logicalId] === null) {
      warnings.push(`Restore pre-validation: ${node.logicalId} had Codex profile ${node.codexConfigProfile} in this snapshot, but its current seat selection has no named profile. Restore uses the current selection; an ordinary floor launch uses workspace-write instead. Review rig seat set-permissions before restoring if this change is unintended. The snapshot does not prove what a prior process enforced.`);
    }
    const checkpoint = checkpoints[node.id] ?? null;
    if (checkpoint && !(opts.cwdOverride || node.cwd)) {
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

    // OPR.0.5.7.1 D6a — validate replay files IFF the node will CONSUME
    // replay (desk static ruling on e42420990): none => fresh path,
    // validate; ambiguity => the node stops loudly and consumes nothing,
    // skip; explicit fresh or a non-resume policy => deliberate fresh,
    // validate; resume_if_possible with no token => stop-and-ask, consumes
    // nothing, skip; usable type + token => exact resume, skip; a token
    // WITHOUT a usable resume type follows the current fresh path,
    // validate.
    // A missing sessions list is already a blocker above; read it as empty here rather than throw.
    const resolution = resolveActiveSnapshotSession({ ...data, sessions: sessions ?? [] }, node.id);
    const freshListed = opts.freshLogicalIds?.includes(node.logicalId) ?? false;
    let consumesReplay: boolean;
    if (resolution.kind === "ambiguous") {
      consumesReplay = false;
    } else if (resolution.kind === "none") {
      consumesReplay = true;
    } else {
      const sess = resolution.session;
      const policy = effectiveRestorePolicy({
        savedRuntime: node.runtime,
        currentRuntime: opts.currentRuntimes?.[node.logicalId] ?? node.runtime,
        recordedSessions: sessions?.filter((recorded) => recorded.nodeId === node.id) ?? [],
      }, sess.restorePolicy);
      if (freshListed || policy !== "resume_if_possible") consumesReplay = true;
      else if (!sess.resumeToken) consumesReplay = false;
      else if (!!sess.resumeType && sess.resumeType !== "none") consumesReplay = false;
      else consumesReplay = true;
    }

    for (const storedFile of consumesReplay ? startupCtx.resolvedStartupFiles ?? [] : []) {
      // Validate the file replay will actually deliver (#261: built-ins follow the running install).
      const file = reanchorBuiltinStartupFile(storedFile, undefined, undefined, exists);
      if (!file.required) {
        if (pathLike(file.absolutePath) && !exists(file.absolutePath)) {
          warnings.push(`Restore pre-validation: optional startup file missing for ${node.logicalId}: ${file.absolutePath}`);
        }
        continue;
      }
      if (pathLike(file.ownerRoot) && !exists(file.ownerRoot)) {
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
      if (pathLike(file.absolutePath) && !exists(file.absolutePath)) {
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

    // OPR.0.3.4.5 (behavior 09): projection-validity != session continuity.
    // A stale/missing projected skill/artifact must NOT abort a restore that
    // has a valid native resume. Demoted from critical blockers to warnings
    // flagged as projection_drift (compose slice-03's drift reporting shape).
    // The existing post-launch filter (:855-885) already skips missing
    // entries with a "(skipped)" warning; here we prevent the pre-restore
    // gate from blocking the attempt entirely. Missing REQUIRED startup
    // files and genuinely-fatal blockers (malformed snapshot, missing nodes)
    // stay critical above.
    for (const storedEntry of startupCtx.projectionEntries ?? []) {
      const entry = reanchorShippedProjectionEntry(storedEntry, undefined, exists);
      if (pathLike(entry.sourcePath) && !exists(entry.sourcePath)) {
        warnings.push(`projection_drift: source root missing for ${node.logicalId}: ${entry.sourcePath} (projection will be skipped at startup; session continuity is unaffected)`);
      }
      if (pathLike(entry.absolutePath) && !exists(entry.absolutePath)) {
        warnings.push(`projection_drift: entry missing for ${node.logicalId}: ${entry.absolutePath} (projection will be skipped at startup; session continuity is unaffected)`);
      }
    }
  }

  // #3218 item 3: two seats this restore would resume on the same recorded conversation are named, with the
  // conversation, so the person can decide. A reported gap, not a guard: nothing is refused or picked.
  // A seat held for startup (a missing required startup file) is not launched, so it is not on the resumed side here
  // (the maintainer's 3rd review of #3250); restore compares it as a current partner.
  const shared = compareConversations(resumingConversationSeats(data, { ...opts, heldLogicalIds: heldForStartupLogicalIds(blockers, nodes) }));
  for (const group of shared.groups) {
    warnings.push(`Restore pre-validation: ${describeSharedConversation(group)}`);
  }
  if (shared.unavailable.length) warnings.push(`Restore pre-validation: ${describeUnavailable(shared.unavailable)}`);

  const servicesRecord = opts.servicesRecord ?? null;
  if (servicesRecord) {
    if (pathLike(servicesRecord.rigRoot) && !exists(servicesRecord.rigRoot)) {
      add({
        code: "service_rig_root_missing",
        severity: "critical",
        target: "services.rigRoot",
        path: servicesRecord.rigRoot,
        message: `Service rig root is missing: ${servicesRecord.rigRoot}`,
        remediation: "Restore the service rig root or update the services record before retrying restore.",
      });
    }
    if (pathLike(servicesRecord.composeFile) && !exists(servicesRecord.composeFile)) {
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

function pathLike(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && (
    path.isAbsolute(value)
    || path.win32.isAbsolute(value)
    || value.startsWith("./")
    || value.startsWith("../")
    || value.startsWith(".\\")
    || value.startsWith("..\\")
    || value.startsWith("~")
  );
}

/** The logical ids of the seats a startup blocker holds (a missing required startup file or owner root): restore
 *  doesn't launch them (#3250, the maintainer's 3rd review). */
export function heldForStartupLogicalIds(blockers: readonly RestoreValidationBlocker[], nodes: readonly { id: string; logicalId: string }[] | null): string[] {
  const held = new Set(blockers.filter((blocker) => SEAT_STARTUP_BLOCKERS.has(blocker.code) && blocker.nodeId).map((blocker) => blocker.nodeId));
  return (nodes ?? []).filter((node) => held.has(node.id)).map((node) => node.logicalId);
}

/** The occupants a restore of this snapshot would resume (the resume policy, not listed fresh, not kept attached to an
 *  external CLI, not held for startup, not a terminal), as ConversationSeat keyed by logical id (#3218 item 3). Shared
 *  by validatePreRestore and the restore's partner check. */
const UNREADABLE = Object.freeze({ unreadable: true });

export function resumingConversationSeats(
  data: SnapshotData,
  opts: {
    freshLogicalIds?: string[];
    currentRuntimes?: Record<string, string | null | undefined>;
    currentStatuses?: Record<string, string | null | undefined>;
    attachedLogicalIds?: string[];
    /** Seats a startup blocker holds: restore doesn't launch them. */
    heldLogicalIds?: string[];
  },
): ConversationSeat[] {
  if (!Array.isArray(data.nodes)) return [];
  const sessions = Array.isArray(data.sessions) ? data.sessions : [];
  const resuming: ConversationSeat[] = [];
  for (const node of resolveSnapshotRestoreTopology(data).intendedNodes) {
    try {
      if (opts.freshLogicalIds?.includes(node.logicalId) || opts.attachedLogicalIds?.includes(node.logicalId)
        || opts.heldLogicalIds?.includes(node.logicalId)) continue;
      const currentRuntime = opts.currentRuntimes?.[node.logicalId] ?? node.runtime;
      if (currentRuntime === "terminal") continue;
      const resolution = resolveActiveSnapshotSession({ ...data, sessions }, node.id);
      if (resolution.kind !== "resolved") continue;
      const policy = effectiveRestorePolicy({
        savedRuntime: node.runtime,
        currentRuntime,
        recordedSessions: sessions.filter((recorded) => recorded.nodeId === node.id),
      }, resolution.session.restorePolicy);
      if (policy !== "resume_if_possible") continue;
      resuming.push({
        seat: node.logicalId,
        // the current record, as for the agents outside it: the snapshot's own says "running" for a seat rig down
        // stopped after taking it (the maintainer's review of #3250)
        state: (opts.currentStatuses ? opts.currentStatuses[node.logicalId] : resolution.session.status) ?? "unknown",
        resumeType: resolution.session.resumeType,
        resumeToken: resolution.session.resumeToken,
      });
    } catch {
      // malformed saved data never stops a restore: the comparison is unavailable for this agent
      resuming.push({ seat: node.logicalId, resumeType: UNREADABLE, resumeToken: UNREADABLE });
    }
  }
  return resuming;
}
