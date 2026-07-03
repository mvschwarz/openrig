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

/** Resume-token provenance precedence (OPR.0.4.0.22; adoption rung added by
 *  OPR.0.4.3.20 FR-3). Higher rank wins; a lower-rank write never overwrites a
 *  higher-rank persisted token.
 *  operator/attested (deliberate set) > hook (runtime self-report) >
 *  adoption (captured at the reconcile/adopt/bind boundary) > scrape (pane).
 *  adoption sits BELOW hook deliberately: a live runtime hook self-report is
 *  fresher than an adoption-time snapshot, so hook must be able to refresh an
 *  adoption token (FR-3 §2.4 — do not freeze the token at adoption time and
 *  reintroduce the staleness the survive slice exists to kill). */
export const RESUME_PROVENANCE_RANK: Record<string, number> = {
  scrape: 0,
  adoption: 1,
  hook: 2,
  operator: 3,
};

/** OPR.0.4.3.20 FR-4 — the latest live session per node, shape needed by the
 *  resume-metadata refresher (structurally compatible with ResumeRefreshSession). */
export interface LatestLiveSession {
  nodeId: string;
  sessionId: string;
  sessionName: string;
  status: string;
  runtime: string | null;
  resumeType: string | null;
  resumeToken: string | null;
  cwd: string | null;
}

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
  // operator/attested set is authoritative and OUTRANKS the runtime hook, the
  // adoption-boundary capture, and the pane scrape (hook > adoption > scrape).
  // A lower-rank write must never clobber a higher-rank persisted token.
  //
  // OPR.0.4.3.20 FR-3 — validity-before-rank guard: an empty/whitespace token
  // is a SKIP, never a write. "Flakiness = missing = no-write, not a bad
  // write." This runs BEFORE the rank comparison so NO caller (a flaky hook,
  // adoption capture, or scrape) can ever replace a valid stored token with an
  // empty one, even from a higher-provenance source.
  //
  // Returns whether a write actually happened: `true` on UPDATE, `false` on an
  // empty-token skip or a lower-rank no-op. Callers that only set-and-forget can
  // ignore it; the adoption-capture path uses it so its audit event never
  // falsely claims a captured write when the provenance guard refused it.
  updateResumeToken(sessionId: string, type: string, token: string, provenance?: "hook" | "scrape" | "operator" | "adoption"): boolean {
    if (typeof token !== "string" || token.trim().length === 0) return false;
    if (provenance) {
      const existing = this.db.prepare(
        "SELECT resume_provenance FROM sessions WHERE id = ?"
      ).get(sessionId) as { resume_provenance: string | null } | undefined;
      const existingProv = existing?.resume_provenance ?? null;
      if (existingProv) {
        const existingRank = RESUME_PROVENANCE_RANK[existingProv] ?? -1;
        const newRank = RESUME_PROVENANCE_RANK[provenance] ?? -1;
        if (newRank < existingRank) return false; // lower-rank cannot overwrite higher-rank
      }
    }
    const prov = provenance ?? null;
    // OPR.0.4.3.20 FR-6 — stamp-on-verify (+ equal-value-refresh): a token
    // (re-)derived from live state IS a verification, so refresh the freshness
    // marker + mark the last probe `resumable` on EVERY successful write, even
    // when the token value is unchanged (a re-verified-but-unchanged token must
    // not look untouched). The plan reads these to compute present/stale.
    this.db
      .prepare(
        "UPDATE sessions SET resume_type = ?, resume_token = ?, resume_provenance = COALESCE(?, resume_provenance), " +
          "resume_last_verified = datetime('now'), resume_last_probe_status = 'resumable' WHERE id = ?",
      )
      .run(type, token, prov, sessionId);
    return true;
  }

  /** OPR.0.4.3.20 FR-6 — record a live resume-probe outcome WITHOUT clearing the
   *  token. On `resumable` it stamps the freshness marker (equal-value-refresh);
   *  on `not_resumable` / `inconclusive` it marks the PRESENT token stale so the
   *  restore plan surfaces it as `stale/unverified — re-verify` (never a silent
   *  null). This replaces the old clear-on-not-resumable behavior (§2.1b) — the
   *  token stays put; FR-7's blank/fresh rollback catches an actually-unresumable
   *  token at restore time. */
  markResumeProbeResult(sessionId: string, status: "resumable" | "not_resumable" | "inconclusive"): void {
    if (status === "resumable") {
      this.db
        .prepare("UPDATE sessions SET resume_last_verified = datetime('now'), resume_last_probe_status = 'resumable' WHERE id = ?")
        .run(sessionId);
      return;
    }
    this.db
      .prepare("UPDATE sessions SET resume_last_probe_status = ? WHERE id = ?")
      .run(status, sessionId);
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
    // OPR.0.4.3.20 FR-6 — also null the verification-freshness columns so a
    // cleared slot carries no orphan freshness. NOTE: after §2.1b the refresher
    // validate path marks-stale instead of clearing, so this has no in-tree
    // caller on the live path; kept for explicit-clear callers/tests.
    this.db
      .prepare("UPDATE sessions SET resume_type = NULL, resume_token = NULL, resume_provenance = NULL, resume_last_verified = NULL, resume_last_probe_status = NULL WHERE id = ?")
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

  /** OPR.0.4.3.20 FR-4 — the latest session PER NODE, filtered to live statuses
   *  (running / idle / unknown), with the fields the resume-metadata refresher
   *  needs. Lifted from rig-teardown so both the teardown pre-down path and the
   *  FR-4 periodic/manual snapshot refresh call ONE query (no duplication). */
  getLatestLiveSessions(rigId: string): LatestLiveSession[] {
    const rows = this.db.prepare(`
      SELECT n.id as node_id, s.id as session_id, s.session_name, s.status, n.runtime, n.cwd, s.resume_type, s.resume_token
      FROM nodes n
      JOIN sessions s ON s.node_id = n.id
      WHERE n.rig_id = ?
        AND s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = n.id ORDER BY s2.created_at DESC, s2.id DESC LIMIT 1)
        AND s.status IN ('running', 'idle', 'unknown')
    `).all(rigId) as Array<{ node_id: string; session_id: string; session_name: string; status: string; runtime: string | null; cwd: string | null; resume_type: string | null; resume_token: string | null }>;

    return rows.map((r) => ({
      nodeId: r.node_id,
      sessionId: r.session_id,
      sessionName: r.session_name,
      status: r.status,
      runtime: r.runtime,
      resumeType: r.resume_type,
      resumeToken: r.resume_token,
      cwd: r.cwd,
    }));
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
      // OPR.0.4.3.20 FR-6 — carry provenance + verification freshness so a
      // snapshot's serialized sessions (and getSessionsForRig) surface token
      // state in the restore plan. Nullable/degrading for pre-45 rows.
      resumeProvenance: row.resume_provenance ?? null,
      resumeLastVerified: row.resume_last_verified ?? null,
      resumeLastProbeStatus: row.resume_last_probe_status ?? null,
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
  // OPR.0.4.3.20 FR-3/FR-6 — resume ledger provenance + verification freshness.
  resume_provenance?: string | null;
  resume_last_verified?: string | null;
  resume_last_probe_status?: string | null;
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
