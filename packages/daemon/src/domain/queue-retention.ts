import type Database from "better-sqlite3";
import { TERMINAL_QUEUE_STATES } from "./queue-repository.js";

/**
 * OPR.0.4.6 FS-1 (daemon read-path hardening) — W2 retention/prune runner.
 *
 * Two tables, two CONTRACTS (arch D3 — never collapsed into one policy):
 *
 *  1. `queue_transitions` = an AUDIT surface with product meaning (chain of
 *     record; `rig queue resolve` decision text). Contract: ARCHIVE, never
 *     plain-delete. A terminal qitem whose LAST transition is older than the
 *     retention window is MOVED (INSERT..SELECT + DELETE in ONE txn) into the
 *     `queue_transitions_archive` sibling (migration 054) — the trail is
 *     preserved, queryable in place, never lost.
 *     THE ACTIVE-FRONTIER INVARIANT (binding, testable): transitions of any
 *     NON-terminal qitem are NEVER touched, at any age. Enforced structurally —
 *     only qitems whose `queue_items.state` is terminal are ever selected.
 *
 *  2b. `usage_samples` (51-08 A2) = telemetry, same contract as watchdog_history:
 *     plain bounded DELETE past the PM-ruled 14d default (`retention.usage_samples_days`).
 *  2. `watchdog_history` = telemetry, no audit contract. Contract: plain DELETE
 *     older than the window, PLUS keep the most recent K per job regardless of
 *     age (respects `idx_watchdog_history_job_recent`, the recent-per-job reader).
 *
 * Runner mechanics: a boot-time sweep + a daily in-daemon maintenance tick (NOT
 * a watchdog policy). Every DB pass is a BOUNDED batch (LIMIT-ed) and the async
 * orchestrator yields to the event loop between batches, so the prune itself can
 * NEVER wedge the loop — the fix must not carry the disease it cures. `nowIso` is
 * injectable for deterministic VM seeding.
 *
 * HONESTY LINE (arch F3): this bounds DB growth, backup size, and any
 * transitions-reading surface. It does NOT move `/api/ps` latency (that is W1's
 * sessions index + N+1 collapse). Kept separate so the ship-gate credits the
 * right fix.
 *
 * ── REBASE-RECONCILE (this module is greenfield-authored on worktree 384e60f1;
 *    the following land against the merged tip, per PLAN §J/§K, NOT this stale
 *    checkout) ──
 *  • P1 — ONE SHARED TERMINAL PREDICATE. Today `queue-repository.ts` has the
 *    terminal set only as INLINE literals (`state === "done" || state ===
 *    "handed-off"` at :522/:663 here; arch cites :550/:691/:1058 at the merged
 *    tip a6c27e74). At rebase, export a single named `TERMINAL_QUEUE_STATES`
 *    from queue-repository, refactor those inline sites to consume it, and
 *    replace this module's local `DEFAULT_TERMINAL_STATES` with that import — a
 *    pure-naming, byte-identical change swept by FUNCTION not line#. Until then
 *    the local default IS the code's terminal set (`['done','handed-off']`), so
 *    behavior is identical; only the SSOT wiring is deferred.
 *  • P2 — FRONTIER-LIVENESS EXCLUSION. Add one WHERE clause (+ one named test)
 *    excluding any qitem referenced in a NON-terminal workflow instance's
 *    current frontier, regardless of state/age. This is active protection for
 *    packet-addressed parallel frontiers; serial close mechanics remain covered
 *    by the same predicate.
 *  • WIRING — register the retention settings keys in `SETTINGS_VALID_KEYS`
 *    (settings-store) and call `runQueueRetentionSweep` from the daemon's
 *    maintenance scheduler (where the watchdog runner is started, index.ts/
 *    server.ts) at boot + on a daily tick. Both integration points live at the
 *    merged tip; wired there.
 */

/**
 * The queue's terminal state set — P1 LANDED: sourced from the SINGLE shared
 * `TERMINAL_QUEUE_STATES` SSOT exported by queue-repository (the same predicate
 * the queue's own closure guards consume via `isTerminalState`), so a future
 * terminal-state addition can never silently diverge the archiver from the queue
 * (arch D3-REFINEMENT P1; widen-never-sibling). `['done','handed-off']` is the
 * full terminal set — done-only would exempt the highest-volume class (workflow
 * step closures exit `handoff -> state=handed-off`).
 */
export const DEFAULT_TERMINAL_STATES = TERMINAL_QUEUE_STATES;

