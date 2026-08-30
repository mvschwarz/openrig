// OPR.0.5.6.1 AM-F1 — the 30-minute away-escalation deferral as a DEFERRED
// DELIVERY on the EXISTING watchdog substrate (SQLite is the schedule; no
// third timer engine, no setInterval anywhere here). The deferral is recorded
// AS A TRANSITION on the row (the S01 transitions-are-the-state pattern), the
// job is a ONE-SHOT (terminal after its single fire — deliberately not the
// repeating periodic-reminder shape), and a daemon restart mid-window changes
// nothing: a fresh repository over the same DB sees the same armed job and the
// same fire-at arithmetic (AM-F1 tooth: exactly once at T+30, never zero,
// never two).

import type { QueueRepository } from "../queue-repository.js";
import type { WatchdogJobsRepository } from "../watchdog-jobs-repository.js";
import type { Policy, PolicyJob, PolicyEvaluation } from "./types.js";

export const DELIVERY_DEFERRAL_POLICY = "delivery-deferral";
export const DELIVERY_DEFERRAL_ARMED_PREFIX = "delivery-deferral-armed";
export const DELIVERY_DEFERRAL_FIRED_PREFIX = "delivery-deferral-fired";

export interface ArmDeliveryDeferralInput {
  jobsRepo: WatchdogJobsRepository;
  queueRepo: QueueRepository;
  qitemId: string;
  entityId: string;
  minutes: number;
  notificationKey?: string;
  now?: Date;
}

interface DeferralContext {
  qitemId: string;
  entityId: string;
  minutes: number;
  armedAt: string;
  notificationKey: string;
}

/** Arm the one-shot deferral. Idempotent per notification key: an already-armed
 *  live deferral for the same episode is returned, never duplicated (the
 *  exactly-once half of AM-F3 — one delivery at T, never immediate-plus-deferred). */
export function armDeliveryDeferral(input: ArmDeliveryDeferralInput): { jobId: string } {
  const key = input.notificationKey ?? input.qitemId;
  const existing = input.jobsRepo.listActive().find(
    (j) => j.policy === DELIVERY_DEFERRAL_POLICY && j.specYaml.includes(`notificationKey: "${key}"`),
  );
  if (existing) return { jobId: existing.jobId };

  const armedAt = (input.now ?? new Date()).toISOString();
  const specYaml = [
    "context:",
    `  qitemId: "${input.qitemId}"`,
    `  entityId: "${input.entityId}"`,
    `  minutes: ${input.minutes}`,
    `  armedAt: "${armedAt}"`,
    `  notificationKey: "${key}"`,
  ].join("\n");
  const job = input.jobsRepo.register({
    policy: DELIVERY_DEFERRAL_POLICY,
    specYaml,
    targetSession: `${input.entityId}@external`,
    intervalSeconds: Math.max(60, input.minutes * 60),
    registeredBySession: "daemon@kernel",
  });
  // Transitions ARE the state: the deferral is readable off the row after any restart.
  input.queueRepo.update({
    qitemId: input.qitemId,
    actorSession: "daemon@kernel",
    transitionNote: [
      DELIVERY_DEFERRAL_ARMED_PREFIX,
      `job_id=${job.jobId}`,
      `fire_at=${new Date(Date.parse(armedAt) + input.minutes * 60_000).toISOString()}`,
      `notification_key=${key}`,
      `who=${input.entityId}`,
    ].join(" "),
  });
  return { jobId: job.jobId };
}

export interface FireDeliveryDeferralInput {
  jobsRepo: WatchdogJobsRepository;
  queueRepo: QueueRepository;
  jobId: string;
  /** R1 B-3: the EPISODE key rides the fire so the Slice 14 receipt lands
   *  current-episode-exact — never the bare-qitemId fallback. */
  deliverInterrupt: (qitemId: string, notificationKey: string) => Promise<{ ok: boolean }>;
  now?: Date;
}

