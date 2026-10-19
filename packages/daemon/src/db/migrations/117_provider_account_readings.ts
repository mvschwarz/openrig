import type { Migration } from "../migrate.js";

// Slice 01: a Codex account's readings, so they survive a daemon restart and a login switch. One row per reading of
// one allowance (a resolved identity key: the provider's account id, or its workspace routing, plus the bucket), as
// the existing projection already holds it in memory. Only normalized, selected fields: the identity labels, the
// windows (name, duration, used %, reset), the limit evidence and the observation time. No raw provider answer, no
// auth or profile content, no token.
//
// 062's usage_samples stays as it is: its rule against an account identity column is about the seats' status-line
// lane, which has no honest account identity. This table holds only what a Codex refresh itself identified.
//
// Rows are added per observation and pruned per key (the store keeps the latest reading, the latest per window, and
// the last 20 exhaustion episodes), so it is append-and-prune, bounded per key.
export const providerAccountReadingsSchema: Migration = {
  name: "117_provider_account_readings.sql",
  sql: `
    CREATE TABLE provider_account_readings (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      provider        TEXT NOT NULL CHECK (provider IN ('codex')),
      identity_key    TEXT NOT NULL,
      account_id      TEXT,
      workspace_id    TEXT,
      limit_id        TEXT NOT NULL,
      email           TEXT,
      plan_type       TEXT,
      identity_source TEXT NOT NULL,
      observed_at     TEXT NOT NULL,
      limit_evidence  TEXT,
      windows_json    TEXT NOT NULL
    );
    CREATE INDEX idx_provider_account_readings_key_time ON provider_account_readings (identity_key, observed_at);
  `,
};
