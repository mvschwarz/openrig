import type Database from "better-sqlite3";
import { resolve } from "node:path";
import { ulid } from "ulid";
import { deriveComposeProjectName } from "./compose-project-name.js";
import type {
  Rig,
  Node,
  Edge,
  Binding,
  NodeWithBinding,
  RigWithRelations,
  RigServicesRecord,
  RigServicesRecordInput,
  Snapshot,
  SnapshotData,
} from "./types.js";

/**
 * Free helper: returns the latest snapshot for a rig whose data carries non-null
 * `resume_token` for at least one persisted session, or null otherwise.
 *
 * Used by node-inventory and ps-projection to derive `lifecycleState=recoverable`
 * post-L1 cold-start. Distinct from `findLatestAutoPreDown`, which filters by kind.
 */
interface SnapshotRow { id: string; rig_id: string; kind: string; status: string; data: string; created_at: string }

/** Shared row → usable-Snapshot mapping (single source of truth for the parse +
 *  the ≥1-resume-token usability rule), used by both the single-rig and the
 *  FS-1 W1.2 all-rigs batched reads so their semantics are byte-identical. */
function snapshotFromRowIfUsable(row: SnapshotRow): Snapshot | null {
  let data: SnapshotData;
  try {
    data = JSON.parse(row.data) as SnapshotData;
  } catch {
    return null;
  }

  const sessions = data.sessions ?? [];
  const hasAnyResumeToken = sessions.some(
    (s) => typeof s.resumeToken === "string" && s.resumeToken.length > 0,
  );
  if (!hasAnyResumeToken) return null;

  return {
    id: row.id,
    rigId: row.rig_id,
    kind: row.kind,
    status: row.status,
    data,
    createdAt: row.created_at,
  };
}

export function findLatestUsableSnapshot(db: Database.Database, rigId: string): Snapshot | null {
  const row = db.prepare(
    "SELECT * FROM snapshots WHERE rig_id = ? ORDER BY created_at DESC, id DESC LIMIT 1"
  ).get(rigId) as SnapshotRow | undefined;
  if (!row) return null;
  return snapshotFromRowIfUsable(row);
}

/**
 * FS-1 W1.2 — the all-rigs batched form of `findLatestUsableSnapshot`: the
 * latest snapshot per rig in ONE query (same `created_at DESC, id DESC` order),
 * each mapped through the shared `snapshotFromRowIfUsable`. Rigs with no usable
 * snapshot are simply absent from the map (callers default to null). Rides the
 * arch-D1.1 sibling-audit `snapshots(rig_id, created_at)` index candidate.
 */
export function findLatestUsableSnapshotsForAllRigs(db: Database.Database): Map<string, Snapshot> {
  const rows = db.prepare(`
    SELECT s.* FROM snapshots s
    WHERE s.id = (
      SELECT s2.id FROM snapshots s2 WHERE s2.rig_id = s.rig_id
      ORDER BY s2.created_at DESC, s2.id DESC LIMIT 1
    )
  `).all() as SnapshotRow[];
  const out = new Map<string, Snapshot>();
  for (const row of rows) {
    const snap = snapshotFromRowIfUsable(row);
    if (snap) out.set(row.rig_id, snap);
  }
  return out;
}

/**
 * OPR.0.3.3.19 - rig archive read filter. Default daemon reads EXCLUDE archived
 * rigs; explicit modes opt in. Mirrors the stream-items `--include-archived`
 * precedent (stream-store.list).
 */
export interface RigArchiveFilter {
  /** include both active and archived rigs */
  includeArchived?: boolean;
  /** return ONLY archived rigs */
  archivedOnly?: boolean;
}

/**
 * SQL condition fragment for the archive filter on a column (e.g. "archived_at"
 * or the aliased "r.archived_at"). Returns null when no filter applies
 * (includeArchived = include everything). Default (no filter) excludes archived.
 */
export function archiveWhereClause(col: string, filter?: RigArchiveFilter): string | null {
  if (filter?.archivedOnly) return `${col} IS NOT NULL`;
  if (filter?.includeArchived) return null;
  return `${col} IS NULL`;
}

