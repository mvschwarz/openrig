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

/** One rendered frame of the lifecycle — a poll's status plus the retained attempt id + phase.
 *  `detached` = the driver stopped polling (poll ceiling reached, or repeated poll errors) while the
 *  restore is STILL running on the daemon — an explicit, operable state (reattach / cancel by id), NEVER
 *  a frozen `running` screen with a dead cancel key. */
export interface RestoreFrame extends RestoreFleetStatus {
  attemptId: string;
  phase: "running" | "done" | "detached";
}

/** Per-rig progress row for the running view (one per rig in the rollup sequence so far). */
export interface RestoreProgressRow {
  rigId: string;
  outcome: string;
}

/** The render model for the restore lifecycle surface — progress while running, rollup + the
 *  keyboard-walkable triage list when done. Built purely from a frame so the render stays testable. */
export interface RestoreLifecycleVM {
  phase: "running" | "done" | "detached";
  cancelled: boolean;
  verdict: string;
  counts: RestoreFleetStatus["rollup"]["counts"];
  progress: RestoreProgressRow[];
  /** The triage list (attention seats + not_attempted rigs) as shipped TriageRow[] — fed to renderTriage. */
  triage: TriageRow[];
  /** The retained attempt id — the detached view needs it for the reattach / direct-cancel affordances. */
  attemptId: string;
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
    attemptId: frame.attemptId,
  };
}

export interface RestoreLifecycleDeps {
  client: RestoreLifecycleClient;
  /** Called with EVERY poll (running + detached frames included) — the progress stream the TUI renders. */
  onFrame: (frame: RestoreFrame) => void;
  /** Polled each tick; when true, the driver POSTs cancel once (stop-before-next-rig). */
  isCancelRequested: () => boolean;
  /** Reattach to an EXISTING attempt (skip the kick) — the detached view's `r` re-enters the loop. */
  attemptId?: string;
  /** Injected in tests (no real delay); production uses setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  maxPolls?: number;
  /** Consecutive poll ERRORS tolerated before detaching (a transient blip must NOT kill the driver). */
  maxConsecutiveErrors?: number;
}

/** Drive one fleet restore from the TUI: kick (or reattach), retain the attempt id, poll emitting a
 *  frame each time (mid-run observable), request cancel when the operator asks, resolve on done. Two
 *  guarantees the operator lifecycle depends on:
 *   - a TRANSIENT poll error never ends the lifecycle — it is tolerated and retried; only
 *     `maxConsecutiveErrors` in a row (a genuinely unreachable daemon) DETACHES.
 *   - reaching the poll ceiling DETACHES (phase "detached"), it does NOT return a frozen "running"
 *     frame — so the caller never renders a live-looking screen whose cancel key is dead. A detached
 *     frame is an explicit, operable state: the caller reattaches or cancels by the retained id. */
export async function driveRestoreLifecycle(deps: RestoreLifecycleDeps): Promise<RestoreFrame> {
  const fleetAttemptId = deps.attemptId ?? (await deps.client.restoreFleet()).fleetAttemptId;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const interval = deps.pollIntervalMs ?? 400;
  const maxPolls = deps.maxPolls ?? 4500; // generous — a real fleet restore is bounded by daemon work
  const maxConsecutiveErrors = deps.maxConsecutiveErrors ?? 5;
  let cancelSent = false;
  let consecutiveErrors = 0;
  let last: RestoreFleetStatus | undefined;
  const detached = (): RestoreFrame => ({
    ...(last ?? { done: false, cancelled: false, verdict: "none_attempted", rollup: { counts: { fully_restored: 0, partially_restored: 0, failed: 0, not_attempted: 0 }, sequence: [], attention_required: [] } }),
    done: false,
    attemptId: fleetAttemptId,
    phase: "detached",
  });
  for (let i = 0; i < maxPolls; i++) {
    if (deps.isCancelRequested() && !cancelSent) {
      cancelSent = true;
      try {
        await deps.client.cancelRestoreFleet(fleetAttemptId); // reach the endpoint that exists
      } catch {
        cancelSent = false; // a failed cancel POST may retry next tick (never swallow the operator's intent)
      }
    }
    let status: RestoreFleetStatus;
    try {
      status = await deps.client.restoreFleetStatus(fleetAttemptId);
      consecutiveErrors = 0; // a good poll clears the transient-error streak
    } catch {
      // TRANSIENT poll failure (r1 refinement 2): tolerate, DO NOT end the lifecycle on one. Only a
      // sustained streak (a genuinely unreachable daemon) detaches to the operable reattach state.
      if (++consecutiveErrors >= maxConsecutiveErrors) {
        const frame = detached();
        deps.onFrame(frame);
        return frame;
      }
      await sleep(interval);
      continue;
    }
    const frame: RestoreFrame = { ...status, attemptId: fleetAttemptId, phase: status.done ? "done" : "running" };
    deps.onFrame(frame); // a frame EVERY poll — the operator sees progress before completion
    last = status;
    if (status.done) return frame;
    await sleep(interval);
  }
  // Poll ceiling: DETACH (never a frozen "running" frame — r1 refinement 1). The restore continues on
  // the daemon; the caller offers reattach / cancel-by-id from this explicit state.
  const frame = detached();
  deps.onFrame(frame);
  return frame;
}
