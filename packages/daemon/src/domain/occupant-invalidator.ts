// GHOST-STAGE (e) — the CANONICAL OccupantInvalidator seam. The INTERFACE is the contract the cutover
// slice (SeatHandoverService.commit()) calls to invalidate a RETIRING occupant's seat-name-keyed
// state, so a successor — which under a cutover RESUMES INTO THE SAME PANE and REUSES the canonical
// seat name (retiringSessionName === successorSessionName) — never inherits it. dev-driver's cutover
// file imports THIS definition (one shape, no twin).
//
// Two invalidation classes (see the (e) enumeration/contract artifact):
//   Class-A (in-mem compaction maps 1a-1f + the name-keyed context sidecar 2a): hard-delete by name.
//     Safe by TIMING — invoked INSIDE commit() BEFORE the successor accumulates any name-keyed state,
//     so a name-scoped delete clears exactly the retiree's entries. (The name does NOT isolate the
//     retiree from the successor — they share it — the timing does.)
//   Class-B (durable queue_items / watchdog_jobs, seat-ROLE-bearing): a name-scoped drop would
//     NEUTRALIZE THE SUCCESSOR'S OWN legitimate role items, so it MUST gen-scope. That requires the
//     occupant-generation identity (atom-B). Until `retiringGeneration` is supplied, Class-B is a LOUD
//     no-op — NEVER a name-scoped drop.

import { parseWatchdogSpec, watchdogJobTarget } from "./watchdog-policy-engine.js";

type SwapWatchdogJob = { policy: string; specYaml: string; targetSession: string };

export interface OccupantInvalidator {
  invalidateRetiringOccupant(args: {
    retiringSessionName: string;
    successorSessionName: string;
    retiringGeneration?: string;
  }): void;
}

/** Deps the default invalidator composes — structural so tests inject fakes and there is no hard
 *  import cycle with the enforcer / context-usage store. */
export interface OccupantInvalidatorDeps {
  enforcer: { invalidateOccupant(sessionName: string): void };
  contextUsage: { invalidateOccupantSidecar(sessionName: string): void };
  /** (e/Class-B) durable watchdog_jobs store — armed jobs the retiring generation registered for its own
   *  seat are stopped at swap (a stale wake into the successor's context is the ghost). Optional: absent ⇒
   *  the watchdog branch is skipped (never a name-scoped fallback). */
  watchdog?: {
    dropArmedByRegisteringGeneration(
      generationUuid: string,
      wakesRetiringSeat: (job: SwapWatchdogJob) => boolean,
      keepJobIds?: readonly string[],
    ): number;
  };
  /** The names that currently reach a seat (`SessionRegistry.sessionAddresses`: its logical address and its
   *  physical session), so a job addressed to either spelling counts as this seat's. Optional: absent ⇒ only
   *  the retiring and successor names do. */
  addresses?: { sessionAddresses(sessionName: string): string[] };
  /** (e/Class-B) durable queue_items store — in-progress items claimed by the retiring generation are
   *  RELEASED to pending (never dropped: the role work is durable, the successor re-claims). Its current
   *  park timers (blocked rows' wakes) are role work too, so the watchdog drop keeps them. Optional. */
  queue?: { releaseClaimsByGeneration(generationUuid: string): number; currentParkTimerIds?(): string[] };
  log?: (msg: string) => void;
}

export class DefaultOccupantInvalidator implements OccupantInvalidator {
  constructor(private readonly deps: OccupantInvalidatorDeps) {}

  invalidateRetiringOccupant(args: {
    retiringSessionName: string;
    successorSessionName: string;
    retiringGeneration?: string;
  }): void {
    const { retiringSessionName, retiringGeneration } = args;
    const log = this.deps.log ?? (() => {});

    // Class-A — hard-delete by name (safe by TIMING; runs at commit() before the successor writes).
    this.deps.enforcer.invalidateOccupant(retiringSessionName);
    this.deps.contextUsage.invalidateOccupantSidecar(retiringSessionName);

    // Class-B — gen-scoped ONLY. Never name-scope (a shared name can't discriminate retiree from
    // successor; a name-scoped drop would neutralize the successor's own live role items).
    if (retiringGeneration === undefined) {
      log(
        `[occupant-invalidator] Class-B (queue_items/watchdog_jobs) invalidation for "${retiringSessionName}" ` +
          `PENDING atom-B: no occupant-generation supplied, so NOT name-scoping (that would neutralize the ` +
          `successor's own legitimate role items). No-op until the generation identity lands.`,
      );
      return;
    }
    // atom-B present → Class-B gen-scoped invalidation.
    // Watchdog (3b): stop every ARMED job the retiring generation registered for this seat — a stale wake
    // firing into the successor's context is the specimen; the successor re-arms its own. Gen-scoped so the
    // successor's OWN armed jobs (same name, live gen) are untouched. A job it registered for another seat
    // wakes that seat, not the successor, so it keeps running (#1775). "This seat" is judged on the job's
    // delivery target (the spec's, where the engine prefers it) against every name that reaches the seat.
    // A blocked row's current park timer is kept: it wakes the seat that owns the row, and nothing re-arms
    // it if it stops. A workflow keepalive is kept for the same reason: it wakes the workflow's current
    // frontier owner (whom the successor succeeds, when it's this seat) and ends with the workflow.
    const seatNames = new Set([retiringSessionName, args.successorSessionName]);
    for (const name of [retiringSessionName, args.successorSessionName]) {
      for (const address of this.deps.addresses?.sessionAddresses(name) ?? []) seatNames.add(address);
    }
    const wakesThisSeat = (job: SwapWatchdogJob) =>
      job.policy !== "workflow-keepalive" && seatNames.has(watchdogJobTarget(job, specTarget(job.specYaml)).session);
    const keepJobIds = this.deps.queue?.currentParkTimerIds?.() ?? [];
    const stopped =
      this.deps.watchdog?.dropArmedByRegisteringGeneration(retiringGeneration, wakesThisSeat, keepJobIds) ?? 0;
    if (stopped > 0) {
      log(
        `[occupant-invalidator] Class-B: stopped ${stopped} armed watchdog job(s) registered by retired ` +
          `generation ${retiringGeneration} (seat "${retiringSessionName}") — successor re-arms its own.`,
      );
    }
    // Queue_items (3a): RELEASE (never drop) every in-progress item CLAIMED by the retiring generation
    // back to pending — the role work is durable and the successor re-claims it; only the retiree's
    // stale claim is the ghost. Gen-scoped via the claimant generation (the successor's own claims,
    // under the reused name but its live gen, are untouched).
    const released = this.deps.queue?.releaseClaimsByGeneration(retiringGeneration) ?? 0;
    if (released > 0) {
      log(
        `[occupant-invalidator] Class-B: released ${released} in-progress queue item(s) claimed by retired ` +
          `generation ${retiringGeneration} (seat "${retiringSessionName}") back to pending — successor re-claims.`,
      );
    }
  }
}

/** A stored spec was validated at registration; an unreadable one falls back to the stored target, as delivery can't use it. */
function specTarget(specYaml: string): { session: string } | null {
  try {
    return parseWatchdogSpec(specYaml).target;
  } catch {
    return null;
  }
}
