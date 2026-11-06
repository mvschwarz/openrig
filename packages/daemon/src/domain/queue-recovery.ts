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
export function recoveryId(db: Database.Database, qitemId: string, overdueDeadline?: string): string {
  const evidence: unknown[] = [qitemId, lastMeaningfulTransition(db, qitemId)?.id ?? null, failedAttempt(db, qitemId)];
  // Keep existing IDs byte-for-byte unless a newer deadline needs its own recovery episode.
  if (overdueDeadline !== undefined) evidence.push(["overdue-claim", overdueDeadline]);
  return `qitem-recovery-${createHash("sha256").update(JSON.stringify(evidence)).digest("hex").slice(0, 16)}`;
}
/** Rows whose tag text could hold a recovery tag: valid JSON stores a string verbatim or with
 * backslash escapes, so this superset loses no exact match. It repeats the first group of
 * idx_queue_items_recovery_tags' WHERE clause (migration 099) byte for byte, which is what lets the
 * planner read that small index instead of scanning and parsing every row. */
const RECOVERY_TAG_ROWS = `(tags LIKE '%"recovery-for:%' OR tags LIKE '%\\%')`;
const RECOVERY_ORDER = "ORDER BY CASE WHEN state IN ('pending','in-progress','blocked') THEN 0 ELSE 1 END, ts_updated DESC, qitem_id DESC LIMIT 1";
/** A listing's recovery index, built by SQLite's own json_each (the same values, and the same truthy excludeTag
 * test, as the per-row query): for each string tag value, the rows that carry it in RECOVERY_ORDER, and each row's
 * string values. Built lazily, on the first lookup inside `withRecoveryIndex`, so a listing that never asks (a
 * compact one) pays nothing; scoped to that synchronous span, so no write can land between the read and its use.
 * Outside it every lookup is the original query. */
type RecoveryRow = { qitem_id: string; state: string; ts_updated: string; values: Set<string> };
type RecoveryScope = { db: Database.Database; byTag: Map<string, RecoveryRow[]> | null };
let scope: RecoveryScope | null = null;
/** Statement text of the index read; exported for tests that count how often a listing builds it. */
export const RECOVERY_INDEX_SQL = `SELECT q.qitem_id, q.state, q.ts_updated, j.value AS value
    FROM queue_items q, json_each(q.tags) j
    WHERE ${RECOVERY_TAG_ROWS.replace(/\btags\b/g, "q.tags")} AND json_valid(q.tags) AND typeof(j.value) = 'text'
    ${RECOVERY_ORDER.replace(/ LIMIT 1$/, "").replace(/\b(state|ts_updated|qitem_id)\b/g, "q.$1")}`;
function buildRecoveryIndex(db: Database.Database): Map<string, RecoveryRow[]> {
  const rows = db.prepare(RECOVERY_INDEX_SQL).all() as Array<{ qitem_id: string; state: string; ts_updated: string; value: string }>;
  const byRow = new Map<string, RecoveryRow>();
  const byTag = new Map<string, RecoveryRow[]>();
  for (const r of rows) {
    let row = byRow.get(r.qitem_id);
    if (!row) byRow.set(r.qitem_id, row = { qitem_id: r.qitem_id, state: r.state, ts_updated: r.ts_updated, values: new Set() });
    if (row.values.has(r.value)) continue;
    row.values.add(r.value);
    const list = byTag.get(r.value);
    if (list) list.push(row); else byTag.set(r.value, [row]);
  }
  return byTag;
}
/** Runs `fn` (synchronous) with one lazily built recovery index for `db`: a listing asks findQueueRecovery once
 * per row, and each ask used to json_each every recovery-tagged row. Re-entrant: a nested call shares the scope. */
export function withRecoveryIndex<T>(db: Database.Database, fn: () => T): T {
  if (scope?.db === db) return fn();
  const previous = scope;
  scope = { db, byTag: null };
  try { return fn(); } finally { scope = previous; }
}
export function findQueueRecovery(db: Database.Database, qitemId: string, excludeTag?: string): { qitemId: string; state: string } | null {
  const tag = recoveryTag(qitemId);
  let row: { qitem_id: string; state: string; ts_updated: string } | undefined;
  if (scope?.db === db) {
    const byTag = scope.byTag ??= buildRecoveryIndex(db);
    row = (byTag.get(tag) ?? []).find((r) => !excludeTag || !r.values.has(excludeTag));
  } else {
    row = db.prepare(`SELECT qitem_id, state, ts_updated FROM queue_items
    WHERE ${RECOVERY_TAG_ROWS} AND json_valid(tags) AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)
    ${excludeTag ? "AND NOT EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)" : ""}
    ${RECOVERY_ORDER}`)
      .get(...(excludeTag ? [tag, excludeTag] : [tag])) as { qitem_id: string; state: string; ts_updated: string } | undefined;
  }
  if (!row) return null;
  if (!["pending", "in-progress", "blocked"].includes(row.state)) {
    const changed = lastMeaningfulTransition(db, qitemId);
    const disposition = lastMeaningfulTransition(db, row.qitem_id);
    if ((changed && disposition && changed.id > disposition.id) || (changed && Date.parse(changed.at) > Date.parse(row.ts_updated)) || Date.parse(failedAttempt(db, qitemId) ?? "") > Date.parse(row.ts_updated)) return null;
  }
  return { qitemId: row.qitem_id, state: row.state };
}
