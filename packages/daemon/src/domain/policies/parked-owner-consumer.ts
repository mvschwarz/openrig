// OPR.0.5.6.24 F-14 — the parked-owner consumer.
//
// A diagnosis with zero consumers is a gate beside an open door. This policy is
// the ONE bounded consumer of the shipped parked derivation: ONE rig-level
// supervisor job per rig (anchor `parked-owner-consumer@<rigName>`), diagnosing
// the WHOLE rig through the same derivation `rig parked` serves and sending ONE
// wake to the first eligible parked owner per evaluation. The S01 ladder owns
// retries/escalation; the watchdog engine owns scheduling.
//
// RECEIPTS ARE ROW-SIDE (R2 repair, advisor-approved): the episode receipt is a
// queue TRANSITION on the episode's primary obligation row, written BEFORE the
// engine delivers (reserve-before-deliver — the at-most-once contract: a crash
// between reserve and delivery loses that wake recoverably, never duplicates;
// exactly-once is not claimed without an idempotent transport). Durability comes
// from queue-retention's binding active-frontier invariant — transitions of any
// non-terminal qitem are never touched, at any age — so an open park's receipt
// outlives watchdog telemetry pruning by construction, and once the row is
// terminal the obligation is gone and the episode is moot.
//
// One-oracle law (mini-req 2): the parked verdict, held-health classification,
// indeterminate arm, and obligation join all come from diagnoseRigParked — this
// module re-derives nothing and never reads raw per-runtime evidence.

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

export interface RowTransitionView {
  ts: string;
  transitionNote: string | null;
}

export interface ParkedOwnerConsumerDeps {
  /** The shipped rig-scoped diagnosis (diagnoseRigParked), adapter-constructed. */
  diagnoseRig: (rigName: string) => { seats: ParkedSeatDiagnosisView[] } | null;
  /** Telemetry — used ONLY to reconcile recent delivery outcomes onto rows
   *  (immediate horizon); NEVER as episode state. */
  history: {
    listForJob: (jobId: string, limit: number) => WatchdogHistoryEntry[];
    countForJob: (jobId: string) => number;
  };
  /** The durable row-side surfaces (queue repository, adapter-wired). */
  rows: {
    listTransitions: (qitemId: string) => RowTransitionView[];
    /** State-preserving note append; ok:false when the row is terminal or missing
     *  (the last guard of the delivery boundary). */
    appendNote: (qitemId: string, note: string) => { ok: boolean };
    /** Lands a failed wake in the ladder's native vocabulary (last_nudge_result). */
    recordNudgeResult: (qitemId: string, result: string) => void;
    /** FRESH open-obligation ids for a seat at the send boundary (B1 recheck). */
    listOpenIds: (destinationSession: string) => string[];
  };
}

export const PARKED_OWNER_POLICY_NAME = "parked-owner-consumer";

/** Stable per-rig registration anchor: member@rig shape, policy name as slug. */
export function makeRigAnchor(rigName: string): string {
  return `${PARKED_OWNER_POLICY_NAME}@${rigName}`;
}

export function rigFromAnchor(targetSession: string): string {
  return targetSession.startsWith(`${PARKED_OWNER_POLICY_NAME}@`)
    ? targetSession.slice(PARKED_OWNER_POLICY_NAME.length + 1)
    : targetSession;
}

// ── The row-note contract (stable prefixes; parsed here and queried by the S01
//    ladder arm via the NUDGE_FAIL prefix on last_nudge_result) ──
export const RESERVE_PREFIX = "parked-owner wake reserved:";
export const CLOSE_PREFIX = "parked-owner episode closed:";
export const REFUSED_PREFIX = "parked-owner wake delivery refused:";
export const FAILED_PREFIX = "parked-owner wake delivery failed:";
export const NUDGE_FAIL_PREFIX = "failed: parked-owner wake delivery";

/** Only the transport's interactive-prompt refusal counts — a generic failed
 *  delivery is never mislabeled refused. Literal source:
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

/** The key sits immediately after the prefix, delimited by ';', ' (' or EOL —
 *  anchored on the prefix so body words can never masquerade as the key. */
