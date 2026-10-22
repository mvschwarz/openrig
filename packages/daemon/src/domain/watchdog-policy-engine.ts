import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import type { EventBus } from "./event-bus.js";
import type { Policy, PolicyEvaluation, PolicyJob } from "./policies/types.js";
import { artifactPoolReadyPolicy } from "./policies/artifact-pool-ready.js";
import { edgeArtifactRequiredPolicy } from "./policies/edge-artifact-required.js";
import { periodicReminderPolicy } from "./policies/periodic-reminder.js";
import { contextUsageThresholdPolicy } from "./policies/context-usage-threshold.js";
import { PARK_WAKE_GUIDANCE, parkContinuationPreview, withContinuationPreview } from "./park-wake-text.js";
import { isRefusedInteractive } from "./policies/parked-owner-consumer.js";
import {
  WatchdogJobsError,
  type WatchdogJob,
  type WatchdogJobsRepository,
} from "./watchdog-jobs-repository.js";
import type { WatchdogHistoryEntry, WatchdogHistoryLog } from "./watchdog-history-log.js";

/**
 * Watchdog policy engine (PL-004 Phase C R1).
 *
 * Owns the per-evaluation state machine that mirrors POC engine
 * `lib/engine.mjs`:
 *   1. Resolve policy by name from registry. Unknown policy → terminal.
 *   2. Parse spec_yaml into top-level `target:` + top-level `message?:` +
 *      nested `context:` block, then build a PolicyJob with the
 *      resolved target object (falls back to registered targetSession
 *      when spec lacks an explicit `target:`).
 *   3. Dispatch policy.evaluate(policyJob).
 *   4. Action handling:
 *      - skip: clear actionable=false; record history + emit event
 *        ONLY if reason is "loud" (not in QUIET_SKIP_REASONS).
 *      - send: enforce active-wake throttle. If state.actionable was
 *        already true AND active_wake_interval_seconds is set AND not
 *        elapsed since last_fire_at → emit/record `active_wake_not_due`
 *        (quiet skip per POC). Otherwise call delivery, record history
 *        with sent outcome, emit evaluation_fired, set actionable=true.
 *      - terminal: mark job terminal, record history, emit terminal.
 *
 * `not_due` polls are filtered upstream by the scheduler and never
 * reach this engine.
 */

export interface DeliveryRequest {
  targetSession: string;
  message: string;
  continuityAction?: {
    type: "create-cutover-baton";
    jobId: string;
    occupantGeneration: string;
    sourceSession: string;
    destination: string;
    body: string;
  };
}

export interface DeliveryOutcome {
  status: "ok" | "failed" | "retained";
  outboxIds?: string[];
  /** The existing transport's actual input boundary; failure never means no input by itself. */
  inputPhase?: "not_reached" | "attempted" | "written";
  error?: string;
  /** Structured continuity custody was durably created or identified. */
  continuityActionCompleted?: boolean;
  /** The text reported by a delivery implementation, without its scheduler header. */
  sentMessage?: string;
}

export interface WatchdogDeliverySource {
  occurrenceId?: string;
  jobId: string;
  policy: string;
  /** A digest's members, when one send carries several reminders: each job and the occurrence it was due for. */
  members?: Array<{ jobId: string; occurrenceId: string }>;
}

export type DeliveryFn = (
  req: DeliveryRequest,
  source: WatchdogDeliverySource,
) => Promise<DeliveryOutcome>;

export function formatWatchdogDeliveryMessage(
  source: WatchdogDeliverySource,
  message: string,
): string {
  if (source.members) {
    return `[OpenRig watchdog scheduler · policy: ${source.policy} · ${source.members.length} jobs · digest: ${source.jobId}]\n${message}`;
  }
  return `[OpenRig watchdog scheduler · policy: ${source.policy} · job: ${source.jobId}]\n${message}`;
}

export interface PolicyContextParser {
  /**
   * Parse the operator-supplied spec_yaml into the structured fields the
   * engine needs. Returns the top-level `target` (object), top-level
   * `message` (string), and the `context:` block (Record).
   */
  (specYaml: string): {
    target: { session: string } | null;
    message: string | null;
    context: Record<string, unknown>;
  };
}

