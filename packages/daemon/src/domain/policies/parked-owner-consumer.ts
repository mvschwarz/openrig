// OPR.0.5.6.24 F-14 — the parked-owner consumer.
//
// A diagnosis with zero consumers is a gate beside an open door. This policy is
// the ONE bounded consumer of the shipped parked derivation: ONE rig-level
// supervisor job per rig (anchor `parked-owner-consumer@<rigName>`), diagnosing
// the WHOLE rig through the same derivation `rig parked` serves and sending ONE
// wake to the first eligible parked owner per evaluation. The S01 ladder owns
// retries/escalation; the watchdog engine owns scheduling.
//
// Row notes describe attempts and preserve positive prompt-refusal recovery. They
// do not veto an undelivered reminder. Recorded success and actual prompt holds
// still apply. The engine owns cadence; attempts rotate eligible owners.
//
// One-oracle law (mini-req 2): the parked verdict, held-health classification,
// indeterminate arm, and obligation join all come from diagnoseRigParked — this
// module re-derives nothing and never reads raw per-runtime evidence.

import { createHash, randomUUID } from "node:crypto";
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
  /** Who wrote the transition and the row state it records. A view without them can't show that a
   *  row is unchanged, so a repeat wake is never withheld on its account. */
  actorSession?: string;
  state?: string;
  /** The persisted transition order (global across rows); orders changes that share a millisecond. */
  transitionId?: number;
}