interface NodeOptions {
  role?: string;
  runtime?: string;
  model?: string;
  codexConfigProfile?: string;
  /** OPR.0.4.8.3 Seam B: per-seat permission_policy REF (builtin:<name> or spec-relative path). */
  permissionPolicy?: string;
  cwd?: string;
  surfaceHint?: string;
  workspace?: string;
  restorePolicy?: string;
  packageRefs?: string[];
  podId?: string;
  agentRef?: string;
  profile?: string;
  label?: string;
  resolvedSpecName?: string;
  resolvedSpecVersion?: string;
  resolvedSpecHash?: string;
}

export class RigRepository {
  readonly db: Database.Database;
  constructor(db: Database.Database) {
    this.db = db;
  }

  createRig(name: string): Rig {
    const id = ulid();
    this.db
      .prepare("INSERT INTO rigs (id, name) VALUES (?, ?)")
      .run(id, name);

    return this.rowToRig(
      this.db.prepare("SELECT * FROM rigs WHERE id = ?").get(id) as RigRow
    );
  }

  /**
   * PL-007 Workspace Primitive — persist the typed workspace block on the
   * rigs row. Stored as JSON in `workspace_json` (migration 038). Pass
   * null to clear. Older test fixtures that bypass the canonical migration
   * list don't have the column; setter is a no-op in that case (the
   * caller's contract is "best-effort persistence"). Whoami / node-inventory
   * read this column to surface the rig's workspace block alongside cwd.
   */
  setRigWorkspace(rigId: string, workspace: import("./types.js").WorkspaceSpec | null): void {
    if (!this.hasRigColumn("workspace_json")) return;
    const json = workspace ? JSON.stringify(workspace) : null;
    this.db.prepare("UPDATE rigs SET workspace_json = ?, updated_at = ? WHERE id = ?")
      .run(json, new Date().toISOString(), rigId);
  }

  /** PL-007 — read the persisted workspace block for a rig. */
  getRigWorkspace(rigId: string): import("./types.js").WorkspaceSpec | null {
    if (!this.hasRigColumn("workspace_json")) return null;
    const row = this.db.prepare("SELECT workspace_json FROM rigs WHERE id = ?")
      .get(rigId) as { workspace_json: string | null } | undefined;
    if (!row || !row.workspace_json) return null;
    try {
      return JSON.parse(row.workspace_json) as import("./types.js").WorkspaceSpec;
    } catch {
      return null;
    }
  }

  /** OPR.0.4.8.3 Seam B — persist a rig's attached permission_policy REF (builtin:<name> or a
   *  spec-relative custom path), or null to clear. Mirrors setRigWorkspace (migration 056). */
  setRigPermissionPolicy(rigId: string, permissionPolicy: string | null): void {
    if (!this.hasRigColumn("permission_policy")) return;
    this.db.prepare("UPDATE rigs SET permission_policy = ?, updated_at = ? WHERE id = ?")
      .run(permissionPolicy ?? null, new Date().toISOString(), rigId);
  }

  /** OPR.0.4.8.3 Seam B — read the persisted rig-level permission_policy REF (null when none). */
  getRigPermissionPolicy(rigId: string): string | null {
    if (!this.hasRigColumn("permission_policy")) return null;
    const row = this.db.prepare("SELECT permission_policy FROM rigs WHERE id = ?")
      .get(rigId) as { permission_policy: string | null } | undefined;
    return row?.permission_policy ?? null;
  }

  /** Seam B Guard-F1 — persist the RIG-level resolved attachment provenance (migration 058).
   *  declaringDir = the ORIGINAL declaring RigSpec dir; consumers must never re-resolve the
   *  raw relative ref against an unrelated operation root. No-op on pre-058 fixture DBs. */
  setRigPolicyProvenance(
    rigId: string,
    provenance: {
      origin: "builtin" | "custom" | "deliberate_none";
      resolvedTarget: string | null;
      declaringDir: string | null;
      launchPosture: "floor" | "full_bypass";
    },
  ): void {
    if (!this.hasRigColumn("rig_policy_launch_posture")) return;
    this.db.prepare(
      "UPDATE rigs SET rig_policy_origin = ?, rig_policy_resolved_target = ?, rig_policy_declaring_dir = ?, rig_policy_launch_posture = ?, updated_at = ? WHERE id = ?",
    ).run(provenance.origin, provenance.resolvedTarget, provenance.declaringDir, provenance.launchPosture, new Date().toISOString(), rigId);
  }

