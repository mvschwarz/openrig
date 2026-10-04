import type { Migration } from "../migrate.js";

export const rigNonInterruptiveSchema: Migration = {
  name: "095_rig_non_interruptive.sql",
  sql: "ALTER TABLE rigs ADD COLUMN non_interruptive INTEGER NOT NULL DEFAULT 0 CHECK (non_interruptive IN (0, 1));",
};
