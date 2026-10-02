import type { Migration } from "../migrate.js";

// #75 — per-seat reasoning effort configuration for Claude and Codex.
export const nodeEffortSchema: Migration = {
  name: "092_node_effort.sql",
  sql: `
    ALTER TABLE nodes ADD COLUMN effort TEXT;
  `,
};
