// B1 ROUND 2 — the operator-owned fleet-restore lifecycle. r2 proved the prior path delegated the
// WHOLE lifecycle to a buffered child command (`execFile rig crash-cart restore-fleet`), so the TUI
// held no attempt id, could not render progress mid-run (two GETs in flight, output only at exit), and
// could not reach the cancel endpoint. This driver makes the TUI own it: kick → poll → cancel, emitting
// a frame PER POLL so the cockpit renders progress from the rollup stream (plan R2/R4), and reaching the
// cancel endpoint on operator request (plan R8). The daemon's async on-commit route (r1-cleared) is
// unchanged — this is the client-side consumer that was missing.
import type { RestoreFleetStatus } from "../daemon-client.js";
import type { TriageRow } from "./triage.js";

/** The daemon surface the lifecycle needs — a structural subset of DaemonClient (injectable for tests). */
export interface RestoreLifecycleClient {
  restoreFleet(): Promise<{ fleetAttemptId: string }>;
  restoreFleetStatus(id: string): Promise<RestoreFleetStatus>;
  cancelRestoreFleet(id: string): Promise<unknown>;
}

/** One rendered frame of the lifecycle — a poll's status plus the retained attempt id + phase. */
export interface RestoreFrame extends RestoreFleetStatus {
  attemptId: string;
  phase: "running" | "done";
}

/** Per-rig progress row for the running view (one per rig in the rollup sequence so far). */
export interface RestoreProgressRow {
  rigId: string;
  outcome: string;
}

/** The render model for the restore lifecycle surface — progress while running, rollup + the
 *  keyboard-walkable triage list when done. Built purely from a frame so the render stays testable. */
export interface RestoreLifecycleVM {
  phase: "running" | "done";
  cancelled: boolean;
  verdict: string;
  counts: RestoreFleetStatus["rollup"]["counts"];
  progress: RestoreProgressRow[];
  /** The triage list (attention seats + not_attempted rigs) as shipped TriageRow[] — fed to renderTriage. */
  triage: TriageRow[];
}

/** Adapt a lifecycle frame into the render VM. The triage list is the UNION of two honest sources,
 *  each carrying its EXACT need on its own row (never a clipped one-line summary): the per-seat
 *  attention rows (Claude picker / Codex auth / awaiting-decision), red; and the not_attempted rigs
 *  that carry a remediation (no usable snapshot / cancelled), yellow (a caveat, not a failed seat). */
export function buildRestoreLifecycleVM(frame: RestoreFrame): RestoreLifecycleVM {
  const attentionRows: TriageRow[] = frame.rollup.attention_required.map((a) => ({
    seat: `${a.seat}@${a.rigId}`,
    check: "resume",
    status: "red",
    need: a.need,
    evidence: a.need,
    remediationSafe: false,
  }));
  const notAttemptedRows: TriageRow[] = frame.rollup.sequence
    .filter((r) => r.outcome === "not_attempted" && (r.remediation || r.reason))
    .map((r) => ({
      seat: r.rigId,
      check: "snapshot",
      status: "yellow",
      need: r.remediation ?? r.reason ?? "not attempted",
      evidence: r.reason ?? "",
      remediationSafe: false,
    }));
  return {
    phase: frame.phase,
    cancelled: frame.cancelled,
    verdict: frame.verdict,
    counts: frame.rollup.counts,
    progress: frame.rollup.sequence.map((r) => ({ rigId: r.rigId, outcome: r.outcome })),
    triage: [...attentionRows, ...notAttemptedRows],
  };
}

export interface RestoreLifecycleDeps {
  client: RestoreLifecycleClient;
  /** Called with EVERY poll (running frames included) — this is the progress stream the TUI renders. */
  onFrame: (frame: RestoreFrame) => void;
  /** Polled each tick; when true, the driver POSTs cancel once (stop-before-next-rig). */
  isCancelRequested: () => boolean;
  /** Injected in tests (no real delay); production uses setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  maxPolls?: number;
}

/** Drive one fleet restore end-to-end from the TUI: kick the async verb, retain the attempt id, poll
 *  the status emitting a frame each time (so a mid-run frame is observable), request cancel when the
 *  operator asks, and resolve on done. On the poll ceiling it returns the last (not-done) frame — the
 *  restore keeps running on the daemon; the caller stays honest about that. */
export async function driveRestoreLifecycle(deps: RestoreLifecycleDeps): Promise<RestoreFrame> {
  const { fleetAttemptId } = await deps.client.restoreFleet();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const interval = deps.pollIntervalMs ?? 400;
  const maxPolls = deps.maxPolls ?? 1500; // ~10 min ceiling at 400ms; restore continues past it on the daemon
  let cancelSent = false;
  let last: RestoreFrame | undefined;
  for (let i = 0; i < maxPolls; i++) {
    if (deps.isCancelRequested() && !cancelSent) {
      cancelSent = true;
      await deps.client.cancelRestoreFleet(fleetAttemptId); // reach the endpoint that exists
    }
    const status = await deps.client.restoreFleetStatus(fleetAttemptId);
    const frame: RestoreFrame = { ...status, attemptId: fleetAttemptId, phase: status.done ? "done" : "running" };
    deps.onFrame(frame); // a frame EVERY poll — the operator sees progress before completion
    last = frame;
    if (status.done) return frame;
    await sleep(interval);
  }
  return last!;
}
