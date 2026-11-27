import type { Migration } from "../migrate.js";

// The hooks a plain community preset declared its own hook script posts (its `activity_hooks`), recorded with that
// launch beside `agent_runner`, as a JSON list of event names. Like `agent_runner` it belongs to this session row, one
// occupant's launch, so a later preset edit never changes it. NULL (no declaration, a legacy row, or a launch that never
// reached the app) keeps today's behaviour: the screen-only inventory.
export const sessionAgentActivityHooksSchema: Migration = {
  name: "197_session_agent_activity_hooks.sql",
  sql: `ALTER TABLE sessions ADD COLUMN agent_activity_hooks TEXT;`,
};
