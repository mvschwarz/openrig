import { parse as parseYaml, parseDocument } from "yaml";
import { artifactPoolListProblem, type ArtifactPoolSpec } from "./policies/artifact-pool-helpers.js";
import { edgeArtifactRequiredSpecProblem } from "./policies/edge-artifact-required.js";
import { periodicReminderSpecProblem } from "./policies/periodic-reminder.js";
import { workflowKeepaliveSpecProblem } from "./policies/workflow-keepalive.js";
import { isQueueWait, retuneQueueWait } from "./queue-wait-backoff.js";
import { nextDueAt } from "./watchdog-due.js";
import {
  validateCadences,
  WatchdogJobsError,
  type WatchdogJob,
  type WatchdogJobsRepository,
} from "./watchdog-jobs-repository.js";
import { parseWatchdogSpec, watchdogJobTarget } from "./watchdog-policy-engine.js";

/** The policies a caller registers through `rig watchdog register`. The others compute their own schedule. */
const UPDATABLE_POLICIES = new Set([
  "periodic-reminder",
  "artifact-pool-ready",
  "edge-artifact-required",
  "workflow-keepalive",
  "idle-gate-qitem",
  "context-usage-threshold",
]);

/** The session the daemon registers its own jobs as (continuity and auto idle-gate watchdogs). */
const DAEMON_REGISTRANT = "daemon@kernel";

export interface WatchdogJobUpdate {
  intervalSeconds?: unknown;
  message?: unknown;
  specYaml?: unknown;
}

export interface WatchdogJobUpdateResult {
  job: WatchdogJob;
  changed: string[];
  /** When the scheduler next evaluates the job; null when it has no recorded evaluation to measure from. */
  nextDueAt: string | null;
  dueNow: boolean;
  intervalEffect: string | null;
}

/** What each policy's own evaluation requires of a spec (its own check), applied before a spec is stored. */
const SPEC_PROBLEMS: Record<string, (spec: ReturnType<typeof parseWatchdogSpec>) => string | null | undefined> = {
  "periodic-reminder": (spec) => periodicReminderSpecProblem(spec)?.message,
  "edge-artifact-required": (spec) => edgeArtifactRequiredSpecProblem(spec)?.message,
  "artifact-pool-ready": (spec) => artifactPoolListProblem(spec.context["pools"] as ArtifactPoolSpec | ArtifactPoolSpec[] | undefined),
  "workflow-keepalive": (spec) => workflowKeepaliveSpecProblem(spec)?.message,
};
function specProblem(policy: string, parsed: ReturnType<typeof parseWatchdogSpec>): string | null {
  return SPEC_PROBLEMS[policy]?.(parsed) ?? null;
}

function storedTarget(job: WatchdogJob): string {
  try { return watchdogJobTarget(job, parseWatchdogSpec(job.specYaml).target).session; }
  catch { return job.targetSession; }
}

/** `message` set on the spec's top-level mapping; the rest of the text, comments included, is left as written. */
function withMessage(specYaml: string, message: string): string {
  const doc = parseDocument(specYaml);
  if (doc.errors.length > 0 || !doc.contents || typeof doc.toJS() !== "object" || Array.isArray(doc.toJS())) {
    throw new WatchdogJobsError("spec_invalid", "the stored watchdog spec is not a YAML mapping, so a message cannot be set on it");
  }
  doc.set("message", message);
  return String(doc);
}

function explainInterval(job: WatchdogJob, dueMs: number | null, nowMs: number): string {
  if (dueMs === null) {
    return `The job has no recorded evaluation to measure ${job.intervalSeconds}s from, so the scheduler evaluates it on its next pass.`;
  }
  const basis = job.lastEvaluationAt
    ? `last evaluation ${job.lastEvaluationAt}`
    : `registration ${job.registeredAt} (it has not been evaluated yet)`;
  const when = new Date(dueMs).toISOString();
  return `Takes effect now, measured from ${basis}: next evaluation ${when} (${job.intervalSeconds}s later)` +
    (dueMs <= nowMs ? "; that time has passed, so the scheduler evaluates it on its next pass." : ".");
}

/**
 * Change an active watchdog job's interval, spec or message in place. The job is rewritten through the existing
 * schedule writer (`updateInPlace`) with its stored last evaluation passed back unchanged, so nothing about when it last ran is
 * invented or lost. Every refusal happens before any write.
 */