interface WatchdogPolicyEngineDeps {
  jobsRepo: WatchdogJobsRepository;
  historyLog: WatchdogHistoryLog;
  eventBus: EventBus;
  deliver: DeliveryFn;
  parseSpec?: PolicyContextParser;
  now?: () => Date;
  /**
   * PL-004 Phase D extension point (orch-ratified per slice IMPL):
   * additional policies to register alongside the Phase C built-in
   * three. Used to register `workflow-keepalive` (which depends on
   * the Phase D workflow_instances DB and so must be constructed at
   * daemon startup with a db handle injected).
   */
  additionalPolicies?: Policy[];
  /**
   * (i-c) FIRE-TIME target-generation gate. Resolve a target session's LIVE occupant-generation (P12
   * `occupant_tenures`) so a GENERATION-bound wake (job.targetGeneration set) can be refused when the
   * target has been handed over to a different generation since the job was armed. Absent → gate off
   * (jobs fire unchanged). A null return = UNKNOWN → fail-open (deliver): the protective act is
   * SKIPPING, so an unknown target-generation must never skip a legitimate wake (note-2 inversion).
   */
  resolveTargetGeneration?: (sessionName: string) => string | null;
  /**
   * Issue #1180 — the target seat's latest context-usage sample under its live
   * occupant generation (generation-guarded by the jobs repository). Null = no
   * usable sample; token/percent context jobs then tell their target once instead of firing.
   */
  resolveContextUsage?: (
    sessionName: string,
    occupantGeneration: string | null,
  ) => {
    usedTokens: number | null;
    usedPercentage: number | null;
    contextWindowSize: number | null;
    sampledAt: string | null;
    fresh: boolean;
  } | null;
  /** Last defense before transport for persisted jobs whose owning domain can
   *  prove they are no longer actionable. A reason terminals the job without
   *  delivering; null preserves the existing send path. */
  resolvePreDeliveryTerminalReason?: (input: { jobId: string }) => string | null;
  /** Queue-side observer for a wake attempt. It appends resume evidence to
   *  every HELD row armed to this job; delivery outcome is preserved. */
  resolveQueueWait?: (input: { jobId: string }) => PolicyEvaluation | null | undefined;
  onWakeAttempt?: (attempt: { jobId: string; deliveryStatus: string }) => void;
  /** The parked row a due reminder is about, when it may share one message with other reminders due for the same
   *  seat in the same scheduler pass. Null, or absent, keeps the reminder's own send. */
  resolveDigestEntry?: (input: { jobId: string; message: string }) => ParkReminderEntry | null;
}

/** The parked row an ordinary park reminder is about, with the current park's recorded continuation for its preview. */
export interface ParkReminderEntry {
  qitemId: string;
  summary: string | null;
  continuation?: string | null;
}

/** A due reminder whose send waits for the end of its scheduler pass, so reminders for one seat go as one message. */
interface HeldReminder {
  job: WatchdogJob;
  outcome: Extract<PolicyEvaluation, { action: "send" }>;
  evaluatedAt: string;
  occurrenceId: string;
  entry: ParkReminderEntry;
}

/** The reminders held during one scheduler pass; `deliverHeldReminders` sends them when the pass ends. */
export interface ReminderPass {
  held: HeldReminder[];
}

const PHASE_C_BUILTIN_POLICIES: ReadonlyArray<Policy> = [
  periodicReminderPolicy,
  artifactPoolReadyPolicy,
  edgeArtifactRequiredPolicy,
  contextUsageThresholdPolicy,
];

/**
 * Quiet skip reasons — POC `shouldAppendHistory` (engine.mjs:99-112)
 * suppresses these from history. Same set must NOT emit watchdog.*
 * events for parity with POC SSE behavior; agents never see scheduler
 * polls just because the pool was empty or the wake throttle was active.
 */
const QUIET_SKIP_REASONS = new Set<string>([
  "not_due",
  // Quiet hours: the window's release job while quiet is still on. Nothing changed, so no history row or event per minute.
  "quiet_hours_still_on",
  // A person's mode before its scheduled end (mode-scheduled-end): the same, for every minute it waits.
  "mode_end_not_yet",
  "queue_wait_already_presented",
  "queue_wait_owner_working",
  "workflow_healthy_deadline_gated",
  "workflow_recovery_owns_notice",
  "workflow_deadline_already_presented",
  "no_actionable_artifacts",
  "no_missing_edge_artifacts",
  "active_wake_not_due",
  "context_usage_below_threshold",
  "threshold_receipt_stable",
  // A context watch that already told its target it can't read the sample, and still can't: told once, not every scan.
  "context_sample_unreadable_notified",
  // OPR.0.4.3.16 idle-gate-qitem routine no-ops — analogues of
  // no_actionable_artifacts. Suppressed from history/SSE so a per-second
  // scan does not spam when there is simply nothing to wake about. The
  // audited signal is the WAKE (fired) path.
  "no_pending_gate",
  "seat_active",
  // OPR.0.5.8.1 S2 — the gated condition has not materially changed since the
  // wake that was already delivered for it. Quiet for the same reason as its
  // siblings: a 60s scan must not write a history row every minute. The
  // suppression stays derivable without one — the row itself remains visible in
  // the held/escalations views (this suppresses the WAKE, never the record),
  // and the job carries `last_fired_condition`, the exact condition it fired
  // for. Adding this string changes no throttle semantics and no other policy
  // emits it.
  "gate_condition_unchanged",
  // OPR.0.5.6.24 — the parked-owner consumer's clean-scan no-op: nothing
  // parked, nothing closed, nothing deferred. Suppressed so a routine rig
  // scan writes no history (the loud, audited signals are the SENT wake,
  // episode-ended, and all-parked-owners-deferred).
  "no-parked-owner",
  // OPR.0.4.3.16 rev1-r1 fixback (advisor ruling 2026-07-03): seat_needs_input
  // and activity_stale_unknown are the COMMON recurring states for this
  // policy's own target scenario — a gate qitem pending on a seat that has
  // gone stale/needs-input. Such a seat never becomes fresh-idle, so it never
  // hits the send throttle; left LOUD it emitted one history row + one SSE per
  // scan, UNBOUNDED, for as long as the gate stayed pending — contradicting the
  // slice's bounded/no-spam ACs (BR6/AC2). Quiet here suppresses the per-scan
  // history+SSE for these routine unwakeable states while the WAKE (send) path
  // — the signal operators actually need — stays LOUD/audited. Stuck-seat
  // visibility is served on-demand (pending gate qitems mapped to unwakeable
  // seats), NOT via a per-scan log.
  "seat_needs_input",
  "activity_stale_unknown",
]);

