import type { Migration } from "../migrate.js";

export const seatReapStateSchema: Migration = {
  name: "191_seat_reap_state.sql",
  sql: `
    CREATE TABLE seat_reap_state (
      node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL,
      generation TEXT NOT NULL,
      activity_seq INTEGER NOT NULL,
      idle_first_seen_ms INTEGER,
      attention_required INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE seat_reaper_control (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      terminal_reason TEXT
    );
    INSERT INTO seat_reaper_control(singleton) VALUES (1);
  `,
};
