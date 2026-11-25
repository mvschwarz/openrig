import type { Migration } from "../migrate.js";

/** #2940: the stop attempt that recorded a session's stop request, so a stop proven to have had no effect puts back
 *  only its own request (on the same row) and never an older or concurrent one. NULL = no attempt recorded. */
export const sessionStopAttemptSchema: Migration = {
  name: "180_session_stop_attempt.sql",
  sql: "ALTER TABLE sessions ADD COLUMN stop_attempt TEXT;",
};
