import type { Migration } from "../migrate.js";

/** #3416 (3): a Claude seat's status line throttle in whole seconds (spec `statusline_throttle`); NULL = none. */
export const nodeStatuslineThrottleSchema: Migration = {
  name: "176_node_statusline_throttle.sql",
  sql: "ALTER TABLE nodes ADD COLUMN statusline_throttle_seconds INTEGER;",
};
