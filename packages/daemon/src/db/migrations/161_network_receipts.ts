import type { Migration } from "../migrate.js";

/** One hub item taken in, and the local item that carries it: what was reported back, and when. It's a receipt, not a
 *  task: the work itself is the local queue item, found by its id, which is derived from the seat's node, the hub, the
 *  participant and the hub item. `binding_id` is the binding that reports it now, and a new binding for the same seat,
 *  hub and participant takes it over. `settled_at` is when nothing more is reported (the result was sent, the outcome is
 *  unknown, or the hub item was closed elsewhere: `outcome` says which); `checked_at` gives every open receipt a turn. */
export const networkReceiptsSchema: Migration = {
  name: "161_network_receipts.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS network_receipts (
      local_qitem_id TEXT PRIMARY KEY,
      binding_id TEXT NOT NULL,
      hub_qitem_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      queued_sent_at TEXT,
      pickup_sent_at TEXT,
      settled_at TEXT,
      checked_at TEXT,
      outcome TEXT,
      last_error TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_network_receipts_hub ON network_receipts(binding_id, hub_qitem_id);
    CREATE INDEX IF NOT EXISTS idx_network_receipts_open ON network_receipts(binding_id) WHERE settled_at IS NULL;
  `,
};
