import type { Migration } from "../migrate.js";

// A decision made on a person's behalf, inside the decision room of the mode they had on, recorded on the ask's own row
// beside human_answers and never in it: who decided, for which mode application, what was asked, what was chosen and
// why, and whether it can be undone. NULL: no delegated decision. The person's own answers stay theirs alone.
export const queueDelegatedDecisionSchema: Migration = {
  name: "123_queue_delegated_decision.sql",
  sql: `
    ALTER TABLE queue_items ADD COLUMN delegated_decision TEXT;
  `,
};
