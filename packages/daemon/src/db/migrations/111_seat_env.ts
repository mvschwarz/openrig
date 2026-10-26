import type { Migration } from "../migrate.js";

/** Non-secret launch environment a rig spec declares: `env:` at rig level (rigs.env_json) and at
 *  member level (nodes.env_json), stored as a JSON object of NAME -> value. NULL = none declared.
 *  The two stay separate so a launch merges them (member over rig) and an export round-trips both. */
export const seatEnvSchema: Migration = {
  name: "111_seat_env.sql",
  sql: `
    ALTER TABLE rigs ADD COLUMN env_json TEXT;
    ALTER TABLE nodes ADD COLUMN env_json TEXT;
  `,
};
