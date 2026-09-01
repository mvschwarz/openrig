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
  /**
   * POC-shape target object. Built from spec_yaml top-level `target:`
   * block when present; otherwise falls back to `{session: registered
   * targetSession}`. Policies access `job.target.session` per POC.
   */
  target: { session: string };
  /** Optional top-level message override (POC pattern: `job.message`). */
  message?: string;
  intervalSeconds: number;
  activeWakeIntervalSeconds: number | null;
  scanIntervalSeconds: number | null;
  /** Parsed `context:` block from the operator-supplied spec_yaml. */
  context: Record<string, unknown>;
  lastEvaluationAt: string | null;
  lastFireAt: string | null;
  registeredBySession: string;
  registeredAt: string;
  watchedFilePath: string | null;
  thresholdBytes: number | null;
  requiresJobId: string | null;
  lastFiredGeneration: string | null;
  occupantGeneration: string | null;
  currentGenerationTranscriptPending: boolean;
  requiredReceiptSatisfied: boolean;
  requiredReceiptDeferred: boolean;
}

export type PolicyEvaluation =
  | {
      action: "send";
      target: { session: string };
      message: string;
      notes?: Record<string, unknown>;
      /**
       * OPR.0.5.8.1 S2 — an opaque receipt for the CONDITION this send is about,
       * persisted by the engine ONLY when delivery actually succeeded.
       *
       * A policy that suppresses on "already told them" must record that against
       * evidence the telling happened. The first cut of this wrote the receipt
       * inside evaluate(), before delivery was attempted, so one transient
       * transport failure suppressed the wake until the watched condition
       * changed — silence instead of noise, which is the worse failure. Policies
       * that do not set this are unaffected.
       */
      conditionReceipt?: string;
    }
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
