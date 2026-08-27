import type { Migration } from "../migrate.js";

// S10 (OPR.0.5.5.10) — the thread↔seat map: ONE table, the design's exact shape
// (FROM-SCRATCH §4.4). A thread is an ad-hoc DM between one human and one seat; OUR side owns
// the map; routing is a deterministic lookup on thread_ts — zero inference. The table is a
// CACHE of truth also stamped onto queue rows (`slack-posted thread_ts=… message_ts=…`
// transition notes), so a lost table REBUILDS from queue rows and never invents a mapping.
export const threadSeatMapSchema: Migration = {
  name: "072_thread_seat_map.sql",
  sql: `
    CREATE TABLE thread_seat_map (
      thread_ts       TEXT PRIMARY KEY,
      channel         TEXT NOT NULL,
      human           TEXT NOT NULL,
      seat            TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      state           TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
      opened_at       TEXT NOT NULL,
      closed_at       TEXT
    );
    CREATE INDEX idx_thread_seat_map_pair ON thread_seat_map (human, seat, state);
  `,
};
