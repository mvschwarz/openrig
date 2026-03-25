import type { Migration } from "../migrate.js";

export const journalSeqSchema: Migration = {
  name: "010_journal_seq.sql",
  sql: `
    -- Rebuild install_journal with seq column for deterministic rollback ordering.
    -- Existing rows get seq = ROW_NUMBER() OVER (PARTITION BY install_id ORDER BY rowid).

    ALTER TABLE install_journal RENAME TO install_journal_old;

    CREATE TABLE install_journal (
      id              TEXT PRIMARY KEY,
      install_id      TEXT NOT NULL REFERENCES package_installs(id),
      seq             INTEGER NOT NULL,
      action          TEXT NOT NULL,
      export_type     TEXT NOT NULL,
      classification  TEXT NOT NULL,
      target_path     TEXT NOT NULL,
      backup_path     TEXT,
      before_hash     TEXT,
      after_hash      TEXT,
      status          TEXT NOT NULL DEFAULT 'pending',
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(install_id, seq)
    );

    INSERT INTO install_journal (id, install_id, seq, action, export_type, classification, target_path, backup_path, before_hash, after_hash, status, created_at)
    SELECT id, install_id,
           ROW_NUMBER() OVER (PARTITION BY install_id ORDER BY rowid) AS seq,
           action, export_type, classification, target_path, backup_path, before_hash, after_hash, status, created_at
    FROM install_journal_old;

    DROP TABLE install_journal_old;

    CREATE INDEX idx_journal_install ON install_journal(install_id);
  `,
};
