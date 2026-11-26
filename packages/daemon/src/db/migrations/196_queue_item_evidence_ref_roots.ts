import type { Migration } from "../migrate.js";

/** The shared roots the writer of a row's evidence_ref may read, as JSON, written with the reference. NULL is a writer
 *  without a root grant (a local seat or an owner), which keeps today's attachment behaviour. */
export const queueItemEvidenceRefRootsSchema: Migration = {
  name: "196_queue_item_evidence_ref_roots.sql",
  sql: `ALTER TABLE queue_items ADD COLUMN evidence_ref_roots TEXT;`,
};
