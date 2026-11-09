import type { Migration } from "../migrate.js";

/**
 * Queue erasure's commit record: each erasure batch that writes ledger lines records its id here, in the same
 * transaction as its changes, so a batch is committed exactly when its row is here. A run uses it to write the commit
 * line a batch is missing (lost after the commit), and a replay uses it for a batch whose line is missing. Ids and
 * times only, no content.
 */
export const queueErasureBatchesSchema: Migration = {
  name: "157_queue_erasure_batches.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS queue_erasure_batches (
      batch_id TEXT PRIMARY KEY,
      committed_at TEXT NOT NULL
    );
  `,
};