export function updateWatchdogJob(
  jobs: WatchdogJobsRepository,
  jobId: string,
  input: WatchdogJobUpdate,
  now: () => Date = () => new Date(),
): WatchdogJobUpdateResult {
  const job = jobs.getByIdOrThrow(jobId);
  if (job.state === "terminal") {
    throw new WatchdogJobsError("job_terminal", `cannot update watchdog job ${jobId}: state is terminal`, { jobId, state: job.state });
  }
  if (job.state === "stopped") {
    throw new WatchdogJobsError(
      "job_stopped",
      `cannot update watchdog job ${jobId}: it is stopped, and an update does not restart it; register a new job to run it again`,
      { jobId, state: job.state },
    );
  }
  const { intervalSeconds, message, specYaml } = input;
  if (intervalSeconds === undefined && message === undefined && specYaml === undefined) {
    throw new WatchdogJobsError("nothing_to_update", "give at least one of intervalSeconds, message or specYaml");
  }
  if (job.registeredBySession === DAEMON_REGISTRANT) {
    throw new WatchdogJobsError(
      "policy_not_updatable",
      `watchdog job ${jobId} was registered by the daemon, which overwrites or replaces its own jobs, so an edit would be lost or change the id`,
      { jobId, registeredBySession: job.registeredBySession },
    );
  }
  if (!UPDATABLE_POLICIES.has(job.policy)) {
    throw new WatchdogJobsError(
      "policy_not_updatable",
      `watchdog job ${jobId} runs the daemon's own ${job.policy} timing, which an update would only fight`,
      { jobId, policy: job.policy },
    );
  }
  let newInterval = job.intervalSeconds;
  if (intervalSeconds !== undefined) {
    validateCadences({ intervalSeconds: intervalSeconds as number });
    if (job.scanIntervalSeconds !== null) {
      throw new WatchdogJobsError(
        "interval_not_effective",
        `watchdog job ${jobId} runs on its scan interval (${job.scanIntervalSeconds}s), so changing interval_seconds would not change when it runs`,
        { jobId, scanIntervalSeconds: job.scanIntervalSeconds },
      );
    }
    newInterval = intervalSeconds as number;
  }
  const queueWait = isQueueWait(job.specYaml);
  let newSpec = job.specYaml;
  if (message !== undefined || specYaml !== undefined) {
    if (queueWait) {
      throw new WatchdogJobsError(
        "spec_not_updatable",
        `watchdog job ${jobId} is a queue wait; its spec holds the queue's packet and what it has delivered, so only its interval can change`,
        { jobId },
      );
    }
    if (job.policy === "context-usage-threshold" && specYaml !== undefined) {
      throw new WatchdogJobsError(
        "spec_not_updatable",
        `watchdog job ${jobId} keeps its thresholds outside the spec; only its message and interval can change`,
        { jobId },
      );
    }
    if (specYaml !== undefined && typeof specYaml !== "string") {
      throw new WatchdogJobsError("spec_invalid", "specYaml must be a string");
    }
    if (message !== undefined && (typeof message !== "string" || !message.trim())) {
      throw new WatchdogJobsError("spec_invalid", "message must be a non-empty string");
    }
    newSpec = (specYaml as string | undefined) ?? job.specYaml;
    if (message !== undefined) newSpec = withMessage(newSpec, message as string);
    const parsed = parseWatchdogSpec(newSpec);
    const named = (parseYaml(newSpec) as Record<string, unknown>)["policy"];
    if (typeof named === "string" && named !== job.policy) {
      throw new WatchdogJobsError("spec_invalid", `the spec names policy ${named}, but this job runs ${job.policy}; a job's policy cannot change`, { jobId, policy: job.policy });
    }
    const problem = specProblem(job.policy, parsed);
    if (problem) throw new WatchdogJobsError("spec_invalid", `watchdog spec is not valid for ${job.policy}: ${problem}`, { jobId, policy: job.policy });
    const target = watchdogJobTarget(job, parsed.target).session;
    if (target !== storedTarget(job)) {
      throw new WatchdogJobsError(
        "target_not_updatable",
        `the spec would deliver to ${target}, but this job delivers to ${storedTarget(job)}; a job's target cannot change`,
        { jobId, target, current: storedTarget(job) },
      );
    }
  }
  if (queueWait && intervalSeconds !== undefined) newSpec = retuneQueueWait(newSpec, newInterval);

  // A wait's retuned settings live in its spec, so an interval it already has can still change what is stored.
  const retuned = queueWait && intervalSeconds !== undefined && newSpec !== job.specYaml;
  const changed = [
    ...(newInterval !== job.intervalSeconds || retuned ? ["intervalSeconds"] : []),
    ...((message !== undefined || specYaml !== undefined) && newSpec !== job.specYaml ? ["specYaml"] : []),
  ];
  if (newInterval !== job.intervalSeconds || newSpec !== job.specYaml) {
    jobs.updateInPlace(jobId, newSpec, newInterval, job.lastEvaluationAt);
  }
  const updated = jobs.getByIdOrThrow(jobId);
  const nowMs = now().getTime();
  const dueMs = nextDueAt(updated);
  return {
    job: updated,
    changed,
    nextDueAt: dueMs === null ? null : new Date(dueMs).toISOString(),
    dueNow: dueMs === null || dueMs <= nowMs,
    intervalEffect: intervalSeconds === undefined ? null : explainInterval(updated, dueMs, nowMs),
  };
}