function keyOfNote(note: string): string | null {
  for (const prefix of [RESERVE_PREFIX, CLOSE_PREFIX, REFUSED_PREFIX, FAILED_PREFIX]) {
    if (!note.startsWith(prefix)) continue;
    const rest = note.slice(prefix.length).trim();
    const m = rest.match(/^([^;()]+?)(?:;|\s*\(|$)/);
    return m ? m[1]!.trim() : null;
  }
  return null;
}

interface RowEpisodeState {
  openKey: string | null;
  refused: boolean;
  nextOrdinal: number;
}

/** Derive the episode state for one idsHash from the primary row's transitions.
 *  Open = a reserve note whose key has no later close note. FAILED annotates but
 *  does not close (the ladder owns the failure; the consumer never re-attempts).
 *  REFUSED marks the refusal cell for as long as the episode stays open. */
function rowEpisode(transitions: RowTransitionView[], idsHash: string): RowEpisodeState {
  const closed = new Set<string>();
  const refusedKeys = new Set<string>();
  let openKey: string | null = null;
  let reserves = 0;
  // listTransitions returns oldest-first; walk newest-first.
  for (let i = transitions.length - 1; i >= 0; i--) {
    const note = transitions[i]!.transitionNote ?? "";
    const key = keyOfNote(note);
    if (!key) continue;
    if (note.startsWith(CLOSE_PREFIX)) closed.add(key);
    else if (note.startsWith(REFUSED_PREFIX)) refusedKeys.add(key);
    else if (note.startsWith(RESERVE_PREFIX) && key.includes(`|${idsHash}#`)) {
      reserves += 1;
      if (openKey === null && !closed.has(key)) openKey = key;
    }
  }
  return { openKey, refused: openKey !== null && refusedKeys.has(openKey), nextOrdinal: reserves + 1 };
}

/** Every open reserve key on a row, across all obligation-set hashes — the set a
 *  not-parked observation must close. */
function openKeysOnRow(transitions: RowTransitionView[]): string[] {
  const closed = new Set<string>();
  const open: string[] = [];
  for (let i = transitions.length - 1; i >= 0; i--) {
    const note = transitions[i]!.transitionNote ?? "";
    const key = keyOfNote(note);
    if (!key) continue;
    if (note.startsWith(CLOSE_PREFIX)) closed.add(key);
    else if (note.startsWith(RESERVE_PREFIX) && !closed.has(key) && !open.includes(key)) open.push(key);
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

      // B2 reconciliation (bounded, immediate horizon): land recent delivery
      // outcomes onto the reserved rows. Refusals mark the refusal cell; generic
      // failures enter the ladder's native vocabulary via last_nudge_result.
      // The episode stays OPEN either way — the consumer never re-attempts.
      const recent = deps.history.listForJob(job.jobId, Math.min(deps.history.countForJob(job.jobId), 25));
      for (const e of recent) {
        if (e.outcome !== "sent" || !e.deliveryStatus || e.deliveryStatus === "ok") continue;
        const n = e.evaluationNotes ?? {};
        const key = typeof n["episodeKey"] === "string" ? (n["episodeKey"] as string) : null;
        const primary = typeof n["primaryRow"] === "string" ? (n["primaryRow"] as string) : null;
        if (!key || !primary) continue;
        const trans = deps.rows.listTransitions(primary);
        const alreadyRecorded = trans.some((t) => {
          const note = t.transitionNote ?? "";
          return (note.startsWith(REFUSED_PREFIX) || note.startsWith(FAILED_PREFIX)) && keyOfNote(note) === key;
        });
        if (alreadyRecorded) continue;
        const reason = String(n["deliveryReason"] ?? e.deliveryStatus);
        if (isRefusedInteractive(reason)) {
          deps.rows.appendNote(primary, `${REFUSED_PREFIX} ${key}; ${reason}`);
        } else {
          deps.rows.appendNote(primary, `${FAILED_PREFIX} ${key}; ${reason}`);
          deps.rows.recordNudgeResult(primary, `${NUDGE_FAIL_PREFIX} — ${reason}`);
        }
      }

      const closures: string[] = [];
      const skipped: Array<{ seat: string; why: string }> = [];
      const seats = [...d.seats].sort((a, b) => a.sessionName.localeCompare(b.sessionName));

      for (const seat of seats) {
        if (seat.parked === "indeterminate") {
          skipped.push({ seat: seat.sessionName, why: "indeterminate-not-parked" });
          continue;
        }
        const knownRows = [
          ...seat.obligations.items.map((r) => r.qitemId),
          ...seat.obligations.held.map((h) => h.qitemId),
        ].filter((v, i, a) => a.indexOf(v) === i);

        if (seat.parked === false) {
          // The episode ends when the seat reads not-parked: close every open
          // reserve key on the seat's rows, durably, on this pass (bounded —
          // one close note per open key, never a write per clean scan).
          for (const qitemId of knownRows) {
            for (const key of openKeysOnRow(deps.rows.listTransitions(qitemId))) {
              deps.rows.appendNote(qitemId, `${CLOSE_PREFIX} ${key} (seat resumed)`);
              if (!closures.includes(key)) closures.push(key);
            }
          }
          continue;
        }

        // Whole diagnosis inherited: open items PLUS unhealthy HELD rows.
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

        // S16 composition: usage-limit parks belong to S16's timed wake.
        const niReason = seat.activity.needsInput.reason ?? "";
        if (/usage.?limit/i.test(niReason)) {
          skipped.push({ seat: seat.sessionName, why: "usage-limit-defer-s16" });
          continue;
        }

        // B1 — the delivery-boundary recheck: re-read the seat's open rows NOW;
        // an obligation closed after diagnosis must not be named or woken.
        const fresh = new Set(deps.rows.listOpenIds(seat.sessionName));
        const namedIds = ids.filter((id) => fresh.has(id));
        if (namedIds.length === 0) {
          skipped.push({ seat: seat.sessionName, why: "obligation-closed-between-derive-and-wake" });
          continue;
        }

        const idsHash = idsHashOf(namedIds);
        const primaryRow = namedIds[0]!;
        const ep = rowEpisode(deps.rows.listTransitions(primaryRow), idsHash);
        if (ep.openKey !== null) {
          skipped.push({
            seat: seat.sessionName,
            why: ep.refused ? "destination-refused-interactive-prompt" : "already-woken-this-episode",
          });
          continue;
        }

        // B4 — reserve BEFORE the engine delivers: the durable receipt is this
        // transition; a terminal race at the row is the final honest guard.
        const episodeKey = `${seat.sessionName}|${idsHash}#${ep.nextOrdinal}`;
        const reserved = deps.rows.appendNote(
          primaryRow,
          `${RESERVE_PREFIX} ${episodeKey}; obligations ${namedIds.join(",")}`,
        );
        if (!reserved.ok) {
          skipped.push({ seat: seat.sessionName, why: "obligation-closed-between-derive-and-wake" });
          continue;
        }

        const message =
          `You are parked (arbitrated: idle at prompt) while holding ${namedIds.length} open ` +
          `obligation${namedIds.length === 1 ? "" : "s"}: ${namedIds.join(", ")}. ` +
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
            primaryRow,
            obligations: namedIds,
            evidence: "arbitrated-idle-at-prompt",
            episodeClosures: closures,
            skippedSeats: skipped,
          },
        };
      }

      if (closures.length > 0) {
        return { action: "skip", reason: "episode-ended", notes: { episodeClosures: closures, skippedSeats: skipped } };
      }
      if (skipped.length > 0) {
        return { action: "skip", reason: "all-parked-owners-deferred", notes: { skippedSeats: skipped } };
      }
      return { action: "skip", reason: "no-parked-owner", notes: { rig: rigName } };
    },
  };
}
