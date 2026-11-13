import type { Migration } from "../migrate.js";

/** Durable actual-run binding; legacy grants remain explicitly unbound. */
export const runBoundActivityGrantsSchema: Migration = {
  name: "165_run_bound_activity_grants.sql",
  sql: `
    ALTER TABLE activity_grants ADD COLUMN run_id TEXT;
    ALTER TABLE activity_grants ADD COLUMN session_id TEXT;
    ALTER TABLE activity_grants ADD COLUMN activated_at TEXT;
    ALTER TABLE activity_grants ADD COLUMN binding_json TEXT;
    CREATE INDEX idx_activity_grants_run ON activity_grants(node_id, run_id);
    CREATE UNIQUE INDEX idx_activity_grants_active_run ON activity_grants(node_id)
      WHERE run_id IS NOT NULL AND activated_at IS NOT NULL AND revoked_at IS NULL;
  `,
};
