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
/** byTag: the rows of each recovery tag value only (`recovery-for:`); byRow: every row with all its string values. */
type RecoveryIndex = { byTag: Map<string, RecoveryRow[]>; byRow: Map<string, RecoveryRow> };
type RecoveryScope = { db: Database.Database; index: RecoveryIndex | null; onBuild?: () => void };
let scope: RecoveryScope | null = null;
/** Statement text of the index read; exported for tests that count how often a listing builds it. */
export const RECOVERY_INDEX_SQL = `SELECT q.qitem_id, q.state, q.ts_updated, j.value AS value
    FROM queue_items q, json_each(q.tags) j
    WHERE ${RECOVERY_TAG_ROWS.replace(/\btags\b/g, "q.tags")} AND json_valid(q.tags) AND typeof(j.value) = 'text'
    ${RECOVERY_ORDER.replace(/ LIMIT 1$/, "").replace(/\b(state|ts_updated|qitem_id)\b/g, "q.$1")}`;
function buildRecoveryIndex(db: Database.Database): RecoveryIndex {
  const rows = db.prepare(RECOVERY_INDEX_SQL).all() as Array<{ qitem_id: string; state: string; ts_updated: string; value: string }>;
  const byRow = new Map<string, RecoveryRow>();
  const byTag = new Map<string, RecoveryRow[]>();
  for (const r of rows) {
    let row = byRow.get(r.qitem_id);
    if (!row) byRow.set(r.qitem_id, row = { qitem_id: r.qitem_id, state: r.state, ts_updated: r.ts_updated, values: new Set() });
    if (row.values.has(r.value)) continue;
    row.values.add(r.value);
    if (!isRecoveryKey(r.value)) continue;
    const list = byTag.get(r.value);
    if (list) list.push(row); else byTag.set(r.value, [row]);
  }
  return { byTag, byRow };
}
/** byTag holds only the values a lookup asks for (recovery tags): the rows of every other value (the stuck sweep's
 *  finding tag is on thousands of rows) were built and kept up to date for nothing. A row's values keep them all, for
 *  excludeTag. */
const isRecoveryKey = (value: string): boolean => value.startsWith("recovery-for:");
const OPEN_STATES = new Set(["pending", "in-progress", "blocked"]);
/** RECOVERY_ORDER as a comparator (ASCII ids and ISO timestamps compare the same in JS as in SQLite). */
function recoveryOrder(a: RecoveryRow, b: RecoveryRow): number {
  const open = (OPEN_STATES.has(a.state) ? 0 : 1) - (OPEN_STATES.has(b.state) ? 0 : 1);
  if (open !== 0) return open;
  if (a.ts_updated !== b.ts_updated) return a.ts_updated < b.ts_updated ? 1 : -1;
  return a.qitem_id === b.qitem_id ? 0 : a.qitem_id < b.qitem_id ? 1 : -1;
}
/** Puts one row, as it now is, into a built index: what a rebuild would read for it. Only for a row whose tags,
 *  state and ts_updated the caller holds exactly (its own write). */
