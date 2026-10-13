import type { WatchdogJob } from "./watchdog-jobs-repository.js";

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

/**
 * When the scheduler next evaluates a job, in epoch milliseconds, or null
 * when it is due now. The scheduler's `isDue` and the waiting view's
 * projected wake both read it, so the projection can't drift from the
 * schedule. It has no domain imports, so either can use it.
 */
export function nextDueAt(
  job: Pick<WatchdogJob, "policy" | "specYaml" | "registeredAt" | "intervalSeconds" | "scanIntervalSeconds" | "lastEvaluationAt">,
): number | null {
  const cadenceMs = (job.scanIntervalSeconds ?? job.intervalSeconds) * 1000;
  if (!job.lastEvaluationAt) {
    // #801: a periodic reminder with no evaluation yet measures its first
    // interval from registration, so it waits a full interval instead of
    // firing on the scheduler's first scan. Every other policy keeps the
    // immediate first evaluation.
    if (job.policy !== "periodic-reminder") return null;
    // Upgrade bridge (#860): pre-upgrade builds marked a pending wake with a
    // null evaluation. Fresh arms start unpending, so null plus a pending
    // event is upgrade state and stays immediately due.
    if (isQueueWaitEventPending(job.specYaml)) return null;
    const registered = Date.parse(job.registeredAt);
    return Number.isNaN(registered) ? null : registered + cadenceMs;
  }
  const last = Date.parse(job.lastEvaluationAt);
  // The epoch is #860's wake-now marker (a blocker change or custody move): due now, not 1970.
  if (Number.isNaN(last) || last === 0) return null;
  return last + cadenceMs;
}
