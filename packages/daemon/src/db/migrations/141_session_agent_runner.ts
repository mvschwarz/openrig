import type { Migration } from "../migrate.js";

// Whether the community app a session was launched for declared itself a runner (its preset's `runner: true`),
// recorded with that launch: 1 runner, 0 plain. Like `agent_app`, it belongs to this session row, one occupant's
// launch, so a later preset edit or a later occupant never changes it. NULL (a legacy row, a session that isn't a
// community app's, or a launch that never reached the app) keeps today's behaviour: never a runner opt-in.
export const sessionAgentRunnerSchema: Migration = {
  name: "141_session_agent_runner.sql",
  sql: `
    ALTER TABLE sessions ADD COLUMN agent_runner INTEGER;
  `,
};
