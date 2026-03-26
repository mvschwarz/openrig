import type Database from "better-sqlite3";
import { ulid } from "ulid";
import type { BootstrapRun, BootstrapAction, BootstrapStatus, ActionKind, ActionStatus } from "./bootstrap-types.js";

interface BootstrapRunRow {
  id: string;
  source_kind: string;
  source_ref: string;
  status: string;
  rig_id: string | null;
  created_at: string;
  applied_at: string | null;
}

interface BootstrapActionRow {
  id: string;
  bootstrap_id: string;
  seq: number;
  action_kind: string;
  subject_type: string | null;
  subject_name: string | null;
  provider: string | null;
  command_preview: string | null;
  status: string;
  detail_json: string | null;
  created_at: string;
}

export class BootstrapRepository {
  readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  createRun(sourceKind: string, sourceRef: string): BootstrapRun {
    const id = ulid();
    this.db.prepare(
      "INSERT INTO bootstrap_runs (id, source_kind, source_ref) VALUES (?, ?, ?)"
    ).run(id, sourceKind, sourceRef);
    return this.getRun(id)!;
  }

  getRun(id: string): BootstrapRun | null {
    const row = this.db.prepare("SELECT * FROM bootstrap_runs WHERE id = ?")
      .get(id) as BootstrapRunRow | undefined;
    return row ? this.rowToRun(row) : null;
  }

  listRuns(): BootstrapRun[] {
    const rows = this.db.prepare("SELECT * FROM bootstrap_runs ORDER BY created_at DESC")
      .all() as BootstrapRunRow[];
    return rows.map((r) => this.rowToRun(r));
  }

  updateRunStatus(id: string, status: BootstrapStatus, opts?: { rigId?: string; appliedAt?: string }): void {
    if (opts?.rigId) {
      this.db.prepare("UPDATE bootstrap_runs SET status = ?, rig_id = ?, applied_at = ? WHERE id = ?")
        .run(status, opts.rigId, opts.appliedAt ?? new Date().toISOString(), id);
    } else if (status === "completed" || status === "failed" || status === "partial") {
      this.db.prepare("UPDATE bootstrap_runs SET status = ?, applied_at = ? WHERE id = ?")
        .run(status, opts?.appliedAt ?? new Date().toISOString(), id);
    } else {
      this.db.prepare("UPDATE bootstrap_runs SET status = ? WHERE id = ?")
        .run(status, id);
    }
  }

  journalAction(
    bootstrapId: string,
    seq: number,
    actionKind: ActionKind,
    subjectType: string | null,
    subjectName: string | null,
    status: ActionStatus,
    opts?: { provider?: string; commandPreview?: string; detailJson?: string },
  ): BootstrapAction {
    const id = ulid();
    this.db.prepare(
      `INSERT INTO bootstrap_actions (id, bootstrap_id, seq, action_kind, subject_type, subject_name, provider, command_preview, status, detail_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, bootstrapId, seq, actionKind,
      subjectType, subjectName,
      opts?.provider ?? null, opts?.commandPreview ?? null,
      status, opts?.detailJson ?? null,
    );
    return this.getAction(id)!;
  }

  getRunActions(bootstrapId: string): BootstrapAction[] {
    const rows = this.db.prepare(
      "SELECT * FROM bootstrap_actions WHERE bootstrap_id = ? ORDER BY seq ASC"
    ).all(bootstrapId) as BootstrapActionRow[];
    return rows.map((r) => this.rowToAction(r));
  }

  private getAction(id: string): BootstrapAction | null {
    const row = this.db.prepare("SELECT * FROM bootstrap_actions WHERE id = ?")
      .get(id) as BootstrapActionRow | undefined;
    return row ? this.rowToAction(row) : null;
  }

  private rowToRun(row: BootstrapRunRow): BootstrapRun {
    return {
      id: row.id,
      sourceKind: row.source_kind,
      sourceRef: row.source_ref,
      status: row.status as BootstrapStatus,
      rigId: row.rig_id,
      createdAt: row.created_at,
      appliedAt: row.applied_at,
    };
  }

  private rowToAction(row: BootstrapActionRow): BootstrapAction {
    return {
      id: row.id,
      bootstrapId: row.bootstrap_id,
      seq: row.seq,
      actionKind: row.action_kind as ActionKind,
      subjectType: row.subject_type,
      subjectName: row.subject_name,
      provider: row.provider,
      commandPreview: row.command_preview,
      status: row.status as ActionStatus,
      detailJson: row.detail_json,
      createdAt: row.created_at,
    };
  }
}
