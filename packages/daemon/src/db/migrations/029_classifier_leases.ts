import type { Migration } from "../migrate.js";

/**
 * Classifier leases (PL-004 Phase B; L2 founder-resolved single-writer lease).
 *
 * Per PRD § L2: agent-backed classifier with daemon-enforced single-writer
 * lease (TTL-based) + deadness detection (via whoami-service / node-inventory)
 * + operator-verb reclaim. Single-writer enforced via partial UNIQUE index
 * on state='active' (SQLite >= 3.8 supports partial indexes; OpenRig's
 * better-sqlite3 ships SQLite 3.45+ so this is safe).
 *
 * State enum: active | expired | reclaimed
 *   active    — lease is current; classifier_session may project
 *   expired   — TTL passed AND heartbeat went stale; lease no longer valid
 *   reclaimed — operator-verb reclaim took the lease away from the previous holder
 *
 * Reclaim is OPERATOR-VERB ONLY: rig project --reclaim-classifier [--if-dead].
 * Daemon does NOT auto-reclaim on its own evaluation. expired→active requires
 * an explicit acquire call from a NEW classifier session (which gets a new
 * lease_id row).
 */
export const classifierLeasesSchema: Migration = {
  name: "029_classifier_leases.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS classifier_leases (
      lease_id TEXT PRIMARY KEY,
      classifier_session TEXT NOT NULL,
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_heartbeat TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active',
      reclaimed_by_session TEXT,
      reclaim_reason TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_classifier_leases_active_singleton
      ON classifier_leases(state) WHERE state = 'active';
    CREATE INDEX IF NOT EXISTS idx_classifier_leases_classifier_session
      ON classifier_leases(classifier_session);
    CREATE INDEX IF NOT EXISTS idx_classifier_leases_expires_at
      ON classifier_leases(expires_at) WHERE state = 'active';
  `,
};
