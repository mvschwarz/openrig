import type { Migration } from "../migrate.js";

/** One request a bound seat sent to a peer through the hub: its local item and the hub item it maps to. It's a receipt,
 *  not a task: the request and its answer are the local queue item, whose id is the seat's own request id; the hub item's
 *  id is derived from the seat's node, the hub, the participant and that request id. It holds no request text: a create
 *  that goes again reads the request from the local item, so erasing that item erases the request, and `body_sha256`
 *  tells a same-id retry of the same request from another. `hub_created_at` is when the hub confirmed the item;
 *  `settled_at` is when nothing more is read (the answer arrived, the hub refused it, or the outcome is unknown: `outcome`
 *  says which). `binding_id` is the binding that reads it now, and a new binding for the same seat, hub and participant
 *  takes it over. */
export const networkRequestsSchema: Migration = {
  name: "184_network_requests.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS network_requests (
      local_qitem_id TEXT PRIMARY KEY,
      binding_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      hub_url TEXT NOT NULL,
      hub_seat TEXT NOT NULL,
      peer TEXT NOT NULL,
      hub_qitem_id TEXT NOT NULL,
      body_sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL,
      hub_created_at TEXT,
      checked_at TEXT,
      settled_at TEXT,
      outcome TEXT,
      last_error TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_network_requests_hub ON network_requests(binding_id, hub_qitem_id);
    CREATE INDEX IF NOT EXISTS idx_network_requests_open ON network_requests(node_id, hub_url, hub_seat) WHERE settled_at IS NULL;
  `,
};
