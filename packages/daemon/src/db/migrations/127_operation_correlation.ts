import type { Migration } from "../migrate.js";

export const operationCorrelationSchema: Migration = {
  name: "127_operation_correlation.sql",
  sql: `CREATE TABLE operation_correlations (
    operation_id TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    rig_id TEXT,
    node_ids_json TEXT NOT NULL DEFAULT '[]'
  );`,
};
