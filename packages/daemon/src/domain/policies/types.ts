// PL-004 Phase C: shared policy contract types.
//
// Each watchdog policy implements `evaluate(job)` returning a
// PolicyEvaluation. Pure: no side-effects, no event-bus, no DB.
// The watchdog-policy-engine maps `action: send` to a delivery call,
// records meaningful outcomes via watchdog-history-log, and emits
// the corresponding RigEvent.

export interface PolicyJob {
  jobId: string;
  policy: string;
  targetSession: string;
  intervalSeconds: number;
  activeWakeIntervalSeconds: number | null;
  scanIntervalSeconds: number | null;
  /** Parsed `context:` block from the operator-supplied spec_yaml. */
  context: Record<string, unknown>;
  lastEvaluationAt: string | null;
  lastFireAt: string | null;
  registeredBySession: string;
  registeredAt: string;
}

export type PolicyEvaluation =
  | { action: "send"; target: string; message: string; notes?: Record<string, unknown> }
  | { action: "skip"; reason: string; notes?: Record<string, unknown> }
  | { action: "terminal"; reason: string; notes?: Record<string, unknown> };

export interface Policy {
  /** Stable identifier matching watchdog_jobs.policy enum. */
  readonly name: string;
  /**
   * Pure evaluation. No I/O beyond filesystem reads (artifact-pool
   * scans). Throws only for hard contract violations (missing required
   * spec fields); recoverable conditions (no actionable artifacts,
   * recent successful run) MUST return action=skip.
   */
  evaluate(job: PolicyJob): Promise<PolicyEvaluation>;
}
