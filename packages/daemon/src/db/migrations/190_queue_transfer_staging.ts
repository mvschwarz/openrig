import type { Migration } from "../migrate.js";

export const queueTransferStagingSchema: Migration = {
  name: "190_queue_transfer_staging.sql",
  sql: `
    CREATE TABLE queue_transfer_staging (
      import_id TEXT PRIMARY KEY NOT NULL,
      origin_host_id TEXT NOT NULL,
      origin_minted_at TEXT NOT NULL,
      digest TEXT NOT NULL,
      envelope BLOB,
      selection_json TEXT NOT NULL,
      row_count INTEGER NOT NULL CHECK (row_count >= 0),
      status TEXT NOT NULL CHECK (status IN ('staged', 'activated', 'discarded', 'rejected')),
      staged_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK ((status = 'discarded') = (envelope IS NULL)),
      UNIQUE (origin_host_id, origin_minted_at, digest)
    );
  `,
};