function parseContext(specYaml: string): DeferralContext | null {
  const grab = (k: string): string | null => {
    const m = specYaml.match(new RegExp(`${k}:\\s*"?([^"\\n]+)"?`));
    return m ? m[1]! : null;
  };
  const qitemId = grab("qitemId");
  const entityId = grab("entityId");
  const minutes = grab("minutes");
  const armedAt = grab("armedAt");
  const notificationKey = grab("notificationKey");
  if (!qitemId || !entityId || !minutes || !armedAt || !notificationKey) return null;
  return { qitemId, entityId, minutes: Number(minutes), armedAt, notificationKey };
}

/** Fire the deferral iff due. Terminal after the single successful delivery —
 *  a later call can never fire again (the one-shot contract). */
export async function fireDeliveryDeferralIfDue(input: FireDeliveryDeferralInput): Promise<{ fired: boolean }> {
  const job = input.jobsRepo.getById(input.jobId);
  if (!job || job.state !== "active") return { fired: false };
  const ctx = parseContext(job.specYaml);
  if (!ctx) {
    input.jobsRepo.markTerminal(input.jobId, "delivery-deferral spec unparseable (fail closed, loudly terminal)");
    return { fired: false };
  }
  const now = input.now ?? new Date();
  const fireAt = Date.parse(ctx.armedAt) + ctx.minutes * 60_000;
  if (now.getTime() < fireAt) return { fired: false };
  // RESERVE BEFORE DELIVER (R2 B-3 / R1 B-4, the S24 precedent): the job goes
  // TERMINAL and the fired transition lands BEFORE the delivery enqueue, so a
  // still-active job can never coexist with an enqueued decision — no restart
  // boundary can mint two decisions for one episode. The trade is at-most-once:
  // a crash between reserve and enqueue loses the fire RECOVERABLY (the row
  // shows fired-without-receipt and surfaces as never-posted), never doubly.
  input.jobsRepo.markTerminal(input.jobId, "delivery-deferral fired (reserve-before-deliver)");
  input.queueRepo.update({
    qitemId: ctx.qitemId,
    actorSession: "daemon@kernel",
    transitionNote: [
      DELIVERY_DEFERRAL_FIRED_PREFIX,
      `job_id=${input.jobId}`,
      `notification_key=${ctx.notificationKey}`,
      `who=${ctx.entityId}`,
    ].join(" "),
  });
  const delivery = await input.deliverInterrupt(ctx.qitemId, ctx.notificationKey);
  if (!delivery.ok) {
    // Loud, row-side, at-most-once honored: the fire is spent; the loss is visible.
    input.queueRepo.update({
      qitemId: ctx.qitemId,
      actorSession: "daemon@kernel",
      transitionNote: `delivery-deferral-fire delivery-failed job_id=${input.jobId} notification_key=${ctx.notificationKey}`,
    });
  }
  return { fired: true };
}

/** Watchdog-engine policy wrapper (additionalPolicies injection, the
 *  parked-owner-consumer wiring precedent). The engine's scheduler cadence
 *  drives evaluation; the due arithmetic above owns the timing. */
export function makeDeliveryDeferralPolicy(deps: {
  jobsRepo: WatchdogJobsRepository;
  queueRepo: QueueRepository;
  deliverInterrupt: (qitemId: string, notificationKey: string) => Promise<{ ok: boolean }>;
}): Policy {
  return {
    name: DELIVERY_DEFERRAL_POLICY,
    async evaluate(job: PolicyJob): Promise<PolicyEvaluation> {
      const { fired } = await fireDeliveryDeferralIfDue({
        jobsRepo: deps.jobsRepo,
        queueRepo: deps.queueRepo,
        jobId: job.jobId,
        deliverInterrupt: deps.deliverInterrupt,
      });
      if (fired) return { action: "terminal", reason: "delivery-deferral fired" };
      return { action: "skip", reason: "not due" };
    },
  } as Policy;
}
