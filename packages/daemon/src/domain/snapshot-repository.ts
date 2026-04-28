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

  findLatestAutoPreDown(rigId: string): Snapshot | null {
    const row = this.db
      .prepare(
        "SELECT * FROM snapshots WHERE rig_id = ? AND kind = 'auto-pre-down' ORDER BY created_at DESC LIMIT 1"
      )
      .get(rigId) as SnapshotRow | undefined;
    return row ? this.rowToSnapshot(row) : null;
  }

  /**
   * L3b: returns the latest snapshot whose persisted `data` carries the minimum
   * structural metadata `RestoreOrchestrator.restore`'s pre-validation requires.
   * Prefers `auto-pre-down` over other kinds when both are present.
   *
   * The single SQL query orders snapshots by `(kind = 'auto-pre-down') DESC,
   * created_at DESC, id DESC` so an auto-pre-down candidate always comes first
   * if any exists. The in-memory loop then validates each candidate and skips
   * snapshots with corrupted JSON or missing topology metadata, returning the
   * first usable row. Returns null when no usable snapshot exists.
   *
   * Distinct from `findLatestUsableSnapshot` (rig-repository.ts, L2): that
   * helper requires at least one persisted resume token and is consumed by
   * the lifecycle projection. This helper only requires structural metadata
   * `RestoreOrchestrator.restore` actually inspects, so terminal-only or
   * resume-tokenless rigs still resolve.
   */
  findLatestRestoreUsable(rigId: string): Snapshot | null {
    const rows = this.db
      .prepare(
        "SELECT * FROM snapshots WHERE rig_id = ? ORDER BY (kind = 'auto-pre-down') DESC, created_at DESC, id DESC"
      )
      .all(rigId) as SnapshotRow[];

    for (const row of rows) {
      let data: SnapshotData;
      try {
        data = JSON.parse(row.data) as SnapshotData;
      } catch {
        continue;
      }
      if (!isRestoreUsableSnapshotData(data)) continue;
      return this.rowToSnapshot(row);
    }
    return null;
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

// Validates `SnapshotData` carries the minimum structural metadata
// `RestoreOrchestrator.restore`'s pre-validation requires.
//
// Per the L3b orch amendment: validate against actual SnapshotData. There is
// NO `data.bindings[]` field and `Session` has NO `runtime` field (runtime
// lives on nodes). Resume tokens are NOT required (resume-tokenless rigs are
// still restorable).
//
// Required:
//   - rig with non-empty id
//   - nodes array (may be empty — restore handles empty topologies)
//   - edges array (may be empty)
//   - sessions array (may be empty — `validatePreRestore` accepts empty)
//   - checkpoints object
//
// When sessions is non-empty, each session must have a non-empty sessionName
// and nodeId so node linkage can be resolved during restore. We do NOT check
// session.runtime because that field doesn't exist on Session (orch amendment).
function isRestoreUsableSnapshotData(data: unknown): data is SnapshotData {
  if (!data || typeof data !== "object") return false;
  const d = data as SnapshotData;
  if (!d.rig || typeof d.rig.id !== "string" || d.rig.id.length === 0) return false;
  if (!Array.isArray(d.nodes)) return false;
  if (!Array.isArray(d.edges)) return false;
  if (!Array.isArray(d.sessions)) return false;
  if (!d.checkpoints || typeof d.checkpoints !== "object") return false;
  for (const s of d.sessions) {
    if (!s || typeof s !== "object") return false;
    if (typeof s.sessionName !== "string" || s.sessionName.length === 0) return false;
    if (typeof s.nodeId !== "string" || s.nodeId.length === 0) return false;
  }
  return true;
}
