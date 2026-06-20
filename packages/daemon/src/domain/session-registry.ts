import type Database from "better-sqlite3";
import { monotonicFactory } from "ulid";

const ulid = monotonicFactory();
import type { Session, Binding } from "./types.js";
import { validateSessionName } from "./session-name.js";

interface BindingFields {
  attachmentType?: "tmux" | "external_cli";
  tmuxSession?: string;
  tmuxWindow?: string;
  tmuxPane?: string;
  externalSessionName?: string;
  cmuxWorkspace?: string;
  cmuxSurface?: string;
}

/** Resume-token provenance precedence (OPR.0.4.0.22). Higher rank wins;
 *  a lower-rank write never overwrites a higher-rank persisted token.
 *  operator/attested (deliberate set) > hook (runtime) > scrape (pane). */
export const RESUME_PROVENANCE_RANK: Record<string, number> = {
  scrape: 0,
  hook: 1,
  operator: 2,
};

export class SessionRegistry {
  readonly db: Database.Database;
  constructor(db: Database.Database) {
    this.db = db;
  }

  registerSession(nodeId: string, sessionName: string): Session {
    if (!validateSessionName(sessionName)) {
      throw new Error(
        `Invalid session name "${sessionName}": must match legacy r{NN}-{suffix} or canonical {pod}-{member}@{rig} format with allowed characters (a-z, A-Z, 0-9, -, _, ., @)`
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

  /** Register a claimed session — skips naming validation, sets origin='claimed', startup_status='ready'. */
  registerClaimedSession(nodeId: string, sessionName: string): Session {
    const id = ulid();
    this.db
      .prepare(
        "INSERT INTO sessions (id, node_id, session_name, status, origin, startup_status) VALUES (?, ?, ?, 'running', 'claimed', 'ready')"
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

  updateStartupStatus(sessionId: string, status: "pending" | "ready" | "attention_required" | "failed", completedAt?: string): void {
    if (completedAt) {
      this.db
        .prepare("UPDATE sessions SET startup_status = ?, startup_completed_at = ? WHERE id = ?")
        .run(status, completedAt, sessionId);
    } else {
      this.db
        .prepare("UPDATE sessions SET startup_status = ? WHERE id = ?")
        .run(status, sessionId);
    }
  }

  // OPR.0.4.0.22 — resume-token provenance precedence. A deliberate
  // operator/attested set is authoritative and OUTRANKS both the runtime
  // hook and the pane scrape; hook outranks scrape (the pre-existing rule).
  // A lower-rank write must never clobber a higher-rank persisted token.
  updateResumeToken(sessionId: string, type: string, token: string, provenance?: "hook" | "scrape" | "operator"): void {
    if (provenance) {
      const existing = this.db.prepare(
        "SELECT resume_provenance FROM sessions WHERE id = ?"
      ).get(sessionId) as { resume_provenance: string | null } | undefined;
      const existingProv = existing?.resume_provenance ?? null;
      if (existingProv) {
        const existingRank = RESUME_PROVENANCE_RANK[existingProv] ?? -1;
        const newRank = RESUME_PROVENANCE_RANK[provenance] ?? -1;
        if (newRank < existingRank) return; // lower-rank cannot overwrite higher-rank
      }
    }
    const prov = provenance ?? null;
    this.db
      .prepare("UPDATE sessions SET resume_type = ?, resume_token = ?, resume_provenance = COALESCE(?, resume_provenance) WHERE id = ?")
      .run(type, token, prov, sessionId);
  }

  /** OPR.0.4.0.22 — resolve a canonical session name to the context needed to
   *  set its resume token: the latest session row + its node's runtime + the
   *  current resume provenance. Returns null when no session matches. */
  findResumeContextByName(sessionName: string): {
    sessionId: string;
    nodeId: string;
    rigId: string;
    runtime: string | null;
    currentProvenance: string | null;
  } | null {
    const row = this.db.prepare(
      `SELECT s.id as session_id, s.node_id, n.rig_id, n.runtime, s.resume_provenance
       FROM sessions s
       JOIN nodes n ON n.id = s.node_id
       WHERE s.session_name = ?
       ORDER BY s.created_at DESC, s.id DESC LIMIT 1`
    ).get(sessionName) as {
      session_id: string;
      node_id: string;
      rig_id: string;
      runtime: string | null;
      resume_provenance: string | null;
    } | undefined;
    if (!row) return null;
    return {
      sessionId: row.session_id,
      nodeId: row.node_id,
      rigId: row.rig_id,
      runtime: row.runtime,
      currentProvenance: row.resume_provenance ?? null,
    };
  }

  clearResumeToken(sessionId: string): void {
    this.db
      .prepare("UPDATE sessions SET resume_type = NULL, resume_token = NULL, resume_provenance = NULL WHERE id = ?")
      .run(sessionId);
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
              attachment_type = ?,
              tmux_session = ?,
              tmux_window = ?,
              tmux_pane = ?,
              external_session_name = ?,
              cmux_workspace = ?,
              cmux_surface = ?,
              updated_at = datetime('now')
            WHERE node_id = ?`
          )
          .run(
            fields.attachmentType ?? existing.attachment_type ?? "tmux",
            fields.tmuxSession ?? existing.tmux_session,
            fields.tmuxWindow ?? existing.tmux_window,
            fields.tmuxPane ?? existing.tmux_pane,
            fields.externalSessionName ?? existing.external_session_name,
            fields.cmuxWorkspace ?? existing.cmux_workspace,
            fields.cmuxSurface ?? existing.cmux_surface,
            nodeId
          );
      } else {
        const id = ulid();
        this.db
          .prepare(
            `INSERT INTO bindings (id, node_id, attachment_type, tmux_session, tmux_window, tmux_pane, external_session_name, cmux_workspace, cmux_surface)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            id,
            nodeId,
            fields.attachmentType ?? "tmux",
            fields.tmuxSession ?? null,
            fields.tmuxWindow ?? null,
            fields.tmuxPane ?? null,
            fields.externalSessionName ?? null,
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
      startupStatus: (row.startup_status as Session["startupStatus"]) ?? "pending",
      startupCompletedAt: row.startup_completed_at ?? null,
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
  startup_status: string | null;
  startup_completed_at: string | null;
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
