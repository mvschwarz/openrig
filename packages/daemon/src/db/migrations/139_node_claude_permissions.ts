import type { Migration } from "../migrate.js";

export const nodeClaudePermissionsSchema: Migration = {
  name: "139_node_claude_permissions.sql",
  sql: "ALTER TABLE nodes ADD COLUMN claude_permissions_json TEXT;",
};
