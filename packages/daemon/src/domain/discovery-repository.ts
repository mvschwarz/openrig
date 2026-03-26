import type Database from "better-sqlite3";
import { ulid } from "ulid";
import type { DiscoveredSession, DiscoveryStatus, RuntimeHint, Confidence } from "./discovery-types.js";

interface DiscoveredSessionRow {
  id: string;
  tmux_session: string;
  tmux_window: string | null;
  tmux_pane: string | null;
  pid: number | null;
  cwd: string | null;
  active_command: string | null;
  runtime_hint: string;
  confidence: string;
  evidence_json: string | null;
  config_json: string | null;
  status: string;
  claimed_node_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

export interface UpsertData {
  tmuxSession: string;
  tmuxPane: string;
  tmuxWindow?: string;
  pid?: number;
  cwd?: string;
  activeCommand?: string;
  runtimeHint: RuntimeHint;
  confidence: Confidence;
  evidenceJson?: string;
  configJson?: string;
}

export class DiscoveryRepository {
  readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /** Upsert: preserve id + first_seen_at on rescan, update mutable fields. */
  upsertDiscoveredSession(data: UpsertData): DiscoveredSession {
    const existing = this.db.prepare(
      "SELECT id, first_seen_at FROM discovered_sessions WHERE tmux_session = ? AND tmux_pane = ?"
    ).get(data.tmuxSession, data.tmuxPane) as { id: string; first_seen_at: string } | undefined;

    if (existing) {
      this.db.prepare(
        `UPDATE discovered_sessions SET
          tmux_window = ?, pid = ?, cwd = ?, active_command = ?,
          runtime_hint = ?, confidence = ?, evidence_json = ?, config_json = ?,
          last_seen_at = datetime('now'), status = 'active'
        WHERE id = ?`
      ).run(
        data.tmuxWindow ?? null, data.pid ?? null, data.cwd ?? null, data.activeCommand ?? null,
        data.runtimeHint, data.confidence, data.evidenceJson ?? null, data.configJson ?? null,
        existing.id,
      );
      return this.getDiscoveredSession(existing.id)!;
    }

    const id = ulid();
    this.db.prepare(
      `INSERT INTO discovered_sessions (id, tmux_session, tmux_window, tmux_pane, pid, cwd, active_command, runtime_hint, confidence, evidence_json, config_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, data.tmuxSession, data.tmuxWindow ?? null, data.tmuxPane,
      data.pid ?? null, data.cwd ?? null, data.activeCommand ?? null,
      data.runtimeHint, data.confidence, data.evidenceJson ?? null, data.configJson ?? null,
    );
    return this.getDiscoveredSession(id)!;
  }

  markVanished(ids: string[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => "?").join(",");
    this.db.prepare(
      `UPDATE discovered_sessions SET status = 'vanished', last_seen_at = datetime('now') WHERE id IN (${placeholders}) AND status = 'active'`
    ).run(...ids);
  }

  markClaimed(id: string, nodeId: string): void {
    this.db.prepare(
      "UPDATE discovered_sessions SET status = 'claimed', claimed_node_id = ? WHERE id = ?"
    ).run(nodeId, id);
  }

  listDiscovered(status?: DiscoveryStatus): DiscoveredSession[] {
    const rows = status
      ? this.db.prepare("SELECT * FROM discovered_sessions WHERE status = ? ORDER BY last_seen_at DESC").all(status) as DiscoveredSessionRow[]
      : this.db.prepare("SELECT * FROM discovered_sessions ORDER BY last_seen_at DESC").all() as DiscoveredSessionRow[];
    return rows.map((r) => this.rowToSession(r));
  }

  getDiscoveredSession(id: string): DiscoveredSession | null {
    const row = this.db.prepare("SELECT * FROM discovered_sessions WHERE id = ?").get(id) as DiscoveredSessionRow | undefined;
    return row ? this.rowToSession(row) : null;
  }

  /** Get IDs of all active discovered sessions */
  getActiveIds(): string[] {
    const rows = this.db.prepare("SELECT id FROM discovered_sessions WHERE status = 'active'").all() as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  /** Get active session by tmux identity */
  getByTmuxIdentity(tmuxSession: string, tmuxPane: string): DiscoveredSession | null {
    const row = this.db.prepare(
      "SELECT * FROM discovered_sessions WHERE tmux_session = ? AND tmux_pane = ? AND status != 'vanished'"
    ).get(tmuxSession, tmuxPane) as DiscoveredSessionRow | undefined;
    return row ? this.rowToSession(row) : null;
  }

  private rowToSession(row: DiscoveredSessionRow): DiscoveredSession {
    return {
      id: row.id,
      tmuxSession: row.tmux_session,
      tmuxWindow: row.tmux_window,
      tmuxPane: row.tmux_pane,
      pid: row.pid,
      cwd: row.cwd,
      activeCommand: row.active_command,
      runtimeHint: row.runtime_hint as RuntimeHint,
      confidence: row.confidence as Confidence,
      evidenceJson: row.evidence_json,
      configJson: row.config_json,
      status: row.status as DiscoveryStatus,
      claimedNodeId: row.claimed_node_id,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
    };
  }
}
