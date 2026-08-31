import type { Migration } from "../migrate.js";

/** Exact validated RigSpec member session_source declaration for export/recreate fidelity. */
export const nodeSessionSourceSchema: Migration = {
  name: "077_node_session_source.sql",
  sql: `ALTER TABLE nodes ADD COLUMN session_source_json TEXT;`,
};
