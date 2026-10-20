import type { Migration } from "../migrate.js";

/**
 * Writer authority leases.
 *
 * Fenced exclusive writer over a named protected resource
 * (`candidate` | `integration_branch` | `publish_target`). Generation increments
 * on every successful acquire/transfer so revoke invalidates prior holders.
 * Partial UNIQUE on (resource_kind, resource_id) WHERE state='active' enforces
 * single-writer when processes share the DB.
 *
 * Note: the private fork used `085_writer_authority_leases`; upstream already
 * shipped `085_rig_claude_managed_block_file`, and main later took `118` for
 * human quiet windows (#1584), so this extract lands as 119.
 */
export const writerAuthorityLeasesSchema: Migration = {
  name: "119_writer_authority_leases.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS writer_authority_leases (
      lease_id TEXT PRIMARY KEY,
      resource_kind TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      holder_session TEXT NOT NULL,
      generation INTEGER NOT NULL,
      acquired_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_renewed_at TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active',
      revoked_by_session TEXT,
      revoke_reason TEXT,
      transferred_from_session TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_writer_authority_active_singleton
      ON writer_authority_leases(resource_kind, resource_id) WHERE state = 'active';
    CREATE INDEX IF NOT EXISTS idx_writer_authority_holder
      ON writer_authority_leases(holder_session);
    CREATE INDEX IF NOT EXISTS idx_writer_authority_expires
      ON writer_authority_leases(expires_at) WHERE state = 'active';
  `,
};
