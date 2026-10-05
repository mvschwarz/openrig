import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { lastMeaningfulTransition } from "./queue-waiting.js";

/** Common provenance on existing diagnostic queue rows, never a second ledger.
 * Both deadline and delivery detectors consult the same recovery disposition. */
export const recoveryTag = (qitemId: string): string => `recovery-for:${qitemId}`;
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
  return `qitem-recovery-${createHash("sha256").update(JSON.stringify([qitemId, lastMeaningfulTransition(db, qitemId)?.id ?? null, failedAttempt(db, qitemId)])).digest("hex").slice(0, 16)}`;
}
export function findQueueRecovery(db: Database.Database, qitemId: string): { qitemId: string; state: string } | null {
  const row = db.prepare(`SELECT qitem_id, state, ts_updated FROM queue_items
    WHERE json_valid(tags) AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)
    ORDER BY CASE WHEN state IN ('pending','in-progress','blocked') THEN 0 ELSE 1 END, ts_updated DESC, qitem_id DESC LIMIT 1`)
    .get(recoveryTag(qitemId)) as { qitem_id: string; state: string; ts_updated: string } | undefined;
  if (!row) return null;
  if (!["pending", "in-progress", "blocked"].includes(row.state)) {
    const changed = lastMeaningfulTransition(db, qitemId);
    const disposition = lastMeaningfulTransition(db, row.qitem_id);
    if ((changed && disposition && changed.id > disposition.id) || (changed && Date.parse(changed.at) > Date.parse(row.ts_updated)) || Date.parse(failedAttempt(db, qitemId) ?? "") > Date.parse(row.ts_updated)) return null;
  }
  return { qitemId: row.qitem_id, state: row.state };
}
