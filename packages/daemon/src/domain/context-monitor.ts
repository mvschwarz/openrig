import type Database from "better-sqlite3";
import type { ClaudeCompactionEnforcer } from "./claude-compaction-enforcer.js";
import type { ContextUsageStore } from "./context-usage-store.js";
import {
  isAttentionRequiredReadinessCode,
  type NodeBinding,
  type ReadinessResult,
} from "./runtime-adapter.js";
import type { UsageSamplesStore, ProviderWindowSampleInput } from "./usage-samples-store.js";
import type { ContextUsage } from "./types.js";
import { hasPendingFreshStartup } from "./startup-orchestrator.js";
import type { EventBus } from "./event-bus.js";

/** Default polling interval: 30 seconds. */
export const DEFAULT_POLL_INTERVAL_MS = 30_000;

export interface StartupSnapshot {
  node_id: string;
  rig_id: string;
  session_id: string;
  session_name: string;
  runtime: string | null;
  resume_token: string | null;
  cwd: string | null;
  model: string | null;
  codex_config_profile: string | null;
  startup_status: "pending" | "ready" | "attention_required" | "failed" | null;
  status: string;
  startup_completed_at: string | null;
  binding_id: string | null;
  binding_session: string | null;
  binding_pane: string | null;
  binding_window: string | null;
  binding_updated_at: string | null;
  generation_uuid: string | null;
  startup_event_seq: number | null;
  has_pending_work: boolean;
}

export type EligibleSession = StartupSnapshot;

export interface ClaudeContextProvisioner {
  ensureContextCollector(binding: { cwd?: string | null; tmuxSession?: string | null }): void;
  checkReady?(binding: NodeBinding): Promise<ReadinessResult>;
}

export interface RuntimeReadinessChecker {
  checkReady?(binding: NodeBinding): Promise<ReadinessResult>;
}

/**
 * Pending startup work belongs to this occupant and must be completed before
 * declaring startup ready. If files, guidance or post-ready actions never landed,
 * a working prompt alone does not prove startup finished.
 */
export function hasPendingStartupWork(
  db: Database.Database,
  nodeId: string,
  sessionId: string,
  startupCompletedAt?: string | null,
): boolean {
  if (hasPendingFreshStartup(db, nodeId, sessionId)) {
    return true;
  }
  if (!startupCompletedAt) {
    const row = db.prepare(
      "SELECT resolved_files_json, startup_actions_json FROM node_startup_context WHERE node_id = ?"
    ).get(nodeId) as { resolved_files_json: string; startup_actions_json: string } | undefined;
    if (row) {
      try {
        const files = JSON.parse(row.resolved_files_json ?? "[]") as Array<{ deliveryHint?: string }>;
        if (files.some((f) => f.deliveryHint === "send_text")) return true;

        const actions = JSON.parse(row.startup_actions_json ?? "[]") as Array<{ type?: string; phase?: string }>;
        if (actions.some((a) => a.phase === "after_files" || a.phase === "after_ready" || a.type === "send_text")) {
          return true;
        }
      } catch {
        return true;
      }
    }
  }
  return false;
}

/**
 * Check whether a startup failure is of a kind that can honestly be cleared by a
 * working prompt (such as a timeout while waiting for prompt, or an attention gate
 * that has since been cleared by the user). Failures due to missing files, failed
 * actions, or runtime launch crashes cannot be cleared by prompt responsiveness alone.
 */
