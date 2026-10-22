import type { Migration } from "../migrate.js";

// OPR.0.7.0.7 — a seat's explicit effort choice (rig seat set-effort), kept apart from
// nodes.effort, which stays the authored/default resolution that spec refresh writes.
// NULL means no explicit choice, so "clear" can name what the seat falls back to.
export const nodeEffortChoiceSchema: Migration = {
  name: "104_node_effort_choice.sql",
  sql: `
    ALTER TABLE nodes ADD COLUMN effort_choice TEXT;
  `,
};
