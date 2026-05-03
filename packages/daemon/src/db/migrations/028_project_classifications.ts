import type { Migration } from "../migrate.js";

/**
 * Project classifications (PL-004 Phase B; L2 Project / Classifier).
 *
 * Per PRD § L2 + slice IMPL § Write Set: agent-backed classification of
 * stream items. Daemon owns idempotency (UNIQUE on stream_item_id) and
 * lease validation (delegated to classifier-lease-manager). Classification
 * fields are agent judgment — daemon does NOT enforce taxonomies on them.
 *
 * Idempotency contract: re-projection of the same stream_item_id MUST
 * fail with structured 409. The first row wins; the second attempt's
 * classification is rejected.
 */
export const projectClassificationsSchema: Migration = {
  name: "028_project_classifications.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS project_classifications (
      project_id TEXT PRIMARY KEY,
      stream_item_id TEXT NOT NULL UNIQUE,
      classification_type TEXT,
      classification_urgency TEXT,
      classification_maturity TEXT,
      classification_confidence TEXT,
      classification_destination TEXT,
      action TEXT,
      classifier_session TEXT NOT NULL,
      ts_projected TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_project_classifications_classifier_session ON project_classifications(classifier_session);
    CREATE INDEX IF NOT EXISTS idx_project_classifications_destination ON project_classifications(classification_destination);
    CREATE INDEX IF NOT EXISTS idx_project_classifications_ts_projected ON project_classifications(ts_projected);
  `,
};
