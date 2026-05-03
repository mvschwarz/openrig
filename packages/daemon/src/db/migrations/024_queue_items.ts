import type { Migration } from "../migrate.js";

/**
 * L3 — Queue (PL-004 Phase A).
 *
 * Owned work for a specific seat. Carries state, provenance, the closure
 * obligation, and the daemon-tracked nudge result. Live runtime state is
 * SQLite-canonical; markdown queue mirrors are read-only debug/export only.
 *
 * State enum (validated at the domain layer):
 *   pending | in-progress | done | blocked | failed | denied | canceled | handed-off
 *
 * Closure-reason enum (required on `done` transitions; hot-potato strict-rejection):
 *   handed_off_to | blocked_on | denied | canceled | no-follow-on | escalation
 *
 * `chain_of_record` and `tags` carry JSON arrays (TEXT-encoded) for forward
 * compat with structured query layers.
 */
export const queueItemsSchema: Migration = {
  name: "024_queue_items.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS queue_items (
      qitem_id TEXT PRIMARY KEY,
      ts_created TEXT NOT NULL,
      ts_updated TEXT NOT NULL,
      source_session TEXT NOT NULL,
      destination_session TEXT NOT NULL,
      state TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'routine',
      tier TEXT,
      tags TEXT,
      blocked_on TEXT,
      handed_off_to TEXT,
      handed_off_from TEXT,
      expires_at TEXT,
      chain_of_record TEXT,
      body TEXT NOT NULL,
      closure_reason TEXT,
      closure_target TEXT,
      closure_required_at TEXT,
      claimed_at TEXT,
      last_nudge_attempt TEXT,
      last_nudge_result TEXT,
      last_heartbeat TEXT,
      resolution TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_queue_items_destination_state ON queue_items(destination_session, state);
    CREATE INDEX IF NOT EXISTS idx_queue_items_source ON queue_items(source_session);
    CREATE INDEX IF NOT EXISTS idx_queue_items_state ON queue_items(state);
    CREATE INDEX IF NOT EXISTS idx_queue_items_handed_off_to ON queue_items(handed_off_to);
    CREATE INDEX IF NOT EXISTS idx_queue_items_closure_overdue ON queue_items(state, closure_required_at) WHERE state = 'in-progress';
  `,
};
