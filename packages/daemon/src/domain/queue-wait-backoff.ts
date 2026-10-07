import type Database from "better-sqlite3";
import { isDeepStrictEqual } from "node:util";
import { lastMeaningfulTransition, type WaitingView } from "./queue-waiting.js";
import type { PolicyEvaluation } from "./policies/types.js";
import { readSliceReadiness } from "./proof/judgments.js";
import type { WatchdogJob, WatchdogJobsRepository } from "./watchdog-jobs-repository.js";

interface WaitState {
  qitemId: string;
  blocker: string | null;
  blockerTransition: number | null;
  evidence: Record<string, unknown> | null;
  initialSeconds: number;
  maxSeconds: number;
  eventPending: boolean;
  attentionRevision?: string;
  notice?: { transition: number | null; attentionRevision?: string; at: string; deliveryStatus: string };
}

/** Opt-in to S01's explicit {scope, revision} input. The canonical reader owns
 * the answer; an event only asks for a fresh read and cannot author acceptance. */
function attentionRevision(evidence: Record<string, unknown> | null): string | undefined {
  const attention = evidence?.attention as { scope?: unknown; revision?: unknown } | undefined;
  return typeof attention?.scope === "string" && typeof attention.revision === "string"
    ? readSliceReadiness(attention.scope).attention.revision : undefined;
}

// Owned by the queue's atomic park, persisted on its existing watchdog job.
// Ordinary YAML watchdogs and one-shot park timers have no such metadata.
function readWait(job: WatchdogJob): { message: string; context: { queue_wait: WaitState } } | null {
  try {
    const spec = JSON.parse(job.specYaml);
    return spec.context?.queue_wait?.qitemId ? spec : null;
  } catch { return null; }
}

export function isQueueWait(specYaml: string): boolean {
  try { return Boolean(JSON.parse(specYaml).context?.queue_wait?.qitemId); }
  catch { return false; }
}

/**
 * Upgrade bridge (#860): builds predating the first-interval rule marked a
 * pending wake by writing a null lastEvaluationAt. Fresh arms always start
 * with eventPending false (and record an evaluation at registration), so a
 * null evaluation plus a pending event can only be pre-upgrade state — and
 * stays immediately due instead of waiting out a fresh first interval.
 */
export function isQueueWaitEventPending(specYaml: string): boolean {
  try { return JSON.parse(specYaml).context?.queue_wait?.eventPending === true; }
  catch { return false; }
}

/** The exact blocker owns progress signals. Ignore delivery receipts; do not
 * interpret its notes. Our own waiting acknowledgments are on a different row. */
function blockerTransition(db: Database.Database, blocker: string | null): number | null {
  if (!blocker?.startsWith("qitem-")) return null;
  return lastMeaningfulTransition(db, blocker)?.id ?? null;
}

export function armQueueWait(db: Database.Database, jobs: WatchdogJobsRepository, input: {
  previousJobId?: string;
  qitemId: string;
  blocker: string | null;
  evidence?: Record<string, unknown>;
  initialSeconds: number;
  maxSeconds: number;
  message: string;
  owner: string;
  actor: string;
}): WatchdogJob {
  const prior = input.previousJobId ? jobs.getById(input.previousJobId) : null;
  const old = prior?.state === "active" ? readWait(prior) : null;
  const state: WaitState = {
    qitemId: input.qitemId, blocker: input.blocker,
    blockerTransition: blockerTransition(db, input.blocker),
    evidence: input.evidence ?? old?.context.queue_wait.evidence ?? null,
    initialSeconds: input.initialSeconds, maxSeconds: input.maxSeconds, eventPending: false,
  };
  const revision = attentionRevision(state.evidence);
  if (revision !== undefined) state.attentionRevision = revision;
  const unchanged = old && isDeepStrictEqual({ ...old.context.queue_wait, eventPending: false, notice: undefined }, { ...state, notice: undefined });
  const specYaml = JSON.stringify({
    policy: "periodic-reminder", target: { session: input.owner }, message: input.message,
    context: { queue_wait: unchanged ? old.context.queue_wait : state },
  });
  if (prior && old && prior.targetSession === input.owner) {
    jobs.updateSchedule(prior.jobId, specYaml, unchanged ? prior.intervalSeconds : input.initialSeconds,
      unchanged ? prior.lastEvaluationAt : new Date().toISOString());
    return jobs.getByIdOrThrow(prior.jobId);
  }
  const job = jobs.register({ policy: "periodic-reminder", specYaml,
    targetSession: input.owner, intervalSeconds: input.initialSeconds, registeredBySession: input.actor });
  jobs.recordEvaluation(job.jobId, job.registeredAt, false);
  return job;
}

/** Event-first schedule update; also run once on startup to bridge an interrupted
 * event delivery. Replays compare durable transition identity and write nothing. */
