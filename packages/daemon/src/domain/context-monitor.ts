import type Database from "better-sqlite3";
import type { ContextUsageStore } from "./context-usage-store.js";
import type { NodeBinding, ReadinessResult } from "./runtime-adapter.js";

/** Default polling interval: 30 seconds. */
export const DEFAULT_POLL_INTERVAL_MS = 30_000;

interface EligibleSession {
  node_id: string;
  session_id: string;
  session_name: string;
  cwd: string | null;
  startup_status: "pending" | "ready" | "attention_required" | "failed" | null;
}

interface ClaudeContextProvisioner {
  ensureContextCollector(binding: { cwd?: string | null; tmuxSession?: string | null }): void;
  checkReady?(binding: NodeBinding): Promise<ReadinessResult>;
}

/**
 * Polls known managed Claude sidecar files and persists the latest
 * normalized context telemetry. Scheduler-only: no queries, no response
 * shaping, no in-memory truth.
 */
export class ContextMonitor {
  private db: Database.Database;
  private store: ContextUsageStore;
  private claudeContextProvisioner: ClaudeContextProvisioner | null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    db: Database.Database,
    store: ContextUsageStore,
    claudeContextProvisioner?: ClaudeContextProvisioner,
  ) {
    this.db = db;
    this.store = store;
    this.claudeContextProvisioner = claudeContextProvisioner ?? null;
  }

  /** Discover active managed Claude sessions and poll their sidecar files. */
  async pollOnce(): Promise<void> {
    const sessions = this.getEligibleSessions();
    for (const session of sessions) {
      try {
        this.claudeContextProvisioner?.ensureContextCollector({
          cwd: session.cwd ?? undefined,
          tmuxSession: session.session_name,
        });
        const usage = this.store.readAndNormalize(session.session_name);
        this.store.persist(session.node_id, usage);
      } catch {
        // One bad session must not crash polling for others
        try {
          this.store.persist(session.node_id, this.store.unknownUsage("parse_error"));
        } catch { /* give up on this session */ }
      }

      await this.normalizeStartupStatus(session);
    }
  }

  /** Start polling at the given interval. Idempotent. */
  start(intervalMs: number = DEFAULT_POLL_INTERVAL_MS): void {
    if (this.timer) return; // Already running
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, intervalMs);
    // Unref so the timer doesn't keep the process alive
    if (this.timer && typeof this.timer === "object" && "unref" in this.timer) {
      (this.timer as NodeJS.Timeout).unref();
    }
  }

  /** Stop polling. Safe to call before start or multiple times. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Query for managed Claude sessions that are currently running. */
  private getEligibleSessions(): EligibleSession[] {
    return this.db.prepare(`
      SELECT
        n.id as node_id,
        s.id as session_id,
        s.session_name,
        n.cwd,
        s.startup_status
      FROM nodes n
      JOIN sessions s ON s.node_id = n.id
        AND s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = n.id ORDER BY s2.id DESC LIMIT 1)
      LEFT JOIN bindings b ON b.node_id = n.id
      WHERE n.runtime = 'claude-code'
        AND s.status = 'running'
        AND COALESCE(b.attachment_type, 'tmux') = 'tmux'
        AND COALESCE(b.tmux_session, s.session_name) IS NOT NULL
    `).all() as EligibleSession[];
  }

  private async normalizeStartupStatus(session: EligibleSession): Promise<void> {
    if (!this.claudeContextProvisioner?.checkReady) return;
    if (session.startup_status !== "failed" && session.startup_status !== "attention_required") return;

    try {
      const readiness = await this.claudeContextProvisioner.checkReady({
        id: `context-monitor:${session.session_id}`,
        nodeId: session.node_id,
        attachmentType: "tmux",
        tmuxSession: session.session_name,
        tmuxWindow: null,
        tmuxPane: null,
        cmuxWorkspace: null,
        cmuxSurface: null,
        updatedAt: "",
        cwd: session.cwd ?? "",
      });
      if (!readiness.ready) return;

      this.db.prepare(`
        UPDATE sessions
        SET startup_status = 'ready',
            startup_completed_at = ?
        WHERE id = ?
      `).run(new Date().toISOString(), session.session_id);
    } catch {
      // Best-effort normalization only; telemetry polling still succeeds.
    }
  }
}
