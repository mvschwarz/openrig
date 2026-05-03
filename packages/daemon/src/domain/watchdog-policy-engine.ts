import type { EventBus } from "./event-bus.js";
import type { Policy, PolicyEvaluation, PolicyJob } from "./policies/types.js";
import { artifactPoolReadyPolicy } from "./policies/artifact-pool-ready.js";
import { edgeArtifactRequiredPolicy } from "./policies/edge-artifact-required.js";
import { periodicReminderPolicy } from "./policies/periodic-reminder.js";
import {
  type WatchdogJob,
  type WatchdogJobsRepository,
} from "./watchdog-jobs-repository.js";
import type { WatchdogHistoryEntry, WatchdogHistoryLog } from "./watchdog-history-log.js";

/**
 * Watchdog policy engine (PL-004 Phase C).
 *
 * Owns:
 *   1. Policy resolution by name (registry).
 *   2. spec_yaml → context parse for the policy.
 *   3. Dispatch evaluate(job) → PolicyEvaluation.
 *   4. For action=send: invoke delivery callback, record history,
 *      emit watchdog.evaluation_fired.
 *   5. For action=skip: record history, emit watchdog.evaluation_skipped.
 *   6. For action=terminal: mark job terminal, record history, emit
 *      watchdog.evaluation_terminal.
 *
 * The actual delivery is injected as a callback so tests can stub it
 * and so the daemon supervision tree can wire it to SessionTransport
 * without this module needing a concrete dependency.
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
  /** Parse the operator-supplied spec_yaml into the `context:` block. */
  (specYaml: string): Record<string, unknown>;
}

interface WatchdogPolicyEngineDeps {
  jobsRepo: WatchdogJobsRepository;
  historyLog: WatchdogHistoryLog;
  eventBus: EventBus;
  deliver: DeliveryFn;
  /** Optional override: defaults to a YAML-aware parser. */
  parseContext?: PolicyContextParser;
  now?: () => Date;
}

const POLICY_REGISTRY: Map<string, Policy> = new Map([
  [periodicReminderPolicy.name, periodicReminderPolicy],
  [artifactPoolReadyPolicy.name, artifactPoolReadyPolicy],
  [edgeArtifactRequiredPolicy.name, edgeArtifactRequiredPolicy],
]);

export interface EvaluationResult {
  job: WatchdogJob;
  outcome: PolicyEvaluation;
  history: WatchdogHistoryEntry | null;
  delivery: DeliveryOutcome | null;
}

export class WatchdogPolicyEngine {
  private readonly jobsRepo: WatchdogJobsRepository;
  private readonly historyLog: WatchdogHistoryLog;
  private readonly eventBus: EventBus;
  private readonly deliver: DeliveryFn;
  private readonly parseContext: PolicyContextParser;
  private readonly now: () => Date;

  constructor(deps: WatchdogPolicyEngineDeps) {
    this.jobsRepo = deps.jobsRepo;
    this.historyLog = deps.historyLog;
    this.eventBus = deps.eventBus;
    this.deliver = deps.deliver;
    this.parseContext = deps.parseContext ?? defaultParseContext;
    this.now = deps.now ?? (() => new Date());
  }

  resolvePolicy(name: string): Policy | undefined {
    return POLICY_REGISTRY.get(name);
  }

  /**
   * Evaluate one watchdog job. Side-effects: history record (for
   * meaningful outcomes), event emission, and (on send) delivery.
   *
   * Pure `not_due` decisions are NOT this engine's concern; the
   * scheduler decides dueness and only calls evaluate for due jobs.
   * If the policy itself returns skip with an internal reason
   * (no_actionable_artifacts, etc.) we DO record that.
   */
  async evaluate(job: WatchdogJob): Promise<EvaluationResult> {
    const policy = this.resolvePolicy(job.policy);
    if (!policy) {
      const reason = `unknown_policy:${job.policy}`;
      this.jobsRepo.markTerminal(job.jobId, reason);
      const evaluatedAt = this.now().toISOString();
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
      };
    }

    const context = this.parseContext(job.specYaml);
    const policyJob: PolicyJob = {
      jobId: job.jobId,
      policy: job.policy,
      targetSession: job.targetSession,
      intervalSeconds: job.intervalSeconds,
      activeWakeIntervalSeconds: job.activeWakeIntervalSeconds,
      scanIntervalSeconds: job.scanIntervalSeconds,
      context,
      lastEvaluationAt: job.lastEvaluationAt,
      lastFireAt: job.lastFireAt,
      registeredBySession: job.registeredBySession,
      registeredAt: job.registeredAt,
    };

    const outcome = await policy.evaluate(policyJob);
    const evaluatedAt = this.now().toISOString();

    if (outcome.action === "send") {
      const delivery = await this.deliver({
        targetSession: outcome.target,
        message: outcome.message,
      });
      const history = this.historyLog.record({
        jobId: job.jobId,
        evaluatedAt,
        outcome: "sent",
        deliveryTargetSession: outcome.target,
        deliveryStatus: delivery.status,
        deliveryMessage: outcome.message,
        evaluationNotes: outcome.notes ?? null,
      });
      this.jobsRepo.recordEvaluation(job.jobId, evaluatedAt, true);
      this.eventBus.emit({
        type: "watchdog.evaluation_fired",
        jobId: job.jobId,
        policy: job.policy,
        targetSession: outcome.target,
        deliveryStatus: delivery.status,
      });
      return {
        job: this.jobsRepo.getByIdOrThrow(job.jobId),
        outcome,
        history,
        delivery,
      };
    }

    if (outcome.action === "skip") {
      const history = this.historyLog.record({
        jobId: job.jobId,
        evaluatedAt,
        outcome: "skipped",
        skipReason: outcome.reason,
        evaluationNotes: outcome.notes ?? null,
      });
      this.jobsRepo.recordEvaluation(job.jobId, evaluatedAt, false);
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
      };
    }

    // terminal
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
    };
  }
}

/**
 * Default spec_yaml parser. Extracts the `context:` block as a
 * generic Record<string, unknown>. Uses a minimal recursive
 * indentation-based parser sufficient for the POC spec shape:
 *   policy: ...
 *   target: <member>@<rig>
 *   interval_seconds: 1800
 *   context:
 *     target:
 *       session: ...
 *     message: "..."
 *     pools:
 *       - path: /abs/...
 *         include_statuses: [ready]
 *
 * For robust YAML, a future maintenance pass can swap in `yaml` or
 * `js-yaml`; the POC schemas are simple enough that this parser
 * handles them in-tree without an extra dependency.
 */
function defaultParseContext(specYaml: string): Record<string, unknown> {
  const lines = specYaml.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (/^context\s*:\s*$/.test(line)) {
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
      // Strip leading two-space indent to make it a top-level YAML doc.
      const dedented = block
        .map((l) => (l.startsWith("  ") ? l.slice(2) : l))
        .join("\n");
      return parseSimpleYaml(dedented) as Record<string, unknown>;
    }
    i++;
  }
  return {};
}

/**
 * Minimal indentation-aware YAML parser. Supports nested mappings,
 * inline `[a, b]` arrays, dash-prefixed sequences of mappings, and
 * scalar string values (quoted or unquoted). Sufficient for the POC
 * spec set; not a general YAML implementation.
 */
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
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1);
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1);
  return trimmed;
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
      // Nested block: probe next line indent.
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
      // First key of an inline mapping element. Synthesize a virtual
      // sub-block by re-injecting the rest as a key + scanning further
      // lines at deeper indent.
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
      // Continue gathering same-element keys at indent blockIndent + 2.
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
