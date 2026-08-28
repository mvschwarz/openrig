import type { EventBus } from "./event-bus.js";
import type { Policy, PolicyEvaluation, PolicyJob } from "./policies/types.js";
import { artifactPoolReadyPolicy } from "./policies/artifact-pool-ready.js";
import { edgeArtifactRequiredPolicy } from "./policies/edge-artifact-required.js";
import { periodicReminderPolicy } from "./policies/periodic-reminder.js";
import { contextUsageThresholdPolicy } from "./policies/context-usage-threshold.js";
import {
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
}

export interface DeliveryOutcome {
  status: "ok" | "failed";
  error?: string;
}

export type DeliveryFn = (req: DeliveryRequest) => Promise<DeliveryOutcome>;

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
  /** Queue-side observer for a wake attempt. It appends resume evidence to
   *  every HELD row armed to this job; delivery outcome is preserved. */
  onWakeAttempt?: (attempt: { jobId: string; deliveryStatus: string }) => void;
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
  "no_actionable_artifacts",
  "no_missing_edge_artifacts",
  "active_wake_not_due",
  "context_usage_below_threshold",
  "threshold_receipt_stable",
  // OPR.0.4.3.16 idle-gate-qitem routine no-ops — analogues of
  // no_actionable_artifacts. Suppressed from history/SSE so a per-second
  // scan does not spam when there is simply nothing to wake about. The
  // audited signal is the WAKE (fired) path.
  "no_pending_gate",
  "seat_active",
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
  private readonly onWakeAttempt?: (attempt: { jobId: string; deliveryStatus: string }) => void;

  constructor(deps: WatchdogPolicyEngineDeps) {
    this.jobsRepo = deps.jobsRepo;
    this.historyLog = deps.historyLog;
    this.eventBus = deps.eventBus;
    this.deliver = deps.deliver;
    this.resolveTargetGeneration = deps.resolveTargetGeneration;
    this.onWakeAttempt = deps.onWakeAttempt;
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

  async evaluate(job: WatchdogJob, evaluationPassStartedAt?: string): Promise<EvaluationResult> {
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
    const target = isContextUsageThreshold
      ? { session: job.targetSession }
      : (parsed.target ?? { session: job.targetSession });
    const occupantGeneration = isContextUsageThreshold
      ? (this.resolveTargetGeneration?.(job.targetSession) ?? null)
      : null;
    let watchedFilePath = job.watchedFilePath;
    let currentGenerationTranscriptPending = false;
    if (
      isContextUsageThreshold &&
      occupantGeneration &&
      job.watchedFileGeneration !== occupantGeneration
    ) {
      watchedFilePath = this.jobsRepo.findTranscriptPath(job.targetSession, occupantGeneration);
      if (watchedFilePath) {
        this.jobsRepo.recordWatchedFileBinding(job.jobId, watchedFilePath, occupantGeneration);
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
      requiresJobId: job.requiresJobId,
      lastFiredGeneration: job.lastFiredGeneration,
      occupantGeneration,
      currentGenerationTranscriptPending,
      requiredReceiptSatisfied,
      requiredReceiptDeferred,
    };

    const outcome = await policy.evaluate(policyJob);

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

    // Match the proven hook's at-most-once ordering: persist the durable
    // generation receipt before crossing the external delivery boundary.
    // A daemon restart after delivery must never repeat the threshold action.
    if (isContextUsageThreshold && occupantGeneration) {
      this.jobsRepo.recordThresholdFire(job.jobId, occupantGeneration, evaluatedAt);
    }
    const delivery = await this.deliver({
      targetSession: outcome.target.session,
      message: outcome.message,
    });
    const history = this.historyLog.record({
      jobId: job.jobId,
      evaluatedAt,
      outcome: "sent",
      deliveryTargetSession: outcome.target.session,
      deliveryStatus: delivery.status,
      deliveryMessage: outcome.message,
      evaluationNotes: outcome.notes ?? null,
    });
    if (!isContextUsageThreshold) {
      this.jobsRepo.recordEvaluation(job.jobId, evaluatedAt, true);
    }
    this.jobsRepo.setActionable(job.jobId, true, evaluatedAt, job.lastActionableAt);
    this.eventBus.emit({
      type: "watchdog.evaluation_fired",
      jobId: job.jobId,
      policy: job.policy,
      targetSession: outcome.target.session,
      deliveryStatus: delivery.status,
    });
    this.onWakeAttempt?.({ jobId: job.jobId, deliveryStatus: delivery.status });
    return {
      job: this.jobsRepo.getByIdOrThrow(job.jobId),
      outcome,
      history,
      delivery,
      meaningful: true,
    };
  }
}

/**
 * Default spec_yaml parser. Extracts:
 *   - top-level `target:` block (POC contract: `{session: "..."}`)
 *   - top-level `message:` scalar (POC pattern for periodic-reminder)
 *   - nested `context:` block as Record<string, unknown>
 *
 * Uses a minimal recursive indentation-based parser sufficient for the
 * POC spec set:
 *   policy: ...
 *   target:
 *     session: ...
 *   message: "..."
 *   interval_seconds: 1800
 *   context:
 *     pools:
 *       - path: /abs/...
 *         include_statuses: [ready]
 *
 * For richer YAML, a future maintenance pass can swap in `yaml` /
 * `js-yaml`; the POC schemas are simple enough that this parser
 * handles them in-tree without an extra dependency.
 */
export function parseWatchdogSpec(specYaml: string): {
  target: { session: string } | null;
  message: string | null;
  context: Record<string, unknown>;
} {
  const lines = specYaml.split("\n");
  const result: { target: { session: string } | null; message: string | null; context: Record<string, unknown> } = {
    target: null,
    message: null,
    context: {},
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trimStart() !== line) {
      // Indented line at top level — skip until we re-hit indent 0.
      i++;
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      i++;
      continue;
    }
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) {
      i++;
      continue;
    }
    const key = trimmed.slice(0, colonIdx).trim();
    const value = trimmed.slice(colonIdx + 1).trim();
    if (value.length > 0) {
      // Inline scalar.
      if (key === "message") {
        result.message = stripQuotes(value);
      }
      i++;
      continue;
    }
    // Block. Collect indented lines below.
    i++;
    const block: string[] = [];
    while (i < lines.length) {
      const sub = lines[i] ?? "";
      if (sub.length === 0) {
        block.push(sub);
        i++;
        continue;
      }
      if (sub.startsWith(" ") || sub.startsWith("\t")) {
        block.push(sub);
        i++;
        continue;
      }
      break;
    }
    const dedented = block.map((l) => (l.startsWith("  ") ? l.slice(2) : l)).join("\n");
    if (key === "context") {
      result.context = parseSimpleYaml(dedented) as Record<string, unknown>;
    } else if (key === "target") {
      const parsed = parseSimpleYaml(dedented);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const sess = (parsed as Record<string, unknown>).session;
        if (typeof sess === "string") result.target = { session: sess };
      }
    }
  }
  return result;
}