export interface EvaluationResult {
  job: WatchdogJob;
  outcome: PolicyEvaluation | { action: "skip"; reason: "active_wake_not_due" };
  history: WatchdogHistoryEntry | null;
  delivery: DeliveryOutcome | null;
  /** True if this evaluation produced a history record + event. */
  meaningful: boolean;
}

export class WatchdogPolicyEngine {
  private readonly jobsRepo: WatchdogJobsRepository;
  private readonly historyLog: WatchdogHistoryLog;
  private readonly eventBus: EventBus;
  private readonly deliver: DeliveryFn;
  private readonly parseSpec: PolicyContextParser;
  private readonly now: () => Date;
  private readonly policies: Map<string, Policy>;
  private readonly resolveTargetGeneration?: (sessionName: string) => string | null;
  private readonly resolveContextUsage?: WatchdogPolicyEngineDeps["resolveContextUsage"];
  private readonly resolvePreDeliveryTerminalReason?: (input: { jobId: string }) => string | null;
  private readonly resolveQueueWait?: WatchdogPolicyEngineDeps["resolveQueueWait"];
  private readonly onWakeAttempt?: (attempt: { jobId: string; deliveryStatus: string }) => void;
  private readonly resolveDigestEntry?: WatchdogPolicyEngineDeps["resolveDigestEntry"];

  constructor(deps: WatchdogPolicyEngineDeps) {
    this.jobsRepo = deps.jobsRepo;
    this.historyLog = deps.historyLog;
    this.eventBus = deps.eventBus;
    this.deliver = deps.deliver;
    this.resolveTargetGeneration = deps.resolveTargetGeneration;
    this.resolveContextUsage = deps.resolveContextUsage;
    this.resolvePreDeliveryTerminalReason = deps.resolvePreDeliveryTerminalReason;
    this.onWakeAttempt = deps.onWakeAttempt;
    this.resolveQueueWait = deps.resolveQueueWait;
    this.resolveDigestEntry = deps.resolveDigestEntry;
    this.parseSpec = deps.parseSpec ?? parseWatchdogSpec;
    this.now = deps.now ?? (() => new Date());
    this.policies = new Map();
    for (const p of PHASE_C_BUILTIN_POLICIES) this.policies.set(p.name, p);
    if (deps.additionalPolicies) {
      for (const p of deps.additionalPolicies) this.policies.set(p.name, p);
    }
  }

  resolvePolicy(name: string): Policy | undefined {
    return this.policies.get(name);
  }

  private inactiveJobResult(jobId: string): EvaluationResult | null {
    const job = this.jobsRepo.getByIdOrThrow(jobId);
    if (job.state === "active") return null;
    return {
      job,
      outcome: { action: "skip", reason: "job_not_active" },
      history: null,
      delivery: null,
      meaningful: false,
    };
  }

