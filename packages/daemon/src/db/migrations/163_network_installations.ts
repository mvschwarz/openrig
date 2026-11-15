import type { Migration } from "../migrate.js";

/** This daemon enrolled in an account: the account's site, its installation id, and whether the person chose plain http
 *  for it. The installation key lives in a private file under the OpenRig home, never in this table. A binding made
 *  through the account names its installation, its participant and the account's installation id the name was listed under,
 *  and records when the account stopped listing it. */
export const networkInstallationsSchema: Migration = {
  name: "163_network_installations.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS network_installations (
      id TEXT PRIMARY KEY,
      site TEXT NOT NULL,
      installation_id TEXT NOT NULL,
      name TEXT,
      allow_http INTEGER NOT NULL DEFAULT 0 CHECK (allow_http IN (0, 1)),
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_network_installations_site ON network_installations(site);
    ALTER TABLE network_bindings ADD COLUMN installation_id TEXT;
    ALTER TABLE network_bindings ADD COLUMN participant_name TEXT;
    ALTER TABLE network_bindings ADD COLUMN account_removed_at TEXT;
    ALTER TABLE network_bindings ADD COLUMN account_installation_id TEXT;
  `,
};
