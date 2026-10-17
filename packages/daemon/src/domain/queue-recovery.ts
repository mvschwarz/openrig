import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { lastMeaningfulTransition } from "./queue-waiting.js";

/** Common provenance on existing diagnostic queue rows, never a second ledger.
 * Both deadline and delivery detectors consult the same recovery disposition. */
export const recoveryTag = (qitemId: string): string => `recovery-for:${qitemId}`;
/** Machine-authored retirement receipt: this false stall is resolved, not the work. */
export const INPUT_WAIT_RESOLVED_NOTE = "stuck-sweep resolved: owner needs input";

/** Only the latest transition can retire a finding this way. A subsequent manual
 * disposition still owns recovery. Read the archive too: human waits can outlast retention. */
export function inputWaitResolution(db: Database.Database, qitemId: string): number | null {
  const sources = db.prepare("SELECT name FROM sqlite_master WHERE name IN ('queue_transitions', 'queue_transitions_archive')").all() as Array<{ name: string }>;
  if (sources.length === 0) return null;
  const fields = "transition_id, state, transition_note, actor_session";
  const transition = db.prepare(`SELECT t.*, q.source_session FROM (
    ${sources.map(({ name }) => `SELECT ${fields} FROM ${name} WHERE qitem_id = ?`).join(" UNION ALL ")}
  ) t JOIN queue_items q ON q.qitem_id = ? AND q.state = 'done' ORDER BY transition_id DESC LIMIT 1`)
    .get(...sources.map(() => qitemId), qitemId) as {
      transition_id: number; state: string; transition_note: string | null; actor_session: string; source_session: string;
    } | undefined;
  return transition?.state === "done" && transition.actor_session === transition.source_session
    && transition.transition_note === INPUT_WAIT_RESOLVED_NOTE ? transition.transition_id : null;
}
function failedAttempt(db: Database.Database, qitemId: string): string | null {
  // A typing-guard refusal (retained:) is newer evidence about the original
  // obligation exactly like a failed nudge: a wake WAS offered after the
  // recovery disposition was written (#344). Without this arm the refusal was
  // invisible here — ladder attempt markers never count as meaningful
  // transitions — so a terminal recovery stayed fresh forever and suppressed
  // the unclaimed baton's retry path.
  return (db.prepare("SELECT last_nudge_attempt AS at FROM queue_items WHERE qitem_id = ? AND (last_nudge_result LIKE 'failed:%' OR last_nudge_result LIKE 'retained:%')").get(qitemId) as { at: string | null } | undefined)?.at ?? null;
}
export function recoveryId(db: Database.Database, qitemId: string): string {
  const previous = latestRecovery(db, qitemId, true);
  const retired = previous ? inputWaitResolution(db, previous.qitem_id) : null;
  const evidence = [qitemId, lastMeaningfulTransition(db, qitemId)?.id ?? null, failedAttempt(db, qitemId)];
  // A later stall must get a new, deterministic ID even when answering the prompt
  // wrote no queue transition. Concurrent sweeps use the same retirement receipt.
  if (retired !== null) evidence.push(`input-wait-resolved:${retired}`);
  return `qitem-recovery-${createHash("sha256").update(JSON.stringify(evidence)).digest("hex").slice(0, 16)}`;
}
/** Rows whose tag text could hold a recovery tag: valid JSON stores a string verbatim or with
 * backslash escapes, so this superset loses no exact match. It repeats the first group of
 * idx_queue_items_recovery_tags' WHERE clause (migration 099) byte for byte, which is what lets the
 * planner read that small index instead of scanning and parsing every row. */
const RECOVERY_TAG_ROWS = `(tags LIKE '%"recovery-for:%' OR tags LIKE '%\\%')`;
const RECOVERY_ORDER = "ORDER BY CASE WHEN state IN ('pending','in-progress','blocked') THEN 0 ELSE 1 END, ts_updated DESC, qitem_id DESC LIMIT 1";
function latestRecovery(db: Database.Database, qitemId: string, terminalOnly = false) {
  const tag = recoveryTag(qitemId);
  return db.prepare(`SELECT qitem_id, state, ts_updated FROM queue_items
    WHERE ${RECOVERY_TAG_ROWS} AND json_valid(tags) AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)
    ${terminalOnly ? "AND state NOT IN ('pending','in-progress','blocked')" : ""}
    ${RECOVERY_ORDER}`)
    .get(tag) as { qitem_id: string; state: string; ts_updated: string } | undefined;
}
export function findQueueRecovery(db: Database.Database, qitemId: string): { qitemId: string; state: string } | null {
  const row = latestRecovery(db, qitemId);
  if (!row) return null;
  if (!["pending", "in-progress", "blocked"].includes(row.state)) {
    if (inputWaitResolution(db, row.qitem_id) !== null) return null;
    const changed = lastMeaningfulTransition(db, qitemId);
    const disposition = lastMeaningfulTransition(db, row.qitem_id);
    if ((changed && disposition && changed.id > disposition.id) || (changed && Date.parse(changed.at) > Date.parse(row.ts_updated)) || Date.parse(failedAttempt(db, qitemId) ?? "") > Date.parse(row.ts_updated)) return null;
  }
  return { qitemId: row.qitem_id, state: row.state };
}
