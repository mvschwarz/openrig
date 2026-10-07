import type { Migration } from "../migrate.js";

// #899 — the reply parts OpenRig posts for a long ask (#897), each mapped to its ask's root, so a
// reaction on any part reaches the seat that asked. Like thread_seat_map (072) it is a CACHE of the
// `slack-posted` stamps on the ask's queue row (a part's stamp names its own message_ts and its
// root's thread_ts), so a lost table rebuilds from queue rows.
export const threadPartMapSchema: Migration = {
  name: "097_thread_part_map.sql",
  sql: `
    CREATE TABLE thread_part_map (
      message_ts TEXT NOT NULL,
      channel    TEXT NOT NULL,
      thread_ts  TEXT NOT NULL,
      PRIMARY KEY (channel, message_ts)
    );
  `,
};