/** Retention defaults (arch D3). BAKED closed-set knobs — registered as settings
 *  keys at rebase; no free-form config. */
export const RETENTION_DEFAULTS = {
  /** archive terminal transitions whose last transition is older than this */
  transitionsRetentionDays: 30,
  /** delete watchdog_history older than this ... */
  watchdogRetentionDays: 14,
  /** ... EXCEPT always keep this many most-recent rows per job */
  watchdogKeepPerJob: 50,
  /** delete usage_samples telemetry older than this (51-08 A2, PM decision 2) */
  usageSamplesRetentionDays: 14,
  /** slice 22 outcome 9: delete unreferenced stream items older than this ... */
  streamRetentionDays: 30,
  /** ... or beyond this many newest unreferenced items, whichever comes first */
  streamMaxItems: 20_000,
  /** rows/qitems touched per bounded batch (the anti-wedge bound) */
  batchSize: 500,
  /** safety cap on batches per table per sweep (defense-in-depth vs a runaway loop) */
  maxBatchesPerTable: 10_000,
} as const;

export interface RetentionOptions {
  /** injected clock (ISO-8601); deterministic for VM seeding */
  nowIso: string;
  terminalStates?: readonly string[];
  transitionsRetentionDays?: number;
  watchdogRetentionDays?: number;
  watchdogKeepPerJob?: number;
  usageSamplesRetentionDays?: number;
  streamRetentionDays?: number;
  streamMaxItems?: number;
  batchSize?: number;
  maxBatchesPerTable?: number;
}

/** ISO cutoff = now minus `days`. Pure; derived from the injected `nowIso` so
 *  the same seed always yields the same boundary (no ambient Date). */