function stripQuotes(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value;
}

function parseSimpleYaml(src: string): unknown {
  const lines = src.split("\n").filter((l) => l.trim().length > 0 && !l.trim().startsWith("#"));
  const idx = { i: 0 };
  return parseYamlBlock(lines, idx, 0);
}

function indentOf(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === " ") n++;
  return n;
}

function parseScalar(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "null" || trimmed === "~") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+$/.test(trimmed)) return Number.parseInt(trimmed, 10);
  if (/^-?\d+\.\d+$/.test(trimmed)) return Number.parseFloat(trimmed);
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((p) => parseScalar(p));
  }
  return stripQuotes(trimmed);
}

function parseYamlBlock(lines: string[], idx: { i: number }, expectedIndent: number): unknown {
  if (idx.i >= lines.length) return null;
  const first = lines[idx.i] ?? "";
  const firstIndent = indentOf(first);
  if (firstIndent < expectedIndent) return null;
  const trimmed = first.trim();
  if (trimmed.startsWith("- ")) {
    return parseYamlSeq(lines, idx, firstIndent);
  }
  return parseYamlMap(lines, idx, firstIndent);
}

function parseYamlMap(
  lines: string[],
  idx: { i: number },
  blockIndent: number,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  while (idx.i < lines.length) {
    const line = lines[idx.i] ?? "";
    const ind = indentOf(line);
    if (ind < blockIndent) break;
    if (ind > blockIndent) break;
    const trimmed = line.trim();
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) break;
    const key = trimmed.slice(0, colonIdx).trim();
    const valuePart = trimmed.slice(colonIdx + 1).trim();
    idx.i++;
    if (valuePart.length > 0) {
      result[key] = parseScalar(valuePart);
    } else {
      if (idx.i < lines.length) {
        const next = lines[idx.i] ?? "";
        const nextIndent = indentOf(next);
        if (nextIndent > blockIndent) {
          result[key] = parseYamlBlock(lines, idx, nextIndent);
          continue;
        }
      }
      result[key] = null;
    }
  }
  return result;
}

function parseYamlSeq(
  lines: string[],
  idx: { i: number },
  blockIndent: number,
): unknown[] {
  const result: unknown[] = [];
  while (idx.i < lines.length) {
    const line = lines[idx.i] ?? "";
    const ind = indentOf(line);
    if (ind < blockIndent) break;
    if (ind > blockIndent) break;
    const trimmed = line.trim();
    if (!trimmed.startsWith("- ")) break;
    const rest = trimmed.slice(2).trim();
    idx.i++;
    if (rest.includes(":")) {
      const colonIdx = rest.indexOf(":");
      const k = rest.slice(0, colonIdx).trim();
      const v = rest.slice(colonIdx + 1).trim();
      const elem: Record<string, unknown> = {};
      if (v.length > 0) {
        elem[k] = parseScalar(v);
      } else if (idx.i < lines.length && indentOf(lines[idx.i] ?? "") > blockIndent + 2) {
        elem[k] = parseYamlBlock(lines, idx, indentOf(lines[idx.i] ?? ""));
      } else {
        elem[k] = null;
      }
      while (idx.i < lines.length) {
        const sub = lines[idx.i] ?? "";
        const subIndent = indentOf(sub);
        if (subIndent !== blockIndent + 2) break;
        const subTrim = sub.trim();
        if (subTrim.startsWith("- ")) break;
        const sCol = subTrim.indexOf(":");
        if (sCol === -1) break;
        const sk = subTrim.slice(0, sCol).trim();
        const sv = subTrim.slice(sCol + 1).trim();
        idx.i++;
        if (sv.length > 0) {
          elem[sk] = parseScalar(sv);
        } else if (idx.i < lines.length && indentOf(lines[idx.i] ?? "") > blockIndent + 2) {
          elem[sk] = parseYamlBlock(lines, idx, indentOf(lines[idx.i] ?? ""));
        } else {
          elem[sk] = null;
        }
      }
      result.push(elem);
    } else {
      result.push(parseScalar(rest));
    }
  }
  return result;
}
