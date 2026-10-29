import type { Migration } from "../migrate.js";

export const nodeClaudeMcpSchema: Migration = {
  name: "142_node_claude_mcp.sql",
  sql: "ALTER TABLE nodes ADD COLUMN claude_mcp TEXT CHECK (claude_mcp IS NULL OR claude_mcp = 'none');",
};
