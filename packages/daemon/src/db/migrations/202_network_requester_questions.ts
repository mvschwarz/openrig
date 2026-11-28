import type { Migration } from "../migrate.js";

/** Requester-relative routes and observed waits stay with the existing request receipts. No question text is copied. */
export const networkRequesterQuestionsSchema: Migration = {
  name: "202_network_requester_questions.sql",
  sql: `
    ALTER TABLE network_requests ADD COLUMN requester_local_qitem_id TEXT;
    ALTER TABLE network_requests ADD COLUMN requester_hub_qitem_id TEXT;
    ALTER TABLE network_requests ADD COLUMN remote_wait TEXT;
  `,
};
