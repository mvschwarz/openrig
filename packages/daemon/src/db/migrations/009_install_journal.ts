import type { Migration } from "../migrate.js";

export const installJournalSchema: Migration = {
  name: "009_install_journal.sql",
  sql: `
    CREATE TABLE package_installs (
      id              TEXT PRIMARY KEY,
      package_id      TEXT NOT NULL REFERENCES packages(id),
      target_root     TEXT NOT NULL,
      scope           TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'planned',
      risk_tier       TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      applied_at      TEXT,
      rolled_back_at  TEXT
    );

    CREATE INDEX idx_installs_package ON package_installs(package_id);

    CREATE TABLE install_journal (
      id              TEXT PRIMARY KEY,
      install_id      TEXT NOT NULL REFERENCES package_installs(id),
      action          TEXT NOT NULL,
      export_type     TEXT NOT NULL,
      classification  TEXT NOT NULL,
      target_path     TEXT NOT NULL,
      backup_path     TEXT,
      before_hash     TEXT,
      after_hash      TEXT,
      status          TEXT NOT NULL DEFAULT 'pending',
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX idx_journal_install ON install_journal(install_id);
  `,
};