function cutoffIso(nowIso: string, days: number): string {
  const now = new Date(nowIso);
  if (Number.isNaN(now.getTime())) {
    throw new Error(`queue-retention: invalid nowIso ${JSON.stringify(nowIso)}`);
  }
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

/** Cooperative yield between bounded batches so a large prune cannot starve the
 *  event loop (better-sqlite3 is synchronous — each batch runs to completion,
 *  the yield is what keeps the loop responsive across batches). */
function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export interface ArchiveBatchResult {
  /** distinct terminal qitems whose transitions were archived this batch */
  archivedQitems: number;
  /** transition rows moved this batch */
  archivedRows: number;
}

/**
 * ONE bounded batch: move (archive-then-delete, single txn per qitem) the
 * transitions of up to `batchSize` TERMINAL qitems whose LAST transition is
 * older than the cutoff. Returns the counts so the orchestrator can loop until
 * a batch is empty. Non-terminal qitems are never selected (active-frontier
 * invariant, structural).
 */
export function archiveAgedTerminalTransitions(
  db: Database.Database,
  opts: RetentionOptions,
): ArchiveBatchResult {
  const terminalStates = opts.terminalStates ?? DEFAULT_TERMINAL_STATES;
  const batchSize = opts.batchSize ?? RETENTION_DEFAULTS.batchSize;
  const cutoff = cutoffIso(
    opts.nowIso,
    opts.transitionsRetentionDays ?? RETENTION_DEFAULTS.transitionsRetentionDays,
  );

  // Eligible = terminal qitems whose newest transition predates the cutoff.
  // Driven off queue_items (terminal filter) with a correlated MAX(ts) that
  // rides idx_queue_transitions_qitem (qitem_id, ts). LIMIT bounds the batch.
  //
  // P2 (arch, frontier-liveness exclusion): the AND NOT EXISTS below NEVER
  // archives a terminal qitem still referenced by a LIVE (active/waiting)
  // workflow instance's current frontier. It MIRRORS the queue-CLOSE-path
  // sibling `createWorkflowFrontierPredicate` (workflow-frontier-guard.ts,
  // WF3 FR-6) — same invariant (`status IN ('active','waiting')` +
  // `current_frontier_json LIKE '%"<qitemId>"%'`), enforced here at the
  // ARCHIVAL-SELECTION seam instead of the close seam (orch ruling: keep this
  // maintenance module standalone/DB-scoped rather than threading the injected
  // predicate). It now protects packet-addressed parallel frontiers as well as
  // the legacy serial case. `workflow_instances` is a core
  // migrated table (always present when the tick runs post-migration).
  const placeholders = terminalStates.map(() => "?").join(", ");
  const eligible = db
    .prepare(
      `SELECT q.qitem_id AS qitemId
         FROM queue_items q
        WHERE q.state IN (${placeholders})
          AND (
            SELECT MAX(t.ts) FROM queue_transitions t WHERE t.qitem_id = q.qitem_id
          ) < ?
          AND NOT EXISTS (
            SELECT 1 FROM workflow_instances wi
             WHERE wi.status IN ('active','waiting')
               AND wi.current_frontier_json LIKE '%"' || q.qitem_id || '"%'
          )
        LIMIT ?`,
    )
    .all(...terminalStates, cutoff, batchSize) as Array<{ qitemId: string }>;

  if (eligible.length === 0) {
    return { archivedQitems: 0, archivedRows: 0 };
  }

  const activeColumns = new Set(
    (db.prepare("PRAGMA table_info(queue_transitions)").all() as Array<{ name: string }>).map((row) => row.name),
  );
  const archiveColumns = new Set(
    (db.prepare("PRAGMA table_info(queue_transitions_archive)").all() as Array<{ name: string }>).map((row) => row.name),
  );
  if (activeColumns.has("identity_provenance") && !archiveColumns.has("identity_provenance")) {
    throw new Error("queue-retention: archive lacks identity_provenance; apply migrations before archiving");
  }
  const identityColumn = activeColumns.has("identity_provenance") ? ", identity_provenance" : "";
  const carriesOwnerNotification = ["owner_notification_kind", "owner_notification_level"]
    .every((column) => activeColumns.has(column) && archiveColumns.has(column));
  const ownerInsert = carriesOwnerNotification ? ", owner_notification_kind, owner_notification_level" : "";
  const ownerSelect = carriesOwnerNotification ? ", owner_notification_kind, owner_notification_level" : "";
  const selectRows = db.prepare(
    `INSERT INTO queue_transitions_archive (
       transition_id, qitem_id, ts, state, transition_note,
       actor_session, closure_reason, closure_target${identityColumn}${ownerInsert}, archived_at
     )
     SELECT transition_id, qitem_id, ts, state, transition_note,
            actor_session, closure_reason, closure_target${identityColumn}${ownerSelect}, ?
       FROM queue_transitions
      WHERE qitem_id = ?`,
  );
  const deleteRows = db.prepare(`DELETE FROM queue_transitions WHERE qitem_id = ?`);

  // One transaction PER qitem: the move for a given qitem is all-or-nothing, and
  // a batch that fails partway leaves already-moved qitems durably archived.
  const moveOne = db.transaction((qitemId: string): number => {
    const inserted = selectRows.run(opts.nowIso, qitemId).changes;
    deleteRows.run(qitemId);
    return inserted;
  });

  let archivedRows = 0;
  for (const { qitemId } of eligible) {
    archivedRows += moveOne(qitemId);
  }
  return { archivedQitems: eligible.length, archivedRows };
}

export interface PruneBatchResult {
  /** watchdog_history rows deleted this batch */
  deletedRows: number;
}

/**
 * ONE bounded batch: DELETE up to `batchSize` watchdog_history rows that are
 * older than the cutoff AND outside the most-recent-K per job. The per-job
 * recency rank rides idx_watchdog_history_job_recent (job_id, evaluated_at DESC).
 * Count strictly newer rows so exact-timestamp ties at the keep boundary
 * over-KEEP (never over-delete) — the safe direction.
 */
export function pruneWatchdogHistory(
  db: Database.Database,
  opts: RetentionOptions,
): PruneBatchResult {
  const batchSize = opts.batchSize ?? RETENTION_DEFAULTS.batchSize;
  const keepPerJob = opts.watchdogKeepPerJob ?? RETENTION_DEFAULTS.watchdogKeepPerJob;
  const cutoff = cutoffIso(
    opts.nowIso,
    opts.watchdogRetentionDays ?? RETENTION_DEFAULTS.watchdogRetentionDays,
  );

  const result = db
    .prepare(
      `DELETE FROM watchdog_history
        WHERE history_id IN (
          SELECT wh.history_id
            FROM watchdog_history wh
           WHERE wh.evaluated_at < ?
             AND (
               SELECT COUNT(*) FROM watchdog_history w2
                WHERE w2.job_id = wh.job_id
                  AND w2.evaluated_at > wh.evaluated_at
             ) >= ?
           LIMIT ?
        )`,
    )
    .run(cutoff, keepPerJob, batchSize);

  return { deletedRows: result.changes };
}

/**
 * 51-08 A2 — ONE bounded batch: DELETE up to `batchSize` usage_samples rows
 * whose captured_at predates the retention cutoff (PM-ruled default 14d,
 * tunable). usage_samples is TELEMETRY under the watchdog_history contract —
 * plain delete, no audit archive. A seat idle past the window loses its rows;
 * the query surfaces render honest-unknown, never a preserved stale value.
 * `<` semantics: an exact-cutoff row survives (over-keep, the safe direction).
 */
export function pruneUsageSamples(
  db: Database.Database,
  opts: RetentionOptions,
): PruneBatchResult {
  const batchSize = opts.batchSize ?? RETENTION_DEFAULTS.batchSize;
  const cutoff = cutoffIso(
    opts.nowIso,
    opts.usageSamplesRetentionDays ?? RETENTION_DEFAULTS.usageSamplesRetentionDays,
  );
  const result = db
    .prepare(
      `DELETE FROM usage_samples
        WHERE id IN (
          SELECT id FROM usage_samples WHERE captured_at < ? LIMIT ?
        )`,
    )
    .run(cutoff, batchSize);
  return { deletedRows: result.changes };
}

/**
 * Slice 22 outcome 9 — ONE bounded batch of stream retention: delete up to `batchSize` stream items that nothing
 * references (no classification, duplicate link, classification attempt, disposition or reader action names them) and that are
 * older than the window or beyond the newest `streamMaxItems` unreferenced items. Referenced items are kept at any
 * age, so custody and outcome links survive. The newest pruned position is recorded in `stream_retention_marks`,
 * where a reader whose cursor is behind it is told about the gap. Items at or below the pre-upgrade floor
 * (`stream_retention_floor`, migration 131) are never pruned and don't count toward the cap: history that existed
 * before retention arrived is kept. Skips when the stream tables aren't present.
 */
export function pruneStreamItems(
  db: Database.Database,
  opts: RetentionOptions,
): PruneBatchResult {
  const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((r) => r.name));
  if (!tables.has("stream_items") || !tables.has("stream_retention_marks")) return { deletedRows: 0 };
  const columns = (table: string) => new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name));
  // One uncorrelated list of referenced ids, built once per statement (NULLs excluded so NOT IN can't turn NULL).
  const lists: string[] = [];
  if (tables.has("project_classifications")) {
    lists.push("SELECT stream_item_id FROM project_classifications WHERE stream_item_id IS NOT NULL");
    if (columns("project_classifications").has("duplicate_of_stream_item_id")) {
      lists.push("SELECT duplicate_of_stream_item_id FROM project_classifications WHERE duplicate_of_stream_item_id IS NOT NULL");
    }
  }
  if (tables.has("classification_attempts")) lists.push("SELECT stream_item_id FROM classification_attempts WHERE stream_item_id IS NOT NULL");
  if (tables.has("stream_dispositions")) lists.push("SELECT stream_item_id FROM stream_dispositions WHERE stream_item_id IS NOT NULL");
  if (tables.has("stream_reader_actions")) {
    lists.push("SELECT stream_item_id FROM stream_reader_actions WHERE stream_item_id IS NOT NULL");
    // A duplicate action names the item it repeats; keep that item too, for corrected (historical) actions as well.
    lists.push("SELECT duplicate_of FROM stream_reader_actions WHERE duplicate_of IS NOT NULL");
  }
  const refs = (alias: string): string => lists.length ? `${alias}.stream_item_id NOT IN (${lists.join(" UNION ")})` : "1";
  const floor = tables.has("stream_retention_floor")
    ? db.prepare("SELECT floor_ts AS ts, floor_key AS key FROM stream_retention_floor WHERE id = 1").get() as { ts: string; key: string } | undefined
    : undefined;
  const above = (alias: string) => floor ? ` AND (${alias}.ts_emitted, ${alias}.stream_sort_key) > (?, ?)` : "";
  const floorParams = floor ? [floor.ts, floor.key] : [];
  const batchSize = opts.batchSize ?? RETENTION_DEFAULTS.batchSize;
  const maxItems = opts.streamMaxItems ?? RETENTION_DEFAULTS.streamMaxItems;
  const cutoff = cutoffIso(opts.nowIso, opts.streamRetentionDays ?? RETENTION_DEFAULTS.streamRetentionDays);
  // The oldest kept item under the count cap is the maxItems-th newest unreferenced one; anything older goes.
  const doomed = db.prepare(
    `SELECT s.stream_item_id AS id, s.ts_emitted AS ts, s.stream_sort_key AS key FROM stream_items s
      WHERE ${refs("s")}${above("s")}
        AND (s.ts_emitted < ? OR (s.ts_emitted, s.stream_sort_key) < (
          SELECT k.ts_emitted, k.stream_sort_key FROM stream_items k WHERE ${refs("k")}${above("k")}
           ORDER BY k.ts_emitted DESC, k.stream_sort_key DESC LIMIT 1 OFFSET ?))
      ORDER BY s.ts_emitted, s.stream_sort_key LIMIT ?`,
  ).all(...floorParams, cutoff, ...floorParams, Math.max(0, maxItems - 1), batchSize) as Array<{ id: string; ts: string; key: string }>;
  if (doomed.length === 0) return { deletedRows: 0 };
  const last = doomed[doomed.length - 1]!;
  const remove = db.prepare("DELETE FROM stream_items WHERE stream_item_id = ?");
  const prior = db.prepare("SELECT pruned_through_ts AS ts, pruned_through_key AS key FROM stream_retention_marks WHERE id = 1");
  const mark = db.prepare(
    `INSERT INTO stream_retention_marks (id, pruned_through_ts, pruned_through_key, pruned_items, pruned_at) VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET pruned_through_ts = excluded.pruned_through_ts, pruned_through_key = excluded.pruned_through_key,
       pruned_items = pruned_items + excluded.pruned_items, pruned_at = excluded.pruned_at`,
  );
  let deleted = 0;
  db.transaction(() => {
    for (const d of doomed) deleted += remove.run(d.id).changes;
    const p = prior.get() as { ts: string; key: string } | undefined;
    const ahead = !p || p.ts < last.ts || (p.ts === last.ts && p.key < last.key);
    mark.run(ahead ? last.ts : p!.ts, ahead ? last.key : p!.key, deleted, opts.nowIso);
  })();
  return { deletedRows: deleted };
}

