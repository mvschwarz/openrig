import type { Migration } from "../migrate.js";

/** Address reads seek a current binding; inventory recency is by id, not wall clock.
 * Keep the older created_at index for readers that explicitly use that order. */
export const sessionAddressReadIndexesSchema: Migration = {
  name: "162_session_address_read_indexes.sql",
  sql: `
    CREATE INDEX IF NOT EXISTS idx_bindings_tmux_session ON bindings(tmux_session)
      WHERE tmux_session IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_sessions_node_latest_id ON sessions(node_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_name_latest_id ON sessions(session_name, id DESC);
  `,
};