  async evaluate(job: WatchdogJob, evaluationPassStartedAt?: string, pass?: ReminderPass): Promise<EvaluationResult> {
    // A prior job's delivery may have yielded since the scheduler selected this row.
    const inactive = this.inactiveJobResult(job.jobId);
    if (inactive) return inactive;
    const policy = this.resolvePolicy(job.policy);
    const evaluatedAt = this.now().toISOString();
    const receiptCutoffAt = evaluationPassStartedAt ?? evaluatedAt;

    if (!policy) {
      const reason = `unknown_policy:${job.policy}`;
      this.jobsRepo.markTerminal(job.jobId, reason);
      const history = this.historyLog.record({
        jobId: job.jobId,
        evaluatedAt,
        outcome: "terminal",
        skipReason: reason,
      });
      this.eventBus.emit({
        type: "watchdog.evaluation_terminal",
        jobId: job.jobId,
        policy: job.policy,
        terminalReason: reason,
      });
      return {
        job: this.jobsRepo.getByIdOrThrow(job.jobId),
        outcome: { action: "terminal", reason },
        history,
        delivery: null,
        meaningful: true,
      };
    }

    const parsed = this.parseSpec(job.specYaml);
    const isContextUsageThreshold = job.policy === "context-usage-threshold";
    const target = watchdogJobTarget(job, parsed.target);
    const occupantGeneration = isContextUsageThreshold
      ? (this.resolveTargetGeneration?.(job.targetSession) ?? null)
      : null;
    let watchedFilePath = job.watchedFilePath;
    let currentGenerationTranscriptPending = false;
    // Issue #1180 — token/percent jobs measure the seat's sampled context use,
    // so only byte-gated jobs need a transcript-file binding.
    const byteGated = job.thresholdBytes != null;
    if (
      isContextUsageThreshold &&
      byteGated &&
      occupantGeneration &&
      job.watchedFileGeneration !== occupantGeneration
    ) {
      watchedFilePath = this.jobsRepo.findTranscriptPath(job.targetSession, occupantGeneration);
      if (watchedFilePath) {
        this.jobsRepo.recordWatchedFileBinding(job.jobId, watchedFilePath, occupantGeneration);
        this.historyLog.record({
          jobId: job.jobId,
          evaluatedAt,
          outcome: "skipped",
          skipReason: "watched_file_bound",
          evaluationNotes: {
            boundAt: evaluatedAt,
            occupantGeneration,
            watchedFilePath,
          },
        });
      } else {
        currentGenerationTranscriptPending = true;
      }
    }
    const requiredJob = job.requiresJobId ? this.jobsRepo.getById(job.requiresJobId) : null;
    const requiredReceiptGenerationMatched = occupantGeneration !== null &&
      requiredJob?.lastFiredGeneration === occupantGeneration;
    const requiredFireMs = Date.parse(requiredJob?.lastFireAt ?? "");
    const receiptCutoffMs = Date.parse(receiptCutoffAt);
    const receiptPredatesBoundary = evaluationPassStartedAt === undefined
      ? requiredFireMs <= receiptCutoffMs
      : requiredFireMs < receiptCutoffMs;
    const requiredReceiptSatisfied = !job.requiresJobId || (
      requiredReceiptGenerationMatched &&
      Number.isFinite(requiredFireMs) &&
      Number.isFinite(receiptCutoffMs) &&
      receiptPredatesBoundary
    );
    const requiredReceiptDeferred = Boolean(
      job.requiresJobId &&
      requiredReceiptGenerationMatched &&
      Number.isFinite(requiredFireMs) &&
      Number.isFinite(receiptCutoffMs) &&
      !receiptPredatesBoundary,
    );
    const policyJob: PolicyJob = {
      jobId: job.jobId,
      policy: job.policy,
      target,
      message: parsed.message ?? undefined,
      intervalSeconds: job.intervalSeconds,
      activeWakeIntervalSeconds: job.activeWakeIntervalSeconds,
      scanIntervalSeconds: job.scanIntervalSeconds,
      context: parsed.context,
      lastEvaluationAt: job.lastEvaluationAt,
      lastFireAt: job.lastFireAt,
      registeredBySession: job.registeredBySession,
      registeredAt: job.registeredAt,
      watchedFilePath,
      thresholdBytes: job.thresholdBytes,
      thresholdTokens: job.thresholdTokens,
      thresholdPercent: job.thresholdPercent,
      // Issue #1180 — sampled context use for the target seat under its live
      // occupant generation; only fetched for token/percent jobs.
      contextUsageSample: isContextUsageThreshold && !byteGated
        ? (this.resolveContextUsage?.(job.targetSession, occupantGeneration) ?? null)
        : null,
      requiresJobId: job.requiresJobId,
      lastFiredGeneration: job.lastFiredGeneration,
      lastFiredCondition: job.lastFiredCondition,
      occupantGeneration,
      currentGenerationTranscriptPending,
      requiredReceiptSatisfied,
      requiredReceiptDeferred,
    };

    const outcome = this.resolveQueueWait?.({ jobId: job.jobId }) ?? await policy.evaluate(policyJob);

    // Stop, park completion or seat handover may retire the job while its policy awaits I/O.
    // Discard every outcome before it can deliver or overwrite the retirement's state.
    const retired = this.inactiveJobResult(job.jobId);
    if (retired) return retired;

    if (outcome.action === "skip") {
      // POC parity: skip clears actionable. Loud-vs-quiet decides
      // whether to record + emit.
      this.jobsRepo.recordEvaluation(job.jobId, evaluatedAt, false);
      this.jobsRepo.setActionable(job.jobId, false, evaluatedAt);
      const isQuiet = QUIET_SKIP_REASONS.has(outcome.reason);
      if (isQuiet) {
        return {
          job: this.jobsRepo.getByIdOrThrow(job.jobId),
          outcome,
          history: null,
          delivery: null,
          meaningful: false,
        };
      }
      const history = this.historyLog.record({
        jobId: job.jobId,
        evaluatedAt,
        outcome: "skipped",
        skipReason: outcome.reason,
        evaluationNotes: outcome.notes ?? null,
      });
      this.eventBus.emit({
        type: "watchdog.evaluation_skipped",
        jobId: job.jobId,
        policy: job.policy,
        skipReason: outcome.reason,
      });
      return {
        job: this.jobsRepo.getByIdOrThrow(job.jobId),
        outcome,
        history,
        delivery: null,
        meaningful: true,
      };
    }

    if (outcome.action === "terminal") {
      this.jobsRepo.markTerminal(job.jobId, outcome.reason);
      const history = this.historyLog.record({
        jobId: job.jobId,
        evaluatedAt,
        outcome: "terminal",
        skipReason: outcome.reason,
        evaluationNotes: outcome.notes ?? null,
      });
      this.eventBus.emit({
        type: "watchdog.evaluation_terminal",
        jobId: job.jobId,
        policy: job.policy,
        terminalReason: outcome.reason,
      });
      return {
        job: this.jobsRepo.getByIdOrThrow(job.jobId),
        outcome,
        history,
        delivery: null,
        meaningful: true,
      };
    }

    // outcome.action === "send".
    // POC active-wake throttle (engine.mjs:49-64, :243-263):
    //   - If state.actionable was already true AND active_wake_interval
    //     is set AND wake-window has not elapsed → quiet skip. Preserves
    //     existing last_fire_at and last_actionable_at.
    //   - Otherwise: deliver, set actionable=true, stamp last_fire_at +
    //     last_actionable_at (preserve existing first-actionable timestamp).
    if (
      job.actionable &&
      job.activeWakeIntervalSeconds !== null &&
      job.lastFireAt !== null
    ) {
      const lastFireMs = Date.parse(job.lastFireAt);
      const nowMs = Date.parse(evaluatedAt);
      const intervalMs = job.activeWakeIntervalSeconds * 1000;
      if (Number.isFinite(lastFireMs) && nowMs - lastFireMs < intervalMs) {
        // Quiet skip: scan happened, pool still actionable, but the
        // wake window is closed. Update last_evaluation_at, do NOT
        // touch last_fire_at, keep actionable=true and preserve
        // last_actionable_at.
        this.jobsRepo.recordEvaluation(job.jobId, evaluatedAt, false);
        this.jobsRepo.setActionable(job.jobId, true, evaluatedAt, job.lastActionableAt);
        return {
          job: this.jobsRepo.getByIdOrThrow(job.jobId),
          outcome: { action: "skip", reason: "active_wake_not_due" },
          history: null,
          delivery: null,
          meaningful: false,
        };
      }
    }

    // (i-c) FIRE-TIME target-generation gate. A generation-bound wake (job.targetGeneration set) must
    // not fire at a target handed over to a DIFFERENT live generation since it was armed. Role-bound
    // jobs (null) skip the gate → fire unchanged. UNKNOWN live generation (null) fails OPEN → deliver
    // (the protective act is SKIPPING, so unknown never skips — note-2). Only a resolved MISMATCH
    // skips LOUD (loud reason → recorded + emitted), with a structured audit naming BOTH generations.
    if (job.targetGeneration !== null && this.resolveTargetGeneration) {
      const liveGeneration = this.resolveTargetGeneration(outcome.target.session);
      if (liveGeneration !== null && liveGeneration !== job.targetGeneration) {
        const reason = "target_generation_mismatch";
        this.jobsRepo.recordEvaluation(job.jobId, evaluatedAt, false);
        this.jobsRepo.setActionable(job.jobId, false, evaluatedAt);
        const history = this.historyLog.record({
          jobId: job.jobId,
          evaluatedAt,
          outcome: "skipped",
          skipReason: reason,
          evaluationNotes: {
            armedForGeneration: job.targetGeneration,
            liveGeneration,
            targetSession: outcome.target.session,
          },
        });
        this.eventBus.emit({
          type: "watchdog.evaluation_skipped",
          jobId: job.jobId,
          policy: job.policy,
          skipReason: reason,
        });
        return {
          job: this.jobsRepo.getByIdOrThrow(job.jobId),
          outcome: { action: "skip", reason },
          history,
          delivery: null,
          meaningful: true,
        };
      }
    }

    // OPR.0.5.8.1 S1c — current queue transitions retire park timers at every
    // exit. This narrow pre-transport guard handles only legacy persisted
    // residue, where the row is already terminal and no transition remains to
    // intercept. It runs after normal policy/throttle/generation decisions but
    // before any custody or message delivery side effect.
    const preDeliveryTerminal = this.terminalBeforeDelivery(job, evaluatedAt);
    if (preDeliveryTerminal) return preDeliveryTerminal;

    // A notice about the watch itself is not the threshold: no fire receipt and no continuity action.
    const thresholdFire = isContextUsageThreshold && !outcome.notice;
    const continuityAction = outcome.notice ? undefined : parseContinuityAction(
      parsed.context["continuity_action"],
      job,
      occupantGeneration,
    );

    const occurrence = [job.jobId, occupantGeneration, outcome.conditionReceipt ?? (job.policy === "periodic-reminder" ? job.lastFireAt : outcome.message)];
    const recurring = outcome.conditionReceipt === undefined && job.policy !== "periodic-reminder" && job.policy !== "context-usage-threshold";
    // Identify cadences for digest grouping and history, not transport deduplication.
    if (recurring && job.lastFireAt !== null) {
      occurrence.push(job.lastFireAt);
    }
    const occurrenceId = createHash("sha256").update(JSON.stringify(occurrence)).digest("hex");
    // A parked-row reminder due in a scheduler pass waits for the pass's end, when every reminder held for its seat
    // goes in one message. Nothing has changed for it yet, so a pass that stops early leaves it due.
    const digestEntry = job.policy === "periodic-reminder" && !continuityAction
      ? this.resolveDigestEntry?.({ jobId: job.jobId, message: outcome.message }) ?? null
      : null;
    if (pass && digestEntry) {
      pass.held.push({ job, outcome, evaluatedAt, occurrenceId, entry: digestEntry });
      return { job, outcome, history: null, delivery: null, meaningful: false };
    }
    // Outside a pass an ordinary park reminder still goes alone, with its continuation's preview.
    const message = digestEntry ? withContinuationPreview(outcome.message, digestEntry.qitemId, digestEntry.continuation) : outcome.message;

    // Plain wakes retain the proven at-most-once ordering. Structured
    // continuity custody is retry-safe by deterministic qitem id, so its
    // receipt waits until the durable action has completed.
    if (thresholdFire && occupantGeneration && !continuityAction) {
      this.jobsRepo.recordThresholdFire(job.jobId, occupantGeneration, evaluatedAt);
    }
    const deliverySchedule = this.jobsRepo.getByIdOrThrow(job.jobId);
    const delivery = await this.deliver(
      {
        targetSession: outcome.target.session,
        message,
        ...(continuityAction ? { continuityAction } : {}),
      },
      { jobId: job.jobId, policy: job.policy, occurrenceId },
    );
    if (
      isContextUsageThreshold &&
      occupantGeneration &&
      continuityAction &&
      delivery.continuityActionCompleted === true
    ) {
      this.jobsRepo.recordThresholdFire(job.jobId, occupantGeneration, evaluatedAt);
    }
    return this.recordAttempt({ job, outcome, evaluatedAt, deliverySchedule, delivery, isContextUsageThreshold: thresholdFire, notice: outcome.notice === true, sentMessage: message });
  }

