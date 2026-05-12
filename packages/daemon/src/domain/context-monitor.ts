import type Database from "better-sqlite3";
import type { ClaudeCompactionEnforcer } from "./claude-compaction-enforcer.js";
import type { ContextUsageStore } from "./context-usage-store.js";
import {
  isAttentionRequiredReadinessCode,
  type NodeBinding,
  type ReadinessResult,
} from "./runtime-adapter.js";
import type { ContextUsage } from "./types.js";

/** Default polling interval: 30 seconds. */
export const DEFAULT_POLL_INTERVAL_MS = 30_000;

interface EligibleSession {
  node_id: string;
  session_id: string;
  session_name: string;
  runtime: string | null;
  resume_token: string | null;
  cwd: string | null;
  startup_status: "pending" | "ready" | "attention_required" | "failed" | null;
}

interface ClaudeContextProvisioner {
  ensureContextCollector(binding: { cwd?: string | null; tmuxSession?: string | null }): void;
  checkReady?(binding: NodeBinding): Promise<ReadinessResult>;
}

/**
 * Polls known managed runtime context sources and persists the latest
 * normalized telemetry. Scheduler-only: no queries, no response shaping,
 * no in-memory truth.
 *
 * Slice 27: optional `compactionEnforcer` participates in each polling
 * tick after persistence so policy-driven /compact triggers fire on the
 * same observation the operator sees in the UI. Without an enforcer
 * provided, polling behavior is unchanged.
 */
export class ContextMonitor {
  private db: Database.Database;
  private store: ContextUsageStore;
  private claudeContextProvisioner: ClaudeContextProvisioner | null;
  private compactionEnforcer: ClaudeCompactionEnforcer | null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    db: Database.Database,
    store: ContextUsageStore,
    claudeContextProvisioner?: ClaudeContextProvisioner,
    compactionEnforcer?: ClaudeCompactionEnforcer,
  ) {
    this.db = db;
    this.store = store;
    this.claudeContextProvisioner = claudeContextProvisioner ?? null;
    this.compactionEnforcer = compactionEnforcer ?? null;
  }

  /** Discover active managed Claude sessions and poll their sidecar files. */
  async pollOnce(): Promise<void> {
    const sessions = this.getEligibleSessions();
    for (const session of sessions) {
      let observed: ContextUsage | null = null;
      try {
        observed = this.readContextUsage(session);
        this.store.persist(session.node_id, observed);
      } catch {
        observed = null;
        // One bad session must not crash polling for others
        try {
          this.store.persist(session.node_id, this.store.unknownUsage("parse_error"));
        } catch { /* give up on this session */ }
      }

      await this.normalizeStartupStatus(session);
      await this.maybeAutoCompact(session, observed);
    }
  }

  /**
   * Slice 27 — invoke the enforcer with the latest observation. The
   * enforcer owns policy + dedup + send; ContextMonitor only relays
   * data and absorbs enforcer errors so a trigger-path fault never
   * crashes telemetry polling.
   */
  private async maybeAutoCompact(
    session: EligibleSession,
    usage: ContextUsage | null,
  ): Promise<void> {
    if (!this.compactionEnforcer) return;
    if (!usage || usage.availability !== "known") return;
    try {
      await this.compactionEnforcer.maybeAutoCompact({
        sessionName: session.session_name,
        runtime: session.runtime,
        usedPercentage: usage.usedPercentage,
      });
    } catch {
      // Defensive: enforcer should not throw, but absorb here so the
      // polling loop continues to make progress for remaining sessions.
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

  /** Query for managed runtime sessions with readable context sources. */
  private getEligibleSessions(): EligibleSession[] {
    return this.db.prepare(`
      SELECT
        n.id as node_id,
        s.id as session_id,
        s.session_name,
        n.runtime,
        s.resume_token,
        n.cwd,
        s.startup_status
      FROM nodes n
      JOIN sessions s ON s.node_id = n.id
        AND s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = n.id ORDER BY s2.id DESC LIMIT 1)
      LEFT JOIN bindings b ON b.node_id = n.id
      WHERE (
          (n.runtime = 'claude-code' AND s.status = 'running')
          OR (n.runtime = 'codex' AND s.resume_token IS NOT NULL)
        )
        AND COALESCE(b.attachment_type, 'tmux') = 'tmux'
        AND COALESCE(b.tmux_session, s.session_name) IS NOT NULL
    `).all() as EligibleSession[];
  }

  private readContextUsage(session: EligibleSession) {
    if (session.runtime === "codex") {
      return this.store.readCodexAndNormalize({
        threadId: session.resume_token,
        sessionName: session.session_name,
      });
    }

    this.claudeContextProvisioner?.ensureContextCollector({
      cwd: session.cwd ?? undefined,
      tmuxSession: session.session_name,
    });
    return this.store.readAndNormalize(session.session_name);
  }

  private async normalizeStartupStatus(session: EligibleSession): Promise<void> {
    if (session.runtime !== "claude-code") return;
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
      if (readiness.ready) {
        this.db.prepare(`
          UPDATE sessions
          SET startup_status = 'ready',
              startup_completed_at = ?
          WHERE id = ?
        `).run(new Date().toISOString(), session.session_id);
        return;
      }

      if (isAttentionRequiredReadinessCode(readiness.code)) {
        this.db.prepare(`
          UPDATE sessions
          SET startup_status = 'attention_required'
          WHERE id = ?
        `).run(session.session_id);
      }
    } catch {
      // Best-effort normalization only; telemetry polling still succeeds.
    }
  }
}
