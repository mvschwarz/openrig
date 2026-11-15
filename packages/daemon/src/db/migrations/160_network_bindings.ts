import type { Migration } from "../migrate.js";

/** A selected local seat joined to one participant of a remote hub (an account's network rig, reached over MCP). The
 *  participant's credential lives in a private file under the OpenRig home, never in this table. One active binding per
 *  local seat and per hub participant; a disconnected or revoked binding stays as history. `allow_http` records the
 *  person's choice to send the participant's token to a plain-http hub. */
export const networkBindingsSchema: Migration = {
  name: "160_network_bindings.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS network_bindings (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL,
      local_session TEXT NOT NULL,
      hub_url TEXT NOT NULL,
      hub_seat TEXT NOT NULL,
      allow_http INTEGER NOT NULL DEFAULT 0 CHECK (allow_http IN (0, 1)),
      state TEXT NOT NULL CHECK (state IN ('active', 'revoked', 'disconnected')),
      state_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_contact_at TEXT,
      last_error TEXT
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_network_bindings_active_node ON network_bindings(node_id) WHERE state = 'active';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_network_bindings_active_participant ON network_bindings(hub_url, hub_seat) WHERE state = 'active';
  `,
};
