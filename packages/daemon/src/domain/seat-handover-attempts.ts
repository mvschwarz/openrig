import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { AppliedLaunchObservation } from "./permission-drift.js";

/**
 * #2985 / #2861: the record of a handover that failed after its successor was launched in the respawned pane, so
 * `rig seat handover <seat> --recover` can adopt that successor if it is running. Table: 165_seat_handover_attempts.
 * The resume token is the session id the daemon generated for the successor's launch; it is never logged, never put in
 * an event, and never returned to a caller.
 */
export interface SeatHandoverAttempt {
  id: string;
  nodeId: string;
  canonicalSession: string;
  pane: string;
  runtime: string | null;
  successorGeneration: string;
  predecessorGeneration: string | null;
  predecessorSessionId: string;
  sourceRaw: string;
  reason: string;
  operator: string | null;
  resumeType: string | null;
  resumeToken: string | null;
  /** What became of the context packet the failed handover was delivering. */
  contextDelivery: "delivered" | "unconfirmed" | "not_sent";
  departingProcess: "ended-graceful" | "ended-forced";
  launchAdditionNotes: string[];
  startedWithoutRequired: string[];
  appliedLaunch: AppliedLaunchObservation | null;
  /** #3044 review S1: the launch's frozen executable and whether it is a #! script (#2341), so the recovery proves a
   *  wrapper launch the way the adapter's readiness does; null and false for a classic launch. */
  executable: string | null;
  executableIsScript: boolean;
  failedStep: string;
  failureCode: string;
  createdAt: string;
}

interface AttemptRow {
  id: string; node_id: string; canonical_session: string; pane: string; runtime: string | null;
  successor_generation: string; predecessor_generation: string | null; predecessor_session_id: string;
  source_raw: string; reason: string; operator: string | null; resume_type: string | null; resume_token: string | null;
  context_delivery: "delivered" | "unconfirmed" | "not_sent"; launch_notes_json: string | null;
  started_without_required_json: string | null; applied_launch_json: string | null; executable: string | null;
  executable_is_script: number; departing_process: "ended-graceful" | "ended-forced"; failed_step: string; failure_code: string;
  created_at: string;
}

function parseList(json: string | null): string[] {
  if (!json) return [];
  try { const value = JSON.parse(json) as unknown; return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []; }
  catch { return []; }
}

function parseApplied(json: string | null): AppliedLaunchObservation | null {
  if (!json) return null;
  try { return JSON.parse(json) as AppliedLaunchObservation; } catch { return null; }
}

function fromRow(row: AttemptRow): SeatHandoverAttempt {
  return {
    id: row.id, nodeId: row.node_id, canonicalSession: row.canonical_session, pane: row.pane, runtime: row.runtime,
    successorGeneration: row.successor_generation, predecessorGeneration: row.predecessor_generation,
    predecessorSessionId: row.predecessor_session_id, sourceRaw: row.source_raw, reason: row.reason, operator: row.operator,
    resumeType: row.resume_type, resumeToken: row.resume_token, contextDelivery: row.context_delivery,
    departingProcess: row.departing_process, launchAdditionNotes: parseList(row.launch_notes_json),
    startedWithoutRequired: parseList(row.started_without_required_json), appliedLaunch: parseApplied(row.applied_launch_json),
    executable: row.executable, executableIsScript: row.executable_is_script === 1, failedStep: row.failed_step, failureCode: row.failure_code, createdAt: row.created_at,
  };
}

/** Records a failed attempt as the seat's open one; an earlier open attempt of the seat is abandoned in the same
 *  transaction (its pane now holds this later launch). Returns the new attempt's id. */
export function recordFailedHandoverAttempt(db: Database.Database, attempt: Omit<SeatHandoverAttempt, "id" | "createdAt">): string {
  const id = randomUUID();
  db.transaction(() => {
    abandonOpenHandoverAttempt(db, attempt.nodeId, "a later handover of this seat failed too");
    db.prepare(`INSERT INTO seat_handover_attempts (id, node_id, canonical_session, pane, runtime, successor_generation,
      predecessor_generation, predecessor_session_id, source_raw, reason, operator, resume_type, resume_token,
      context_delivery, launch_notes_json, started_without_required_json, applied_launch_json, executable,
      executable_is_script, departing_process, failed_step, failure_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, attempt.nodeId, attempt.canonicalSession, attempt.pane, attempt.runtime, attempt.successorGeneration,
      attempt.predecessorGeneration, attempt.predecessorSessionId, attempt.sourceRaw, attempt.reason, attempt.operator,
      attempt.resumeType, attempt.resumeToken, attempt.contextDelivery,
      attempt.launchAdditionNotes.length ? JSON.stringify(attempt.launchAdditionNotes) : null,
      attempt.startedWithoutRequired.length ? JSON.stringify(attempt.startedWithoutRequired) : null,
      attempt.appliedLaunch ? JSON.stringify(attempt.appliedLaunch) : null, attempt.executable,
      attempt.executableIsScript ? 1 : 0, attempt.departingProcess,
      attempt.failedStep, attempt.failureCode);
  })();
  return id;
}

/** The seat's open (failed, not yet adopted or abandoned) attempt, if any. */
export function openHandoverAttempt(db: Database.Database, nodeId: string): SeatHandoverAttempt | null {
  const row = db.prepare("SELECT * FROM seat_handover_attempts WHERE node_id = ? AND phase = 'failed'").get(nodeId) as AttemptRow | undefined;
  return row ? fromRow(row) : null;
}

/** Closes an open attempt: adopted (inside the recovery's commit transaction) or abandoned, with the reason. A closed
 *  attempt keeps no resume token. Returns whether that attempt was still open. */
export function closeHandoverAttempt(db: Database.Database, id: string, phase: "adopted" | "abandoned", outcome: string): boolean {
  return db.prepare(`UPDATE seat_handover_attempts SET phase = ?, outcome = ?, resume_token = NULL,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND phase = 'failed'`).run(phase, outcome, id).changes === 1;
}

/** Abandons the seat's open attempt, if any (a later handover took the seat, or failed too). */
export function abandonOpenHandoverAttempt(db: Database.Database, nodeId: string, outcome: string): void {
  db.prepare(`UPDATE seat_handover_attempts SET phase = 'abandoned', outcome = ?, resume_token = NULL,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE node_id = ? AND phase = 'failed'`).run(outcome, nodeId);
}
