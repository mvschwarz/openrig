// OPR.0.5.6.24 F-14 — the parked-owner consumer.
//
// A diagnosis with zero consumers is a gate beside an open door. This policy is
// the ONE bounded consumer of the shipped parked derivation: ONE rig-level
// supervisor job per rig (anchor `parked-owner-consumer@<rigName>` — safety is
// the policy+target tuple, the rig suffix, role-bound null generation, and the
// evaluator-owned outcome.target; never lexical impossibility). Per evaluation
// it diagnoses the WHOLE rig through the same derivation `rig parked` serves,
// sends ONE wake to the first eligible parked owner, and steps back — the S01
// ladder owns retries/escalation; the watchdog engine owns scheduling.
//
// One-oracle law (mini-req 2): the parked verdict, the held-health
// classification, the indeterminate arm, and the obligation join all come from
// diagnoseRigParked — this module re-derives nothing and never reads raw
// per-runtime evidence.
//
// Episode identity (mini-req 4, desk seams 41983): PURELY history-derived —
// nothing lives in memory. A sent receipt (episodeSeat/idsHash/episodeKey in
// the sent row's notes) stays OPEN across restarts until a later row's
// episodeClosures names its key; an observed not-parked scan closes the seat's
// open keys durably (riding the same-pass send's notes, or one bounded
// episode-ended skip); a re-park of the same seat+obligations earns the next
// ordinal. NeedsInput churn during a continuous park never re-wakes: the
// arbitrated changedAt is deliberately NOT part of the identity.

import { createHash } from "node:crypto";
import type { Policy, PolicyJob, PolicyEvaluation } from "./types.js";
import type { WatchdogHistoryEntry } from "../watchdog-history-log.js";

/** Structural view of the shipped SeatParkedDiagnosis (parked-query.ts). */
export interface ParkedSeatDiagnosisView {
  sessionName: string;
  parked: boolean | "indeterminate";
  activity: { value: string; needsInput: { count: number; reason: string | null } };
  obligations: {
    items: Array<{ qitemId: string; state: string; summary: string | null }>;
    held: Array<{ qitemId: string; healthy: boolean }>;
  };
}

export interface ParkedOwnerConsumerDeps {
  /** The shipped rig-scoped diagnosis (diagnoseRigParked), adapter-constructed. */
  diagnoseRig: (rigName: string) => { seats: ParkedSeatDiagnosisView[] } | null;
  /** Durable receipts = the job's own history rows (full scan via countForJob). */
  history: {
    listForJob: (jobId: string, limit: number) => WatchdogHistoryEntry[];
    countForJob: (jobId: string) => number;
  };
}

export const PARKED_OWNER_POLICY_NAME = "parked-owner-consumer";

/** The stable per-rig registration anchor: member@rig shape, member slug = the
 *  policy name. Uniqueness per rig comes from the (policy, target_session)
 *  ensure tuple, not from lexical impossibility. */
export function makeRigAnchor(rigName: string): string {
  return `${PARKED_OWNER_POLICY_NAME}@${rigName}`;
}

/** Rig from the anchor — the fixed prefix means no session-name parsing rules apply. */
export function rigFromAnchor(targetSession: string): string {
  return targetSession.startsWith(`${PARKED_OWNER_POLICY_NAME}@`)
    ? targetSession.slice(PARKED_OWNER_POLICY_NAME.length + 1)
    : targetSession;
}

/** Only the transport's interactive-prompt refusal counts — a generic failed
 *  delivery is never mislabeled refused (desk seam 3). Literal source:
 *  session-transport.ts:1045 `Refused: '<name>' is at an interactive prompt`. */
function isRefusedInteractive(deliveryReason: unknown): boolean {
  return (
    typeof deliveryReason === "string" &&
    deliveryReason.startsWith("Refused:") &&
    deliveryReason.includes("interactive prompt")
  );
}

function idsHashOf(sortedIds: string[]): string {
  return createHash("sha256").update(sortedIds.join(",")).digest("hex").slice(0, 16);
}

interface EpisodeState {
  openKey: string | null;
  openEntry: WatchdogHistoryEntry | null;
  nextOrdinal: number;
}

/** Newest-first scan: closures collected as we go, so by the time a sent row is
 *  reached, `closed` already holds every LATER closure naming it. */
function episodeState(entries: WatchdogHistoryEntry[], seat: string, idsHash: string): EpisodeState {
  const closed = new Set<string>();
  let openKey: string | null = null;
  let openEntry: WatchdogHistoryEntry | null = null;
  let sentCount = 0;
  for (const e of entries) {
    const n = e.evaluationNotes ?? {};
    const closures = Array.isArray(n["episodeClosures"]) ? (n["episodeClosures"] as unknown[]) : [];
    for (const k of closures) if (typeof k === "string") closed.add(k);
    if (e.outcome === "sent" && n["episodeSeat"] === seat && n["idsHash"] === idsHash) {
      sentCount += 1;
      const key = typeof n["episodeKey"] === "string" ? (n["episodeKey"] as string) : null;
      if (openKey === null && key !== null && !closed.has(key)) {
        openKey = key;
        openEntry = e;
      }
    }
  }
  return { openKey, openEntry, nextOrdinal: sentCount + 1 };
}

