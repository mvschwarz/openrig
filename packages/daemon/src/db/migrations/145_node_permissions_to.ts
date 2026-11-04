import type { Migration } from "../migrate.js";

/** The registered person who answers a runner seat's permission requests, chosen by its operator with
 *  `rig seat set-permissions-to`. Null (the default) asks the default person and permits the request if nobody can be asked. */
export const nodePermissionsToSchema: Migration = {
  name: "145_node_permissions_to.sql",
  sql: "ALTER TABLE nodes ADD COLUMN permissions_to TEXT;",
};
