import type { Migration } from "../migrate.js";

/** Slice 13: a Claude seat's opt-in to delivery through its launch-owned hook bridge, who set it and why, and the occupant
 *  generation whose launch added the bridge's hooks (only that occupant can use it). */
export const seatHookBridgeSchema: Migration = {
  name: "171_seat_hook_bridge.sql",
  sql: `
    CREATE TABLE seat_hook_bridge (
      node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
      desired INTEGER NOT NULL CHECK (desired IN (0, 1)),
      actor TEXT NOT NULL,
      reason TEXT NOT NULL,
      changed_at TEXT NOT NULL,
      armed_generation TEXT,
      armed_at TEXT
    );
    CREATE TABLE seat_hook_bridge_changes (
      change_id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
      desired INTEGER NOT NULL CHECK (desired IN (0, 1)),
      actor TEXT NOT NULL,
      reason TEXT NOT NULL,
      changed_at TEXT NOT NULL
    );
  `,
};