/** Every open key a seat holds across ALL obligation-set hashes — the set an
 *  observed not-parked scan must close. */
function openKeysForSeat(entries: WatchdogHistoryEntry[], seat: string): string[] {
  const closed = new Set<string>();
  const open: string[] = [];
  for (const e of entries) {
    const n = e.evaluationNotes ?? {};
    const closures = Array.isArray(n["episodeClosures"]) ? (n["episodeClosures"] as unknown[]) : [];
    for (const k of closures) if (typeof k === "string") closed.add(k);
    if (e.outcome === "sent" && n["episodeSeat"] === seat && typeof n["episodeKey"] === "string") {
      const key = n["episodeKey"] as string;
      if (!closed.has(key) && !open.includes(key)) open.push(key);
    }
  }
  return open;
}

export function makeParkedOwnerConsumerPolicy(deps: ParkedOwnerConsumerDeps): Policy {
  return {
    name: PARKED_OWNER_POLICY_NAME,
    async evaluate(job: PolicyJob): Promise<PolicyEvaluation> {
      const rigName = rigFromAnchor(job.target.session);
      const d = deps.diagnoseRig(rigName);
      if (!d) {
        return { action: "skip", reason: "indeterminate-not-parked", notes: { rig: rigName } };
      }

      const total = deps.history.countForJob(job.jobId);
      const entries = deps.history.listForJob(job.jobId, Math.max(total, 1));

      const closures: string[] = [];
      const skipped: Array<{ seat: string; why: string }> = [];
      const seats = [...d.seats].sort((a, b) => a.sessionName.localeCompare(b.sessionName));

      for (const seat of seats) {
        if (seat.parked === "indeterminate") {
          skipped.push({ seat: seat.sessionName, why: "indeterminate-not-parked" });
          continue;
        }
        if (seat.parked === false) {
          // The episode ends the moment the seat reads not-parked; record the
          // durable closure on this pass (send notes or the episode-ended skip).
          for (const key of openKeysForSeat(entries, seat.sessionName)) {
            if (!closures.includes(key)) closures.push(key);
          }
          continue; // quiet per-seat — the S02 idiom
        }

        // The WHOLE diagnosis is inherited: park-driving obligations are the
        // open items PLUS unhealthy HELD rows (desk gap 3 — an unhealthy-HELD
        // driven park with zero open items still wakes, naming those rows).
        const ids = [
          ...seat.obligations.items.map((r) => r.qitemId),
          ...seat.obligations.held.filter((h) => h.healthy === false).map((h) => h.qitemId),
        ]
          .filter((v, i, a) => a.indexOf(v) === i)
          .sort();
        if (ids.length === 0) {
          skipped.push({ seat: seat.sessionName, why: "no-park-driving-obligation" });
          continue;
        }

        // S16 composition: a usage-limit park belongs to S16's timed wake —
        // real surface reason, no invented cause field.
        const niReason = seat.activity.needsInput.reason ?? "";
        if (/usage.?limit/i.test(niReason)) {
          skipped.push({ seat: seat.sessionName, why: "usage-limit-defer-s16" });
          continue;
        }

        const idsHash = idsHashOf(ids);
        const ep = episodeState(entries, seat.sessionName, idsHash);
        if (ep.openKey !== null) {
          const deliveryReason = ep.openEntry?.evaluationNotes?.["deliveryReason"];
          skipped.push({
            seat: seat.sessionName,
            why: isRefusedInteractive(deliveryReason)
              ? "destination-refused-interactive-prompt"
              : "already-woken-this-episode",
          });
          continue;
        }

        const episodeKey = `${seat.sessionName}|${idsHash}#${ep.nextOrdinal}`;
        const message =
          `You are parked (arbitrated: idle at prompt) while holding ${ids.length} open ` +
          `obligation${ids.length === 1 ? "" : "s"}: ${ids.join(", ")}. ` +
          `Resume the work or update each row honestly (close, park-with-wake, or hand off). ` +
          `This is the one wake for this park episode; the S01 ladder owns anything further.`;
        return {
          action: "send",
          target: { session: seat.sessionName },
          message,
          notes: {
            episodeKey,
            episodeSeat: seat.sessionName,
            idsHash,
            obligations: ids,
            evidence: "arbitrated-idle-at-prompt",
            episodeClosures: closures,
            skippedSeats: skipped,
          },
        };
      }

      if (closures.length > 0) {
        // Bounded: only when something actually closed — never a row per clean scan.
        return { action: "skip", reason: "episode-ended", notes: { episodeClosures: closures, skippedSeats: skipped } };
      }
      if (skipped.length > 0) {
        return { action: "skip", reason: "all-parked-owners-deferred", notes: { skippedSeats: skipped } };
      }
      return { action: "skip", reason: "no-parked-owner", notes: { rig: rigName } };
    },
  };
}