  /** The pre-transport guard: a job its owning domain can prove is no longer actionable is terminaled, not sent. */
  private terminalBeforeDelivery(job: WatchdogJob, evaluatedAt: string): EvaluationResult | null {
    const preDeliveryTerminalReason = this.resolvePreDeliveryTerminalReason?.({ jobId: job.jobId });
    if (!preDeliveryTerminalReason) return null;
    this.jobsRepo.markTerminal(job.jobId, preDeliveryTerminalReason);
    const history = this.historyLog.record({
      jobId: job.jobId,
      evaluatedAt,
      outcome: "terminal",
      skipReason: preDeliveryTerminalReason,
    });
    this.eventBus.emit({
      type: "watchdog.evaluation_terminal",
      jobId: job.jobId,
      policy: job.policy,
      terminalReason: preDeliveryTerminalReason,
    });
    return {
      job: this.jobsRepo.getByIdOrThrow(job.jobId),
      outcome: { action: "terminal", reason: preDeliveryTerminalReason },
      history,
      delivery: null,
      meaningful: true,
    };
  }

  /** Send the reminders held during a scheduler pass: one message per seat holding two or more, each naming every row
   *  it covers, and a lone reminder exactly as it would have gone on its own. Every member keeps its own history,
   *  schedule and wake receipt, all from the one attempt. */
  async deliverHeldReminders(
    pass: ReminderPass,
    onError: (err: unknown) => void = (err) => { throw err; },
    shouldStop: () => boolean = () => false,
  ): Promise<void> {
    const bySeat = new Map<string, HeldReminder[]>();
    for (const held of pass.held) {
      const seat = held.outcome.target.session;
      bySeat.set(seat, [...(bySeat.get(seat) ?? []), held]);
    }
    pass.held = [];
    for (const [seat, group] of bySeat) {
      // A stop leaves every seat not yet started untouched, and still due.
      if (shouldStop()) return;
      try {
        await this.deliverHeldGroup(seat, group, shouldStop);
      } catch (err) {
        onError(err);
      }
    }
  }

