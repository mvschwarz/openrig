import type { Migration } from "../migrate.js";

export const queueRelayedAnswersSchema: Migration = {
  name: "179_queue_relayed_answers.sql",
  sql: "ALTER TABLE queue_items ADD COLUMN relayed_answers TEXT;",
};
