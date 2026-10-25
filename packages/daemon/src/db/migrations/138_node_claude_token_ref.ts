import type { Migration } from "../migrate.js";

// A Claude seat's own subscription credential, as a reference only: { label, tokenFile } JSON. Never the token.
export const nodeClaudeTokenRefSchema: Migration = {
  name: "138_node_claude_token_ref.sql",
  sql: `
    ALTER TABLE nodes ADD COLUMN claude_token_ref TEXT;
  `,
};
