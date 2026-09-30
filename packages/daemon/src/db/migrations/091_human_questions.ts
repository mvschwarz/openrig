import type { Migration } from "../migrate.js";

// #193 — structured questions on a human decision, and the answers recorded from clicks.
export const humanQuestionsSchema: Migration = {
  name: "091_human_questions.sql",
  sql: `
    ALTER TABLE queue_items ADD COLUMN human_questions TEXT;
    ALTER TABLE queue_items ADD COLUMN human_answers TEXT;
  `,
};
