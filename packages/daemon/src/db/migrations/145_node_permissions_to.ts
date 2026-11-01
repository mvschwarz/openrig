import type { Migration } from "../migrate.js";

/** The registered person who answers a runner seat's permission requests, chosen by its operator with
 *  `rig seat set-permissions-to`. Null (the default) means no answered route: the runner refuses and holds attention. */
export const nodePermissionsToSchema: Migration = {
  name: "145_node_permissions_to.sql",
  sql: "ALTER TABLE nodes ADD COLUMN permissions_to TEXT;",
};
