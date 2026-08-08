import type Database from "better-sqlite3";
import { ulid } from "ulid";

/**
 * Watchdog jobs repository (PL-004 Phase C; extended in Phase D).
 *
 * Owns all reads/writes against `watchdog_jobs`. Pure persistence; no
 * event-bus, no scheduler, no policy dispatch. Composed by the
 * scheduler and policy engine.
 *
 * Phase D v1 accepts FOUR policy values (the orch-ratified Phase C
 * `workflow-keepalive` deferral has been lifted; the policy module
 * now exists at `policies/workflow-keepalive.ts` and reads from the
 * SQLite `workflow_instances` table introduced in Phase D):
 *   - periodic-reminder (Phase C)
 *   - artifact-pool-ready (Phase C)
 *   - edge-artifact-required (Phase C)
 *   - workflow-keepalive (Phase D)
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
    if (this.hasTargetGenColumn) {
      this.db
        .prepare(
          `INSERT INTO watchdog_jobs (
            job_id, policy, spec_yaml, target_session,
            interval_seconds, active_wake_interval_seconds, scan_interval_seconds,
            last_evaluation_at, last_fire_at, state,
            registered_by_session, registered_at, terminal_reason,
            registered_by_generation_uuid, target_generation_uuid
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'active', ?, ?, NULL, ?, ?)`,
        )
        .run(
          jobId, input.policy, input.specYaml, input.targetSession,
          input.intervalSeconds, input.activeWakeIntervalSeconds ?? null, input.scanIntervalSeconds ?? null,
          input.registeredBySession, registeredAt, registeredByGeneration, targetGenerationUuid,
        );
    } else if (this.hasGenColumn) {
      this.db
        .prepare(
          `INSERT INTO watchdog_jobs (
            job_id, policy, spec_yaml, target_session,
            interval_seconds, active_wake_interval_seconds, scan_interval_seconds,
            last_evaluation_at, last_fire_at, state,
            registered_by_session, registered_at, terminal_reason,
            registered_by_generation_uuid
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'active', ?, ?, NULL, ?)`,
        )
        .run(
          jobId, input.policy, input.specYaml, input.targetSession,
          input.intervalSeconds, input.activeWakeIntervalSeconds ?? null, input.scanIntervalSeconds ?? null,
          input.registeredBySession, registeredAt, registeredByGeneration,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO watchdog_jobs (
            job_id, policy, spec_yaml, target_session,
            interval_seconds, active_wake_interval_seconds, scan_interval_seconds,
            last_evaluation_at, last_fire_at, state,
            registered_by_session, registered_at, terminal_reason
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'active', ?, ?, NULL)`,
        )
        .run(
          jobId, input.policy, input.specYaml, input.targetSession,
          input.intervalSeconds, input.activeWakeIntervalSeconds ?? null, input.scanIntervalSeconds ?? null,
          input.registeredBySession, registeredAt,
        );
    }
    return this.getByIdOrThrow(jobId);
  }

  /**
   * Ensure the daemon-owned, role-bound auto-registration tuple has exactly
   * one nonterminal row. Stopped is an operator opt-out and is therefore as
   * durable as active; terminal-only history is replaced. The table has no
   * uniqueness constraint, so every matching row must be inspected.
   */
  ensureAutoRegistration(input: EnsureAutoRegistrationInput): WatchdogJob {
    const rows = this.listExactTuple(
      input.policy,
      input.targetSession,
      input.targetGenerationUuid ?? null,
    );
    const nonterminal = rows.filter((row) => row.state !== "terminal");
    if (nonterminal.length === 1) return nonterminal[0]!;
    if (nonterminal.length > 1) {
      throw new WatchdogJobsError(
        "auto_registration_ambiguous",
        `auto-registration is ambiguous for ${input.policy}/${input.targetSession}: ${nonterminal.length} nonterminal rows`,
        {
          policy: input.policy,
          targetSession: input.targetSession,
          targetGenerationUuid: input.targetGenerationUuid ?? null,
          rows: nonterminal.map((row) => ({ jobId: row.jobId, state: row.state })),
        },
      );
    }
    return this.register(input);
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
  };
}
