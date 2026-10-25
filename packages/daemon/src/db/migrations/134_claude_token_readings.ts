import type { Migration } from "../migrate.js";
// Extend the existing reading history, not a credential registry. Metadata holds labels/references only.
export const claudeTokenReadingsSchema: Migration = {
  name: "134_claude_token_readings.sql",
  sql: `
    CREATE TABLE provider_account_readings_next (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude')),
      identity_key TEXT NOT NULL, account_id TEXT, workspace_id TEXT, limit_id TEXT NOT NULL,
      email TEXT, plan_type TEXT, identity_source TEXT NOT NULL, observed_at TEXT NOT NULL,
      limit_evidence TEXT, windows_json TEXT NOT NULL, metadata_json TEXT
    );
    INSERT INTO provider_account_readings_next
      (id, provider, identity_key, account_id, workspace_id, limit_id, email, plan_type, identity_source, observed_at, limit_evidence, windows_json)
      SELECT id, provider, identity_key, account_id, workspace_id, limit_id, email, plan_type, identity_source, observed_at, limit_evidence, windows_json
      FROM provider_account_readings;
    DROP TABLE provider_account_readings;
    ALTER TABLE provider_account_readings_next RENAME TO provider_account_readings;
    CREATE INDEX idx_provider_account_readings_key_time ON provider_account_readings (identity_key, observed_at);
  `,
};
