import type { Migration } from "../migrate.js";

/**
 * Slice 11 (release-0.3.1 workflow-spec-folder-discovery) —
 * workflow_specs diagnostic columns.
 *
 * SC-29 #10 (verbatim, declared in commit body):
 *   "Slice 11 (workflow-spec-folder-discovery) requires schema
 *   migration 040_workflow_specs_diagnostic.ts adding
 *   status TEXT DEFAULT 'valid' + error_message TEXT columns to the
 *   workflow_specs cache. No new table, no constraint changes beyond
 *   default; ALTER TABLE ADD COLUMN preserves existing rows (default
 *   'valid' fills retroactively for already-cached rows). Read-only
 *   diagnostic surface — the cache stores parser/validator errors
 *   so the Library UI can render them; daemon does not act on the
 *   diagnostic state. Per IMPL-PRD §HG-8 'unless provenance / status
 *   columns require migration — declare upfront if so': declared
 *   upfront in slice 11 ACK + commit body."
 *
 * Columns:
 *   - status TEXT NOT NULL DEFAULT 'valid' — one of 'valid' | 'error'.
 *     Existing rows pre-040 retroactively gain 'valid' via the
 *     DEFAULT clause when ALTER TABLE ADD COLUMN populates them.
 *   - error_message TEXT NULL — populated only when status='error';
 *     carries the parse/validation diagnostic for the UI to render.
 *
 * Provenance is NOT a new column — derived at scan time from
 * source_path relative to the daemon's bundled-builtin starter dir
 * (existing scanner logic at spec-library-workflow-scanner.ts
 * already does isUnderDir(source_path, workflowBuiltinSpecsDir)).
 */
export const workflowSpecsDiagnosticSchema: Migration = {
  name: "040_workflow_specs_diagnostic.sql",
  sql: `
    ALTER TABLE workflow_specs ADD COLUMN status TEXT NOT NULL DEFAULT 'valid';
    ALTER TABLE workflow_specs ADD COLUMN error_message TEXT;
  `,
};
