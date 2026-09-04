// OPR.0.5.7.1 — the ONE active-occupant truth, as a pure leaf module.
//
// Execution (restore-orchestrator), preview (restore-plan-preview), snapshot
// usability (rig-repository), and lifecycle projection (node-inventory) all
// consume the SAME four-way ladder below; capture (snapshot-capture) and the
// live no-snapshot preview both derive the relation through the SAME helper.
// R2's HOLD was exactly the drift this module removes: reporting surfaces
// selecting historical rows the execution path would never resume.
//
// FOUR-WAY OCCUPANT TRUTH (repair ruling qitem-20260829080039-c47a571e):
// the ONLY case where legacy inference may run is the WHOLE relation map
// being absent (a pre-convention snapshot). A PRESENT map is the authority —
// a null value, a missing node key, or a dangling id each fails LOUDLY; the
// map is never collapsed by truthiness into the legacy ladder.

import type { SnapshotData, Session, SnapshotOccupantState } from "./types.js";

/** The minimal row shape the ladder needs — satisfied by Session and by the
 *  preview's narrower session rows alike, so ONE ladder serves every consumer
 *  without a copied variant. */
export interface OccupantCandidateRow {
  id: string;
  nodeId: string;
  status: string | null;
}

export type ActiveOccupantResolution<T extends OccupantCandidateRow> =
  | { kind: "resolved"; session: T }
  | { kind: "none" }
  | { kind: "ambiguous"; candidateIds: string[]; detail: string };

export type ActiveSnapshotSessionResolution =
  | { kind: "resolved"; session: Session }
  | { kind: "none" }
  | { kind: "ambiguous"; candidateIds: string[]; detail: string };

/** The four-way ladder (moved from restore-orchestrator.ts, behavior
 *  byte-faithful; generic over the row shape so no consumer copies it). */
export function resolveActiveOccupantRow<T extends OccupantCandidateRow>(
  sessions: T[],
  relationMap: Record<string, string | null> | undefined,
  nodeId: string,
): ActiveOccupantResolution<T> {
  const rows = sessions.filter((s) => s.nodeId === nodeId);
  const map = relationMap;
  if (map === undefined) {
    // Pre-convention snapshot: this is the ONLY branch where zero rows means
    // "never ran" (none) and legacy inference may run — a single row, else
    // the uniquely-running row, else ambiguity.
    if (rows.length === 0) return { kind: "none" };
    if (rows.length === 1) return { kind: "resolved", session: rows[0]! };
    const running = rows.filter((s) => s.status === "running");
    if (running.length === 1) return { kind: "resolved", session: running[0]! };
    return { kind: "ambiguous", candidateIds: rows.map((r) => r.id), detail: "no explicit active relation (pre-convention snapshot) and no uniquely-running row" };
  }
  // Map PRESENT: it is the authority even with zero session rows — a null,
  // missing-key, or dangling relation state is loud regardless of history.
  if (!Object.prototype.hasOwnProperty.call(map, nodeId)) {
    return { kind: "ambiguous", candidateIds: rows.map((r) => r.id), detail: "the snapshot's activeSessionIdByNode map carries no entry for this node" };
  }
  const rel = map[nodeId];
  if (rel === null) {
    return { kind: "ambiguous", candidateIds: rows.map((r) => r.id), detail: "the snapshot recorded no single live occupant at capture (explicit null)" };
  }
  const hit = rows.find((s) => s.id === rel);
  if (!hit) {
    return { kind: "ambiguous", candidateIds: rows.map((r) => r.id), detail: `the recorded active relation ${rel} names no session row in this snapshot (dangling)` };
  }
  return { kind: "resolved", session: hit };
}

/** The snapshot-shaped entry point (the original public signature; a thin
 *  wrapper so execution call sites are unchanged). */
