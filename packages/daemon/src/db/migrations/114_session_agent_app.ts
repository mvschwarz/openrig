import type { Migration } from "../migrate.js";

// The community agent app a session was launched for, selected through its data preset. Written when the launch
// goes through the agent-app adapter, before the app starts: a selection, not launch success and not identity proof.
// It belongs to this session row, one occupant's registration, so a later occupant (another launch, a claim or a
// self-attach) never inherits it. NULL for every other session.
export const sessionAgentAppSchema: Migration = {
  name: "114_session_agent_app.sql",
  sql: `
    ALTER TABLE sessions ADD COLUMN agent_app TEXT;
  `,
};
