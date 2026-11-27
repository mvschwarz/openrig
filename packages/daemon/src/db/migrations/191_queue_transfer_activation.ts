import type { Migration } from "../migrate.js";

// Migration number coordinated at merge; recheck against upstream before merging.
export const queueTransferActivationSchema: Migration = {
  name: "191_queue_transfer_activation.sql",
  sql: `
    CREATE TABLE queue_transfer_ledger (
      record_id TEXT PRIMARY KEY NOT NULL,
      side TEXT NOT NULL CHECK (side IN ('origin', 'destination')),
      kind TEXT NOT NULL CHECK (kind IN ('relinquished', 'activating', 'activated', 'reconciled')),
      transfer_id TEXT NOT NULL,
      archive_digest TEXT NOT NULL,
      origin_host_id TEXT NOT NULL,
      origin_minted_at TEXT NOT NULL,
      destination_host_id TEXT NOT NULL,
      import_id TEXT,
      authorization_digest TEXT NOT NULL,
      mapping_digest TEXT NOT NULL,
      actor TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      receipt_json TEXT,
      result_json TEXT
    );
    CREATE INDEX idx_queue_transfer_ledger_archive ON queue_transfer_ledger (archive_digest, kind);
    CREATE UNIQUE INDEX idx_queue_transfer_ledger_destination ON queue_transfer_ledger (import_id)
      WHERE side = 'destination';
    CREATE UNIQUE INDEX idx_queue_transfer_ledger_relinquished ON queue_transfer_ledger (archive_digest, destination_host_id)
      WHERE kind = 'relinquished';

    CREATE TABLE queue_transfer_relinquished (
      qitem_id TEXT PRIMARY KEY NOT NULL,
      record_id TEXT NOT NULL REFERENCES queue_transfer_ledger (record_id),
      archive_digest TEXT NOT NULL,
      destination_host_id TEXT NOT NULL,
      source_state TEXT NOT NULL,
      reconciled_at TEXT,
      reconcile_outcome TEXT
    );
    CREATE INDEX idx_queue_transfer_relinquished_record ON queue_transfer_relinquished (record_id);

    CREATE TABLE queue_transfer_transition_origins (
      transition_id INTEGER PRIMARY KEY,
      record_id TEXT NOT NULL REFERENCES queue_transfer_ledger (record_id),
      origin_transition_id INTEGER NOT NULL,
      origin_host_id TEXT NOT NULL,
      origin_minted_at TEXT NOT NULL
    );
    ALTER TABLE mission_control_actions ADD COLUMN imported_from TEXT;
  `,
};
