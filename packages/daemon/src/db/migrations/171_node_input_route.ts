import type { Migration } from "../migrate.js";

/** Seat selection is independent of a runner's live capabilities. Existing seats continue to type. */
export const nodeInputRouteSchema: Migration = {
  name: "171_node_input_route.sql",
  sql: "ALTER TABLE nodes ADD COLUMN input_route TEXT NOT NULL DEFAULT 'typed' CHECK(input_route IN ('typed','native'));",
};