export function refreshQueueWaits(db: Database.Database, jobs: WatchdogJobsRepository, changedQitem?: string, proofChanged = false): void {
  // ponytail: one scan of active watchdogs per queue event; index this metadata
  // if measured job volume makes the scan material. No second scheduler/store.
  for (const job of jobs.listActive()) {
    const spec = readWait(job);
    if (!spec) continue;
    const state = spec.context.queue_wait;
    if (changedQitem && state.blocker !== changedQitem) continue;
    const row = db.prepare("SELECT state, blocked_on FROM queue_items WHERE qitem_id = ?").get(state.qitemId) as { state: string; blocked_on: string | null } | undefined;
    if (!row || row.state !== "blocked" || row.blocked_on !== state.blocker) {
      const attached = db.prepare("SELECT 1 FROM queue_transition_wakes WHERE wake_ref = ? AND wake_kind = 'watchdog' LIMIT 1").get(job.jobId);
      if (!attached) jobs.markTerminal(job.jobId, "park_wait_ended");
      continue;
    }
    const current = blockerTransition(db, state.blocker);
    // File reads ride proof events and the authored timer's existing due point,
    // never an unconditional per-second filesystem scan.
    const due = !job.lastEvaluationAt || Date.now() - Date.parse(job.lastEvaluationAt) >= job.intervalSeconds * 1000;
    const revision = proofChanged || due ? attentionRevision(state.evidence) : state.attentionRevision;
    if (current === state.blockerTransition && revision === state.attentionRevision) continue;
    state.blockerTransition = current;
    state.attentionRevision = revision;
    state.eventPending = true;
    // Wake-now: a blocker change must wake the owner even inside the first
    // interval (#801 gives fresh reminders a full first interval, so null no
    // longer means due). Write the epoch, which is always due, instead.
    jobs.updateSchedule(job.jobId, JSON.stringify(spec), state.initialSeconds, new Date(0).toISOString());
  }
}

/** Called after the existing watchdog delivers. Event wakes restart the initial
 * interval; unchanged timer wakes double it. The queue packet never changes. */
export function backOffQueueWait(jobs: WatchdogJobsRepository, jobId: string, deliveryStatus?: string): boolean {
  const job = jobs.getById(jobId);
  const spec = job ? readWait(job) : null;
  if (!job || !spec) return false;
  const state = spec.context.queue_wait;
  const delay = state.eventPending ? state.initialSeconds : Math.min(job.intervalSeconds * 2, state.maxSeconds);
  if (deliveryStatus !== undefined) state.notice = { transition: state.blockerTransition, attentionRevision: state.attentionRevision, at: new Date().toISOString(), deliveryStatus };
  state.eventPending = false;
  jobs.updateSchedule(jobId, JSON.stringify(spec), delay, new Date().toISOString());
  return true;
}

/** One presentation per actual blocker transition. The existing stuck sweep owns
 * an unconsumed/failed notice after the pickup grace; the timer keeps reconciling
 * without replaying it or resetting that deadline. No receipt is task progress. */
export function evaluateQueueWait(jobs: WatchdogJobsRepository, jobId: string, view: WaitingView | null): PolicyEvaluation | null {
  const job = jobs.getById(jobId);
  const spec = job ? readWait(job) : null;
  if (!job || !spec) return null;
  const state = spec.context.queue_wait;
  if (!view || view.state !== "blocked" || (view.blocker?.ref ?? null) !== state.blocker) return { action: "terminal", reason: "park_wait_ended" };
  if (state.notice && state.notice.transition === state.blockerTransition && state.notice.attentionRevision === state.attentionRevision) {
    backOffQueueWait(jobs, jobId);
    return { action: "skip", reason: "queue_wait_already_presented" };
  }
  if (!state.eventPending && view.liveness.activity === "working" && view.liveness.needsInput.count === 0) {
    backOffQueueWait(jobs, jobId);
    return { action: "skip", reason: "queue_wait_owner_working" };
  }
  const reason = state.eventPending ? "Waiting source changed" : "Waiting backstop";
  return {
    action: "send", target: { session: view.owner },
    message: `${reason}: ${view.obligation}; blocker ${view.blocker?.ref ?? "unknown"} (owner ${view.blocker?.owner ?? "unknown"}).\nActivity: ${view.liveness.activity}; confidence: ${view.liveness.confidence}. Full packet: rig queue show ${view.obligation} --full.`,
    notes: { qitemId: view.obligation, blocker: state.blocker, transition: state.blockerTransition, attentionRevision: state.attentionRevision, cause: state.eventPending ? "waiting-source-change" : "wait-backstop", nextOwner: "queue-stuck-sweep" },
  };
}

export function queueWaitNotice(specYaml: string): WaitState["notice"] | undefined {
  try { return JSON.parse(specYaml).context?.queue_wait?.notice; } catch { return undefined; }
}

/** Rebind the existing authored timer when custody moves to another worker.
 * Returning to the waiting owner is handled by auto-unpark instead. */
export function retargetQueueWait(db: Database.Database, jobs: WatchdogJobsRepository, jobId: string, blocker: string): boolean {
  const job = jobs.getById(jobId);
  const spec = job ? readWait(job) : null;
  if (!job || !spec) return false;
  Object.assign(spec.context.queue_wait, { blocker, blockerTransition: blockerTransition(db, blocker), eventPending: true, notice: undefined });
  // Wake-now on custody move: epoch is always due, unlike null (#801).
  jobs.updateSchedule(jobId, JSON.stringify(spec), spec.context.queue_wait.initialSeconds, new Date(0).toISOString());
  return true;
}