  /** Seam B Guard-F1 — read the rig-level resolved attachment provenance (null when none). */
  getRigPolicyProvenance(rigId: string): {
    origin: "builtin" | "custom" | "deliberate_none";
    resolvedTarget: string | null;
    declaringDir: string | null;
    launchPosture: "floor" | "full_bypass";
    /** the raw rig ref (056) alongside, for re-validation */
    rigRef: string | null;
  } | null {
    if (!this.hasRigColumn("rig_policy_launch_posture")) return null;
    const row = this.db.prepare(
      "SELECT permission_policy, rig_policy_origin, rig_policy_resolved_target, rig_policy_declaring_dir, rig_policy_launch_posture FROM rigs WHERE id = ?",
    ).get(rigId) as {
      permission_policy: string | null;
      rig_policy_origin: string | null;
      rig_policy_resolved_target: string | null;
      rig_policy_declaring_dir: string | null;
      rig_policy_launch_posture: string | null;
    } | undefined;
    if (!row || row.rig_policy_origin == null || row.rig_policy_launch_posture == null) return null;
    return {
      origin: row.rig_policy_origin as "builtin" | "custom" | "deliberate_none",
      resolvedTarget: row.rig_policy_resolved_target,
      declaringDir: row.rig_policy_declaring_dir,
      launchPosture: row.rig_policy_launch_posture as "floor" | "full_bypass",
      rigRef: row.permission_policy,
    };
  }

  /** OPR.0.4.8.3 Seam B (R2, dev-guard ruling) — persist a node's RESOLVED policy attachment
   *  provenance (restart-stable: origin + resolved target + declaring dir + launch posture).
   *  Builtins carry resolvedTarget=null until the packaging leg's canonical path is ruled
   *  (PM lane c76c7153) — never a `builtin:<name>` echo. No-op on pre-057 fixture DBs. */
  setNodePolicyProvenance(
    nodeId: string,
    provenance: {
      origin: "builtin" | "custom" | "deliberate_none";
      resolvedTarget: string | null;
      declaringDir: string | null;
      launchPosture: "floor" | "full_bypass";
    },
  ): void {
    if (!this.hasNodeColumn("policy_launch_posture")) return;
    this.db.prepare(
      "UPDATE nodes SET policy_origin = ?, policy_resolved_target = ?, policy_declaring_dir = ?, policy_launch_posture = ? WHERE id = ?",
    ).run(provenance.origin, provenance.resolvedTarget, provenance.declaringDir, provenance.launchPosture, nodeId);
  }

  /** Seam B (R2) — read a node's persisted policy provenance; null when none attached
   *  (or pre-057 DB). Restore consumers re-derive posture from this without the spec. */
  getNodePolicyProvenance(nodeId: string): {
    origin: "builtin" | "custom" | "deliberate_none";
    resolvedTarget: string | null;
    declaringDir: string | null;
    launchPosture: "floor" | "full_bypass";
    /** The node's own raw ref (member-level; null when the attachment came from the rig). */
    nodeRef: string | null;
  } | null {
    if (!this.hasNodeColumn("policy_launch_posture")) return null;
    const row = this.db.prepare(
      "SELECT permission_policy, policy_origin, policy_resolved_target, policy_declaring_dir, policy_launch_posture FROM nodes WHERE id = ?",
    ).get(nodeId) as {
      permission_policy: string | null;
      policy_origin: string | null;
      policy_resolved_target: string | null;
      policy_declaring_dir: string | null;
      policy_launch_posture: string | null;
    } | undefined;
    if (!row || row.policy_origin == null || row.policy_launch_posture == null) return null;
    return {
      origin: row.policy_origin as "builtin" | "custom" | "deliberate_none",
      resolvedTarget: row.policy_resolved_target,
      declaringDir: row.policy_declaring_dir,
      launchPosture: row.policy_launch_posture as "floor" | "full_bypass",
      nodeRef: row.permission_policy,
    };
  }

