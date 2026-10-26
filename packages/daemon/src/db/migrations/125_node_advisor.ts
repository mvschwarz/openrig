import type { Migration } from "../migrate.js";

// #1152: per-seat Claude Advisor configuration, independent of shared settings.
export const nodeAdvisorSchema: Migration = {
  name: "125_node_advisor.sql",
  sql: `
    ALTER TABLE nodes ADD COLUMN advisor TEXT;
  `,
};
