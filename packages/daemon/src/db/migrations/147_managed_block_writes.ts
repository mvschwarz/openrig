import type { Migration } from "../migrate.js";

/**
 * #2456: what OpenRig last wrote in each managed guidance block, by the guidance file's real path and the block id: the
 * sha256 of the block's body without the writer's framing. A block whose body still has that hash is OpenRig's own and is
 * refreshed from its source; any other body is a person's edit and is kept. No row (every block written before this) means
 * OpenRig can't tell which it is.
 */
export const managedBlockWritesSchema: Migration = {
  name: "147_managed_block_writes.sql",
  sql: `
    CREATE TABLE managed_block_writes (
      path_key    TEXT NOT NULL,
      block_id    TEXT NOT NULL,
      body_sha256 TEXT NOT NULL,
      written_at  TEXT NOT NULL,
      PRIMARY KEY (path_key, block_id)
    );
  `,
};