  /** Re-check current job/park state before each call. Group current reminders; a receipt never replaces delivery.
   * A stop leaves every unstarted member due, while the call already in flight finishes and is accounted. */
  private async deliverHeldGroup(seat: string, group: HeldReminder[], shouldStop: () => boolean): Promise<void> {
    const finished = new Set<HeldReminder>();
    for (;;) {
      if (shouldStop()) return;
      const digest: HeldReminder[] = [];
      let alone: { held: HeldReminder; entry: ParkReminderEntry | null } | null = null;
      for (const held of group) {
        if (finished.has(held)) continue;
        if (this.inactiveJobResult(held.job.jobId) || this.terminalBeforeDelivery(held.job, held.evaluatedAt)) {
          finished.add(held);
          continue;
        }
        const current = this.resolveDigestEntry?.({ jobId: held.job.jobId, message: held.outcome.message }) ?? null;
        if (current) digest.push({ ...held, entry: current });
        else alone ??= { held, entry: current };
      }
      if (alone) {
        finished.add(alone.held);
        await this.deliverAlone(seat, alone.held, alone.entry);
        continue;
      }
      if (digest.length === 1) await this.deliverAlone(seat, digest[0]!, digest[0]!.entry);
      else if (digest.length > 1) await this.deliverDigest(seat, digest);
      return;
    }
  }

