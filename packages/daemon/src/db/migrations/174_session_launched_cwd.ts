import type { Migration } from "../migrate.js";

/** The folder a session was launched in: its seat's saved folder, or a run's own folder (`rig up <rig> --existing --cwd`,
 *  which leaves the saved folder as it is), so rig down cleans what that launch wrote there. NULL (every row written
 *  before this, and a session OpenRig didn't launch) means not recorded. */
export const sessionLaunchedCwdSchema: Migration = {
  name: "174_session_launched_cwd.sql",
  sql: "ALTER TABLE sessions ADD COLUMN launched_cwd TEXT;",
};
