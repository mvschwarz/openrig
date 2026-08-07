import type Database from "better-sqlite3";

export interface ProjectionManifestEntry {
  targetPath: string;
  lastHash: string;
  writtenAt: string;
  sourceSpec: string | null;
  category: string | null;
}

interface Row {
  target_path: string;
  last_hash: string;
  written_at: string;
  source_spec: string | null;
  category: string | null;
}

/**
 * P20 — accessors for the projection_manifest. `record` is called ON WRITE (the
 * projector actually wrote content to targetPath); `get` is consulted at
 * classify-time to discriminate stale-projection (target == last_hash → safe
 * overwrite) from operator-modified (target diverges from BOTH last_hash and the
 * new source → protect). Upsert on target_path keeps exactly the LAST write.
 */
export class ProjectionManifestStore {
  constructor(private readonly db: Database.Database) {}

  record(entry: {
    targetPath: string;
    lastHash: string;
    writtenAt: string;
    sourceSpec?: string | null;
    category?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO projection_manifest (target_path, last_hash, written_at, source_spec, category)
           VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(target_path) DO UPDATE SET
           last_hash = excluded.last_hash,
           written_at = excluded.written_at,
           source_spec = excluded.source_spec,
           category = excluded.category`,
      )
      .run(entry.targetPath, entry.lastHash, entry.writtenAt, entry.sourceSpec ?? null, entry.category ?? null);
  }

  get(targetPath: string): ProjectionManifestEntry | null {
    const row = this.db
      .prepare(`SELECT target_path, last_hash, written_at, source_spec, category FROM projection_manifest WHERE target_path = ?`)
      .get(targetPath) as Row | undefined;
    if (!row) return null;
    return {
      targetPath: row.target_path,
      lastHash: row.last_hash,
      writtenAt: row.written_at,
      sourceSpec: row.source_spec ?? null,
      category: row.category ?? null,
    };
  }

  /** Convenience for the discrimination rule: the last-written hash, or null. */
  lastHash(targetPath: string): string | null {
    return this.get(targetPath)?.lastHash ?? null;
  }
}
