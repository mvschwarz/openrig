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
 *    current frontier, regardless of state/age. VACUOUS today (single-frontier
 *    close mechanics already remove terminal packets from the frontier — the
 *    non-terminal invariant covers it); armed for the WF-6/parallel-frontier era.
 *    Authored at the merged tip where the frontier schema is final.
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
  // predicate). VACUOUS today (single-frontier close mechanics remove terminal
  // packets from the frontier, and the terminal filter already excludes the
  // non-terminal frontier residents); armed for WF-6/parallel-frontier, where
  // it becomes mechanical rather than assumed. `workflow_instances` is a core
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

  const selectRows = db.prepare(
    `INSERT INTO queue_transitions_archive (
       transition_id, qitem_id, ts, state, transition_note,
       actor_session, closure_reason, closure_target, archived_at
     )
     SELECT transition_id, qitem_id, ts, state, transition_note,
            actor_session, closure_reason, closure_target, ?
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
 * `>=` in the rank subquery means exact-timestamp ties over-KEEP (never
 * over-delete) — the safe direction.
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
                  AND w2.evaluated_at >= wh.evaluated_at
             ) > ?
           LIMIT ?
        )`,
    )
    .run(cutoff, keepPerJob, batchSize);

  return { deletedRows: result.changes };
}

export interface RetentionSweepSummary {
  archivedQitems: number;
  archivedRows: number;
  watchdogDeleted: number;
  transitionBatches: number;
  watchdogBatches: number;
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
    transitionBatches: 0,
    watchdogBatches: 0,
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

  return summary;
}