export interface RetentionSweepSummary {
  archivedQitems: number;
  archivedRows: number;
  watchdogDeleted: number;
  usageSamplesDeleted: number;
  streamDeleted: number;
  transitionBatches: number;
  watchdogBatches: number;
  usageSamplesBatches: number;
  streamBatches: number;
}

/**
 * The boot-sweep / daily-tick entry point: drain both retention passes in
 * bounded batches, yielding to the event loop between batches so a large
 * backlog can never wedge the daemon. Idempotent and safe to run on every boot.
 * Each pass stops when a batch is empty or the safety batch-cap is hit.
 */
export async function runQueueRetentionSweep(
  db: Database.Database,
  opts: RetentionOptions,
): Promise<RetentionSweepSummary> {
  const maxBatches = opts.maxBatchesPerTable ?? RETENTION_DEFAULTS.maxBatchesPerTable;
  const summary: RetentionSweepSummary = {
    archivedQitems: 0,
    archivedRows: 0,
    watchdogDeleted: 0,
    usageSamplesDeleted: 0,
    streamDeleted: 0,
    transitionBatches: 0,
    watchdogBatches: 0,
    usageSamplesBatches: 0,
    streamBatches: 0,
  };

  for (let i = 0; i < maxBatches; i++) {
    const batch = archiveAgedTerminalTransitions(db, opts);
    if (batch.archivedQitems === 0) break;
    summary.archivedQitems += batch.archivedQitems;
    summary.archivedRows += batch.archivedRows;
    summary.transitionBatches++;
    await yieldToLoop();
  }

  for (let i = 0; i < maxBatches; i++) {
    const batch = pruneWatchdogHistory(db, opts);
    if (batch.deletedRows === 0) break;
    summary.watchdogDeleted += batch.deletedRows;
    summary.watchdogBatches++;
    await yieldToLoop();
  }

  for (let i = 0; i < maxBatches; i++) {
    const batch = pruneUsageSamples(db, opts);
    if (batch.deletedRows === 0) break;
    summary.usageSamplesDeleted += batch.deletedRows;
    summary.usageSamplesBatches++;
    await yieldToLoop();
  }

  for (let i = 0; i < maxBatches; i++) {
    const batch = pruneStreamItems(db, opts);
    if (batch.deletedRows === 0) break;
    summary.streamDeleted += batch.deletedRows;
    summary.streamBatches++;
    await yieldToLoop();
  }

  return summary;
}
