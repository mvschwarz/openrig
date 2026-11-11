import type { Migration } from "../migrate.js";

/** One hub item a network binding took in, and the local item that carries it: what was reported back, and when. It's a
 *  receipt, not a task: the work itself is the local queue item, found by its id. The hub item id is unique per binding,
 *  so a retried take finds the same local item. */
export const networkReceiptsSchema: Migration = {
  name: "161_network_receipts.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS network_receipts (
      local_qitem_id TEXT PRIMARY KEY,
      binding_id TEXT NOT NULL,
      hub_qitem_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      pickup_sent_at TEXT,
      result_sent_at TEXT,
      outcome TEXT,
      last_error TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_network_receipts_hub ON network_receipts(binding_id, hub_qitem_id);
    CREATE INDEX IF NOT EXISTS idx_network_receipts_open ON network_receipts(binding_id) WHERE result_sent_at IS NULL;
  `,
};
