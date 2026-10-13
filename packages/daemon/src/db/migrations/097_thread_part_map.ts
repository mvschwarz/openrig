import type { Migration } from "../migrate.js";

// #899 — every message OpenRig posts into a thread for an ask (a long ask's reply parts, a later
// notification in the ask's own thread, an ask posted into another thread), mapped to that ask and its
// seat, so a reaction on it reaches the seat that asked. The thread root alone can't say which ask a
// reply belongs to: an ask posted into another ask's thread shares that ask's root. Like
// thread_seat_map (072) it is a CACHE of the `slack-posted` stamps on the ask's queue row (a reply's
// stamp names its own message_ts, the thread's thread_ts, its seat and its ask), so a lost table rebuilds.
export const threadPartMapSchema: Migration = {
  name: "097_thread_part_map.sql",
  sql: `
    CREATE TABLE thread_part_map (
      message_ts      TEXT NOT NULL,
      channel         TEXT NOT NULL,
      thread_ts       TEXT NOT NULL,
      seat            TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      PRIMARY KEY (channel, message_ts)
    );
  `,
};
