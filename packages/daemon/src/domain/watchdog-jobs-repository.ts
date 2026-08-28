import type Database from "better-sqlite3";
import { ulid } from "ulid";

/**
 * Watchdog jobs repository (PL-004 Phase C; extended in Phase D).
 *
 * Owns all reads/writes against `watchdog_jobs`. Pure persistence; no
 * event-bus, no scheduler, no policy dispatch. Composed by the
 * scheduler and policy engine.
 *
 * Accepted policy values include the orch-ratified Phase C set plus
 * daemon-native workflow, idle-gate, and context-usage conditions:
 *   - periodic-reminder (Phase C)
 *   - artifact-pool-ready (Phase C)
 *   - edge-artifact-required (Phase C)
 *   - workflow-keepalive (Phase D)
 *   - idle-gate-qitem
 *   - context-usage-threshold
 *
 * PHASE_C_POLICIES retained as a deprecated alias for callers that
 * still reference it; new code uses PHASE_D_POLICIES.
 */

export const PHASE_D_POLICIES = [
  "periodic-reminder",
  "artifact-pool-ready",
  "edge-artifact-required",
  "workflow-keepalive",
  // OPR.0.4.3.16 — idle-seat gate watchdog. DB-backed (queue_items) +
  // AgentActivityStore-backed; factory-constructed at startup and injected
  // via WatchdogPolicyEngine additionalPolicies (like workflow-keepalive).
  "idle-gate-qitem",
  "context-usage-threshold",
] as const;

/** @deprecated since Phase D — use PHASE_D_POLICIES. */
export const PHASE_C_POLICIES = PHASE_D_POLICIES;

export type WatchdogPolicyName = (typeof PHASE_D_POLICIES)[number];

export type WatchdogJobState = "active" | "stopped" | "terminal";

export interface WatchdogJob {
  jobId: string;
  policy: WatchdogPolicyName;
  specYaml: string;
  targetSession: string;
  intervalSeconds: number;
  activeWakeIntervalSeconds: number | null;
  scanIntervalSeconds: number | null;
  lastEvaluationAt: string | null;
  lastFireAt: string | null;
  actionable: boolean;
  lastActionableAt: string | null;
  state: WatchdogJobState;
  registeredBySession: string;
  registeredAt: string;
  terminalReason: string | null;
  /** (e/Class-B) atom-B generation of the occupant that armed this job; null = UNKNOWN/pre-063. */
  registeredByGeneration: string | null;
  /** (i-c) opt-in target occupant-generation this wake is bound to; null = ROLE-bound (fire at whoever
   *  occupies the seat name). Only a non-null value opts the job into the fire-time gen-gate. */
  targetGeneration: string | null;
  /** Transcript-byte condition state. Null on every other policy. */
  watchedFilePath: string | null;
  thresholdBytes: number | null;
  requiresJobId: string | null;
  /** The latest occupant generation for which this threshold fired. */
  lastFiredGeneration: string | null;
}

export interface RegisterWatchdogJobInput {
  policy: string;
  specYaml: string;
  targetSession: string;
  intervalSeconds: number;
  activeWakeIntervalSeconds?: number | null;
  scanIntervalSeconds?: number | null;
  registeredBySession: string;
  /** (i-c) opt-in: the occupant-generation this wake is bound to. Omit/null = ROLE-bound (the common
   *  case — fires at whoever occupies the seat, unchanged). Non-null opts into the fire-time gen-gate. */
  targetGenerationUuid?: string | null;
  watchedFilePath?: string | null;
  thresholdBytes?: number | null;
  requiresJobId?: string | null;
}

export type EnsureAutoRegistrationInput = RegisterWatchdogJobInput;

interface JobRow {
  job_id: string;
  policy: string;
  spec_yaml: string;
  target_session: string;
  interval_seconds: number;
  active_wake_interval_seconds: number | null;
  scan_interval_seconds: number | null;
  last_evaluation_at: string | null;
  last_fire_at: string | null;
  actionable: number;
  last_actionable_at: string | null;
  state: string;
  registered_by_session: string;
  registered_at: string;
  terminal_reason: string | null;
  registered_by_generation_uuid?: string | null;
  target_generation_uuid?: string | null;
  watched_file_path?: string | null;
  threshold_bytes?: number | null;
  requires_job_id?: string | null;
  last_fired_generation_uuid?: string | null;
}

