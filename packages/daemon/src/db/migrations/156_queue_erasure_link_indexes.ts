import type { Migration } from "../migrate.js";

/** Queue erasure finds a row's copies by its id; without these, each lookup scans the whole table. */
export const queueErasureLinkIndexesSchema: Migration = {
  name: "156_queue_erasure_link_indexes.sql",
  sql: `
    CREATE INDEX IF NOT EXISTS idx_outbox_entries_audit_pointer ON outbox_entries(audit_pointer);
    CREATE INDEX IF NOT EXISTS idx_inbox_entries_absorbed_qitem ON inbox_entries(absorbed_qitem_id);
    CREATE INDEX IF NOT EXISTS idx_inbox_entries_audit_pointer ON inbox_entries(audit_pointer);
    CREATE INDEX IF NOT EXISTS idx_stream_dispositions_work_qitem ON stream_dispositions(work_qitem_id);
    CREATE INDEX IF NOT EXISTS idx_stream_dispositions_effect_qitem ON stream_dispositions(effect_qitem_id);
    CREATE INDEX IF NOT EXISTS idx_stream_reader_actions_work_qitem ON stream_reader_actions(work_qitem_id);
    CREATE INDEX IF NOT EXISTS idx_stream_reader_actions_duplicate_of ON stream_reader_actions(duplicate_of);
  `,
};
