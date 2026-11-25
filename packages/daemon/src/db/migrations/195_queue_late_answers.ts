import type { Migration } from "../migrate.js";

export const queueLateAnswersSchema: Migration = {
  name: "195_queue_late_answers.sql",
  sql: `
    CREATE TABLE queue_late_answers (
      question_id TEXT PRIMARY KEY REFERENCES queue_items(qitem_id) ON DELETE CASCADE,
      delivery_id TEXT NOT NULL UNIQUE,
      principal TEXT NOT NULL,
      lead TEXT NOT NULL,
      recipient TEXT NOT NULL,
      stopped INTEGER NOT NULL DEFAULT 0,
      answer_transition_id INTEGER,
      queued INTEGER NOT NULL DEFAULT 0
    );
  `,
};
