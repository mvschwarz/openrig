import type { Migration } from "../migrate.js";

/**
 * Slice 22: a stream item's routing outcome from the automatic path. Either an accepted judgment with
 * its fixed intended effect, written in the same transaction as the item's write-once classification;
 * or a deferral to intake, written with the automatic attempt's abstention and no classification, so
 * the intake agent has custody at once. The actual template bytes, the exact request sent and the
 * returned provenance are kept either way. Only the application fields change afterwards.
 */
export const streamDispositionsSchema: Migration = {
  name: "129_stream_dispositions.sql",
  sql: `
    CREATE TABLE stream_dispositions (
      stream_item_id TEXT PRIMARY KEY REFERENCES stream_items(stream_item_id),
      project_id TEXT UNIQUE REFERENCES project_classifications(project_id),
      disposition TEXT NOT NULL CHECK (disposition IN ('create', 'join', 'duplicate', 'no_action', 'deferred')),
      accepted_by TEXT NOT NULL,
      owner_session TEXT,
      work_qitem_id TEXT,
      effect_operation TEXT NOT NULL CHECK (effect_operation IN ('create', 'note', 'none')),
      effect_qitem_id TEXT,
      effect_destination TEXT,
      template_digest TEXT NOT NULL,
      template_text TEXT NOT NULL,
      request_json TEXT NOT NULL,
      provenance_json TEXT NOT NULL,
      reason TEXT,
      result_json TEXT,
      accepted_at TEXT NOT NULL,
      applied_at TEXT,
      applied_json TEXT,
      CHECK ((disposition = 'deferred') = (project_id IS NULL))
    );
    CREATE INDEX idx_stream_dispositions_unapplied ON stream_dispositions(accepted_at) WHERE applied_at IS NULL;
  `,
};
