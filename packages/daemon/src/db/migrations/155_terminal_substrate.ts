import type { Migration } from "../migrate.js";

/**
 * A seat's terminal substrate: which terminal multiplexer runs its pane. NULL is tmux, as before. It lives on the node,
 * not the binding, because a stopped seat's binding is cleared and restore still has to know it (as launch_wrapper).
 * `bindings.herdr_workspace` is the Herdr workspace id a Herdr seat's pane belongs to (the pane id stays in tmux_pane),
 * and `bindings.herdr_socket` the Herdr endpoint it was created on, so a daemon restarted with another endpoint still
 * reaches it instead of reading it as gone.
 * `herdr_session_meta` keeps the session environment and options a Herdr seat would otherwise hold in tmux's server,
 * so they survive a daemon restart.
 */
export const terminalSubstrateSchema: Migration = {
  name: "155_terminal_substrate.sql",
  sql: `
    ALTER TABLE nodes ADD COLUMN terminal_substrate TEXT;
    ALTER TABLE bindings ADD COLUMN herdr_workspace TEXT;
    ALTER TABLE bindings ADD COLUMN herdr_socket TEXT;
    CREATE TABLE IF NOT EXISTS herdr_session_meta (
      session_name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('env', 'env_present', 'option', 'seat')),
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      PRIMARY KEY (session_name, kind, key)
    );
  `,
};
