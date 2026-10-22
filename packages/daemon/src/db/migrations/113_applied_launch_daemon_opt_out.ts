import type { Migration } from "../migrate.js";

// A Codex launch's daemon choice, kept with that generation's other launch facts so the printed recovery
// command can repeat it: 1 = launched with --no-daemon, 0 = probed legacy (no such option), NULL = not recorded.
export const appliedLaunchDaemonOptOutSchema: Migration = {
  name: "113_applied_launch_daemon_opt_out.sql",
  sql: `
    ALTER TABLE applied_launch_observations ADD COLUMN daemon_opt_out INTEGER;
  `,
};
