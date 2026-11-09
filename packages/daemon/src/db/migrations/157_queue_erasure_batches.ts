import type { Migration } from "../migrate.js";

/**
 * Queue erasure's commit record: each erasure batch that writes ledger lines records its id here, in the same
 * transaction as its changes, so a batch is committed exactly when its row is here. `line_at` is set once its commit
 * line is in the ledger; a run writes the commit line for any batch still without one (lost after the commit), and a
 * replay uses the record for a batch whose line is missing. Ids and times only, no content.
 */
export const queueErasureBatchesSchema: Migration = {
  name: "157_queue_erasure_batches.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS queue_erasure_batches (
      batch_id TEXT PRIMARY KEY,
      committed_at TEXT NOT NULL,
      line_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_queue_erasure_batches_line_pending ON queue_erasure_batches(batch_id) WHERE line_at IS NULL;
  `,
};
