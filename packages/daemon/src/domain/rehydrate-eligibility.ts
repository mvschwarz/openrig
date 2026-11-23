import type Database from "better-sqlite3";
import { deriveRehydrateOccupantsByNode, freshSeatLaunchCommand, resolveActiveOccupantRow, resolveActiveSnapshotSession } from "./active-occupant.js";
import { readFreshOccupantRelations } from "./fresh-occupant-relation.js";
import { effectiveRestorePolicy } from "./restore-policy.js";
import type { RigWithRelations, Session, Snapshot, SnapshotData } from "./types.js";

export interface CurrentStateRehydrateEligibility {
  ok: boolean;
  blockers: string[];
  /** Seats a current-state restore leaves unstarted, waiting for a decision, instead of blocking the rig on them
   *  (present only when there are any). */
  awaitingDecision?: string[];
}

/**
 * A crash snapshot remains trustworthy only while it names every occupant that
 * durable current state still identifies as active. Boot reconciliation turns
 * rows detached after abrupt substrate loss, so detached rows must participate:
 * a different session id or native resume identity is positive evidence that
 * the snapshot belongs to an older occupant. Ambiguous current state is also
 * not permission to revive a historical occupant; current-state capture
 * preserves the ambiguity and restore refuses it explicitly.
 */
export function assessSnapshotCurrentOccupants(
  db: Database.Database,
  rig: RigWithRelations,
  snapshot: { data: Pick<SnapshotData, "activeOccupantsByNode" | "activeSessionIdByNode"> & {
    sessions: Array<Pick<Session, "id" | "nodeId" | "resumeType" | "resumeToken"> & { status: string | null }>;
  } },
  preserveStoppedInitial = false,
): { matches: boolean; stoppedNodeIds: Set<string> } {
  const stoppedNodeIds = new Set<string>();
  const mismatch = () => ({ matches: false, stoppedNodeIds: new Set<string>() });
  if (rig.nodes.length === 0) return { matches: true, stoppedNodeIds };
  const rows = db.prepare(
    `SELECT s.*, s.node_id AS nodeId,
            s.resume_type AS resumeType, s.resume_token AS resumeToken
       FROM sessions s
       JOIN nodes n ON n.id = s.node_id
       WHERE n.rig_id = ? ORDER BY s.created_at DESC, s.id DESC`
  ).all(rig.rig.id) as Array<{
    id: string;
    nodeId: string;
    status: string;
    resumeType: string | null;
    resumeToken: string | null;
    intentionally_stopped?: number;
  }>;

  const recorded = readFreshOccupantRelations(db, rig.rig.id);
  // A clean down exits the fresh occupant without revoking its relation.
  // Keep that row for snapshot comparison, but exclude unrelated exited history.
  const candidates = rows.filter((row) => row.status !== "superseded" && (row.status !== "exited" || recorded[row.nodeId] === row.id));
  for (const node of rig.nodes) {
    const current = resolveActiveOccupantRow(candidates, Object.prototype.hasOwnProperty.call(recorded, node.id) ? recorded : undefined, node.id);
    if (current.kind === "none" && !preserveStoppedInitial) continue;
    if (current.kind === "ambiguous") return mismatch();
    const captured = resolveActiveSnapshotSession(snapshot.data, node.id);
    const stoppedHistoryMatches = (session: typeof rows[number]) => {
      const history = snapshot.data.sessions.filter(s => s.nodeId === node.id && s.id === session.id);
      return captured.kind === "none" && snapshot.data.activeOccupantsByNode?.[node.id]?.kind === "absent"
        && session.status === "exited" && session.intentionally_stopped === 1
        && history.length === 1 && history[0]!.status === "exited"
        && (history[0]!.resumeType ?? null) === session.resumeType
        && (history[0]!.resumeToken ?? null) === session.resumeToken;
    };
    if (current.kind === "none") {
      // Only explicit existing-rig up extends the stop rule to the original
      // occupant. The newest session and newest initial tenure own the stop,
      // including after restore. An older row's flag cannot hold its successor.
      const newest = rows.find(row => row.nodeId === node.id);
      const tenure = preserveStoppedInitial && node.runtime && node.runtime !== "terminal" && newest
        ? db.prepare("SELECT kind FROM occupant_tenures WHERE node_id=? ORDER BY generation_ordinal DESC LIMIT 1").get(node.id) as { kind: string } | undefined
        : undefined;
      if (tenure?.kind === "initial" && newest && stoppedHistoryMatches(newest)) {
        stoppedNodeIds.add(node.id);
      }
      continue;
    }
    // An absent occupant is current only with the deliberate stop, the exact
    // exited/native history, and a fresh effect fenced to the current tenure.
    // Missing/ambiguous legacy relations never qualify as recorded absence.
    if (stoppedHistoryMatches(current.session) && recorded[node.id] === current.session.id
      && (db.prepare("SELECT kind FROM occupant_tenures WHERE node_id=? ORDER BY generation_ordinal DESC LIMIT 1").get(node.id) as { kind: string } | undefined)?.kind === "fresh") {
      stoppedNodeIds.add(node.id);
      continue;
    }
    if (
      captured.kind !== "resolved"
      || captured.session.id !== current.session.id
      || (captured.session.resumeType ?? null) !== current.session.resumeType
      || (captured.session.resumeToken ?? null) !== current.session.resumeToken
    ) {
      return mismatch();
    }
  }
  return { matches: true, stoppedNodeIds };
}

