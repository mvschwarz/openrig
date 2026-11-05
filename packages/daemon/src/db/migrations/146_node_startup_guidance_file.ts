import type { Migration } from "../migrate.js";

/** The file a seat's launch chose for its managed guidance blocks, when that isn't the rule's file in its working directory
 *  (a Pi seat's own agent folder AGENTS.md, #875). Null (the default, and every row written before this) means the rule's
 *  file, so restore, teardown and inventory keep reading exactly what they read before. */
export const nodeStartupGuidanceFileSchema: Migration = {
  name: "146_node_startup_guidance_file.sql",
  sql: "ALTER TABLE node_startup_context ADD COLUMN guidance_file TEXT;",
};
