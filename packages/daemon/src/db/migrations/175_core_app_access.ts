import type { Migration } from "../migrate.js";

export const coreAppAccessSchema: Migration = {
  name: "175_core_app_access.sql",
  sql: `
    CREATE TABLE core_app_credentials (
      credential_id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      actors_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT
    );
    CREATE TABLE core_app_submissions (
      app_id TEXT NOT NULL,
      answer_id TEXT NOT NULL,
      request_id TEXT NOT NULL,
      binding_hash TEXT NOT NULL,
      binding_json TEXT,
      checkpoint_json TEXT,
      receipt_json TEXT,
      erased_at TEXT,
      PRIMARY KEY (app_id, answer_id)
    );
    CREATE INDEX core_app_submissions_request ON core_app_submissions(request_id);
  `,
};
