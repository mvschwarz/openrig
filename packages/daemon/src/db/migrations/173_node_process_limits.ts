import type { Migration } from "../migrate.js";

/** #3253: a seat's own process limits (spec `process_limits`), as JSON (`{"tasks_max":N}`); NULL = none. */
export const nodeProcessLimitsSchema: Migration = {
  name: "173_node_process_limits.sql",
  sql: "ALTER TABLE nodes ADD COLUMN process_limits TEXT;",
};
