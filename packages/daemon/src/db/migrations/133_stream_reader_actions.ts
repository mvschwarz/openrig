import type { Migration } from "../migrate.js";

/**
 * Slice 22 outcome 9: what a reader did about a stream item. Append-only, so a correction is a newer row and the
 * earlier one stays inspectable; a reader's newest row is its current action. `act` links owned work, `decline`
 * carries the reader's reason and is that reader's alone, `duplicate` links the work or item it repeats.
 */
export const streamReaderActionsSchema: Migration = {
  name: "133_stream_reader_actions.sql",
  sql: `
    CREATE TABLE stream_reader_actions (
      action_id TEXT PRIMARY KEY,
      stream_item_id TEXT NOT NULL REFERENCES stream_items(stream_item_id),
      reader_session TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('act', 'decline', 'duplicate')),
      work_qitem_id TEXT,
      duplicate_of TEXT,
      reason TEXT,
      acted_at TEXT NOT NULL,
      CHECK ((action = 'act') = (work_qitem_id IS NOT NULL)),
      CHECK ((action = 'duplicate') = (duplicate_of IS NOT NULL)),
      CHECK (action <> 'decline' OR reason IS NOT NULL)
    );
    CREATE INDEX idx_stream_reader_actions_item ON stream_reader_actions(stream_item_id, acted_at);
  `,
};
