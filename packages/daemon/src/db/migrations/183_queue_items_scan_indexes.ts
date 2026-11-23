import type { Migration } from "../migrate.js";

/** Two reads on the main connection walked every queue row for the few rows they want, and the second holds the event
 *  loop while it does. Each index lists only those rows, under the read's own condition, so the read covers them alone:
 *  - the delegated-decision account (`delegatedDecisionsFor`): rows with a delegated decision. Its JSON is read only on
 *    those rows, as before; indexing the JSON value itself would fail a write that stored malformed JSON;
 *  - the passive health ceremony's lineage read (`readLineageRows`): rows whose tags name a `health-lineage:` id. */
export const queueItemsScanIndexesSchema: Migration = {
  name: "183_queue_items_scan_indexes.sql",
  sql: `
    CREATE INDEX IF NOT EXISTS idx_queue_items_delegated_decision ON queue_items(qitem_id) WHERE delegated_decision IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_queue_items_health_lineage ON queue_items(qitem_id) WHERE tags LIKE '%health-lineage:%';
  `,
};
