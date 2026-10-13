import type { Migration } from "../migrate.js";

export const rigInstallRootSchema: Migration = {
  name: "096_rig_install_root.sql",
  sql: "ALTER TABLE rigs ADD COLUMN install_root TEXT;",
};