  private async deliverDigest(seat: string, digest: HeldReminder[]): Promise<void> {
    const schedules = digest.map((held) => this.jobsRepo.getByIdOrThrow(held.job.jobId));
    const members = digest.map((held) => ({ jobId: held.job.jobId, occurrenceId: held.occurrenceId }));
    const digestId = `digest-${createHash("sha256").update(JSON.stringify(members.map((m) => m.occurrenceId).sort())).digest("hex")}`;
    const lines = digest.map(({ entry }) => {
      const recorded = entry.continuation?.trim();
      return `- ${entry.qitemId}${entry.summary ? ` — ${entry.summary.replace(/\s+/g, " ")}` : ""}`
        + (recorded ? `\n  ${parkContinuationPreview(entry.qitemId, recorded)}` : "");
    });
    const message = [
      `Wake timers fired for ${digest.length} parked rows. Resume each row's recorded continuation and update it:`,
      ...lines,
      ...(digest.some(({ entry }) => entry.continuation?.trim()) ? [PARK_WAKE_GUIDANCE] : []),
    ].join("\n");
    const delivery = await this.deliver(
      { targetSession: seat, message },
      { jobId: digestId, policy: "periodic-reminder", occurrenceId: digestId, members },
    );
    digest.forEach((held, i) => this.recordAttempt({
      ...held, deliverySchedule: schedules[i]!, delivery, isContextUsageThreshold: false,
      digest: { deliveryId: digestId, size: digest.length, line: lines[i]! },
    }));
  }

  /** A held reminder sent on its own, exactly as `evaluate` would have sent it: an ordinary park reminder with its
   *  continuation's preview, anything else verbatim. */
  private async deliverAlone(seat: string, held: HeldReminder, entry: ParkReminderEntry | null): Promise<void> {
    const schedule = this.jobsRepo.getByIdOrThrow(held.job.jobId);
    const message = entry ? withContinuationPreview(held.outcome.message, entry.qitemId, entry.continuation) : held.outcome.message;
    const delivery = await this.deliver(
      { targetSession: seat, message },
      { jobId: held.job.jobId, policy: held.job.policy, occurrenceId: held.occurrenceId },
    );
    this.recordAttempt({ ...held, deliverySchedule: schedule, delivery, isContextUsageThreshold: false, sentMessage: message });
  }

  /** Audit one job's delivery attempt and advance its schedule, wake receipt and actionable state from it. */
  private recordAttempt(input: {
    job: WatchdogJob;
    outcome: Extract<PolicyEvaluation, { action: "send" }>;
    evaluatedAt: string;
    deliverySchedule: WatchdogJob;
    delivery: DeliveryOutcome;
    isContextUsageThreshold: boolean;
    /** A notice about the watch itself (PolicyEvaluation `notice`), not its condition firing. */
    notice?: boolean;
    /** Set when this job's reminder went out inside a digest with others: the digest, its size and this job's line. */
    digest?: { deliveryId: string; size: number; line: string };
    /** The text a lone send delivered, when it differs from the outcome's message (a park wake's continuation preview). */
    sentMessage?: string;
  }): EvaluationResult {
    const { job, outcome, evaluatedAt, deliverySchedule, delivery, isContextUsageThreshold, digest, sentMessage } = input;
    const notes = digest
      ? { ...(outcome.notes ?? {}), digestDeliveryId: digest.deliveryId, digestSize: digest.size }
      : outcome.notes;
    const deliveryNotes = delivery.inputPhase === undefined ? notes : { ...(notes ?? {}), deliveryInputPhase: delivery.inputPhase };
    const history = this.historyLog.record({
      jobId: job.jobId,
      evaluatedAt,
      outcome: delivery.status === "retained" ? "skipped" : delivery.status === "ok" ? "sent"
        : isRefusedInteractive(delivery.error) ? "refused" : "failed",
      skipReason: delivery.status === "retained" ? "typing_guard_retained" : null,
      deliveryTargetSession: outcome.target.session,
      deliveryStatus: delivery.status,
      deliveryMessage: digest?.line ?? delivery.sentMessage ?? sentMessage ?? outcome.message,
      // OPR.0.5.6.24 — the delivery error/reason string survives into the
      // durable record so a policy can distinguish an interactive-prompt
      // refusal from a generic failure (status alone discards that identity).
      evaluationNotes:
        delivery.error !== undefined
          ? { ...(deliveryNotes ?? {}), deliveryReason: delivery.error }
          : delivery.status === "retained" ? { ...(deliveryNotes ?? {}), outboxIds: delivery.outboxIds ?? [], retainedNotDelivered: true } : deliveryNotes ?? null,
    });
    // A notice stamps no fire time and leaves the job not actionable, so the active-wake throttle can't hold
    // back the watched condition's own send after it.
    if (input.notice) {
      this.jobsRepo.recordEvaluation(job.jobId, evaluatedAt, false);
    } else if (!isContextUsageThreshold) {
      this.jobsRepo.recordEvaluation(job.jobId, evaluatedAt, true, deliverySchedule);
    }
    // OPR.0.5.8.1 S2 — a policy's condition receipt is banked ONLY on positive
    // delivery. `status` is "ok" | "failed"; anything that is not a definite ok
    // leaves the receipt untouched so the next scan retries. A policy that does
    // not propose a receipt is untouched by this, so no other policy's
    // behaviour changes.
    if (outcome.conditionReceipt !== undefined && delivery.status === "ok") {
      this.jobsRepo.recordConditionReceipt(job.jobId, outcome.conditionReceipt);
    }
    if (input.notice) this.jobsRepo.setActionable(job.jobId, false, evaluatedAt);
    else this.jobsRepo.setActionable(job.jobId, true, evaluatedAt, job.lastActionableAt);
    this.eventBus.emit({
      type: "watchdog.evaluation_fired",
      jobId: job.jobId,
      policy: job.policy,
      targetSession: outcome.target.session,
      deliveryStatus: delivery.status,
    });
    // The history above audits the actual attempt. A newer park/blocker change
    // must not receive its receipt or be backed off as though we sent for it.
    const current = this.jobsRepo.getByIdOrThrow(job.jobId);
    if (current.state === "active" && current.specYaml === deliverySchedule.specYaml
      && current.intervalSeconds === deliverySchedule.intervalSeconds
      && (isContextUsageThreshold || current.lastEvaluationAt === evaluatedAt)) {
      this.onWakeAttempt?.({ jobId: job.jobId, deliveryStatus: delivery.status });
    }
    return {
      job: this.jobsRepo.getByIdOrThrow(job.jobId),
      outcome,
      history,
      delivery,
      meaningful: true,
    };
  }
}