export function snapshotMatchesCurrentOccupants(db: Database.Database, rig: RigWithRelations, snapshot: Snapshot): boolean {
  return assessSnapshotCurrentOccupants(db, rig, snapshot).matches;
}

export function stoppedSnapshotReason(logicalId: string, rigName: string): string {
  return `Seat '${logicalId}' was deliberately stopped in the current generation and this snapshot. It remains stopped. To explicitly start this seat in a new conversation, run: ${freshSeatLaunchCommand(logicalId, rigName)}.`;
}

/**
 * Determines whether current persisted DB state is sufficient to synthesize a
 * restore snapshot after volatile runtime state (tmux) disappeared.
 *
 * This is intentionally conservative. It does not claim provider continuity by
 * itself; it only says the existing restore orchestrator has enough persisted
 * input to attempt a normal restore from an on-demand snapshot.
 *
 * Both selection paths that fall back to an auto-rehydrate capture (`rig start`'s
 * POST /api/rigs/:id/up and chooseRestoreSnapshot for `rig up --existing` and
 * daemon start) decide here, and restore-check reports the same answer.
 */
export function assessCurrentStateRehydrateEligibility(
  db: Database.Database,
  rig: RigWithRelations,
): CurrentStateRehydrateEligibility {
  const blockers: string[] = [];

  if (rig.nodes.length === 0) {
    blockers.push("rig has no nodes to rehydrate");
  }

  const sessions = db.prepare(
    `SELECT node_id, resume_token
       FROM sessions
       WHERE node_id IN (${rig.nodes.map(() => "?").join(",") || "NULL"})
         AND status NOT IN ('superseded', 'exited')
       ORDER BY id DESC`
  ).all(...rig.nodes.map((node) => node.id)) as Array<{ node_id: string; resume_token: string | null }>;

  if (rig.nodes.length > 0 && sessions.length === 0) {
    blockers.push("rig has no persisted sessions to rehydrate");
  }

  const sessionByNode = new Map<string, Array<{ resume_token: string | null }>>();
  for (const session of sessions) {
    const rows = sessionByNode.get(session.node_id) ?? [];
    rows.push(session);
    sessionByNode.set(session.node_id, rows);
  }

  // A seat with neither saved startup context nor a resume token would start blank, so it blocks, with one exception.
  // When its current occupant resolves unambiguously, as the auto-rehydrate capture resolves it, under
  // resume_if_possible, restore starts nothing for it: the capture keeps that row and its null token, and restore stops
  // the seat as awaiting-decision before any launch while the other seats resume from their own current rows. No token
  // comes from an older row, and the occupant match is unchanged. With no other eligible seat the blocker stays:
  // restoring that rig would start nothing.
  const seatBlockers: Array<{ logicalId: string; blocker: string; awaitsDecision: boolean }> = [];
  let eligibleSeats = 0;
  let awaitsDecision: ((node: RigWithRelations["nodes"][number]) => boolean) | undefined;
  for (const node of rig.nodes) {
    const runtime = node.runtime ?? "";
    const isAgentRuntime = runtime.length > 0 && runtime !== "terminal";
    const hasStartupContext = !!db.prepare(
      "SELECT 1 FROM node_startup_context WHERE node_id = ? LIMIT 1"
    ).get(node.id);
    const hasResumeToken = (sessionByNode.get(node.id) ?? []).some((session) =>
      typeof session.resume_token === "string" && session.resume_token.length > 0
    );

    // A resume token is enough for a pod-aware seat too: restore resumes it with an empty plan and names the gap.
    const blocker = node.podId && !hasStartupContext && !hasResumeToken
      ? `node ${node.logicalId} is pod-aware but has no persisted startup context or resume token`
      : isAgentRuntime && !hasStartupContext && !hasResumeToken
        ? `node ${node.logicalId} has runtime ${runtime} but no startup context or resume token`
        : null;
    if (!blocker) {
      eligibleSeats++;
      continue;
    }
    awaitsDecision ??= tokenlessResumeOccupants(db, rig);
    seatBlockers.push({ logicalId: node.logicalId, blocker, awaitsDecision: awaitsDecision(node) });
  }
  const waiting = eligibleSeats > 0 ? seatBlockers.filter((seat) => seat.awaitsDecision) : [];
  blockers.push(...seatBlockers.filter((seat) => !waiting.includes(seat)).map((seat) => seat.blocker));

  return {
    ok: blockers.length === 0,
    blockers,
    ...(waiting.length > 0 ? { awaitingDecision: waiting.map((seat) =>
      `node ${seat.logicalId} has no persisted startup context or resume token: restore keeps its current session and leaves it unstarted, waiting for a decision`) } : {}),
  };
}

