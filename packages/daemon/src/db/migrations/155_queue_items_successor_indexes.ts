import type { Migration } from "../migrate.js";

/**
 * The stuck sweep reads the linked successors of its custody rows once per pass (createLinkedSuccessorLookup): rows
 * whose handed_off_from is one of them, or whose chain_of_record names one. With no index on either column, both halves
 * scanned the whole table (33 ms in one statement on a 23k-row queue, growing with the history, not with the custody
 * rows). The first index turns the handed_off_from half into a search; the second lets the chain_of_record half walk
 * only the rows that have a chain, in qitem_id pages the sweep yields between. Index-only: no table, trigger or
 * backfill.
 */
export const queueItemsSuccessorIndexesSchema: Migration = {
  name: "155_queue_items_successor_indexes.sql",
  sql: `
    CREATE INDEX IF NOT EXISTS idx_queue_items_handed_off_from ON queue_items(handed_off_from) WHERE handed_off_from IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_queue_items_chain_of_record ON queue_items(qitem_id) WHERE chain_of_record IS NOT NULL;
  `,
};
