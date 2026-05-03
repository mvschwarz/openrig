import type Database from "better-sqlite3";
import { ulid } from "ulid";

/**
 * Watchdog jobs repository (PL-004 Phase C).
 *
 * Owns all reads/writes against `watchdog_jobs`. Pure persistence; no
 * event-bus, no scheduler, no policy dispatch. Composed by the
 * scheduler and policy engine.
 *
 * Phase C v1 enforces the policy enum against three values:
 * periodic-reminder, artifact-pool-ready, edge-artifact-required.
 * `workflow-keepalive` is intentionally rejected with a structured
 * `policy_deferred_to_phase_d` error.
 */

export const PHASE_C_POLICIES = [
  "periodic-reminder",
  "artifact-pool-ready",
  "edge-artifact-required",
] as const;

export type WatchdogPolicyName = (typeof PHASE_C_POLICIES)[number];

export const WORKFLOW_KEEPALIVE_DEFERRED_POLICY = "workflow-keepalive";

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
  state: WatchdogJobState;
  registeredBySession: string;
  registeredAt: string;
  terminalReason: string | null;
}

export interface RegisterWatchdogJobInput {
  policy: string;
  specYaml: string;
  targetSession: string;
  intervalSeconds: number;
  activeWakeIntervalSeconds?: number | null;
  scanIntervalSeconds?: number | null;
  registeredBySession: string;
}

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
  state: string;
  registered_by_session: string;
  registered_at: string;
  terminal_reason: string | null;
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

export class WatchdogJobsRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly now: () => Date = () => new Date(),
  ) {}

  register(input: RegisterWatchdogJobInput): WatchdogJob {
    if (input.policy === WORKFLOW_KEEPALIVE_DEFERRED_POLICY) {
      throw new WatchdogJobsError(
        "policy_deferred_to_phase_d",
        `policy 'workflow-keepalive' ships in PL-004 Phase D paired with workflow_instances; not available in Phase C v1`,
        { policy: input.policy, phase: "C", deferredTo: "D" },
      );
    }
    if (!PHASE_C_POLICIES.includes(input.policy as WatchdogPolicyName)) {
      throw new WatchdogJobsError(
        "policy_unknown",
        `unknown watchdog policy '${input.policy}'; Phase C v1 supports: ${PHASE_C_POLICIES.join(", ")}`,
        { policy: input.policy, supported: [...PHASE_C_POLICIES] },
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
        jobId,
        input.policy,
        input.specYaml,
        input.targetSession,
        input.intervalSeconds,
        input.activeWakeIntervalSeconds ?? null,
        input.scanIntervalSeconds ?? null,
        input.registeredBySession,
        registeredAt,
      );
    return this.getByIdOrThrow(jobId);
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
    state: row.state as WatchdogJobState,
    registeredBySession: row.registered_by_session,
    registeredAt: row.registered_at,
    terminalReason: row.terminal_reason,
  };
}
