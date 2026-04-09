import type { Migration } from "../migrate.js";

export const rigServicesSchema: Migration = {
  name: "020_rig_services.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS rig_services (
      rig_id TEXT PRIMARY KEY REFERENCES rigs(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      spec_json TEXT NOT NULL,
      rig_root TEXT NOT NULL,
      compose_file TEXT NOT NULL,
      project_name TEXT NOT NULL,
      latest_receipt_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `,
};
