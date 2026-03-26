import type Database from "better-sqlite3";
import { ulid } from "ulid";
import type { Session, Binding } from "./types.js";
import { validateSessionName } from "./session-name.js";

interface BindingFields {
  tmuxSession?: string;
  tmuxWindow?: string;
  tmuxPane?: string;
  cmuxWorkspace?: string;
  cmuxSurface?: string;
}

export class SessionRegistry {
  readonly db: Database.Database;
  constructor(db: Database.Database) {
    this.db = db;
  }

  registerSession(nodeId: string, sessionName: string): Session {
    if (!validateSessionName(sessionName)) {
      throw new Error(
        `Invalid session name "${sessionName}": must match Rigged naming pattern r{NN}-{cluster}{N}-{role}`
      );
    }

    const id = ulid();
    this.db
      .prepare(
        "INSERT INTO sessions (id, node_id, session_name) VALUES (?, ?, ?)"
      )
      .run(id, nodeId, sessionName);

    return this.rowToSession(
      this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as SessionRow
    );
  }

  updateStatus(sessionId: string, status: string): void {
    this.db
      .prepare("UPDATE sessions SET status = ?, last_seen_at = datetime('now') WHERE id = ?")
      .run(status, sessionId);
  }

  markDetached(sessionId: string): void {
    this.updateStatus(sessionId, "detached");
  }

  markSuperseded(sessionId: string): void {
    this.updateStatus(sessionId, "superseded");
  }

  clearBinding(nodeId: string): void {
    this.db.prepare("DELETE FROM bindings WHERE node_id = ?").run(nodeId);
  }

  getSessionsForRig(rigId: string): Session[] {
    const rows = this.db
      .prepare(
        `SELECT s.* FROM sessions s
         JOIN nodes n ON s.node_id = n.id
         WHERE n.rig_id = ?
         ORDER BY s.created_at`
      )
      .all(rigId) as SessionRow[];

    return rows.map((r) => this.rowToSession(r));
  }

  getBindingForNode(nodeId: string): Binding | null {
    const row = this.db
      .prepare("SELECT * FROM bindings WHERE node_id = ?")
      .get(nodeId) as BindingRow | undefined;

    return row ? this.rowToBinding(row) : null;
  }

  updateBinding(nodeId: string, fields: BindingFields): Binding {
    // Atomic upsert: entire read-modify-write is inside a transaction
    const upsert = this.db.transaction(() => {
      const existing = this.db
        .prepare("SELECT * FROM bindings WHERE node_id = ?")
        .get(nodeId) as BindingRow | undefined;

      if (existing) {
        // Partial update: only overwrite fields that are provided
        this.db
          .prepare(
            `UPDATE bindings SET
              tmux_session = ?,
              tmux_window = ?,
              tmux_pane = ?,
              cmux_workspace = ?,
              cmux_surface = ?,
              updated_at = datetime('now')
            WHERE node_id = ?`
          )
          .run(
            fields.tmuxSession ?? existing.tmux_session,
            fields.tmuxWindow ?? existing.tmux_window,
            fields.tmuxPane ?? existing.tmux_pane,
            fields.cmuxWorkspace ?? existing.cmux_workspace,
            fields.cmuxSurface ?? existing.cmux_surface,
            nodeId
          );
      } else {
        const id = ulid();
        this.db
          .prepare(
            `INSERT INTO bindings (id, node_id, tmux_session, tmux_window, tmux_pane, cmux_workspace, cmux_surface)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            id,
            nodeId,
            fields.tmuxSession ?? null,
            fields.tmuxWindow ?? null,
            fields.tmuxPane ?? null,
            fields.cmuxWorkspace ?? null,
            fields.cmuxSurface ?? null
          );
      }
    });

    upsert();

    return this.rowToBinding(
      this.db.prepare("SELECT * FROM bindings WHERE node_id = ?").get(nodeId) as BindingRow
    );
  }

  // -- Row-to-domain mappers --

  private rowToSession(row: SessionRow): Session {
    return {
      id: row.id,
      nodeId: row.node_id,
      sessionName: row.session_name,
      status: row.status,
      resumeType: row.resume_type ?? null,
      resumeToken: row.resume_token ?? null,
      restorePolicy: row.restore_policy ?? "resume_if_possible",
      lastSeenAt: row.last_seen_at,
      createdAt: row.created_at,
      origin: (row.origin === "claimed" ? "claimed" : "launched"),
    };
  }

  private rowToBinding(row: BindingRow): Binding {
    return {
      id: row.id,
      nodeId: row.node_id,
      tmuxSession: row.tmux_session,
      tmuxWindow: row.tmux_window,
      tmuxPane: row.tmux_pane,
      cmuxWorkspace: row.cmux_workspace,
      cmuxSurface: row.cmux_surface,
      updatedAt: row.updated_at,
    };
  }
}

// -- Raw DB row types (snake_case) --

interface SessionRow {
  id: string;
  node_id: string;
  session_name: string;
  status: string;
  resume_type: string | null;
  resume_token: string | null;
  restore_policy: string | null;
  last_seen_at: string | null;
  created_at: string;
  origin: string;
}

interface BindingRow {
  id: string;
  node_id: string;
  tmux_session: string | null;
  tmux_window: string | null;
  tmux_pane: string | null;
  cmux_workspace: string | null;
  cmux_surface: string | null;
  updated_at: string;
}
