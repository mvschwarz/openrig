import type Database from "better-sqlite3";
import { ulid } from "ulid";
import type { RestoreSnapshotSelection, RestoreSnapshotSummary, Snapshot, SnapshotData } from "./types.js";

export type RestoreSnapshotSelectionOutcome =
  | { ok: true; snapshot: Snapshot; selection: RestoreSnapshotSelection }
  | { ok: false; code: "snapshot_not_found" | "snapshot_wrong_rig" | "snapshot_unusable" | "no_usable_snapshot"; message: string };

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
   * Returns the latest snapshot whose persisted `data` carries the minimum
   * structural metadata `RestoreOrchestrator.restore`'s pre-validation requires.
   *
   * OPR.0.3.4.9 Option Y: prefers the most-recent of the crash-insurance tier
   * {auto-pre-down, auto-periodic} -- the freshest of the two wins. A newer
   * auto-periodic beats a stale auto-pre-down (the crash fix); a genuinely-
   * fresher auto-pre-down still wins (graceful-cycle preserved). Manual,
   * pre_restore, and auto-rehydrate remain below the tier (unchanged).
   *
   * The SQL query orders by `(kind IN ('auto-pre-down','auto-periodic')) DESC,
   * created_at DESC, id DESC`. The in-memory loop validates each candidate and
   * skips snapshots with corrupted JSON or missing topology metadata, returning
   * the first usable row. Returns null when no usable snapshot exists.
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
        "SELECT * FROM snapshots WHERE rig_id = ? ORDER BY (kind IN ('auto-pre-down', 'auto-periodic')) DESC, created_at DESC, id DESC"
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

  /** Resolve an exact or policy-ranked restore source and return the evidence
   * needed to make that decision legible before any restore mutation. */
  selectRestoreUsable(rigId: string, snapshotId?: string, nowMs: number = Date.now()): RestoreSnapshotSelectionOutcome {
    let snapshot: Snapshot | null;
    if (snapshotId) {
      snapshot = this.getSnapshot(snapshotId);
      if (!snapshot) return { ok: false, code: "snapshot_not_found", message: `Snapshot ${snapshotId} not found` };
      if (snapshot.rigId !== rigId) {
        return { ok: false, code: "snapshot_wrong_rig", message: `Snapshot ${snapshotId} belongs to rig ${snapshot.rigId}, not ${rigId}` };
      }
      if (!isRestoreUsableSnapshotData(snapshot.data)) {
        return { ok: false, code: "snapshot_unusable", message: `Snapshot ${snapshotId} is not structurally restore-usable` };
      }
    } else {
      snapshot = this.findLatestRestoreUsable(rigId);
      if (!snapshot) return { ok: false, code: "no_usable_snapshot", message: `No usable snapshot for rig ${rigId}` };
    }

    const newer = this.listSnapshots(rigId)
      .filter((candidate) => candidate.id !== snapshot!.id)
      .filter((candidate) => Date.parse(sqliteUtc(candidate.createdAt)) > Date.parse(sqliteUtc(snapshot!.createdAt)))
      .find((candidate) => isRestoreUsableSnapshotData(candidate.data));
    const mode = snapshotId ? "explicit" as const : "automatic" as const;
    return {
      ok: true,
      snapshot,
      selection: {
        ...summarizeSnapshot(snapshot, nowMs),
        mode,
        rationale: mode === "explicit"
          ? "operator selected this exact restore-usable snapshot"
          : "automatic crash-insurance ranking prefers auto-pre-down/auto-periodic, then newest usable",
        newerUsableAlternative: newer ? summarizeSnapshot(newer, nowMs) : null,
      },
    };
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

  /** OPR.0.3.4.9 — kind-scoped retention. Keeps the newest `keepCount` rows
   *  of the given kind and deletes only older rows of THAT kind. Never touches
   *  other kinds. Hard floor: keepCount >= 1 (never prune to zero). */
  pruneSnapshotsByKind(rigId: string, kind: string, keepCount: number): number {
    const effectiveKeep = Math.max(1, keepCount);
    const keepers = this.db
      .prepare(
        "SELECT id FROM snapshots WHERE rig_id = ? AND kind = ? ORDER BY created_at DESC LIMIT ?"
      )
      .all(rigId, kind, effectiveKeep) as { id: string }[];

    const keepIds = new Set(keepers.map((r) => r.id));

    const all = this.db
      .prepare("SELECT id FROM snapshots WHERE rig_id = ? AND kind = ?")
      .all(rigId, kind) as { id: string }[];

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

function sqliteUtc(value: string): string {
  return /Z$|[+-]\d\d:\d\d$/.test(value) ? value : value.replace(" ", "T") + "Z";
}

export function summarizeSnapshot(snapshot: Snapshot, nowMs: number = Date.now()): RestoreSnapshotSummary {
  return {
    snapshotId: snapshot.id,
    kind: snapshot.kind,
    createdAt: snapshot.createdAt,
    ageMs: Math.max(0, nowMs - Date.parse(sqliteUtc(snapshot.createdAt))),
  };
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
export function isRestoreUsableSnapshotData(data: unknown): data is SnapshotData {
  if (!data || typeof data !== "object") return false;
  const d = data as SnapshotData;
  if (!d.rig || typeof d.rig.id !== "string" || d.rig.id.length === 0) return false;
  if (!Array.isArray(d.nodes)) return false;
  if (!Array.isArray(d.edges)) return false;
  if (!Array.isArray(d.sessions)) return false;
  if (!d.checkpoints || typeof d.checkpoints !== "object") return false;
  const nodeIds = new Set<string>();
  for (const node of d.nodes) {
    if (!node || typeof node !== "object") return false;
    if (typeof node.id !== "string" || node.id.length === 0) return false;
    if (typeof node.logicalId !== "string" || node.logicalId.length === 0) return false;
    if (nodeIds.has(node.id)) return false;
    nodeIds.add(node.id);
  }
  for (const s of d.sessions) {
    if (!s || typeof s !== "object") return false;
    if (typeof s.sessionName !== "string" || s.sessionName.length === 0) return false;
    if (typeof s.nodeId !== "string" || s.nodeId.length === 0) return false;
  }
  if (d.topologyRoster !== undefined) {
    const roster = d.topologyRoster;
    const allowedSources = new Set(["materialized_topology", "operator_explicit", "legacy_current_nodes"]);
    if (roster.version !== 1 || !allowedSources.has(roster.source) || !Array.isArray(roster.intendedNodeIds)) return false;
    if (!roster.intendedNodeIds.every((nodeId) => typeof nodeId === "string" && nodeId.length > 0)) return false;
    if (new Set(roster.intendedNodeIds).size !== roster.intendedNodeIds.length) return false;
    if (roster.intendedNodeIds.some((nodeId) => !nodeIds.has(nodeId))) return false;
  }
  if (d.activeOccupantsByNode !== undefined) {
    if (!d.activeOccupantsByNode || typeof d.activeOccupantsByNode !== "object" || Array.isArray(d.activeOccupantsByNode)) return false;
    const intendedNodeIds = d.topologyRoster?.intendedNodeIds ?? [...nodeIds];
    if (intendedNodeIds.some((nodeId) => !(nodeId in d.activeOccupantsByNode!))) return false;
    if (Object.keys(d.activeOccupantsByNode).some((nodeId) => !nodeIds.has(nodeId))) return false;
    const sessionsById = new Map(d.sessions.map((session) => [session.id, session]));
    for (const [nodeId, state] of Object.entries(d.activeOccupantsByNode)) {
      if (!state || typeof state !== "object") return false;
      if (state.kind === "absent") continue;
      if (state.kind === "resolved" && typeof state.sessionId === "string" && state.sessionId.length > 0) {
        if (sessionsById.get(state.sessionId)?.nodeId !== nodeId) return false;
        continue;
      }
      if (state.kind === "ambiguous" && Array.isArray(state.candidateIds)) {
        if (state.candidateIds.length < 2 || new Set(state.candidateIds).size !== state.candidateIds.length) return false;
        if (state.candidateIds.some((id) => typeof id !== "string" || id.length === 0 || sessionsById.get(id)?.nodeId !== nodeId)) return false;
        continue;
      }
      return false;
    }
  }
  return true;
}