export function isRecoverableStartupFailure(
  db: Database.Database,
  nodeId: string,
  sessionId: string,
  startupStatus: string | null,
): boolean {
  if (startupStatus === "attention_required") {
    return true;
  }
  if (startupStatus !== "failed") {
    return false;
  }
  const row = db.prepare(
    "SELECT payload FROM events WHERE node_id = ? AND type IN ('node.startup_pending', 'node.startup_ready', 'node.startup_failed') ORDER BY seq DESC LIMIT 1"
  ).get(nodeId) as { payload: string } | undefined;
  if (!row) {
    return true;
  }
  try {
    const event = JSON.parse(row.payload);
    if (event.type !== "node.startup_failed" || event.sessionId !== sessionId) {
      return false;
    }
    const err = (event.error ?? "").toLowerCase();
    const isTimeout = err.includes("timeout") || err.includes("not become interactive") || err.includes("readiness check error");
    const isGate = err.includes("attention") || err.includes("gate");
    return isTimeout || isGate;
  } catch {
    return false;
  }
}

/**
 * Take an atomic snapshot of the latest session, its binding, occupant generation,
 * startup status, event sequence, and pending work for currentness checks.
 */
export function getStartupSnapshot(
  db: Database.Database,
  target: { nodeId?: string; sessionName?: string },
): StartupSnapshot | undefined {
  const whereClauses: string[] = [
    "s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = n.id ORDER BY s2.id DESC LIMIT 1)",
    "(r.archived_at IS NULL OR s.status = 'running')",
    "COALESCE(b.attachment_type, 'tmux') = 'tmux'",
    "COALESCE(b.tmux_session, s.session_name) IS NOT NULL",
  ];
  const params: unknown[] = [];

  if (target.nodeId !== undefined) {
    whereClauses.push("n.id = ?");
    params.push(target.nodeId);
  }
  if (target.sessionName !== undefined) {
    whereClauses.push("s.session_name = ?");
    params.push(target.sessionName);
  }

  const row = db.prepare(`
    SELECT
      n.id as node_id,
      r.id as rig_id,
      s.id as session_id,
      s.session_name,
      n.runtime,
      s.resume_token,
      n.cwd,
      n.model,
      n.codex_config_profile,
      s.startup_status,
      s.status,
      s.startup_completed_at,
      b.id AS binding_id,
      b.tmux_session AS binding_session,
      b.tmux_pane AS binding_pane,
      b.tmux_window AS binding_window,
      b.updated_at AS binding_updated_at,
      (SELECT generation_uuid FROM occupant_tenures t WHERE t.node_id = n.id
        ORDER BY generation_ordinal DESC LIMIT 1) AS generation_uuid,
      (SELECT MAX(seq) FROM events e WHERE e.node_id = n.id
        AND e.type IN ('node.startup_pending', 'node.startup_ready', 'node.startup_failed')) AS startup_event_seq
    FROM nodes n
    JOIN rigs r ON r.id = n.rig_id
    JOIN sessions s ON s.node_id = n.id
    LEFT JOIN bindings b ON b.node_id = n.id
    WHERE ${whereClauses.join(" AND ")}
    ORDER BY s.id DESC
    LIMIT 1
  `).get(...params) as (Omit<StartupSnapshot, "has_pending_work"> & { has_pending_work?: boolean }) | undefined;

  if (!row) return undefined;

  row.has_pending_work = hasPendingStartupWork(db, row.node_id, row.session_id, row.startup_completed_at);
  return row as StartupSnapshot;
}

export interface NormalizeStartupStatusOpts {
  db: Database.Database;
  readinessCheckers: Record<string, RuntimeReadinessChecker | undefined>;
  eventBus?: EventBus;
  target: { nodeId?: string; sessionName?: string };
  inFlightMap?: Map<string, Promise<boolean>>;
}

/**
 * Reconcile non-ready startup state (`failed` or `attention_required`) via a runtime
 * readiness probe with currentness verification and atomic commit.
 */
