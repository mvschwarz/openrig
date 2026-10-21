import type { Migration } from "../migrate.js";

/** Only a supported seat stop records this intent; old exits remain unexplained. */
export const sessionStopIntentSchema: Migration = {
  name: "103_session_stop_intent.sql",
  sql: `
    ALTER TABLE sessions ADD COLUMN intentionally_stopped INTEGER NOT NULL DEFAULT 0
      CHECK (intentionally_stopped IN (0, 1));
  `,
};
