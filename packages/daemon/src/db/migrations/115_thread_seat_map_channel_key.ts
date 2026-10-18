import type { Migration } from "../migrate.js";

// A Slack thread root is identified by its channel and its ts: a ts is unique only within a channel. 072 keyed
// roots by ts alone, so two roots with one ts in different channels shared a row and the second was dropped.
// Once a person's own top-level message also opens a root, that is easy to reach. This rebuilds the table with
// (channel, thread_ts) as the key and adds `origin`: 'posted' for a root OpenRig posted (every existing row),
// 'person' for one minted from a person's message. thread_part_map (097) already keys by channel.
export const threadSeatMapChannelKeySchema: Migration = {
  name: "115_thread_seat_map_channel_key.sql",
  sql: `
    CREATE TABLE thread_seat_map_v2 (
      thread_ts       TEXT NOT NULL,
      channel         TEXT NOT NULL,
      human           TEXT NOT NULL,
      seat            TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      state           TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
      opened_at       TEXT NOT NULL,
      closed_at       TEXT,
      origin          TEXT NOT NULL DEFAULT 'posted' CHECK (origin IN ('posted', 'person')),
      PRIMARY KEY (channel, thread_ts)
    );
    INSERT INTO thread_seat_map_v2 (thread_ts, channel, human, seat, conversation_id, state, opened_at, closed_at, origin)
      SELECT thread_ts, channel, human, seat, conversation_id, state, opened_at, closed_at, 'posted' FROM thread_seat_map;
    DROP TABLE thread_seat_map;
    ALTER TABLE thread_seat_map_v2 RENAME TO thread_seat_map;
    CREATE INDEX idx_thread_seat_map_pair ON thread_seat_map (human, seat, state);
  `,
};
