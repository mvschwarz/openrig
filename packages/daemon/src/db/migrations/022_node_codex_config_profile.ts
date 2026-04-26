import type { Migration } from "../migrate.js";

export const nodeCodexConfigProfileSchema: Migration = {
  name: "022_node_codex_config_profile.sql",
  sql: `
    ALTER TABLE nodes ADD COLUMN codex_config_profile TEXT;
  `,
};
