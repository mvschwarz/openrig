import type Database from "better-sqlite3";
import { ulid } from "ulid";
import type { Snapshot, SnapshotData } from "./types.js";

interface ListOptions {
  kind?: string;
  limit?: number;
}

export class SnapshotRepository {
  readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  createSnapshot(rigId: string, kind: string, data: SnapshotData): Snapshot {
    const id = ulid();
    this.db
      .prepare(
        "INSERT INTO snapshots (id, rig_id, kind, data) VALUES (?, ?, ?, ?)"
      )
      .run(id, rigId, kind, JSON.stringify(data));

    return this.rowToSnapshot(
      this.db.prepare("SELECT * FROM snapshots WHERE id = ?").get(id) as SnapshotRow
    );
  }

  getSnapshot(id: string): Snapshot | null {
    const row = this.db
      .prepare("SELECT * FROM snapshots WHERE id = ?")
      .get(id) as SnapshotRow | undefined;
    return row ? this.rowToSnapshot(row) : null;
  }

  getLatestSnapshot(rigId: string): Snapshot | null {
    const row = this.db
      .prepare(
        "SELECT * FROM snapshots WHERE rig_id = ? ORDER BY created_at DESC LIMIT 1"
      )
      .get(rigId) as SnapshotRow | undefined;
    return row ? this.rowToSnapshot(row) : null;
  }

  listSnapshots(rigId: string, opts?: ListOptions): Snapshot[] {
    let sql = "SELECT * FROM snapshots WHERE rig_id = ?";
    const params: unknown[] = [rigId];

    if (opts?.kind) {
      sql += " AND kind = ?";
      params.push(opts.kind);
    }

    sql += " ORDER BY created_at DESC";

    if (opts?.limit) {
      sql += " LIMIT ?";
      params.push(opts.limit);
    }

    const rows = this.db.prepare(sql).all(...params) as SnapshotRow[];
    return rows.map((r) => this.rowToSnapshot(r));
  }

  pruneSnapshots(rigId: string, keepCount: number): number {
    // Find IDs to keep (newest N)
    const keepers = this.db
      .prepare(
        "SELECT id FROM snapshots WHERE rig_id = ? ORDER BY created_at DESC LIMIT ?"
      )
      .all(rigId, keepCount) as { id: string }[];

    const keepIds = new Set(keepers.map((r) => r.id));

    // Delete everything else for this rig
    const all = this.db
      .prepare("SELECT id FROM snapshots WHERE rig_id = ?")
      .all(rigId) as { id: string }[];

    const toDelete = all.filter((r) => !keepIds.has(r.id));

    if (toDelete.length === 0) return 0;

    const placeholders = toDelete.map(() => "?").join(",");
    this.db
      .prepare(`DELETE FROM snapshots WHERE id IN (${placeholders})`)
      .run(...toDelete.map((r) => r.id));

    return toDelete.length;
  }

  private rowToSnapshot(row: SnapshotRow): Snapshot {
    return {
      id: row.id,
      rigId: row.rig_id,
      kind: row.kind,
      status: row.status,
      data: JSON.parse(row.data) as SnapshotData,
      createdAt: row.created_at,
    };
  }
}

interface SnapshotRow {
  id: string;
  rig_id: string;
  kind: string;
  status: string;
  data: string;
  created_at: string;
}
