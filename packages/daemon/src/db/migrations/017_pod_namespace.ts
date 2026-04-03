import type { Migration } from "../migrate.js";

export const podNamespaceSchema: Migration = {
  name: "017_pod_namespace.sql",
  sql: `
    ALTER TABLE pods ADD COLUMN namespace TEXT NOT NULL DEFAULT '';
    UPDATE pods SET namespace = id WHERE namespace = '';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pods_rig_namespace ON pods(rig_id, namespace) WHERE namespace != '';
  `,
};
