import type { Migration } from "../migrate.js";

// A Codex seat's own permission envelope (sandbox, approval and the workspace-write fields), read live at each managed
// launch. NULL leaves the seat's launch unchanged.
export const nodeCodexPermissionsSchema: Migration = {
  name: "137_node_codex_permissions.sql",
  sql: "ALTER TABLE nodes ADD COLUMN codex_permissions_json TEXT;",
};
