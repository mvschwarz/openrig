// OPR.0.5.6.24 F-14 — the parked-owner consumer.
//
// A diagnosis with zero consumers is a gate beside an open door. This policy is
// the ONE bounded consumer of the join the system already holds: (1) the queue —
// this seat holds open obligations (claimed in-progress rows included); (2) the
// ARBITRATED activity verdict — this seat is idle at its prompt. When both are
// true, deliver exactly ONE wake naming the obligations, then step back: the S01
// ladder owns retries/escalation; the watchdog engine owns scheduling/throttle.
//
// One-oracle law (mini-req 2): the seat verdict enters ONLY through the
// arbitrated `getSeatState` seam — the same surface `rig parked` renders from.
// This module never reads raw per-runtime evidence; the first specimen's
// raw-vs-arbitrated disagreement is the exact hole that rule closes.

import type { Policy, PolicyJob, PolicyEvaluation } from "./types.js";

/** The arbitrated verdict view this policy consumes (adapter-mapped at startup). */
export interface ParkedSeatView {
  /** Arbitrated activity value (e.g. "idle" | "working" | "unknown"). */
  value: string;
  needsInput: unknown;
  /** Which arbitration rung decided — null means nothing decided (S21: indeterminate). */
  decidedBy: string | null;
  /** True when the seat sits at an interactive prompt awaiting input. */
  atPrompt: boolean;
  /** Optional park cause; "usage-limit" defers to S16's timed wake (mini-req 4). */
  cause?: string;
}

export interface ObligationRowView {
  qitemId: string;
  state: "pending" | "in-progress" | "blocked";
  summary: string | null;
}

export interface EpisodeReceipt {
  episodeKey: string;
  deliveredAt: string;
}

export interface ParkedOwnerConsumerDeps {
  /** The arbitrated seat verdict, keyed by session name (the one oracle). */
  getSeatState: (sessionName: string) => ParkedSeatView | null;
  /** Destination-scoped open obligations — the shipped parked-query scope. */
  listOpenObligations: (
    destinationSession: string,
    limit: number,
  ) => { rows: ObligationRowView[]; limit: number };
  /** Once-per-park-episode delivery receipts (mini-req 4). */
  receipts: {
    findForEpisode: (episodeKey: string) => EpisodeReceipt | null;
    record: (receipt: EpisodeReceipt) => void;
  };
}

export const PARKED_OWNER_OBLIGATION_LIMIT = 500;

/** One rig-level supervisor policy on the EXISTING watchdog engine (mini-req 1):
 *  no timer of its own, no second delivery path, no retry loop — evaluate() is
 *  pure over the injected seams and the engine does the rest. */
export function makeParkedOwnerConsumerPolicy(deps: ParkedOwnerConsumerDeps): Policy {
  // Park-EPISODE tracking: an episode is "parked since the seat last read
  // not-parked" (mini-req 4). The marker lives in-process; the durable receipt
  // store plus the engine's activeWakeInterval throttle bound the restart edge —
  // a restart can only SKIP a wake (safe direction), never double-deliver
  // within a tracked episode.
  const currentEpisode = new Map<string, string>();
  let episodeCounter = 0;

  return {
    name: "parked-owner-consumer",
    async evaluate(job: PolicyJob): Promise<PolicyEvaluation> {
      const seat = job.target.session;

      const view = deps.getSeatState(seat);
      // S21 inheritance: an indeterminate verdict is NOT parked — no wake, ever.
      if (!view || view.value === "unknown" || view.decidedBy === null) {
        return { action: "skip", reason: "indeterminate-not-parked", notes: { seat } };
      }

      const parked = view.value === "idle" && view.atPrompt === true;
      if (!parked) {
        // The episode (if any) ends the moment the seat reads not-parked; a
        // later park is a NEW episode and earns its own single wake.
        currentEpisode.delete(seat);
        return { action: "skip", reason: "not-parked", notes: { seat, activity: view.value } };
      }

      // S16 composition (mini-req 4): a usage-limit park belongs to S16's timed
      // wake — this consumer stays silent rather than double-waking.
      if (view.cause === "usage-limit") {
        return { action: "skip", reason: "usage-limit-defer-s16", notes: { seat } };
      }

      const { rows } = deps.listOpenObligations(seat, PARKED_OWNER_OBLIGATION_LIMIT);
      if (rows.length === 0) {
        return { action: "skip", reason: "no-open-obligation", notes: { seat } };
      }

      let episodeKey = currentEpisode.get(seat);
      if (!episodeKey) {
        episodeCounter += 1;
        episodeKey = `${seat}#${episodeCounter}`;
        currentEpisode.set(seat, episodeKey);
      }

      const existing = deps.receipts.findForEpisode(episodeKey);
      if (existing) {
        return {
          action: "skip",
          reason: "already-woken-this-episode",
          notes: { seat, episodeKey, deliveredAt: existing.deliveredAt },
        };
      }

      const ids = rows.map((r) => r.qitemId);
      const message =
        `You are parked (arbitrated: idle at prompt) while holding ${ids.length} open ` +
        `obligation${ids.length === 1 ? "" : "s"}: ${ids.join(", ")}. ` +
        `Resume the work or update each row honestly (close, park-with-wake, or hand off). ` +
        `This is the one wake for this park episode; the S01 ladder owns anything further.`;

      deps.receipts.record({ episodeKey, deliveredAt: new Date().toISOString() });
      return {
        action: "send",
        target: { session: seat },
        message,
        notes: { seat, episodeKey, obligations: ids, evidence: "arbitrated-idle-at-prompt" },
      };
    },
  };
}