/** Whether a seat's current occupant, resolved exactly as the auto-rehydrate capture resolves it, is unambiguous, has
 *  no resume token, and restores under resume_if_possible: restore then stops the seat as awaiting-decision before any
 *  launch (the orchestrator's pre-launch stop, which restore-plan-preview forecasts). Read once per rig, and only for a
 *  rig with a seat that would otherwise block. */
function tokenlessResumeOccupants(db: Database.Database, rig: RigWithRelations): (node: RigWithRelations["nodes"][number]) => boolean {
  const nodeIds = rig.nodes.map((node) => node.id);
  // Every row of the rig's seats, as capture records them: the occupant ladder skips superseded and exited rows
  // itself, and the restore policy reads the seat's whole recorded history.
  const rows = db.prepare(
    `SELECT id, node_id AS nodeId, status, restore_policy AS restorePolicy, resume_token AS resumeToken
       FROM sessions WHERE node_id IN (${nodeIds.map(() => "?").join(",") || "NULL"})`
  ).all(...nodeIds) as Array<{ id: string; nodeId: string; status: string | null; restorePolicy: string | null; resumeToken: string | null }>;
  const occupants = deriveRehydrateOccupantsByNode(rows, nodeIds, readFreshOccupantRelations(db, rig.rig.id));
  return (node) => {
    const state = occupants[node.id];
    const occupant = state?.kind === "resolved" ? rows.find((row) => row.id === state.sessionId) : undefined;
    if (!occupant || occupant.resumeToken) return false;
    const recordedSessions = rows.filter((row) => row.nodeId === node.id);
    return effectiveRestorePolicy({ savedRuntime: node.runtime, currentRuntime: node.runtime, recordedSessions }, occupant.restorePolicy)
      === "resume_if_possible";
  };
}
