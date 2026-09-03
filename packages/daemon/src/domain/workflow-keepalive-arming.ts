// OPR.0.4.6.WF1 FR-3 (G2): auto-arm the shipped workflow-keepalive
// policy — the policy registered at startup but NOTHING created a
// watchdog job carrying context.workflow_instance_id, so the keepalive
// never fired for any instance.
//
// Arming rides the transactional scribe: instantiate and every handoff
// projection call ensureWorkflowKeepaliveArmed INSIDE the same
// db.transaction that routes the step (watchdog register/markTerminal
// are plain INSERT/UPDATE on the same handle — verified composable).
// This closes the commit-then-crash-before-nudge window: the armed job
// exists the instant the routed frontier packet exists, so a lost
// post-commit nudge is re-issued by the keepalive even when the daemon
// died before nudging (FR-3 AC; the boot sweep — FR-4 — is the
// immediate-on-restart leg of the same closure).
//
// ONE JOB PER LIVE PACKET for packet-addressed dependency graphs; legacy
// serial instances retain the original one-job-per-instance shape. The
// policy resolves the addressed packet owner live from SQLite at every
// evaluation, while target_session remains the registered fallback.
//
// AUTO-ARMED JOBS ARE DEADLINE-GATED (context.deadline_gated: true):
// the policy stays QUIET while the instance is healthy and sends only
// when the FR-2 evaluator reports overdue — preserving the FR-2
// zero-noise-on-the-happy-path AC. Operator-registered keepalive jobs
// (no flag) keep the shipped POC always-send parity unchanged.

import type {
  WatchdogJob,
  WatchdogJobsRepository,
} from "./watchdog-jobs-repository.js";

/**
 * Evaluation cadence for auto-armed keepalive jobs. Deadline-gated
 * evaluations are quiet skips until overdue, so this interval costs
 * nothing on the happy path (quiet skips are not even recorded in
 * watchdog history).
 */
export const WORKFLOW_KEEPALIVE_AUTO_INTERVAL_SECONDS = 15 * 60;

export function buildKeepaliveSpecYaml(instanceId: string, targetSession: string, packetId?: string): string {
  return [
    "policy: workflow-keepalive",
    "target:",
    `  session: ${targetSession}`,
    "context:",
    `  workflow_instance_id: ${instanceId}`,
    ...(packetId ? [`  workflow_packet_id: ${packetId}`] : []),
    "  deadline_gated: true",
    "",
  ].join("\n");
}

/**
 * Find the active auto/manual keepalive job carrying this instance id.
 * Jobs carry context only inside spec_yaml (no context column); ULIDs
 * are 26-char unique so a containment check is exact in practice.
 */
export function findArmedKeepaliveJob(
  repo: WatchdogJobsRepository,
  instanceId: string,
  packetId?: string,
): WatchdogJob | null {
  return (
    repo
      .listActive()
      .find(
        (j) => {
          if (j.policy !== "workflow-keepalive") return false;
          if (!j.specYaml.includes(`workflow_instance_id: ${instanceId}`)) return false;
          const packetLine = /(?:^|\n)\s*workflow_packet_id:\s*(\S+)/.exec(j.specYaml)?.[1];
          return packetId ? packetLine === packetId : packetLine === undefined;
        },
      ) ?? null
  );
}

/**
 * Idempotent in-transaction arm: registers the addressed packet keepalive
 * (or the legacy instance keepalive) if no active one exists. Composable inside the scribe txn
 * (register is a plain INSERT).
 */
export function ensureWorkflowKeepaliveArmed(
  repo: WatchdogJobsRepository,
  input: {
    instanceId: string;
    targetSession: string;
    registeredBySession: string;
    packetId?: string;
  },
): { jobId: string; newlyArmed: boolean } {
  const existing = findArmedKeepaliveJob(repo, input.instanceId, input.packetId);
  if (existing) return { jobId: existing.jobId, newlyArmed: false };
  const job = repo.register({
    policy: "workflow-keepalive",
    specYaml: buildKeepaliveSpecYaml(input.instanceId, input.targetSession, input.packetId),
    targetSession: input.targetSession,
    intervalSeconds: WORKFLOW_KEEPALIVE_AUTO_INTERVAL_SECONDS,
    registeredBySession: input.registeredBySession,
  });
  return { jobId: job.jobId, newlyArmed: true };
}

/**
 * In-transaction disarm on terminal instance state (completed/failed):
 * the job goes terminal so no orphaned watchdog noise survives the
 * instance (FR-3 AC). No-op when nothing is armed.
 */
export function disarmWorkflowKeepalive(
  repo: WatchdogJobsRepository,
  instanceId: string,
  reason: string,
  packetId?: string,
): string | null {
  const existing = findArmedKeepaliveJob(repo, instanceId, packetId);
  if (!existing) return null;
  repo.markTerminal(existing.jobId, reason);
  return existing.jobId;
}

export function disarmAllWorkflowKeepalives(
  repo: WatchdogJobsRepository,
  instanceId: string,
  reason: string,
): string[] {
  const jobs = repo.listActive().filter(
    (job) => job.policy === "workflow-keepalive" && job.specYaml.includes(`workflow_instance_id: ${instanceId}`),
  );
  for (const job of jobs) repo.markTerminal(job.jobId, reason);
  return jobs.map((job) => job.jobId);
}
