import type { Migration } from "../migrate.js";

/**
 * OPR.0.4.6 FS-1 (daemon read-path hardening, W2) — queue_transitions ARCHIVE
 * sibling table (arch D3: ARCHIVE-never-plain-delete for the audit surface).
 *
 * `queue_transitions` is an AUDIT surface with product meaning (chain of record;
 * `rig queue resolve` records decision text here) — INSERT-ONLY today, no prune
 * path exists, so it grows unbounded (13691 rows on the incident fixture) and
 * bloats backups + any transitions-reading surface. Arch D3 ruling: NEVER
 * plain-delete; MOVE terminal-and-aged transitions into this sibling table, in
 * the SAME transaction, so the audit trail is preserved (queryable in place),
 * not lost.
 *
 * Schema MIRRORS `queue_transitions` (025) column-for-column so a move is a
 * single `INSERT INTO queue_transitions_archive (...) SELECT ... FROM
 * queue_transitions WHERE ...` + `DELETE`, both inside one txn. `transition_id`
 * is a plain PRIMARY KEY (NOT AUTOINCREMENT) so archived rows KEEP their original
 * id — audit references stay resolvable across the move. `archived_at` records
 * when the row was archived (provenance; the source `ts` is preserved untouched).
 *
 * THE ACTIVE-FRONTIER INVARIANT (enforced by the W2 runner, not this migration):
 * only transitions of TERMINAL qitems whose LAST transition is older than the
 * retention window (default 30d) are ever moved; a non-terminal qitem's full
 * transition history is never touched, at any age. The move runner + retention
 * knobs land in the W2 maintenance-tick change; this migration is the sibling
 * table + its read index only (additive; no data change to `queue_transitions`).
 *
 * Number 054: renumbered 052→054 with the FS-1 index (053) after the
 * 051_workflow_resume ship + FAC-1's 052 reservation (orch deconflict
 * 2026-07-06; re-verify against the final merged tree at rebase/proof time).
 * The archive table + index names are unchanged.
 */
export const queueTransitionsArchiveSchema: Migration = {
  name: "054_queue_transitions_archive.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS queue_transitions_archive (
      transition_id INTEGER PRIMARY KEY,
      qitem_id TEXT NOT NULL,
      ts TEXT NOT NULL,
      state TEXT NOT NULL,
      transition_note TEXT,
      actor_session TEXT NOT NULL,
      closure_reason TEXT,
      closure_target TEXT,
      archived_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_queue_transitions_archive_qitem ON queue_transitions_archive(qitem_id, ts);
  `,
};
