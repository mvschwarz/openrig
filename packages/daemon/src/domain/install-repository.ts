import type Database from "better-sqlite3";
import { ulid } from "ulid";

export interface Install {
  id: string;
  packageId: string;
  targetRoot: string;
  scope: string;
  status: string;
  riskTier: string | null;
  createdAt: string;
  appliedAt: string | null;
  rolledBackAt: string | null;
}

export interface JournalEntry {
  id: string;
  installId: string;
  seq: number;
  action: string;
  exportType: string;
  classification: string;
  targetPath: string;
  backupPath: string | null;
  beforeHash: string | null;
  afterHash: string | null;
  status: string;
  createdAt: string;
}

interface InstallRow {
  id: string;
  package_id: string;
  target_root: string;
  scope: string;
  status: string;
  risk_tier: string | null;
  created_at: string;
  applied_at: string | null;
  rolled_back_at: string | null;
}

interface JournalRow {
  id: string;
  install_id: string;
  seq: number;
  action: string;
  export_type: string;
  classification: string;
  target_path: string;
  backup_path: string | null;
  before_hash: string | null;
  after_hash: string | null;
  status: string;
  created_at: string;
}

export class InstallRepository {
  readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  createInstall(packageId: string, targetRoot: string, scope: string): Install {
    const id = ulid();
    this.db
      .prepare("INSERT INTO package_installs (id, package_id, target_root, scope) VALUES (?, ?, ?, ?)")
      .run(id, packageId, targetRoot, scope);
    return this.getInstall(id)!;
  }

  updateInstallStatus(installId: string, status: string): void {
    const timestampCol = status === "applied" ? "applied_at" : status === "rolled_back" ? "rolled_back_at" : null;
    if (timestampCol) {
      this.db
        .prepare(`UPDATE package_installs SET status = ?, ${timestampCol} = datetime('now') WHERE id = ?`)
        .run(status, installId);
    } else {
      this.db
        .prepare("UPDATE package_installs SET status = ? WHERE id = ?")
        .run(status, installId);
    }
  }

  getInstall(installId: string): Install | null {
    const row = this.db
      .prepare("SELECT * FROM package_installs WHERE id = ?")
      .get(installId) as InstallRow | undefined;
    return row ? this.rowToInstall(row) : null;
  }

  listInstalls(packageId?: string): Install[] {
    if (packageId) {
      const rows = this.db
        .prepare("SELECT * FROM package_installs WHERE package_id = ? ORDER BY created_at")
        .all(packageId) as InstallRow[];
      return rows.map((r) => this.rowToInstall(r));
    }
    const rows = this.db
      .prepare("SELECT * FROM package_installs ORDER BY created_at")
      .all() as InstallRow[];
    return rows.map((r) => this.rowToInstall(r));
  }

  createJournalEntry(opts: {
    installId: string;
    action: string;
    exportType: string;
    classification: string;
    targetPath: string;
    backupPath?: string;
    beforeHash?: string;
    afterHash?: string;
    status?: string;
  }): JournalEntry {
    const id = ulid();
    // Compute next seq for this install
    const maxSeq = this.db
      .prepare("SELECT MAX(seq) as max_seq FROM install_journal WHERE install_id = ?")
      .get(opts.installId) as { max_seq: number | null };
    const seq = (maxSeq.max_seq ?? 0) + 1;

    this.db
      .prepare(
        "INSERT INTO install_journal (id, install_id, seq, action, export_type, classification, target_path, backup_path, before_hash, after_hash, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        id, opts.installId, seq, opts.action, opts.exportType, opts.classification,
        opts.targetPath, opts.backupPath ?? null, opts.beforeHash ?? null,
        opts.afterHash ?? null, opts.status ?? "applied"
      );

    return this.getJournalEntry(id)!;
  }

  getJournalEntries(installId: string): JournalEntry[] {
    const rows = this.db
      .prepare("SELECT * FROM install_journal WHERE install_id = ? ORDER BY seq ASC")
      .all(installId) as JournalRow[];
    return rows.map((r) => this.rowToJournalEntry(r));
  }

  private getJournalEntry(id: string): JournalEntry | null {
    const row = this.db
      .prepare("SELECT * FROM install_journal WHERE id = ?")
      .get(id) as JournalRow | undefined;
    return row ? this.rowToJournalEntry(row) : null;
  }

  private rowToInstall(row: InstallRow): Install {
    return {
      id: row.id,
      packageId: row.package_id,
      targetRoot: row.target_root,
      scope: row.scope,
      status: row.status,
      riskTier: row.risk_tier,
      createdAt: row.created_at,
      appliedAt: row.applied_at,
      rolledBackAt: row.rolled_back_at,
    };
  }

  private rowToJournalEntry(row: JournalRow): JournalEntry {
    return {
      id: row.id,
      installId: row.install_id,
      seq: row.seq,
      action: row.action,
      exportType: row.export_type,
      classification: row.classification,
      targetPath: row.target_path,
      backupPath: row.backup_path,
      beforeHash: row.before_hash,
      afterHash: row.after_hash,
      status: row.status,
      createdAt: row.created_at,
    };
  }
}