function noteRecoveryRow(index: RecoveryIndex, row: { qitemId: string; state: string; tsUpdated: string; tags: readonly unknown[] | null | undefined }): void {
  const old = index.byRow.get(row.qitemId);
  if (old) {
    for (const value of old.values) {
      if (!isRecoveryKey(value)) continue;
      const list = index.byTag.get(value);
      const at = list?.indexOf(old) ?? -1;
      if (list && at >= 0) list.splice(at, 1);
    }
    index.byRow.delete(row.qitemId);
  }
  const text = JSON.stringify(row.tags ?? []);
  // RECOVERY_TAG_ROWS (LIKE ignores ASCII case) and json_valid: a row the index read would not return stays out.
  if (!Array.isArray(row.tags) || !(/"recovery-for:/i.test(text) || text.includes("\\"))) return;
  const entry: RecoveryRow = { qitem_id: row.qitemId, state: row.state, ts_updated: row.tsUpdated, values: new Set() };
  for (const value of row.tags) if (typeof value === "string") entry.values.add(value);
  index.byRow.set(row.qitemId, entry);
  for (const value of entry.values) {
    if (!isRecoveryKey(value)) continue;
    const list = index.byTag.get(value);
    if (!list) { index.byTag.set(value, [entry]); continue; }
    let at = 0;
    while (at < list.length && recoveryOrder(list[at]!, entry) <= 0) at++;
    list.splice(at, 0, entry);
  }
}
/** Runs `fn` (synchronous) with one lazily built recovery index for `db`: a listing asks findQueueRecovery once
 * per row, and each ask used to json_each every recovery-tagged row. Re-entrant: a nested call shares the scope. */
export function withRecoveryIndex<T>(db: Database.Database, fn: () => T): T {
  if (scope?.db === db) return fn();
  const previous = scope;
  scope = { db, index: null };
  try { return fn(); } finally { scope = previous; }
}
/** findQueueRecovery's live read through queue_recovery_tags (migration 156): a search by the exact tag value instead of
 *  json_each over every tagged row. The table holds exactly the top-level text values of valid JSON tags that start with
 *  `recovery-for:`, so `t.tag = ?` picks the rows the json_each read's `value = ?` picked; excludeTag is still tested on
 *  the row's own tags (they are valid JSON: the row is in the table). Same order. */
export function recoveryLiveSql(withExcludeTag: boolean): string {
  return `SELECT q.qitem_id, q.state, q.ts_updated FROM queue_recovery_tags t JOIN queue_items q ON q.qitem_id = t.qitem_id
    WHERE t.tag = ?${withExcludeTag ? " AND NOT EXISTS (SELECT 1 FROM json_each(q.tags) WHERE value = ?)" : ""}
    ${RECOVERY_ORDER.replace(/\b(state|ts_updated|qitem_id)\b/g, "q.$1")}`;
}
const recoveryTagTables = new WeakMap<Database.Database, boolean>();
/** Whether db has queue_recovery_tags (a database migrated past 156); a test fixture with fewer migrations keeps the
 *  json_each reads. Read once per connection. */
export function hasRecoveryTagTable(db: Database.Database): boolean {
  let has = recoveryTagTables.get(db);
  if (has === undefined) {
    has = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'queue_recovery_tags'").get();
    recoveryTagTables.set(db, has);
  }
  return has;
}
export function findQueueRecovery(db: Database.Database, qitemId: string, excludeTag?: string): { qitemId: string; state: string } | null {
  const tag = recoveryTag(qitemId);
  let row: { qitem_id: string; state: string; ts_updated: string } | undefined;
  if (scope?.db === db) {
    if (!scope.index) { scope.index = buildRecoveryIndex(db); scope.onBuild?.(); }
    row = pickFromIndex(scope.index.byTag, qitemId, excludeTag);
  } else {
    row = db.prepare(hasRecoveryTagTable(db) ? recoveryLiveSql(!!excludeTag) : `SELECT qitem_id, state, ts_updated FROM queue_items
    WHERE ${RECOVERY_TAG_ROWS} AND json_valid(tags) AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)
    ${excludeTag ? "AND NOT EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)" : ""}
    ${RECOVERY_ORDER}`)
      .get(...(excludeTag ? [tag, excludeTag] : [tag])) as { qitem_id: string; state: string; ts_updated: string } | undefined;
  }
  return settleRecovery(db, qitemId, row);
}
function pickFromIndex(byTag: Map<string, RecoveryRow[]>, qitemId: string, excludeTag?: string): RecoveryRow | undefined {
  return (byTag.get(recoveryTag(qitemId)) ?? []).find((r) => !excludeTag || !r.values.has(excludeTag));
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
 * first lookup until invalidate(), and note(row) puts one row the caller itself wrote into it, as a rebuild would read
 * it, without rebuilding. Writes by other code are not in the snapshot: a caller that keeps it across an await or a
 * yield confirms what it decides on with a live read. run(fn) lends it, for the synchronous fn only, to the
 * findQueueRecovery calls made deep inside fn (a getById's waiting view), as withRecoveryIndex does. The final custody
 * check (settleRecovery) always reads live, as findQueueRecovery's does. `builds` counts the index reads. */
export function createRecoveryLookup(db: Database.Database): {
  find: (qitemId: string, excludeTag?: string) => { qitemId: string; state: string } | null;
  run: <T>(fn: () => T) => T;
  note: (row: { qitemId: string; state: string; tsUpdated: string; tags: readonly unknown[] | null | undefined }) => void;
  invalidate: () => void;
  readonly builds: number;
} {
  let builds = 0;
  const own: RecoveryScope = { db, index: null, onBuild: () => { builds++; } };
  const index = (): RecoveryIndex => {
    if (!own.index) { own.index = buildRecoveryIndex(db); builds++; }
    return own.index;
  };
  return {
    find: (qitemId, excludeTag) => settleRecovery(db, qitemId, pickFromIndex(index().byTag, qitemId, excludeTag)),
    run: (fn) => {
      if (scope?.db === db) return fn();
      const previous = scope;
      scope = own;
      try { return fn(); } finally { scope = previous; }
    },
    note: (row) => { if (own.index) noteRecoveryRow(own.index, row); },
    invalidate: () => { own.index = null; },
    get builds() { return builds; },
  };
}