export function resolveActiveSnapshotSession(data: SnapshotData, nodeId: string): ActiveSnapshotSessionResolution {
  const explicit = data.activeOccupantsByNode;
  if (explicit !== undefined) {
    const state = explicit[nodeId];
    const rows = data.sessions.filter((session) => session.nodeId === nodeId);
    if (!state) {
      return { kind: "ambiguous", candidateIds: rows.map((row) => row.id), detail: "the snapshot's activeOccupantsByNode map carries no entry for this node" };
    }
    if (state.kind === "absent") return { kind: "none" };
    if (state.kind === "ambiguous") {
      return { kind: "ambiguous", candidateIds: [...state.candidateIds], detail: "the snapshot recorded multiple live occupant candidates at capture" };
    }
    const session = rows.find((row) => row.id === state.sessionId);
    if (!session) {
      return { kind: "ambiguous", candidateIds: rows.map((row) => row.id), detail: `the recorded active occupant ${state.sessionId} names no session row in this snapshot (dangling)` };
    }
    return { kind: "resolved", session };
  }
  return resolveActiveOccupantRow(data.sessions, data.activeSessionIdByNode, nodeId);
}

/** One wording for the loud failure everywhere — divergent phrasings would be
 *  a second copy of the truth. */
export function activeOccupantAmbiguityError(candidateIds: string[], detail?: string): string {
  return `Active-occupant ambiguity: ${candidateIds.length} candidate session rows (${candidateIds.join(", ")})` +
    `${detail ? ` — ${detail}` : ""}. Seat unrecoverable until resolved. ` +
    `Refusing newest-row-wins and refusing a replacement occupant.`;
}

/** The CAPTURE rule, shared verbatim by SnapshotCapture and the live
 *  no-snapshot preview so the two sibling derivations cannot drift:
 *  exactly one RUNNING row for a node -> its id; otherwise -> explicit null
 *  (recorded honestly; restore resolves it loudly instead of guessing). */
export function deriveActiveSessionIdByNode(
  sessions: OccupantCandidateRow[],
  nodeIds: string[],
): Record<string, string | null> {
  const relation: Record<string, string | null> = {};
  for (const nodeId of nodeIds) {
    const running = sessions.filter((s) => s.nodeId === nodeId && s.status === "running");
    relation[nodeId] = running.length === 1 ? running[0]!.id : null;
  }
  return relation;
}

/** Capture the same live relation without collapsing absent and ambiguous. */
export function deriveActiveOccupantsByNode(
  sessions: OccupantCandidateRow[],
  nodeIds: string[],
): Record<string, SnapshotOccupantState> {
  const relation: Record<string, SnapshotOccupantState> = {};
  for (const nodeId of nodeIds) {
    const running = sessions.filter((session) => session.nodeId === nodeId && session.status === "running");
    relation[nodeId] = running.length === 0
      ? { kind: "absent" }
      : running.length === 1
        ? { kind: "resolved", sessionId: running[0]!.id }
        : { kind: "ambiguous", candidateIds: running.map((session) => session.id) };
  }
  return relation;
}

/** Reboot capture equivalent: resolve one durable non-terminal occupant when
 * possible, otherwise preserve the exact absent/ambiguous candidate set. */
export function deriveRehydrateOccupantsByNode(
  sessions: OccupantCandidateRow[],
  nodeIds: string[],
): Record<string, SnapshotOccupantState> {
  const candidates = sessions.filter((session) => session.status !== "superseded" && session.status !== "exited");
  const relation: Record<string, SnapshotOccupantState> = {};
  for (const nodeId of nodeIds) {
    const rows = candidates.filter((session) => session.nodeId === nodeId);
    const resolved = resolveActiveOccupantRow(candidates, undefined, nodeId);
    relation[nodeId] = resolved.kind === "resolved"
      ? { kind: "resolved", sessionId: resolved.session.id }
      : rows.length === 0
        ? { kind: "absent" }
        : { kind: "ambiguous", candidateIds: rows.map((row) => row.id) };
  }
  return relation;
}

/** Reboot-only capture rule. Startup reconciliation has already changed the
 * lost process's row from running to detached, so the ordinary live-capture
 * rule cannot identify it. Reuse the legacy relation ladder over durable rows:
 * one non-terminal row, or one uniquely-running row among several, is enough;
 * every ambiguous shape remains explicit null and therefore fails closed. */
export function deriveRehydrateSessionIdByNode(
  sessions: OccupantCandidateRow[],
  nodeIds: string[],
): Record<string, string | null> {
  const candidates = sessions.filter((session) => session.status !== "superseded" && session.status !== "exited");
  const relation: Record<string, string | null> = {};
  for (const nodeId of nodeIds) {
    const resolved = resolveActiveOccupantRow(candidates, undefined, nodeId);
    relation[nodeId] = resolved.kind === "resolved" ? resolved.session.id : null;
  }
  return relation;
}
