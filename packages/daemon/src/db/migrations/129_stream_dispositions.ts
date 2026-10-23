import type { Migration } from "../migrate.js";

/**
 * Slice 22: a stream item's accepted routing judgment and its fixed intended effect. Written in the
 * same transaction as the item's classification, which stays write-once; only the application
 * fields (applied_at, applied_json) change afterwards. The actual template bytes and the exact
 * request sent are kept, so recovery reuses the accepted answer instead of deciding again.
 */
export const streamDispositionsSchema: Migration = {
  name: "129_stream_dispositions.sql",
  sql: `
    CREATE TABLE stream_dispositions (
      stream_item_id TEXT PRIMARY KEY REFERENCES stream_items(stream_item_id),
      project_id TEXT NOT NULL UNIQUE REFERENCES project_classifications(project_id),
      disposition TEXT NOT NULL CHECK (disposition IN ('create', 'join', 'duplicate', 'no_action')),
      owner_session TEXT,
      work_qitem_id TEXT,
      effect_operation TEXT NOT NULL CHECK (effect_operation IN ('create', 'note', 'none')),
      effect_qitem_id TEXT,
      effect_destination TEXT,
      template_digest TEXT NOT NULL,
      template_text TEXT NOT NULL,
      request_json TEXT NOT NULL,
      provenance_json TEXT NOT NULL,
      accepted_at TEXT NOT NULL,
      applied_at TEXT,
      applied_json TEXT
    );
    CREATE INDEX idx_stream_dispositions_unapplied ON stream_dispositions(accepted_at) WHERE applied_at IS NULL;
  `,
};
