import type { Migration } from "../migrate.js";

/**
 * Custom views (PL-004 Phase B; L5 View — custom-view registration table).
 *
 * Per PRD § L5: built-in views (`recently-active`, `founder`, `pod-load`,
 * `escalations`, `held`, `activity`) are HARDCODED in view-projector.ts.
 * Operator-defined custom views are stored in this table and registered at
 * daemon startup from `~/.openrig/views.yaml` (or via API at runtime).
 *
 * Built-in views are NOT inserted into this table — view-projector.ts
 * exposes them by name without DB lookup. Custom views are looked up here
 * when the operator queries `rig view show <custom-name>`.
 */
export const viewsCustomSchema: Migration = {
  name: "030_views_custom.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS views_custom (
      view_id TEXT PRIMARY KEY,
      view_name TEXT NOT NULL UNIQUE,
      definition TEXT NOT NULL,
      registered_by_session TEXT NOT NULL,
      registered_at TEXT NOT NULL,
      last_evaluated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_views_custom_registered_by ON views_custom(registered_by_session);
  `,
};