export class WatchdogJobsError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "WatchdogJobsError";
  }
}

/** Defensive additive-column detect (mirrors queue-repository's detectQueueColumn): a harness whose
 *  db predates migration 063 lacks the generation columns, so writers degrade instead of throwing. */
function detectWatchdogColumn(db: Database.Database, columnName: string): boolean {
  try {
    return db.prepare("PRAGMA table_info(watchdog_jobs)").all()
      .some((row) => (row as { name?: string }).name === columnName);
  } catch {
    return false;
  }
}

export class WatchdogJobsRepository {
  private readonly hasGenColumn: boolean;
  private readonly hasTargetGenColumn: boolean;
  private readonly hasContextUsageColumns: boolean;
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => Date = () => new Date(),
    // GHOST-STAGE (e/Class-B): resolve the ARMING occupant's atom-B generation so a job carries the
    // generation that registered it. null/absent ⇒ UNKNOWN → the column stays NULL and the swap-time
    // gen predicate never matches it (never dropped on unknown). Injected in startup (SessionRegistry).
    private readonly resolveOccupantGeneration?: (sessionName: string) => string | null,
  ) {
    this.hasGenColumn = detectWatchdogColumn(db, "registered_by_generation_uuid");
    this.hasTargetGenColumn = detectWatchdogColumn(db, "target_generation_uuid");
    this.hasContextUsageColumns = detectWatchdogColumn(db, "last_fired_generation_uuid");
  }

  register(input: RegisterWatchdogJobInput): WatchdogJob {
    if (!PHASE_D_POLICIES.includes(input.policy as WatchdogPolicyName)) {
      throw new WatchdogJobsError(
        "policy_unknown",
        `unknown watchdog policy '${input.policy}'; Phase D v1 supports: ${PHASE_D_POLICIES.join(", ")}`,
        { policy: input.policy, supported: [...PHASE_D_POLICIES] },
      );
    }
    if (!Number.isInteger(input.intervalSeconds) || input.intervalSeconds <= 0) {
      throw new WatchdogJobsError(
        "interval_invalid",
        `interval_seconds must be a positive integer (got ${input.intervalSeconds})`,
        { intervalSeconds: input.intervalSeconds },
      );
    }
    if (!input.targetSession || !input.targetSession.includes("@")) {
      throw new WatchdogJobsError(
        "target_session_invalid",
        `target_session must be canonical '<member>@<rig>' (got '${input.targetSession}')`,
        { targetSession: input.targetSession },
      );
    }
    const isContextUsageThreshold = input.policy === "context-usage-threshold";
    if (isContextUsageThreshold && !this.hasContextUsageColumns) {
      throw new WatchdogJobsError(
        "context_usage_schema_missing",
        "context-usage-threshold requires migration 074_context_usage_watchdog",
      );
    }
    if (
      isContextUsageThreshold &&
      (!Number.isInteger(input.thresholdBytes) || (input.thresholdBytes ?? 0) <= 0)
    ) {
      throw new WatchdogJobsError(
        "threshold_invalid",
        `threshold_bytes must be a positive integer (got ${String(input.thresholdBytes)})`,
      );
    }
    if (isContextUsageThreshold && !input.watchedFilePath) {
      throw new WatchdogJobsError(
        "watched_file_unresolved",
        `no transcript file could be resolved for ${input.targetSession}`,
        { targetSession: input.targetSession },
      );
    }
    if (isContextUsageThreshold && input.requiresJobId && !this.getById(input.requiresJobId)) {
      throw new WatchdogJobsError(
        "requires_job_not_found",
        `required watchdog job ${input.requiresJobId} does not exist`,
        { requiresJobId: input.requiresJobId },
      );
    }
    const jobId = ulid();
    const registeredAt = this.now().toISOString();
    // (e/Class-B): stamp the ARMING occupant's generation so a swap can drop THIS gen's armed jobs
    // (a stale wake firing into the successor's context is the ghost). NULL when unresolved/pre-063.
    const registeredByGeneration = this.hasGenColumn
      ? (this.resolveOccupantGeneration?.(input.registeredBySession) ?? null)
      : null;
    // (i-c) opt-in TARGET generation: caller-supplied (NULL = role-bound). Stored only when the 066
    // column exists; pre-066 dbs silently degrade the opt-in to role-bound. 066 ⟹ 063 (additive order).
    const targetGenerationUuid = this.hasTargetGenColumn ? (input.targetGenerationUuid ?? null) : null;
    const columns = [
      "job_id", "policy", "spec_yaml", "target_session", "interval_seconds",
      "active_wake_interval_seconds", "scan_interval_seconds", "state",
      "registered_by_session", "registered_at",
    ];
    const values: unknown[] = [
      jobId, input.policy, input.specYaml, input.targetSession, input.intervalSeconds,
      input.activeWakeIntervalSeconds ?? null, input.scanIntervalSeconds ?? null, "active",
      input.registeredBySession, registeredAt,
    ];
    if (this.hasGenColumn) {
      columns.push("registered_by_generation_uuid");
      values.push(registeredByGeneration);
    }
    if (this.hasTargetGenColumn) {
      columns.push("target_generation_uuid");
      values.push(targetGenerationUuid);
    }
    if (this.hasContextUsageColumns) {
      columns.push(
        "watched_file_path",
        "threshold_bytes",
        "requires_job_id",
        "last_fired_generation_uuid",
      );
      values.push(
        isContextUsageThreshold ? input.watchedFilePath : null,
        isContextUsageThreshold ? input.thresholdBytes : null,
        isContextUsageThreshold ? (input.requiresJobId ?? null) : null,
        null,
      );
    }
    this.db
      .prepare(
        `INSERT INTO watchdog_jobs (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      )
      .run(...values);
    return this.getByIdOrThrow(jobId);
  }

  /** Latest recorded transcript path for the exact current seat name. */
  findTranscriptPath(targetSession: string): string | null {
    const row = this.db
      .prepare(
        `SELECT transcript_path FROM context_usage
         WHERE session_name = ? AND transcript_path IS NOT NULL AND transcript_path != ''
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(targetSession) as { transcript_path: string } | undefined;
    return row?.transcript_path ?? null;
  }

  recordThresholdFire(jobId: string, occupantGeneration: string, firedAt: string): void {
    if (!this.hasContextUsageColumns) {
      throw new WatchdogJobsError(
        "context_usage_schema_missing",
        "context-usage-threshold requires migration 074_context_usage_watchdog",
      );
    }
    this.db
      .prepare(
        `UPDATE watchdog_jobs
         SET last_fired_generation_uuid = ?, last_evaluation_at = ?, last_fire_at = ?
         WHERE job_id = ?`,
      )
      .run(occupantGeneration, firedAt, firedAt, jobId);
  }

  /**
   * Ensure the daemon-owned, role-bound auto-registration tuple has exactly
   * one nonterminal row. Stopped is an operator opt-out and is therefore as
   * durable as active; terminal-only history is replaced. The table has no
   * uniqueness constraint, so every matching row must be inspected.
   */
  ensureAutoRegistration(
    input: EnsureAutoRegistrationInput,
    historicalTargetSessions: string[] = [input.targetSession],
  ): WatchdogJob {
    const existing = this.findAutoRegistration(
      input.policy,
      input.targetSession,
      input.targetGenerationUuid ?? null,
      historicalTargetSessions,
    );
    if (existing) {
      this.db.prepare(
        `UPDATE watchdog_jobs
            SET spec_yaml = ?, target_session = ?, interval_seconds = ?,
                active_wake_interval_seconds = ?, scan_interval_seconds = ?
          WHERE job_id = ?`,
      ).run(
        input.specYaml,
        input.targetSession,
        input.intervalSeconds,
        input.activeWakeIntervalSeconds ?? null,
        input.scanIntervalSeconds ?? null,
        existing.jobId,
      );
      return this.getByIdOrThrow(existing.jobId);
    }
    return this.register(input);
  }

  /**
   * Resolve the one active/stopped role-bound row across every historical
   * session alias for a node. Persisted states are intentionally closed:
   * unknown values are neither runnable jobs nor operator opt-outs.
   */
  findAutoRegistration(
    policy: string,
    targetSession: string,
    targetGenerationUuid: string | null,
    historicalTargetSessions: string[] = [targetSession],
  ): WatchdogJob | null {
    const rows = this.listAliasTuples(policy, historicalTargetSessions, targetGenerationUuid);
    const invalid = rows.filter((row) =>
      row.state !== "active" && row.state !== "stopped" && row.state !== "terminal"
    );
    if (invalid.length > 0) {
      throw new WatchdogJobsError(
        "auto_registration_state_invalid",
        `auto_registration_state_invalid: auto-registration has invalid persisted state for ${policy}/${targetSession}`,
        {
          policy,
          targetSession,
          targetGenerationUuid,
          rows: invalid.map((row) => ({ jobId: row.jobId, state: row.state })),
        },
      );
    }
    const nonterminal = rows.filter((row) => row.state === "active" || row.state === "stopped");
    if (nonterminal.length > 1) {
      throw new WatchdogJobsError(
        "auto_registration_ambiguous",
        `auto-registration is ambiguous for ${policy}/${targetSession}: ${nonterminal.length} nonterminal rows`,
        {
          policy,
          targetSession,
          targetGenerationUuid,
          rows: nonterminal.map((row) => ({ jobId: row.jobId, state: row.state })),
        },
      );
    }
    return nonterminal[0] ?? null;
  }

  /** All rows for the exact policy/seat/generation tuple, including history. */
  listExactTuple(
    policy: string,
    targetSession: string,
    targetGenerationUuid: string | null,
  ): WatchdogJob[] {
    const targetClause = this.hasTargetGenColumn
      ? "target_generation_uuid IS ?"
      : targetGenerationUuid === null
        ? "1 = 1"
        : "0 = 1";
    const params = this.hasTargetGenColumn
      ? [policy, targetSession, targetGenerationUuid]
      : [policy, targetSession];
    const rows = this.db.prepare(
      `SELECT * FROM watchdog_jobs
       WHERE policy = ? AND target_session = ? AND ${targetClause}
       ORDER BY registered_at ASC, job_id ASC`,
    ).all(...params) as JobRow[];
    return rows.map(rowToJob);
  }

  private listAliasTuples(
    policy: string,
    targetSessions: string[],
    targetGenerationUuid: string | null,
  ): WatchdogJob[] {
    const aliases = [...new Set(targetSessions)];
    if (aliases.length === 0) return [];
    const targetClause = this.hasTargetGenColumn
      ? "target_generation_uuid IS ?"
      : targetGenerationUuid === null
        ? "1 = 1"
        : "0 = 1";
    const placeholders = aliases.map(() => "?").join(", ");
    const params = this.hasTargetGenColumn
      ? [policy, ...aliases, targetGenerationUuid]
      : [policy, ...aliases];
    const rows = this.db.prepare(
      `SELECT * FROM watchdog_jobs
       WHERE policy = ? AND target_session IN (${placeholders}) AND ${targetClause}
       ORDER BY registered_at ASC, job_id ASC`,
    ).all(...params) as JobRow[];
    return rows.map(rowToJob);
  }

  getById(jobId: string): WatchdogJob | null {
    const row = this.db
      .prepare(`SELECT * FROM watchdog_jobs WHERE job_id = ?`)
      .get(jobId) as JobRow | undefined;
    return row ? rowToJob(row) : null;
  }

  getByIdOrThrow(jobId: string): WatchdogJob {
    const job = this.getById(jobId);
    if (!job) {
      throw new WatchdogJobsError(
        "job_not_found",
        `watchdog job ${jobId} not found`,
        { jobId },
      );
    }
    return job;
  }

  listAll(): WatchdogJob[] {
    const rows = this.db
      .prepare(`SELECT * FROM watchdog_jobs ORDER BY registered_at ASC`)
      .all() as JobRow[];
    return rows.map(rowToJob);
  }

  listActive(): WatchdogJob[] {
    const rows = this.db
      .prepare(`SELECT * FROM watchdog_jobs WHERE state = 'active' ORDER BY registered_at ASC`)
      .all() as JobRow[];
    return rows.map(rowToJob);
  }

  recordEvaluation(jobId: string, evaluatedAt: string, fired: boolean): void {
    if (fired) {
      this.db
        .prepare(
          `UPDATE watchdog_jobs SET last_evaluation_at = ?, last_fire_at = ? WHERE job_id = ?`,
        )
        .run(evaluatedAt, evaluatedAt, jobId);
    } else {
      this.db
        .prepare(`UPDATE watchdog_jobs SET last_evaluation_at = ? WHERE job_id = ?`)
        .run(evaluatedAt, jobId);
    }
  }

  /**
   * R1 fix: write the actionable-state machine columns. Mirrors POC
   * engine's `state.actionable` + `state.last_actionable_at`. Called
   * by the policy engine after every meaningful evaluation:
   *   - newActionable=false (skip): clears actionable + last_actionable_at.
   *   - newActionable=true with no preserveLastActionableAt: stamps
   *     last_actionable_at to evaluatedAt (newly actionable).
   *   - newActionable=true with preserveLastActionableAt set: keeps the
   *     existing first-actionable timestamp (continued actionable window).
   */
  setActionable(
    jobId: string,
    newActionable: boolean,
    evaluatedAt: string,
    preserveLastActionableAt: string | null = null,
  ): void {
    if (!newActionable) {
      this.db
        .prepare(
          `UPDATE watchdog_jobs SET actionable = 0, last_actionable_at = NULL WHERE job_id = ?`,
        )
        .run(jobId);
      return;
    }
    const stamp = preserveLastActionableAt ?? evaluatedAt;
    this.db
      .prepare(
        `UPDATE watchdog_jobs SET actionable = 1, last_actionable_at = ? WHERE job_id = ?`,
      )
      .run(stamp, jobId);
  }

  markTerminal(jobId: string, reason: string): void {
    this.db
      .prepare(
        `UPDATE watchdog_jobs SET state = 'terminal', terminal_reason = ? WHERE job_id = ?`,
      )
      .run(reason, jobId);
  }

  stop(jobId: string, reason = "operator_stopped"): WatchdogJob {
    const existing = this.getByIdOrThrow(jobId);
    if (existing.state === "terminal") {
      throw new WatchdogJobsError(
        "job_terminal",
        `cannot stop watchdog job ${jobId}: state is terminal`,
        { jobId, state: existing.state },
      );
    }
    if (existing.state === "stopped") return existing;
    this.db
      .prepare(`UPDATE watchdog_jobs SET state = 'stopped', terminal_reason = ? WHERE job_id = ?`)
      .run(reason, jobId);
    return this.getByIdOrThrow(jobId);
  }

  /**
   * GHOST-STAGE (e/Class-B): at a seat swap, stop every ARMED (state='active') job registered by the
   * RETIRING generation — a stale wake firing into the successor's context is the specimen; the
   * successor re-arms its own. Gen-scoped, NEVER name-scoped (the successor shares the seat name, so a
   * name-scoped stop would kill the successor's own jobs). A NULL/empty generation never matches
   * (UNKNOWN ≠ retired — note-2). Returns the count stopped. Auditable (terminal_reason), not a hard
   * delete — the row stays for forensics. Pre-063 dbs no-op.
   */
  dropArmedByRegisteringGeneration(generationUuid: string): number {
    if (!this.hasGenColumn || !generationUuid) return 0;
    const res = this.db
      .prepare(
        `UPDATE watchdog_jobs SET state = 'stopped', terminal_reason = 'registering generation retired (seat handover)'
         WHERE state = 'active' AND registered_by_generation_uuid = ?`,
      )
      .run(generationUuid);
    return res.changes;
  }
}

function rowToJob(row: JobRow): WatchdogJob {
  return {
    jobId: row.job_id,
    policy: row.policy as WatchdogPolicyName,
    specYaml: row.spec_yaml,
    targetSession: row.target_session,
    intervalSeconds: row.interval_seconds,
    activeWakeIntervalSeconds: row.active_wake_interval_seconds,
    scanIntervalSeconds: row.scan_interval_seconds,
    lastEvaluationAt: row.last_evaluation_at,
    lastFireAt: row.last_fire_at,
    actionable: row.actionable !== 0,
    lastActionableAt: row.last_actionable_at,
    state: row.state as WatchdogJobState,
    registeredBySession: row.registered_by_session,
    registeredAt: row.registered_at,
    terminalReason: row.terminal_reason,
    registeredByGeneration: row.registered_by_generation_uuid ?? null,
    targetGeneration: row.target_generation_uuid ?? null,
    watchedFilePath: row.watched_file_path ?? null,
    thresholdBytes: row.threshold_bytes ?? null,
    requiresJobId: row.requires_job_id ?? null,
    lastFiredGeneration: row.last_fired_generation_uuid ?? null,
  };
}
