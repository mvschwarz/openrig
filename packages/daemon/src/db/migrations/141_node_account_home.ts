import type { Migration } from "../migrate.js";

// A native account-home switch stores a path only. Credential values stay in that home.
export const nodeAccountHomeSchema: Migration = {
  name: "141_node_account_home.sql",
  sql: "ALTER TABLE nodes ADD COLUMN account_home TEXT;",
};
