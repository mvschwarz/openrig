import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { lastMeaningfulTransition } from "./queue-waiting.js";

/** Common provenance on existing diagnostic queue rows, never a second ledger.
 * Both deadline and delivery detectors consult the same recovery disposition. */
export const recoveryTag = (qitemId: string): string => `recovery-for:${qitemId}`;
/** #2988: a per-row stuck-sweep finding the sweep folded into a delegation parent's standing unclaimed-backlog notice. It
 *  was closed by that fold, not by anyone acting on the row, so it no longer owns the row: every recovery lookup skips
 *  it, and the row reads as one that never had a finding of its own (the notice now stands for it). */
export const BACKLOG_FOLDED_TAG = "stuck-sweep-folded-into-backlog";
function failedAttempt(db: Database.Database, qitemId: string): string | null {
  // A typing-guard refusal (retained:) is newer evidence about the original
  // obligation exactly like a failed nudge: a wake WAS offered after the
  // recovery disposition was written (#344). Without this arm the refusal was
  // invisible here — ladder attempt markers never count as meaningful
  // transitions — so a terminal recovery stayed fresh forever and suppressed
  // the unclaimed baton's retry path.
  return (db.prepare("SELECT last_nudge_attempt AS at FROM queue_items WHERE qitem_id = ? AND (last_nudge_result LIKE 'failed:%' OR last_nudge_result LIKE 'retained:%')").get(qitemId) as { at: string | null } | undefined)?.at ?? null;
}
export function recoveryId(db: Database.Database, qitemId: string, overdueDeadline?: string, afterFolded?: string): string {
  const evidence: unknown[] = [qitemId, lastMeaningfulTransition(db, qitemId)?.id ?? null, failedAttempt(db, qitemId)];
  // Keep existing IDs byte-for-byte unless a newer deadline needs its own recovery episode.
  if (overdueDeadline !== undefined) evidence.push(["overdue-claim", overdueDeadline]);
  // A folded finding (#2988) took this row's id without owning it: a new finding is a new episode.
  if (afterFolded !== undefined) evidence.push(["after-folded", afterFolded]);
  return `qitem-recovery-${createHash("sha256").update(JSON.stringify(evidence)).digest("hex").slice(0, 16)}`;
}
/** The id a new recovery for this row's current episode takes: recoveryId, past every finding the stuck sweep folded into a
 *  backlog notice (#2988). A fold holds its id without owning the row, and the same episode can be folded more than once
 *  (the route to the parent comes and goes), so each folded id chains one level further until an id is free. Every level
 *  exists only as a row that was created and folded, so the chain ends. */
export function freshRecoveryId(db: Database.Database, qitemId: string, overdueDeadline?: string): string {
  const folded = db.prepare(`SELECT 1 FROM queue_items WHERE qitem_id = ? AND json_valid(tags)
    AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)`);
  let id = recoveryId(db, qitemId, overdueDeadline);
  while (folded.get(id, BACKLOG_FOLDED_TAG)) id = recoveryId(db, qitemId, overdueDeadline, id);
  return id;
}
/** Rows whose tag text could hold a recovery tag: valid JSON stores a string verbatim or with
 * backslash escapes, so this superset loses no exact match. It repeats the first group of
 * idx_queue_items_recovery_tags' WHERE clause (migration 099) byte for byte, which is what lets the
 * planner read that small index instead of scanning and parsing every row. */
const RECOVERY_TAG_ROWS = `(tags LIKE '%"recovery-for:%' OR tags LIKE '%\\%')`;
// Unary + preserves the numeric CASE order but prevents a prefix match on the full-history listing
// index. Both standalone lookups and the batch need the small recovery-tag index instead.
const RECOVERY_ORDER = "ORDER BY +CASE WHEN state IN ('pending','in-progress','blocked') THEN 0 ELSE 1 END, ts_updated DESC, qitem_id DESC LIMIT 1";
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
    row = pickFromIndex(byTag, qitemId, excludeTag);
  } else {
    row = db.prepare(`SELECT qitem_id, state, ts_updated FROM queue_items
    WHERE ${RECOVERY_TAG_ROWS} AND json_valid(tags) AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)
    AND NOT EXISTS (SELECT 1 FROM json_each(tags) WHERE value = '${BACKLOG_FOLDED_TAG}')
    ${excludeTag ? "AND NOT EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)" : ""}
    ${RECOVERY_ORDER}`)
      .get(...(excludeTag ? [tag, excludeTag] : [tag])) as { qitem_id: string; state: string; ts_updated: string } | undefined;
  }
  return settleRecovery(db, qitemId, row);
}
function pickFromIndex(byTag: Map<string, RecoveryRow[]>, qitemId: string, excludeTag?: string): RecoveryRow | undefined {
  return (byTag.get(recoveryTag(qitemId)) ?? []).find((r) => !r.values.has(BACKLOG_FOLDED_TAG) && (!excludeTag || !r.values.has(excludeTag)));
}
/** The chosen recovery row still owns custody unless it is closed and the original obligation moved after it. */
function settleRecovery(db: Database.Database, qitemId: string, row: { qitem_id: string; state: string; ts_updated: string } | undefined): { qitemId: string; state: string } | null {
  if (!row) return null;
  if (!["pending", "in-progress", "blocked"].includes(row.state)) {
    const changed = lastMeaningfulTransition(db, qitemId);
    const disposition = lastMeaningfulTransition(db, row.qitem_id);
    if ((changed && disposition && changed.id > disposition.id) || (changed && Date.parse(changed.at) > Date.parse(row.ts_updated)) || Date.parse(failedAttempt(db, qitemId) ?? "") > Date.parse(row.ts_updated)) return null;
  }
  return { qitemId: row.qitem_id, state: row.state };
}
/** The same recovery index as withRecoveryIndex, held by its caller instead of the module scope, for a pass that awaits
 * or yields between lookups (the stuck sweep): an await never exposes it to other callers. It is a snapshot from its
 * first lookup until invalidate(); the caller invalidates it whenever other code could have run (after an await or a
 * yield) or it wrote recovery tags, state or ts_updated itself, and the next lookup rebuilds it. run(fn) lends it, for
 * the synchronous fn only, to the findQueueRecovery calls made deep inside fn (a getById's waiting view), as
 * withRecoveryIndex does. The final custody check (settleRecovery) always reads live, as findQueueRecovery's does. */
export function createRecoveryLookup(db: Database.Database): {
  find: (qitemId: string, excludeTag?: string) => { qitemId: string; state: string } | null;
  run: <T>(fn: () => T) => T;
  invalidate: () => void;
} {
  const own: RecoveryScope = { db, byTag: null };
  return {
    find: (qitemId, excludeTag) => settleRecovery(db, qitemId, pickFromIndex(own.byTag ??= buildRecoveryIndex(db), qitemId, excludeTag)),
    run: (fn) => {
      if (scope?.db === db) return fn();
      const previous = scope;
      scope = own;
      try { return fn(); } finally { scope = previous; }
    },
    invalidate: () => { own.byTag = null; },
  };
}
