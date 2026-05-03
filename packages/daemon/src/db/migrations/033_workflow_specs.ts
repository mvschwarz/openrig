import type { Migration } from "../migrate.js";

/**
 * Workflow specs (PL-004 Phase D; daemon-native Workflow Runtime).
 *
 * Per PRD § L4 Workflow Runtime: workflow specs are markdown/YAML
 * authoritative — the daemon caches a read-through copy here so that
 * lookups are fast and instances can resolve the spec at runtime
 * even if the source file moves. source_hash invalidates the cache
 * on next read; valid operator edits to the spec file win
 * (workspace-surface reconciliation contract).
 *
 * Columns:
 *   - spec_id (ULID PK)
 *   - name (workflow.id from spec yaml)
 *   - version (workflow.version)
 *   - purpose (workflow.objective)
 *   - target_rig (workflow.target.rig)
 *   - roles_json (serialized roles[] map)
 *   - steps_json (serialized steps[] array)
 *   - coordination_terminal_turn_rule (default `hot_potato`)
 *   - source_path (markdown/yaml spec file path on disk)
 *   - source_hash (content hash for invalidation detection)
 *   - cached_at (ISO timestamp; latest read-through cache stamp)
 *
 * Unique constraint on (name, version) — a workflow spec at a given
 * version is canonical; re-caching the same spec content updates
 * cached_at + source_hash without inserting a duplicate row.
 */
export const workflowSpecsSchema: Migration = {
  name: "033_workflow_specs.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS workflow_specs (
      spec_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      purpose TEXT,
      target_rig TEXT,
      roles_json TEXT NOT NULL,
      steps_json TEXT NOT NULL,
      coordination_terminal_turn_rule TEXT NOT NULL DEFAULT 'hot_potato',
      source_path TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      cached_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_specs_name_version
      ON workflow_specs(name, version);
    CREATE INDEX IF NOT EXISTS idx_workflow_specs_target_rig
      ON workflow_specs(target_rig);
  `,
};
