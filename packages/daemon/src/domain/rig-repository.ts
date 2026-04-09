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
} from "./types.js";

interface NodeOptions {
  role?: string;
  runtime?: string;
  model?: string;
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

  addNode(rigId: string, logicalId: string, opts?: NodeOptions): Node {
    // Same-rig guard for podId
    if (opts?.podId) {
      const pod = this.db.prepare("SELECT rig_id FROM pods WHERE id = ?").get(opts.podId) as { rig_id: string } | undefined;
      if (!pod) throw new Error(`Pod not found: ${opts.podId}`);
      if (pod.rig_id !== rigId) throw new Error("Pod belongs to a different rig");
    }

    const id = ulid();
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

  listRigs(): Rig[] {
    const rows = this.db
      .prepare("SELECT * FROM rigs ORDER BY created_at")
      .all() as RigRow[];
    return rows.map((r) => this.rowToRig(r));
  }

  findRigsByName(name: string): Rig[] {
    const rows = this.db
      .prepare("SELECT * FROM rigs WHERE name = ? ORDER BY created_at")
      .all(name) as RigRow[];
    return rows.map((r) => this.rowToRig(r));
  }

  getRigSummaries(): Array<{ id: string; name: string; nodeCount: number; latestSnapshotAt: string | null; latestSnapshotId: string | null; hasServices: boolean }> {
    const rows = this.db.prepare(`
      SELECT
        r.id,
        r.name,
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
      ORDER BY r.created_at
    `).all() as Array<{ id: string; name: string; node_count: number; has_services: number; latest_snapshot_id: string | null; latest_snapshot_at: string | null }>;

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      nodeCount: r.node_count,
      hasServices: r.has_services === 1,
      latestSnapshotAt: r.latest_snapshot_at,
      latestSnapshotId: r.latest_snapshot_id,
    }));
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
