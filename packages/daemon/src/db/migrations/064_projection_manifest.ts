import type { Migration } from "../migrate.js";

/**
 * P20 — the PROJECTION MANIFEST: what the projector last WROTE to each target,
 * so a divergent target can be discriminated operator-modified (protect) vs
 * stale-projection (safe overwrite). Follows P17 (overwrite-with-loud-warning,
 * the manifest-less default): P17 sees only "target ≠ source" and cannot tell an
 * operator edit from a stale projection; this table adds the third data point —
 * last_hash = the content hash the projector last wrote to target_path.
 *
 * One row per projected target, keyed by absolute path. Per-row upserts are
 * transactional (nodes launch concurrently → a whole-file JSON manifest would
 * race; a DB table does not). Recorded ON WRITE only (idempotent: re-projecting
 * identical content is a no-op → no row change).
 *
 * (Number 064: next-free at authoring on fold-64 base — 061 is P7's lifecycle
 * table folding separately, 060/062/063 are other lanes. The desk owns the final
 * migration-number union at restack; own-table semantics are the ruling.)
 */
export const projectionManifestSchema: Migration = {
  name: "064_projection_manifest.sql",
  sql: `
    CREATE TABLE IF NOT EXISTS projection_manifest (
      target_path TEXT PRIMARY KEY,
      last_hash   TEXT NOT NULL,
      written_at  TEXT NOT NULL,
      source_spec TEXT,
      category    TEXT
    );
  `,
};