  /** PL-007 — defensive column probe on rigs (migration 038's
   *  workspace_json is absent in legacy test fixtures). */
  private hasRigColumn(columnName: string): boolean {
    try {
      return this.db.prepare("PRAGMA table_info(rigs)").all()
        .some((row) => (row as { name?: string }).name === columnName);
    } catch {
      return false;
    }
  }

  addNode(rigId: string, logicalId: string, opts?: NodeOptions): Node {
    // Same-rig guard for podId
    if (opts?.podId) {
      const pod = this.db.prepare("SELECT rig_id FROM pods WHERE id = ?").get(opts.podId) as { rig_id: string } | undefined;
      if (!pod) throw new Error(`Pod not found: ${opts.podId}`);
      if (pod.rig_id !== rigId) throw new Error("Pod belongs to a different rig");
    }

    const id = ulid();
    if (this.hasNodeColumn("codex_config_profile") && this.hasNodeColumn("permission_policy")) {
      // OPR.0.4.8.3 Seam B: both ALTER-added optional columns present (migrations 022 + 055; 055
      // runs after 022, so a permission_policy column implies a codex_config_profile column).
      this.db
        .prepare(
          `INSERT INTO nodes (id, rig_id, logical_id, role, runtime, model, codex_config_profile, permission_policy, cwd, surface_hint, workspace, restore_policy, package_refs,
           pod_id, agent_ref, profile, label, resolved_spec_name, resolved_spec_version, resolved_spec_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          rigId,
          logicalId,
          opts?.role ?? null,
          opts?.runtime ?? null,
          opts?.model ?? null,
          opts?.codexConfigProfile ?? null,
          opts?.permissionPolicy ?? null,
          opts?.cwd ?? null,
          opts?.surfaceHint ?? null,
          opts?.workspace ?? null,
          opts?.restorePolicy ?? null,
          opts?.packageRefs ? JSON.stringify(opts.packageRefs) : null,
          opts?.podId ?? null,
          opts?.agentRef ?? null,
          opts?.profile ?? null,
          opts?.label ?? null,
          opts?.resolvedSpecName ?? null,
          opts?.resolvedSpecVersion ?? null,
          opts?.resolvedSpecHash ?? null,
        );
    } else if (this.hasNodeColumn("codex_config_profile")) {
      this.db
        .prepare(
          `INSERT INTO nodes (id, rig_id, logical_id, role, runtime, model, codex_config_profile, cwd, surface_hint, workspace, restore_policy, package_refs,
           pod_id, agent_ref, profile, label, resolved_spec_name, resolved_spec_version, resolved_spec_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          rigId,
          logicalId,
          opts?.role ?? null,
          opts?.runtime ?? null,
          opts?.model ?? null,
          opts?.codexConfigProfile ?? null,
          opts?.cwd ?? null,
          opts?.surfaceHint ?? null,
          opts?.workspace ?? null,
          opts?.restorePolicy ?? null,
          opts?.packageRefs ? JSON.stringify(opts.packageRefs) : null,
          opts?.podId ?? null,
          opts?.agentRef ?? null,
          opts?.profile ?? null,
          opts?.label ?? null,
          opts?.resolvedSpecName ?? null,
          opts?.resolvedSpecVersion ?? null,
          opts?.resolvedSpecHash ?? null,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO nodes (id, rig_id, logical_id, role, runtime, model, cwd, surface_hint, workspace, restore_policy, package_refs,
           pod_id, agent_ref, profile, label, resolved_spec_name, resolved_spec_version, resolved_spec_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          rigId,
          logicalId,
          opts?.role ?? null,
          opts?.runtime ?? null,
          opts?.model ?? null,
          opts?.cwd ?? null,
          opts?.surfaceHint ?? null,
          opts?.workspace ?? null,
          opts?.restorePolicy ?? null,
          opts?.packageRefs ? JSON.stringify(opts.packageRefs) : null,
          opts?.podId ?? null,
          opts?.agentRef ?? null,
          opts?.profile ?? null,
          opts?.label ?? null,
          opts?.resolvedSpecName ?? null,
          opts?.resolvedSpecVersion ?? null,
          opts?.resolvedSpecHash ?? null,
        );
    }

    return this.rowToNode(
      this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as NodeRow
    );
  }

  addEdge(rigId: string, sourceId: string, targetId: string, kind: string): Edge {
    const id = ulid();
    this.db
      .prepare(
        "INSERT INTO edges (id, rig_id, source_id, target_id, kind) VALUES (?, ?, ?, ?, ?)"
      )
      .run(id, rigId, sourceId, targetId, kind);

    return this.rowToEdge(
      this.db.prepare("SELECT * FROM edges WHERE id = ?").get(id) as EdgeRow
    );
  }

  getRig(rigId: string): RigWithRelations | null {
    const rigRow = this.db
      .prepare("SELECT * FROM rigs WHERE id = ?")
      .get(rigId) as RigRow | undefined;

    if (!rigRow) return null;

    const nodeRows = this.db
      .prepare("SELECT * FROM nodes WHERE rig_id = ? ORDER BY created_at")
      .all(rigId) as NodeRow[];

    const edgeRows = this.db
      .prepare("SELECT * FROM edges WHERE rig_id = ?")
      .all(rigId) as EdgeRow[];

    const nodes: NodeWithBinding[] = nodeRows.map((row) => {
      const bindingRow = this.db
        .prepare("SELECT * FROM bindings WHERE node_id = ?")
        .get(row.id) as BindingRow | undefined;

      return {
        ...this.rowToNode(row),
        binding: bindingRow ? this.rowToBinding(bindingRow) : null,
      };
    });

    return {
      rig: this.rowToRig(rigRow),
      nodes,
      edges: edgeRows.map((r) => this.rowToEdge(r)),
    };
  }

  listRigs(filter?: RigArchiveFilter): Rig[] {
    const cond = archiveWhereClause("archived_at", filter);
    const where = cond ? `WHERE ${cond}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM rigs ${where} ORDER BY created_at`)
      .all() as RigRow[];
    return rows.map((r) => this.rowToRig(r));
  }

  /**
   * Returns the latest snapshot for this rig with at least one non-null resume token,
   * or null if no usable snapshot exists. Used by the lifecycle projection to derive
   * `recoverable` state.
   */
  findLatestUsableSnapshot(rigId: string): Snapshot | null {
    return findLatestUsableSnapshot(this.db, rigId);
  }

  findRigsByName(name: string): Rig[] {
    const rows = this.db
      .prepare("SELECT * FROM rigs WHERE name = ? ORDER BY created_at")
      .all(name) as RigRow[];
    return rows.map((r) => this.rowToRig(r));
  }

  getRigSummaries(filter?: RigArchiveFilter): Array<{ id: string; name: string; nodeCount: number; latestSnapshotAt: string | null; latestSnapshotId: string | null; hasServices: boolean; archivedAt: string | null }> {
    const cond = archiveWhereClause("r.archived_at", filter);
    const where = cond ? `WHERE ${cond}` : "";
    const rows = this.db.prepare(`
      SELECT
        r.id,
        r.name,
        r.archived_at AS archived_at,
        (SELECT COUNT(*) FROM nodes n WHERE n.rig_id = r.id) AS node_count,
        EXISTS(SELECT 1 FROM rig_services rs WHERE rs.rig_id = r.id) AS has_services,
        ls.id AS latest_snapshot_id,
        ls.created_at AS latest_snapshot_at
      FROM rigs r
      LEFT JOIN snapshots ls ON ls.id = (
        SELECT s2.id FROM snapshots s2
        WHERE s2.rig_id = r.id
        ORDER BY s2.created_at DESC, s2.id DESC
        LIMIT 1
      )
      ${where}
      ORDER BY r.created_at
    `).all() as Array<{ id: string; name: string; archived_at: string | null; node_count: number; has_services: number; latest_snapshot_id: string | null; latest_snapshot_at: string | null }>;

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      nodeCount: r.node_count,
      hasServices: r.has_services === 1,
      latestSnapshotAt: r.latest_snapshot_at,
      latestSnapshotId: r.latest_snapshot_id,
      archivedAt: r.archived_at,
    }));
  }

  /**
   * OPR.0.3.3.19 - soft-archive a rig: sets `archived_at`. The rigs row,
   * topology rows, and snapshots are all RETAINED (this is NOT the delete
   * path - contrast deleteRig). Returns false if the rig was already archived.
   */
  archiveRig(rigId: string): boolean {
    const result = this.db
      .prepare("UPDATE rigs SET archived_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND archived_at IS NULL")
      .run(rigId);
    return result.changes > 0;
  }

  /** OPR.0.3.3.19 - reverse archive: clears `archived_at`. Returns false if not archived. */
  unarchiveRig(rigId: string): boolean {
    const result = this.db
      .prepare("UPDATE rigs SET archived_at = NULL, updated_at = datetime('now') WHERE id = ? AND archived_at IS NOT NULL")
      .run(rigId);
    return result.changes > 0;
  }

  deleteRig(rigId: string): void {
    this.db.prepare("DELETE FROM rigs WHERE id = ?").run(rigId);
  }

  deleteNode(nodeId: string): void {
    this.db.prepare("DELETE FROM nodes WHERE id = ?").run(nodeId);
  }

  setServicesRecord(rigId: string, record: RigServicesRecordInput): RigServicesRecord {
    const now = new Date().toISOString();
    const composeFile = resolve(record.rigRoot, record.composeFile);
    const rig = this.db.prepare("SELECT name FROM rigs WHERE id = ?").get(rigId) as { name: string } | undefined;
    if (!rig) throw new Error(`Rig not found: ${rigId}`);
    const projectName = record.projectName ?? deriveComposeProjectName(rig.name);
    this.db.prepare(`
      INSERT INTO rig_services (
        rig_id,
        kind,
        spec_json,
        rig_root,
        compose_file,
        project_name,
        latest_receipt_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(rig_id) DO UPDATE SET
        kind = excluded.kind,
        spec_json = excluded.spec_json,
        rig_root = excluded.rig_root,
        compose_file = excluded.compose_file,
        project_name = excluded.project_name,
        latest_receipt_json = excluded.latest_receipt_json,
        updated_at = excluded.updated_at
    `).run(
      rigId,
      record.kind,
      record.specJson,
      record.rigRoot,
      composeFile,
      projectName,
      record.latestReceiptJson ?? null,
      now,
      now,
    );

    const stored = this.db.prepare("SELECT * FROM rig_services WHERE rig_id = ?").get(rigId) as RigServicesRow | undefined;
    if (!stored) throw new Error(`Failed to persist services record for rig ${rigId}`);
    return this.rowToServicesRecord(stored);
  }

  getServicesRecord(rigId: string): RigServicesRecord | null {
    const row = this.db.prepare("SELECT * FROM rig_services WHERE rig_id = ?").get(rigId) as RigServicesRow | undefined;
    return row ? this.rowToServicesRecord(row) : null;
  }

  updateServicesReceipt(rigId: string, latestReceiptJson: string | null): RigServicesRecord | null {
    const now = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE rig_services
      SET latest_receipt_json = ?, updated_at = ?
      WHERE rig_id = ?
    `).run(latestReceiptJson, now, rigId);

    if (result.changes === 0) return null;
    return this.getServicesRecord(rigId);
  }

  // -- Row-to-domain mappers --

  private rowToRig(row: RigRow): Rig {
    return {
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private rowToNode(row: NodeRow): Node {
    return {
      id: row.id,
      rigId: row.rig_id,
      logicalId: row.logical_id,
      role: row.role,
      runtime: row.runtime,
      model: row.model,
      codexConfigProfile: row.codex_config_profile ?? null,
      permissionPolicy: row.permission_policy ?? null,
      cwd: row.cwd,
      surfaceHint: row.surface_hint ?? null,
      workspace: row.workspace ?? null,
      restorePolicy: row.restore_policy ?? null,
      packageRefs: row.package_refs ? JSON.parse(row.package_refs) as string[] : [],
      podId: row.pod_id ?? null,
      agentRef: row.agent_ref ?? null,
      profile: row.profile ?? null,
      label: row.label ?? null,
      resolvedSpecName: row.resolved_spec_name ?? null,
      resolvedSpecVersion: row.resolved_spec_version ?? null,
      resolvedSpecHash: row.resolved_spec_hash ?? null,
      occupantLifecycle: row.occupant_lifecycle as Node["occupantLifecycle"] ?? null,
      continuityOutcome: row.continuity_outcome as Node["continuityOutcome"] ?? null,
      handoverResult: row.handover_result as Node["handoverResult"] ?? null,
      previousOccupant: row.previous_occupant ?? null,
      handoverAt: row.handover_at ?? null,
      createdAt: row.created_at,
    };
  }

  private rowToEdge(row: EdgeRow): Edge {
    return {
      id: row.id,
      rigId: row.rig_id,
      sourceId: row.source_id,
      targetId: row.target_id,
      kind: row.kind,
      createdAt: row.created_at,
    };
  }

  private rowToBinding(row: BindingRow): Binding {
    return {
      id: row.id,
      nodeId: row.node_id,
      attachmentType: (row.attachment_type as Binding["attachmentType"]) ?? "tmux",
      tmuxSession: row.tmux_session,
      tmuxWindow: row.tmux_window,
      tmuxPane: row.tmux_pane,
      externalSessionName: row.external_session_name ?? null,
      cmuxWorkspace: row.cmux_workspace,
      cmuxSurface: row.cmux_surface,
      updatedAt: row.updated_at,
    };
  }

  private rowToServicesRecord(row: RigServicesRow): RigServicesRecord {
    return {
      rigId: row.rig_id,
      kind: row.kind as "compose",
      specJson: row.spec_json,
      rigRoot: row.rig_root,
      composeFile: row.compose_file,
      projectName: row.project_name,
      latestReceiptJson: row.latest_receipt_json ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private hasNodeColumn(columnName: string): boolean {
    return this.db.prepare("PRAGMA table_info(nodes)").all()
      .some((row) => (row as { name?: string }).name === columnName);
  }
}

// -- Raw DB row types (snake_case) --

interface RigRow {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

interface NodeRow {
  id: string;
  rig_id: string;
  logical_id: string;
  role: string | null;
  runtime: string | null;
  model: string | null;
  codex_config_profile?: string | null;
  permission_policy?: string | null;
  cwd: string | null;
  surface_hint: string | null;
  workspace: string | null;
  restore_policy: string | null;
  package_refs: string | null;
  pod_id: string | null;
  agent_ref: string | null;
  profile: string | null;
  label: string | null;
  resolved_spec_name: string | null;
  resolved_spec_version: string | null;
  resolved_spec_hash: string | null;
  occupant_lifecycle: string | null;
  continuity_outcome: string | null;
  handover_result: string | null;
  previous_occupant: string | null;
  handover_at: string | null;
  created_at: string;
}

interface EdgeRow {
  id: string;
  rig_id: string;
  source_id: string;
  target_id: string;
  kind: string;
  created_at: string;
}

interface BindingRow {
  id: string;
  node_id: string;
  attachment_type: string | null;
  tmux_session: string | null;
  tmux_window: string | null;
  tmux_pane: string | null;
  external_session_name: string | null;
  cmux_workspace: string | null;
  cmux_surface: string | null;
  updated_at: string;
}

interface RigServicesRow {
  rig_id: string;
  kind: string;
  spec_json: string;
  rig_root: string;
  compose_file: string;
  project_name: string;
  latest_receipt_json: string | null;
  created_at: string;
  updated_at: string;
}