export interface ParkedOwnerConsumerDeps {
  /** The shipped rig-scoped diagnosis (diagnoseRigParked), adapter-constructed. */
  diagnoseRig: (rigName: string) => { seats: ParkedSeatDiagnosisView[] } | null;
  /** Bounded outcomes for rotation and best-effort reporting; missing history cannot veto input. */
  history: {
    listForJob: (jobId: string, limit: number) => WatchdogHistoryEntry[];
    countForJob: (jobId: string) => number;
  };
  /** The durable row-side surfaces (queue repository, adapter-wired). */
  rows: {
    listTransitions: (qitemId: string) => RowTransitionView[];
    /** Best-effort state-preserving attempt note. Failure is not a transport refusal. */
    appendNote: (qitemId: string, note: string) => { ok: boolean };
    /** Lands a failed wake in the ladder's native vocabulary (last_nudge_result). */
    recordNudgeResult: (qitemId: string, result: string) => void;
    /** FRESH open-obligation ids for a seat at the send boundary (B1 recheck). */
    listOpenIds: (destinationSession: string) => string[];
    /** Existing delivery/recovery ownership; does not change the parked diagnosis. */
    recoveryOwnsWake?: (qitemId: string) => boolean;
  };
  /** Optional attempt provenance; the transport still binds the actual recipient. */
  occupantGeneration?: (sessionName: string) => string | null;
  /** The same enforcer's owed turn-boundary/restore/audit state, not an idle-time inference. */
  hasPendingPostCompactStage?: (sessionName: string) => boolean;
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
/** A recorded ok wake to the same known occupant waits for a change to its obligations. */
export const DELIVERED_PREFIX = "parked-owner wake delivered:";
export const NUDGE_FAIL_PREFIX = "failed: parked-owner wake delivery";
export const PARKED_OWNER_COMPACTION_PENDING = "[managed-compaction-pending] Parked-owner reminder deferred until the existing post-compact stages clear.";

/** Only the transport's interactive-prompt refusal counts — a generic failed
 *  delivery is never mislabeled refused. Literal source:
 *  session-transport.ts:1045 `Refused: '<name>' is at an interactive prompt`. */
export function isRefusedInteractive(deliveryReason: unknown): boolean {
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
  for (const prefix of [RESERVE_PREFIX, CLOSE_PREFIX, REFUSED_PREFIX, FAILED_PREFIX, DELIVERED_PREFIX]) {
    if (!note.startsWith(prefix)) continue;
    const rest = note.slice(prefix.length).trim();
    const m = rest.match(/^([^;()]+?)(?:;|\s*\(|$)/);
    return m ? m[1]!.trim() : null;
  }
  return null;
}

/** Whether what the seat holds changed after `since`: on any of the rows, a transition by the seat
 *  itself or a state change. Notes by other seats and system bookkeeping (this consumer's own
 *  reserve and close notes) aren't changes. A transition the view can't attribute counts as one, and
 *  so does a state with no baseline state to compare it with. */
function changedSince(listTransitions: (qitemId: string) => RowTransitionView[], ids: string[], seat: string, since: { ts: string; transitionId?: number }): boolean {
  for (const id of ids) {
    let prior: string | undefined;
    for (const t of listTransitions(id)) {
      // The reserve and everything before it set the baseline state. Transition order decides when the
      // view carries it, since two transitions can share a millisecond.
      const atOrBefore = since.transitionId !== undefined && t.transitionId !== undefined ? t.transitionId <= since.transitionId : t.ts <= since.ts;
      if (atOrBefore) { prior = t.state; continue; }
      if (t.actorSession === undefined || t.state === undefined || t.actorSession === seat) return true;
      if (prior !== t.state) return true;
    }
  }
  return false;
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

/** Open positive refusals and the exact obligation set reserved before delivery. */
export function openPromptRefusals(transitions: RowTransitionView[]): Array<{ key: string; ids: string[]; refusedAt: string; note: string }> {
  return openKeysOnRow(transitions).flatMap(key => {
    const refusal = transitions.find(t => t.transitionNote?.startsWith(REFUSED_PREFIX) && keyOfNote(t.transitionNote) === key);
    if (!refusal) return [];
    const reserve = transitions.find(t => t.transitionNote?.startsWith(RESERVE_PREFIX) && keyOfNote(t.transitionNote) === key);
    const ids = reserve?.transitionNote?.split("; obligations ")[1]?.split(",") ?? [];
    return [{ key, ids, refusedAt: refusal.ts, note: refusal.transitionNote ?? "" }];
  });
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

      // Missing telemetry or note writes cannot prevent a current input attempt.
      let recent: WatchdogHistoryEntry[] = [];
      try { recent = deps.history.listForJob(job.jobId, 25); } catch { /* telemetry is not admission */ }
      const latestRows = new Set<string>();
      for (const e of recent) {
        if (e.outcome === "skipped" || e.outcome === "terminal" || !e.deliveryStatus) continue;
        const n = e.evaluationNotes ?? {};
        const key = typeof n["episodeKey"] === "string" ? n["episodeKey"] : null;
        const primary = typeof n["primaryRow"] === "string" ? n["primaryRow"] : null;
        if (!key || !primary || latestRows.has(primary)) continue;
        latestRows.add(primary);
        if (e.deliveryStatus === "ok") {
          try {
            if (!deps.rows.listTransitions(primary).some(t => t.transitionNote === `${DELIVERED_PREFIX} ${key}`))
              deps.rows.appendNote(primary, `${DELIVERED_PREFIX} ${key}`);
          } catch { /* absent bookkeeping cannot prove a delivered reminder */ }
          continue;
        }
        const reason = String(n["deliveryReason"] ?? e.deliveryStatus);
        // The parked policy retries after its own stage clears; the generic wake ladder must not interrupt restore.
        if (reason.includes(PARKED_OWNER_COMPACTION_PENDING)) continue;
        try {
          const recorded = deps.rows.listTransitions(primary).some(t =>
            (t.transitionNote?.startsWith(REFUSED_PREFIX) || t.transitionNote?.startsWith(FAILED_PREFIX)) && keyOfNote(t.transitionNote!) === key);
          if (recorded) continue;
          if (isRefusedInteractive(reason)) {
            deps.rows.appendNote(primary, `${REFUSED_PREFIX} ${key}; ${reason}`);
          } else {
            deps.rows.appendNote(primary, `${FAILED_PREFIX} ${key}; ${reason}`);
            const uncertain = n["deliveryInputPhase"] === "attempted" || n["deliveryInputPhase"] === "written";
            deps.rows.recordNudgeResult(primary, `${uncertain ? "indeterminate: parked-owner wake delivery" : NUDGE_FAIL_PREFIX} — ${reason}`);
          }
        } catch { /* reporting failure is not permission to lose the next message */ }
      }

      const closures: string[] = [];
      const skipped: Array<{ seat: string; why: string }> = [];
      // Rotate after the latest physical delivery selection, including retained input. A single
      // cursor from history cannot lose an owner's turn just because a bounded window filled.
      const lastTarget = recent.find(e => e.deliveryStatus && e.deliveryTargetSession)?.deliveryTargetSession;
      const ordered = [...d.seats].sort((a, b) => a.sessionName.localeCompare(b.sessionName));
      const next = ordered.findIndex(seat => seat.sessionName === lastTarget) + 1;
      const seats = [...ordered.slice(next), ...ordered.slice(0, next)];

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
            try {
              for (const key of openKeysOnRow(deps.rows.listTransitions(qitemId))) {
                if (deps.rows.appendNote(qitemId, `${CLOSE_PREFIX} ${key} (seat resumed)`).ok && !closures.includes(key)) closures.push(key);
              }
            } catch { /* best-effort closure of old prompt-refusal records */ }
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

        // Leave this wake unreserved: the existing next pass can remind the owner after restore/audit.
        if (deps.hasPendingPostCompactStage?.(seat.sessionName)) {
          skipped.push({ seat: seat.sessionName, why: "managed-compaction-pending" });
          continue;
        }

        // B1 — the delivery-boundary recheck: re-read the seat's open rows NOW;
        // an obligation closed after diagnosis must not be named or woken.
        const fresh = new Set(deps.rows.listOpenIds(seat.sessionName));
        const namedIds = ids.filter((id) => fresh.has(id) && !deps.rows.recoveryOwnsWake?.(id));
        if (namedIds.length === 0) {
          skipped.push({ seat: seat.sessionName, why: ids.some(id => fresh.has(id)) ? "recovery-already-owns-wake" : "obligation-closed-between-derive-and-wake" });
          continue;
        }

        const idsHash = idsHashOf(namedIds);
        const primaryRow = namedIds[0]!;
        const generation = deps.occupantGeneration?.(seat.sessionName) ?? null;
        let transitions: RowTransitionView[] = [];
        try { transitions = deps.rows.listTransitions(primaryRow); } catch { /* missing history cannot prove success or refusal */ }
        const matches = (key: string) => key.startsWith(`${seat.sessionName}|${idsHash}#`);
        const generationOf = (t: RowTransitionView | undefined) => t?.transitionNote?.match(/; generation ([^;\s]+);/)?.[1] ?? null;
        const reserve = [...transitions].reverse().find(t => t.transitionNote?.startsWith(RESERVE_PREFIX) && matches(keyOfNote(t.transitionNote) ?? ""));
        const refused = openPromptRefusals(transitions).some(({ key }) => {
          const prior = generationOf(transitions.find(t => t.transitionNote?.startsWith(RESERVE_PREFIX) && keyOfNote(t.transitionNote) === key));
          return matches(key) && (generation === null || prior === null || prior === generation);
        });
        if (refused) {
          skipped.push({ seat: seat.sessionName, why: "destination-refused-interactive-prompt" });
          continue;
        }
        const lastKey = reserve && keyOfNote(reserve.transitionNote!);
        const delivered = reserve && generation !== null && generationOf(reserve) === generation
          && transitions.some(t => t.transitionNote === `${DELIVERED_PREFIX} ${lastKey}`)
          && !transitions.some(t => (t.transitionNote?.startsWith(FAILED_PREFIX) || t.transitionNote?.startsWith(REFUSED_PREFIX)) && keyOfNote(t.transitionNote!) === lastKey);
        if (delivered && !changedSince(deps.rows.listTransitions, namedIds, seat.sessionName, reserve)) {
          skipped.push({ seat: seat.sessionName, why: "unchanged-since-last-wake" });
          continue;
        }
        const episodeKey = `${seat.sessionName}|${idsHash}#${randomUUID()}`;
        let noted = false;
        try {
          noted = deps.rows.appendNote(primaryRow,
            `${RESERVE_PREFIX} ${episodeKey}; ${generation === null ? "" : `generation ${generation}; `}obligations ${namedIds.join(",")}`).ok;
        } catch { /* the current row, not the receipt write, governs the wake */ }
        if (!noted && !deps.rows.listOpenIds(seat.sessionName).includes(primaryRow)) {
          skipped.push({ seat: seat.sessionName, why: "obligation-closed-between-derive-and-wake" });
          continue;
        }

        const message =
          `You are parked (arbitrated: idle at prompt) while holding ${namedIds.length} open ` +
          `obligation${namedIds.length === 1 ? "" : "s"}: ${namedIds.join(", ")}. ` +
          `Resume the work or update each row honestly (close, park-with-wake, or hand off). ` +
          `After a recorded delivery to this occupant, this check waits for your rows to change. An interrupted or unconfirmed attempt may repeat; interactive-prompt recovery stays with the wake-or-escalate ladder. ` +
          `Held rows stay listed in rig view show held; for a claimed in-progress row, the wake-or-escalate ladder also retries a failed wake.`;
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
