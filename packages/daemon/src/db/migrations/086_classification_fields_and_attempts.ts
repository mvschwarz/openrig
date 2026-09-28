import type { Migration } from "../migrate.js";

/**
 * 0.6.0 S02 P1: classification fields, result binding, and the attempt ledger.
 *
 * project_classifications (028) gains:
 * - four nullable label fields: area, scope_ref, duplicate_of_stream_item_id,
 *   needs_human (0/1; NULL = unknown, never false)
 * - result binding: lease_id plus the classifier, taxonomy and candidate-set
 *   versions the label was produced under
 * Rows written before 086 keep NULL in every new column; first-write-wins (the
 * UNIQUE stream_item_id) is unchanged.
 *
 * classification_attempts is the durable ledger for work that must NOT land in
 * the immutable classification row: abstentions, errors and in-flight attempts.
 * Identity is (stream_item_id, classifier_version, taxonomy_version,
 * evidence_epoch). An abstention is terminal only for that identity; a changed
 * version or evidence epoch is a new identity and makes the item eligible
 * again. Errors and abandoned in-flight attempts retry within a finite budget,
 * then end `exhausted`.
 *
 * execution_id fences each execution: every begin (first try, timeout reissue
 * or error retry) mints a new one, and only the current execution_id may finish
 * the attempt. A renewable lease never proves an older execution is dead.
 */
export const classificationFieldsAndAttemptsSchema: Migration = {
  name: "086_classification_fields_and_attempts.sql",
  sql: `
    ALTER TABLE project_classifications ADD COLUMN area TEXT;
    ALTER TABLE project_classifications ADD COLUMN scope_ref TEXT;
    ALTER TABLE project_classifications ADD COLUMN duplicate_of_stream_item_id TEXT
      REFERENCES stream_items(stream_item_id);
    ALTER TABLE project_classifications ADD COLUMN needs_human INTEGER
      CHECK (needs_human IS NULL OR needs_human IN (0, 1));
    ALTER TABLE project_classifications ADD COLUMN lease_id TEXT;
    ALTER TABLE project_classifications ADD COLUMN classifier_version TEXT;
    ALTER TABLE project_classifications ADD COLUMN taxonomy_version TEXT;
    ALTER TABLE project_classifications ADD COLUMN candidate_set_version TEXT;

    CREATE INDEX IF NOT EXISTS idx_project_classifications_area
      ON project_classifications(area);
    CREATE INDEX IF NOT EXISTS idx_project_classifications_scope_ref
      ON project_classifications(scope_ref);

    CREATE TABLE IF NOT EXISTS classification_attempts (
      attempt_id TEXT PRIMARY KEY,
      stream_item_id TEXT NOT NULL REFERENCES stream_items(stream_item_id),
      classifier_version TEXT NOT NULL,
      taxonomy_version TEXT NOT NULL,
      evidence_epoch TEXT NOT NULL,
      status TEXT NOT NULL
        CHECK (status IN ('in_flight', 'abstained', 'written', 'error', 'exhausted')),
      attempt_count INTEGER NOT NULL CHECK (attempt_count >= 1),
      execution_id TEXT NOT NULL,
      lease_id TEXT NOT NULL,
      classifier_session TEXT NOT NULL,
      retry_after TEXT,
      reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (stream_item_id, classifier_version, taxonomy_version, evidence_epoch)
    );

    CREATE INDEX IF NOT EXISTS idx_classification_attempts_status_retry
      ON classification_attempts(status, retry_after);
  `,
};