function parseContinuityAction(
  raw: unknown,
  job: WatchdogJob,
  occupantGeneration: string | null,
): DeliveryRequest["continuityAction"] | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (value["type"] !== "create-cutover-baton") return undefined;
  if (
    !occupantGeneration ||
    typeof value["destination"] !== "string" ||
    typeof value["body"] !== "string"
  ) {
    throw new Error(`continuity_action_invalid: ${job.jobId}`);
  }
  return {
    type: "create-cutover-baton",
    jobId: job.jobId,
    occupantGeneration,
    sourceSession: job.targetSession,
    destination: value["destination"],
    body: value["body"],
  };
}

/** The seat a job is addressed to, before delivery resolves the name: a context-usage job measures and wakes its
 *  stored target; every other policy prefers its spec's `target:`. A seat swap compares the same value (#1775). */
export function watchdogJobTarget(
  job: { policy: string; targetSession: string },
  specTarget: { session: string } | null,
): { session: string } {
  return job.policy === "context-usage-threshold"
    ? { session: job.targetSession }
    : (specTarget ?? { session: job.targetSession });
}

/** Parse the operator-authored watchdog YAML before it reaches persistence. */
export function parseWatchdogSpec(specYaml: string): {
  target: { session: string } | null;
  message: string | null;
  context: Record<string, unknown>;
} {
  let parsed: unknown;
  try {
    parsed = parseYaml(specYaml);
  } catch (err) {
    throw new WatchdogJobsError(
      "spec_invalid",
      `watchdog spec has invalid YAML: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isRecord(parsed)) {
    throw new WatchdogJobsError("spec_invalid", "watchdog spec must be a YAML mapping");
  }

  const rawMessage = parsed["message"];
  if (rawMessage !== undefined && rawMessage !== null && typeof rawMessage !== "string") {
    throw new WatchdogJobsError("spec_invalid", "watchdog spec field 'message' must be a string");
  }

  const rawContext = parsed["context"];
  if (rawContext !== undefined && rawContext !== null && !isRecord(rawContext)) {
    throw new WatchdogJobsError("spec_invalid", "watchdog spec field 'context' must be a mapping");
  }
  const context = isRecord(rawContext) ? rawContext : {};
  if (
    context["message"] !== undefined &&
    context["message"] !== null &&
    typeof context["message"] !== "string"
  ) {
    throw new WatchdogJobsError("spec_invalid", "watchdog spec field 'context.message' must be a string");
  }

  const rawTarget = parsed["target"];
  let target: { session: string } | null = null;
  if (typeof rawTarget === "string") {
    target = { session: rawTarget };
  } else if (rawTarget !== undefined && rawTarget !== null) {
    if (!isRecord(rawTarget) || typeof rawTarget["session"] !== "string") {
      throw new WatchdogJobsError(
        "spec_invalid",
        "watchdog spec field 'target' must be a session string or mapping with string 'session'",
      );
    }
    target = { session: rawTarget["session"] };
  }

  return {
    target,
    message: typeof rawMessage === "string" ? rawMessage : null,
    context,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