export async function normalizeStartupStatus(opts: NormalizeStartupStatusOpts): Promise<boolean> {
  const { db, readinessCheckers, eventBus, target, inFlightMap } = opts;
  const snapshot = getStartupSnapshot(db, target);
  if (!snapshot) return false;
  if (snapshot.status !== "running") return false;
  if (!isRecoverableStartupFailure(db, snapshot.node_id, snapshot.session_id, snapshot.startup_status)) return false;

  const checker = snapshot.runtime ? readinessCheckers[snapshot.runtime] : undefined;
  if (!checker?.checkReady) return false;
  const checkReady = checker.checkReady.bind(checker);

  const key = snapshot.node_id;
  if (inFlightMap?.has(key)) {
    return inFlightMap.get(key)!;
  }

  const runReconciliation = async (): Promise<boolean> => {
    // Currentness check: snapshot must match current DB state
    const isCurrent = () => JSON.stringify(getStartupSnapshot(db, { nodeId: snapshot.node_id })) === JSON.stringify(snapshot);
    if (!isCurrent()) return false;

    const binding: NodeBinding = {
      id: `readiness:${snapshot.session_id}`,
      nodeId: snapshot.node_id,
      attachmentType: "tmux",
      tmuxSession: snapshot.binding_session ?? snapshot.session_name,
      tmuxWindow: snapshot.binding_window,
      tmuxPane: snapshot.binding_pane,
      cmuxWorkspace: null,
      cmuxSurface: null,
      updatedAt: snapshot.binding_updated_at ?? "",
      cwd: snapshot.cwd ?? "",
      model: snapshot.model ?? undefined,
      codexConfigProfile: snapshot.codex_config_profile ?? undefined,
    };

    let readiness: ReadinessResult;
    try {
      readiness = await checkReady(binding);
    } catch {
      return false;
    }

    let reconciled = false;
    // Hold no database lock while observing the runtime. Revalidation and
    // the write share an immediate transaction, reserving the writer before the
    // snapshot read so WAL contention cannot fail a later read-to-write upgrade.
    db.transaction(() => {
      if (!isCurrent()) return;

      if (readiness.ready) {
        if (snapshot.has_pending_work) return;
        if (!isRecoverableStartupFailure(db, snapshot.node_id, snapshot.session_id, snapshot.startup_status)) return;

        const completedAt = new Date().toISOString();
        const updateResult = db.prepare(`
          UPDATE sessions
          SET startup_status = 'ready',
              startup_completed_at = ?
          WHERE id = ? AND startup_status IN ('failed', 'attention_required')
        `).run(completedAt, snapshot.session_id);

        if (updateResult.changes > 0) {
          reconciled = true;
        }
        return;
      }

      if (isAttentionRequiredReadinessCode(readiness.code)) {
        if (snapshot.startup_status !== "attention_required") {
          db.prepare(`
            UPDATE sessions
            SET startup_status = 'attention_required'
            WHERE id = ? AND startup_status != 'attention_required'
          `).run(snapshot.session_id);
        }
      }
    }).immediate();

    if (reconciled) {
      eventBus?.emit({
        type: "node.startup_ready",
        rigId: snapshot.rig_id,
        nodeId: snapshot.node_id,
        previousStatus: snapshot.startup_status as "failed" | "attention_required",
      });
    }

    return reconciled;
  };

  if (!inFlightMap) {
    return runReconciliation();
  }

  const promise = runReconciliation();
  inFlightMap.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlightMap.delete(key);
  }
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
  private readinessCheckers: Record<string, RuntimeReadinessChecker | undefined>;
  private usageSamples: UsageSamplesStore | null = null;
  private providerWindowSampler: (() => ProviderWindowSampleInput[]) | null = null;
  private eventBus?: EventBus;
  private timer: ReturnType<typeof setInterval> | null = null;
  private activePoll: Promise<void> | null = null;

  constructor(
    db: Database.Database,
    store: ContextUsageStore,
    claudeContextProvisioner?: ClaudeContextProvisioner,
    compactionEnforcer?: ClaudeCompactionEnforcer,
    readinessCheckers?: Record<string, RuntimeReadinessChecker | undefined>,
    usageSamples?: UsageSamplesStore,
    providerWindowSampler?: () => ProviderWindowSampleInput[],
    eventBus?: EventBus,
  ) {
    this.db = db;
    this.store = store;
    this.usageSamples = usageSamples ?? null;
    this.providerWindowSampler = providerWindowSampler ?? null;
    this.claudeContextProvisioner = claudeContextProvisioner ?? null;
    this.compactionEnforcer = compactionEnforcer ?? null;
    this.readinessCheckers = readinessCheckers ?? {};
    this.eventBus = eventBus;
    if (claudeContextProvisioner && !this.readinessCheckers["claude-code"]) {
      this.readinessCheckers["claude-code"] = claudeContextProvisioner;
    }
  }

  /** Discover active managed Claude sessions and poll their sidecar files. */
  async pollOnce(): Promise<void> {
    if (this.activePoll) return this.activePoll;
    const poll = this.runPoll();
    this.activePoll = poll;
    try {
      await poll;
    } finally {
      if (this.activePoll === poll) this.activePoll = null;
    }
  }

  private async runPoll(): Promise<void> {
    this.compactionEnforcer?.reconcilePreparations?.();
    const sessions = this.getEligibleSessions();
    for (const session of sessions) {
      let observed: ContextUsage | null = null;
      const canReadContextUsage = session.runtime !== "codex" || !!session.resume_token;
      if (canReadContextUsage) {
        try {
          observed = this.readContextUsage(session);
          this.store.persist(session.node_id, observed);
          // 51-08 A1: the over-time twin — advance-only append on the SAME tick
          // (PM decision 1: piggyback, no parallel sampler). Known samples only:
          // unknown is a query-side judgment, never a stored zero (Option-A bar
          // + BR-2 absent-never-zero).
          if (this.usageSamples && observed.availability === "known") {
            try {
              this.usageSamples.appendContextSample(
                {
                  nodeId: session.node_id,
                  seatSession: session.session_name,
                  source: observed.source,
                  sampledAt: observed.sampledAt,
                  totalInputTokens: observed.totalInputTokens,
                  totalOutputTokens: observed.totalOutputTokens,
                  usedPercentage: observed.usedPercentage,
                },
                new Date().toISOString(),
              );
            } catch { /* series write must never break polling */ }
          }
        } catch {
          observed = null;
          // One bad session must not crash polling for others
          try {
            this.store.persist(session.node_id, this.store.unknownUsage("parse_error"));
          } catch { /* give up on this session */ }
        }
      }

      await this.normalizeStartupStatus(session);
      await this.maybeAutoCompact(session, observed);
    }
    this.drainProviderWindowSamples();
  }

  /** 51-08 A1: drain the provider-window supplier once per tick, advance-only.
   *  Defensive parity with the enforcer seam: a supplier fault never breaks polling. */
  private drainProviderWindowSamples(): void {
    if (!this.usageSamples || !this.providerWindowSampler) return;
    try {
      const capturedAt = new Date().toISOString();
      for (const sample of this.providerWindowSampler()) {
        this.usageSamples.appendProviderWindowSample(sample, capturedAt);
      }
    } catch { /* series write must never break polling */ }
  }

  /**
   * Slice 27 — invoke the enforcer with the latest observation. The
   * enforcer owns policy + dedup + send; ContextMonitor only relays
   * data and absorbs enforcer errors so a trigger-path fault never
   * crashes telemetry polling.
   *
   * Only a fresh, known sample can start a compaction. A stale or unknown
   * sample still drains a post-compact stage that is already pending: the
   * seat may take no turn after /compact, and only a turn refreshes its
   * sample.
   */
  private async maybeAutoCompact(
    session: EligibleSession,
    usage: ContextUsage | null,
  ): Promise<void> {
    if (!this.compactionEnforcer) return;
    try {
      if (usage && usage.availability === "known" && usage.fresh && usage.usedPercentage != null) {
        await this.compactionEnforcer.maybeAutoCompact({
          sessionName: session.session_name,
          cwd: session.cwd,
          runtime: session.runtime,
          usedPercentage: usage.usedPercentage,
          transcriptPath: usage.transcriptPath,
          sessionId: usage.sessionId,
        });
        return;
      }
      if (!this.compactionEnforcer.hasPendingPostCompactStage?.(session.session_name)) return;
      await this.compactionEnforcer.drainPendingPostCompactStage({
        sessionName: session.session_name,
        cwd: session.cwd,
        runtime: session.runtime,
        transcriptPath: usage?.transcriptPath ?? null,
        sessionId: usage?.sessionId ?? null,
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
  private getEligibleSessions(nodeId?: string): EligibleSession[] {
    const rows = this.db.prepare(`
      SELECT
        n.id as node_id,
        r.id as rig_id,
        s.id as session_id,
        s.session_name,
        n.runtime,
        s.resume_token,
        n.cwd,
        n.model,
        n.codex_config_profile,
        s.startup_status,
        s.status,
        s.startup_completed_at,
        b.id AS binding_id,
        b.tmux_session AS binding_session,
        b.tmux_pane AS binding_pane,
        b.tmux_window AS binding_window,
        b.updated_at AS binding_updated_at,
        (SELECT generation_uuid FROM occupant_tenures t WHERE t.node_id = n.id
          ORDER BY generation_ordinal DESC LIMIT 1) AS generation_uuid,
        (SELECT MAX(seq) FROM events e WHERE e.node_id = n.id
          AND e.type IN ('node.startup_pending', 'node.startup_ready', 'node.startup_failed')) AS startup_event_seq
      FROM nodes n
      JOIN rigs r ON r.id = n.rig_id
      JOIN sessions s ON s.node_id = n.id
        AND s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = n.id ORDER BY s2.id DESC LIMIT 1)
      LEFT JOIN bindings b ON b.node_id = n.id
      WHERE (
          (n.runtime = 'claude-code' AND s.status = 'running')
          OR (n.runtime = 'stub' AND s.status = 'running')
          OR (
            n.runtime = 'codex'
            AND (
              s.resume_token IS NOT NULL
              OR s.startup_status IN ('failed', 'attention_required')
            )
          )
        )
        AND (r.archived_at IS NULL OR s.status = 'running')
        AND COALESCE(b.attachment_type, 'tmux') = 'tmux'
        AND COALESCE(b.tmux_session, s.session_name) IS NOT NULL
        ${nodeId === undefined ? "" : "AND n.id = ?"}
    `).all(...(nodeId === undefined ? [] : [nodeId])) as (Omit<StartupSnapshot, "has_pending_work"> & { has_pending_work?: boolean })[];

    for (const row of rows) {
      row.has_pending_work = hasPendingStartupWork(this.db, row.node_id, row.session_id, row.startup_completed_at);
    }
    return rows as EligibleSession[];
  }

  private readContextUsage(session: EligibleSession) {
    if (session.runtime === "codex") {
      return this.store.readCodexAndNormalize({
        threadId: session.resume_token,
        sessionName: session.session_name,
      });
    }

    // Only claude-code seats get the Claude context collector provisioned into
    // their cwd. A runtime:stub seat self-provides its context sidecar, so the
    // monitor consumes it via readAndNormalize below WITHOUT writing any
    // Claude-specific collector config into the stub's cwd.
    if (session.runtime === "claude-code") {
      this.claudeContextProvisioner?.ensureContextCollector({
        cwd: session.cwd ?? undefined,
        tmuxSession: session.session_name,
      });
    }
    return this.store.readAndNormalize(session.session_name);
  }

  private async normalizeStartupStatus(session: EligibleSession): Promise<void> {
    await normalizeStartupStatus({
      db: this.db,
      readinessCheckers: this.readinessCheckers,
      eventBus: this.eventBus,
      target: { nodeId: session.node_id },
    }).catch(() => {});
  }
}
