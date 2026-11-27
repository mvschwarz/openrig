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
// still apply. A typed quota refusal waits for admission or obligation changes while existing recovery keeps custody.
// The engine owns cadence; attempts rotate eligible owners. After a reminder was typed and
// sent to the occupant running as an owner, that owner gets no other one for
// context.owner_min_interval_s (an hour by default); the next one names every obligation
// still open, with the ones new since the last.
//
// One-oracle law (mini-req 2): the parked verdict, held-health classification,
// indeterminate arm, and obligation join all come from diagnoseRigParked — this
// module re-derives nothing and never reads raw per-runtime evidence.

import { createHash, randomUUID } from "node:crypto";
import { parse as parseYaml } from "yaml";
import type { Policy, PolicyJob, PolicyEvaluation } from "./types.js";
import { BACKGROUND_SHELL_GRACE_MINUTES } from "../queue-pickup.js";
import { deliveryReachedSeat, historyRecordedAt, type WatchdogHistoryEntry } from "../watchdog-history-log.js";

/** Structural view of the shipped SeatParkedDiagnosis (parked-query.ts). */
export interface ParkedSeatDiagnosisView {
  sessionName: string;
  parked: boolean | "indeterminate";
  /** `since`: when the seat's arbitrated state last changed, so for a stopped seat, when it began waiting. */
  activity: {
    value: string; needsInput: { count: number; reason: string | null }; since?: string | null;
    /** #2661 (b): a live background shell, first seen at observedAt. */
    backgroundWork?: { observedAt: string } | null;
  };
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
    /** The job's newest send to one seat that was typed and submitted (status `ok`, result `accepted`) to that
     *  occupant generation, however many other rows came after it. Without it, the owner's minimum interval finds no
     *  earlier reminder and holds nothing back. */
    latestAcceptedSendTo?: (jobId: string, targetSession: string, occupantGeneration: string) => WatchdogHistoryEntry | null;
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
  /** Existing bound-terminal authority; only a positive result excludes automated reminders. */
  isTerminalSeat?: (sessionName: string) => boolean;
  /** The seat's typing guard is at queue-only (#3076): a person types there, so nothing is typed; its open rows already
   *  are the reminder in its queue. */
  isQueueOnlySeat?: (sessionName: string) => boolean;
  /** #3315: the seat's tmux server does not answer (the queue's delivery hold). Nothing is reserved or attempted until
   *  it answers again; the reminder stays owed. */
  terminalServerUnreachable?: (sessionName: string) => boolean;
  /** Opaque current node/guard revision/retained quota inputs, not a parked-state oracle. */
  retentionState?: (sessionName: string) => string | null;
  /** The clock the waiting grace is measured on; the wall clock when absent. */
  now?: () => number;
  /** #2661 (b): how long a live background shell defers the reminder; BACKGROUND_SHELL_GRACE_MINUTES when absent. */
  backgroundShellGraceMs?: number;
  /** A delivered reminder whose rows are still pending and unclaimed past PARKED_OWNER_ESCALATE_AFTER_MS: tell someone who can
   *  act, once per episode. Returns who was told; nothing is held, refused or re-sent to the seat. */
  escalateUnclaimed?: (input: { seat: string; qitemIds: string[]; deliveredAt: string; episodeKey: string; nextReminderAt?: string }) => Promise<string[]>;
}

export const PARKED_OWNER_POLICY_NAME = "parked-owner-consumer";
/** A seat that just handed work off or asked a person has only started waiting (#1933): its first reminder waits
 *  until its arbitrated waiting state has been unchanged this long. A seat at a prompt gets no grace. */
export const PARKED_OWNER_IDLE_GRACE_MS = 5 * 60_000;
/** How long a delivered reminder's rows may stay pending and unclaimed, with the seat idle and nothing changed, before
 *  someone who can act is told. */
export const PARKED_OWNER_ESCALATE_AFTER_MS = 15 * 60_000;

/** Stable per-rig registration anchor: member@rig shape, policy name as slug. */
export function makeRigAnchor(rigName: string): string {
  return `${PARKED_OWNER_POLICY_NAME}@${rigName}`;
}

export function rigFromAnchor(targetSession: string): string {
  return targetSession.startsWith(`${PARKED_OWNER_POLICY_NAME}@`)
    ? targetSession.slice(PARKED_OWNER_POLICY_NAME.length + 1)
    : targetSession;
}

/** The job context key: the minimum seconds between this job's reminders to one owner. A number sets it for every
 *  owner; an object (owner session -> seconds) sets it per owner, the others keeping the default. 0 turns it off. */
export const OWNER_MIN_INTERVAL_KEY = "owner_min_interval_s";
/** The minimum interval of an owner the job's context doesn't set. */
export const DEFAULT_OWNER_MIN_INTERVAL_S = 3600;

/** An interval in the words the reminder uses: hours when it is whole hours, minutes when whole minutes. */
export function intervalWords(seconds: number): string {
  if (seconds % 3600 === 0) return `every ${seconds / 3600} h`;
  if (seconds % 60 === 0) return `every ${seconds / 60} min`;
  return `every ${seconds} s`;
}

const validInterval = (seconds: unknown): seconds is number => typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0;

/** The valid part of context.owner_min_interval_s: a number of seconds that is not negative, or an object keeping
 *  only such entries; anything else is not set (null). */
function ownerMinIntervalSetting(context: Record<string, unknown> | null | undefined): number | Record<string, number> | null {
  const raw = context?.[OWNER_MIN_INTERVAL_KEY];
  if (validInterval(raw)) return raw;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const kept = Object.entries(raw).filter((entry): entry is [string, number] => validInterval(entry[1]));
  return kept.length === 0 ? null : Object.fromEntries(kept);
}

/** One owner's minimum interval in seconds (0: none), from the job's context or the default. */
export function ownerMinInterval(context: Record<string, unknown> | null | undefined, owner: string): number {
  const setting = ownerMinIntervalSetting(context);
  if (typeof setting === "number") return setting;
  return setting !== null && Object.hasOwn(setting, owner) ? setting[owner]! : DEFAULT_OWNER_MIN_INTERVAL_S;
}

/** The spec the daemon ensures for a rig's job. The ensure rewrites the spec on every start, so an operator's
 *  owner_min_interval_s in the prior spec is carried over (only its valid part); everything else is the default. */
export function parkedOwnerSpecYaml(rigName: string, priorSpecYaml?: string | null): string {
  const spec = `policy: ${PARKED_OWNER_POLICY_NAME}\ntarget:\n  session: ${makeRigAnchor(rigName)}\ncontext:\n  rig: ${rigName}\n`;
  let prior: unknown = null;
  try { prior = priorSpecYaml ? parseYaml(priorSpecYaml) : null; } catch { /* an unreadable prior spec keeps nothing */ }
  const context = prior !== null && typeof prior === "object" ? (prior as { context?: unknown }).context : null;
  const kept = ownerMinIntervalSetting(context !== null && typeof context === "object" ? context as Record<string, unknown> : null);
  return kept === null ? spec : `${spec}  ${OWNER_MIN_INTERVAL_KEY}: ${JSON.stringify(kept)}\n`;
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
/** A queue-only seat's reminder, held on purpose (#3076): neither a delivery nor a failure. */
export const HELD_PREFIX = "parked-owner wake held:";
/** The once-per-episode notice that a delivered reminder's rows are still unclaimed. */
export const ESCALATED_PREFIX = "parked-owner escalated:";
const QUEUE_ONLY_NO_INPUT = "; code queue_only_seat; input not_reached;";
const QUOTA_NO_INPUT = "; code retained_quota_full; input not_reached;";
const TERMINAL_NO_INPUT = "; code terminal_seat; input not_reached;";
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

/** The current machine-authored failure only: free-text suffixes never establish no-input. */
export function currentParkedOwnerNoInputFailure(transitions: RowTransitionView[]):
  { code: "retained_quota_full" | "terminal_seat"; ts: string; transitionId?: number } | null {
  const reserve = [...transitions].reverse().find(t => t.transitionNote?.startsWith(RESERVE_PREFIX));
  const key = reserve?.transitionNote && keyOfNote(reserve.transitionNote);
  if (!key || !openKeysOnRow(transitions).includes(key)) return null;
  for (const t of [...transitions].reverse()) {
    // A later held note (the seat turned queue-only, #3076) supersedes an earlier refusal: input there stops by the level.
    if (t.transitionNote?.startsWith(HELD_PREFIX)) return null;
    if (t.transitionNote?.startsWith(`${FAILED_PREFIX} ${key}${QUOTA_NO_INPUT}`)) return { code: "retained_quota_full", ts: t.ts, transitionId: t.transitionId };
    if (t.transitionNote?.startsWith(`${FAILED_PREFIX} ${key}${TERMINAL_NO_INPUT}`)) return { code: "terminal_seat", ts: t.ts, transitionId: t.transitionId };
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
        if (deliveryReachedSeat(e.deliveryStatus)) {
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
            const typedNoInput = n["deliveryInputPhase"] === "not_reached" && n["deliveryCode"] === "retained_quota_full";
            const terminal = n["deliveryInputPhase"] === "not_reached" && n["deliveryCode"] === "terminal_seat";
            const admission = typedNoInput ? QUOTA_NO_INPUT : terminal ? TERMINAL_NO_INPUT : "; detail:";
            deps.rows.appendNote(primary, `${FAILED_PREFIX} ${key}${admission} ${reason}`);
            const uncertain = n["deliveryInputPhase"] === "attempted" || n["deliveryInputPhase"] === "written";
            deps.rows.recordNudgeResult(primary, `${uncertain ? "indeterminate: parked-owner wake delivery" : NUDGE_FAIL_PREFIX}${typedNoInput ? QUOTA_NO_INPUT : terminal ? TERMINAL_NO_INPUT : ""} — ${reason}`);
          }
        } catch { /* reporting failure is not permission to lose the next message */ }
      }

      // The owner's minimum interval runs from its newest reminder that was typed and sent (the transport accepted the
      // submit, whether or not the screen confirmed it) to the occupant running as that owner now, timed from when that
      // send returned (the history row recorded then). An attempt that may or may not have been sent, a failed one, a
      // refused one, one to an earlier occupant, or one with no recorded occupant starts nothing: an unknown occupant
      // earns no quiet time.
      const lastReminder = (owner: string, generation: string | null):
        { at: number; obligations: string[]; episodeKey: string | null; primaryRow: string | null } | null => {
        if (generation === null) return null;
        let e: WatchdogHistoryEntry | null = null;
        try { e = deps.history.latestAcceptedSendTo?.(job.jobId, owner, generation) ?? null; } catch { /* unknown history holds no reminder back */ }
        const sentAt = e ? historyRecordedAt(e.historyId) : null;
        if (!e || sentAt === null || e.deliveryTargetSession !== owner || e.deliveryStatus !== "ok"
          || e.evaluationNotes?.["deliveryFact"] !== "accepted" || e.evaluationNotes?.["occupantGeneration"] !== generation) return null;
        const named = e.evaluationNotes?.["obligations"];
        const key = typeof e.evaluationNotes?.["episodeKey"] === "string" ? e.evaluationNotes["episodeKey"] as string : null;
        const row = e.evaluationNotes?.["primaryRow"];
        return { at: sentAt, obligations: Array.isArray(named) ? named.filter((id): id is string => typeof id === "string") : [],
          episodeKey: key, primaryRow: typeof row === "string" ? row : null };
      };

      // A refusal for this agent newer than its last accepted reminder is a return to ability: the attempt met a prompt,
      // the ladder closed that refusal once the prompt cleared, and the owner can take the reminder now. The interval
      // doesn't hold it back; before the interval existed, that scan sent. Only this agent's own refusal counts: the
      // episode is keyed by the seat, and the reserve behind it by the occupant it was sent to.
      const refusedSince = (rows: string[], at: number, owner: string, generation: string | null,
        generationOf: (t: RowTransitionView | undefined) => string | null): boolean => {
        for (const id of rows) {
          try {
            const transitions = deps.rows.listTransitions(id);
            for (const t of transitions) {
              if (!t.transitionNote?.startsWith(REFUSED_PREFIX) || !(Number.isFinite(Date.parse(t.ts)) && Date.parse(t.ts) > at)) continue;
              const key = keyOfNote(t.transitionNote);
              if (!key || !key.startsWith(`${owner}|`)) continue;
              const prior = generationOf(transitions.find(r => r.transitionNote?.startsWith(RESERVE_PREFIX) && keyOfNote(r.transitionNote) === key));
              if (generation === null || prior === null || prior === generation) return true;
            }
          } catch { /* unreadable history holds nothing back */ }
        }
        return false;
      };

      // A delivered reminder's rows still pending and unclaimed past the bound go to someone who can act, once per
      // episode: the escalated note is written on `noteRow` and looked for on every row in `readRows` (the rows the
      // reminder named, which may since have been claimed or closed).
      const escalateIfDue = async (seat: string, episodeKey: string, deliveredAt: string, unclaimed: string[],
        readRows: string[], noteRow: string, nextReminderAt?: string): Promise<{ episodeKey: string; failure: string } | undefined> => {
        if (!deps.escalateUnclaimed || unclaimed.length === 0
          || (deps.now?.() ?? Date.now()) - Date.parse(deliveredAt) < PARKED_OWNER_ESCALATE_AFTER_MS) return undefined;
        const escalated = (row: string) => {
          try { return deps.rows.listTransitions(row).some(t => t.transitionNote?.startsWith(`${ESCALATED_PREFIX} ${episodeKey} `)); }
          catch { return false; }
        };
        if ([...new Set([noteRow, ...readRows])].some(escalated)) return undefined;
        try {
          const told = await deps.escalateUnclaimed({ seat, qitemIds: unclaimed, deliveredAt, episodeKey, ...(nextReminderAt ? { nextReminderAt } : {}) });
          if (told.length > 0) deps.rows.appendNote(noteRow, `${ESCALATED_PREFIX} ${episodeKey} to ${told.join(", ")}`);
        } catch (error) {
          // Nothing is marked escalated, so a later pass tries again; this pass's notes say why it didn't land.
          return { episodeKey, failure: (error as { code?: string }).code ?? (error instanceof Error ? error.name : typeof error) };
        }
        return undefined;
      };

      const closures: string[] = [];
      const skipped: Array<{ seat: string; why: string; primaryRow?: string; obligations?: string[]; episodeKey?: string; refusalReason?: string;
        escalationFailure?: { episodeKey: string; failure: string }; nextReminderAt?: string }> = [];
      // Rotate after the latest physical delivery selection, including retained input. A single
      // cursor from history cannot lose an owner's turn just because a bounded window filled.
      const lastTarget = recent.find(e => e.deliveryStatus && e.deliveryTargetSession)?.deliveryTargetSession;
      const ordered = [...d.seats].sort((a, b) => a.sessionName.localeCompare(b.sessionName));
      const next = ordered.findIndex(seat => seat.sessionName === lastTarget) + 1;
      const seats = [...ordered.slice(next), ...ordered.slice(0, next)];

      for (const seat of seats) {
        // #3315: first, so it holds whatever else the seat reads as (a seat on a lost server often reads indeterminate):
        // no reservation and no transition per scan for a seat whose terminal server does not answer; the first scan
        // after it answers again sends the reminder.
        if (deps.terminalServerUnreachable?.(seat.sessionName)) {
          skipped.push({ seat: seat.sessionName, why: "terminal-server-unreachable" });
          continue;
        }
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
                if (deps.rows.appendNote(qitemId, `${CLOSE_PREFIX} ${key} (no longer observed parked)`).ok && !closures.includes(key)) closures.push(key);
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

        // #2661 (b): the turn is over but a shell the owner started still runs (a CI watch, a test suite). It is working
        // in the background, up to a ceiling, so a forgotten shell still gets its reminder. Unreserved, as above.
        const shell = seat.activity.backgroundWork?.observedAt ? Date.parse(seat.activity.backgroundWork.observedAt) : Number.NaN;
        const shellGraceMs = deps.backgroundShellGraceMs ?? BACKGROUND_SHELL_GRACE_MINUTES * 60_000;
        if (seat.activity.needsInput.count === 0 && Number.isFinite(shell) && (deps.now?.() ?? Date.now()) - shell < shellGraceMs) {
          skipped.push({ seat: seat.sessionName, why: "background-shell" });
          continue;
        }

        // A seat idle for moments has just handed off or asked someone, not got stuck holding work. The diagnosis says
        // how long its waiting state has been unchanged; with no start known, the reminder goes as before. A seat at a
        // prompt gets no grace: this attempt's refusal is what alerts whoever can clear the prompt.
        const waitingSince = seat.activity.since ? Date.parse(seat.activity.since) : Number.NaN;
        if (seat.activity.needsInput.count === 0 && Number.isFinite(waitingSince)
          && (deps.now?.() ?? Date.now()) - waitingSince < PARKED_OWNER_IDLE_GRACE_MS) {
          skipped.push({ seat: seat.sessionName, why: "waiting-grace" });
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
        // A queue-only seat: nothing is typed, its open rows are the reminder. Held once per obligation set and occupant,
        // with no nudge result (each row keeps its own) and no failure code the no-input recovery would read. Once held,
        // the unchanged hold is quiet (below), not a history row every scan.
        if (deps.isQueueOnlySeat?.(seat.sessionName) === true && deps.isTerminalSeat?.(seat.sessionName) !== true) {
          const held = `${HELD_PREFIX} ${seat.sessionName}|${idsHash}${generation === null ? "" : `; generation ${generation}`}${QUEUE_ONLY_NO_INPUT}`;
          if (transitions.some(t => t.transitionNote?.startsWith(held))) {
            skipped.push({ seat: seat.sessionName, why: "queue-only-seat-unchanged" });
            continue;
          }
          try {
            deps.rows.appendNote(primaryRow, `${held} The seat takes OpenRig's reminders only in its queue (typing guard queue-only); its open rows are the reminder. No input was written.`);
          } catch { /* the rows stay open and listed */ }
          skipped.push({ seat: seat.sessionName, why: "queue-only-seat" });
          continue;
        }
        const reserve = [...transitions].reverse().find(t => t.transitionNote?.startsWith(RESERVE_PREFIX) && matches(keyOfNote(t.transitionNote) ?? ""));
        const refused = openPromptRefusals(transitions).find(({ key }) => {
          const prior = generationOf(transitions.find(t => t.transitionNote?.startsWith(RESERVE_PREFIX) && keyOfNote(t.transitionNote) === key));
          return matches(key) && (generation === null || prior === null || prior === generation);
        });
        if (refused) {
          skipped.push({ seat: seat.sessionName, why: "destination-refused-interactive-prompt", primaryRow,
            obligations: namedIds, episodeKey: refused.key, refusalReason: refused.note });
          continue;
        }
        const lastKey = reserve && keyOfNote(reserve.transitionNote!);
        const delivered = reserve && generation !== null && generationOf(reserve) === generation
          && transitions.some(t => t.transitionNote === `${DELIVERED_PREFIX} ${lastKey}`)
          && !transitions.some(t => (t.transitionNote?.startsWith(FAILED_PREFIX) || t.transitionNote?.startsWith(REFUSED_PREFIX)) && keyOfNote(t.transitionNote!) === lastKey);
        if (delivered && !changedSince(deps.rows.listTransitions, namedIds, seat.sessionName, reserve)) {
          // Delivered, the seat idle and nothing changed: the reminder doesn't repeat. Rows still unclaimed past the bound
          // go to someone who can act, once for this episode.
          const deliveredAt = transitions.find(t => t.transitionNote === `${DELIVERED_PREFIX} ${lastKey}`)?.ts;
          const unclaimed = seat.obligations.items.filter(r => r.state === "pending" && namedIds.includes(r.qitemId)).map(r => r.qitemId);
          const escalationFailure = deliveredAt ? await escalateIfDue(seat.sessionName, lastKey!, deliveredAt, unclaimed, namedIds, primaryRow) : undefined;
          skipped.push({ seat: seat.sessionName, why: "unchanged-since-last-wake", ...(escalationFailure ? { escalationFailure } : {}) });
          continue;
        }
        let retentionState: string | null = null;
        try { retentionState = deps.retentionState?.(seat.sessionName) ?? null; } catch { /* unknown is not evidence that admission recovered */ }
        const encodedRetentionState = Buffer.from(retentionState ?? "unknown").toString("base64url");
        const open = lastKey != null && openKeysOnRow(transitions).includes(lastKey);
        const sameGeneration = generation === null || generationOf(reserve) === null || generationOf(reserve) === generation;
        const quotaFailed = open && sameGeneration && transitions.some(t => t.transitionNote?.startsWith(FAILED_PREFIX)
          && keyOfNote(t.transitionNote) === lastKey && t.transitionNote.startsWith(`${FAILED_PREFIX} ${lastKey}${QUOTA_NO_INPUT}`));
        const priorRetentionState = reserve?.transitionNote?.match(/; retention-state ([^;\s]+);/)?.[1];
        if (quotaFailed && reserve && (retentionState === null || priorRetentionState === encodedRetentionState)
          && !changedSince(deps.rows.listTransitions, namedIds, seat.sessionName, reserve)) {
          // The existing row failure/recovery keeps custody. Do not recreate attempts or row notes every tick.
          skipped.push({ seat: seat.sessionName, why: "retention-quota-unchanged" });
          continue;
        }
        const terminal = deps.isTerminalSeat?.(seat.sessionName) === true;
        if (terminal && open && sameGeneration && transitions.some(t => t.transitionNote?.startsWith(FAILED_PREFIX)
          && keyOfNote(t.transitionNote) === lastKey && t.transitionNote.startsWith(`${FAILED_PREFIX} ${lastKey}${TERMINAL_NO_INPUT}`))) {
          skipped.push({ seat: seat.sessionName, why: "terminal-seat" });
          continue;
        }
        // The owner's minimum interval: nothing is reserved until it ends, and the next reminder names every obligation
        // still open, the ones opened since the last reminder included. Only a reminder typed and sent to this occupant counts.
        // A seat at a prompt is not held: this attempt's refusal is what alerts whoever can clear the prompt. The last
        // reminder's rows still unclaimed past the bound are escalated as when nothing changed.
        const minIntervalS = ownerMinInterval(job.context, seat.sessionName);
        const last = minIntervalS === 0 ? null : lastReminder(seat.sessionName, generation);
        if (!terminal && last && seat.activity.needsInput.count === 0
          && (deps.now?.() ?? Date.now()) - last.at < minIntervalS * 1000
          // The rows the reminder named are read too: a refusal recorded on one of them still counts after it closes.
          && !refusedSince([...new Set([...knownRows, ...last.obligations])], last.at, seat.sessionName, generation, generationOf)) {
          const unclaimed = seat.obligations.items.filter(r => r.state === "pending" && last.obligations.includes(r.qitemId)
            && namedIds.includes(r.qitemId)).map(r => r.qitemId);
          const nextReminderAt = new Date(last.at + minIntervalS * 1000).toISOString();
          const escalationFailure = last.episodeKey && unclaimed.length > 0
            ? await escalateIfDue(seat.sessionName, last.episodeKey, new Date(last.at).toISOString(), unclaimed,
              [...(last.primaryRow ? [last.primaryRow] : []), ...last.obligations], unclaimed[0]!, nextReminderAt)
            : undefined;
          skipped.push({ seat: seat.sessionName, why: "owner-min-interval", nextReminderAt, ...(escalationFailure ? { escalationFailure } : {}) });
          continue;
        }
        const newSinceLastWake = last ? namedIds.filter(id => !last.obligations.includes(id)) : [];

        const episodeKey = `${seat.sessionName}|${idsHash}#${randomUUID()}`;
        let noted = false;
        try {
          noted = deps.rows.appendNote(primaryRow,
            `${RESERVE_PREFIX} ${episodeKey}; ${generation === null ? "" : `generation ${generation}; `}retention-state ${encodedRetentionState}; obligations ${namedIds.join(",")}`).ok;
        } catch { /* the current row, not the receipt write, governs the wake */ }
        if (!noted && !deps.rows.listOpenIds(seat.sessionName).includes(primaryRow)) {
          skipped.push({ seat: seat.sessionName, why: "obligation-closed-between-derive-and-wake" });
          continue;
        }

        if (terminal) {
          const reason = "Automated reminders cannot be consumed by a terminal seat; route it to an agent seat. No input was written.";
          try { deps.rows.appendNote(primaryRow, `${FAILED_PREFIX} ${episodeKey}${TERMINAL_NO_INPUT} ${reason}`); } catch { /* keep the obligation visible if reporting is unavailable */ }
          try { deps.rows.recordNudgeResult(primaryRow, `failed:terminal-seat: ${reason}`); } catch { /* no reporting failure permits terminal input */ }
          skipped.push({ seat: seat.sessionName, why: "terminal-seat" });
          continue;
        }

        const message =
          `You are parked (arbitrated: idle at prompt) while holding ${namedIds.length} open ` +
          `obligation${namedIds.length === 1 ? "" : "s"}: ${namedIds.join(", ")}. ` +
          `Resume the work or update each row honestly (close, park-with-wake, or hand off). ` +
          `If you're waiting on a person's answer, don't ask again; hold the row with rig queue block <id> --on <who> --wake-after <duration> ` +
          `(a hold on a person also needs --summary and --evidence-ref unless the row has them). ` +
          `After a recorded delivery to this occupant, this check waits for your rows to change. An interrupted or unconfirmed attempt may repeat; interactive-prompt recovery stays with the wake-or-escalate ladder. ` +
          `Held rows stay listed in rig view show held; for a claimed in-progress row, the wake-or-escalate ladder also retries a failed wake.` +
          (!last ? "" :
            ` This check reminds you at most once ${intervalWords(minIntervalS)}; this reminder covers the eligible items listed here` +
            ` since the last one at ${new Date(last.at).toISOString()}` +
            (newSinceLastWake.length > 0 ? `, new since then: ${newSinceLastWake.join(", ")}` : "") + ".");
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
            // The occupant this reminder goes to: its interval is that occupant's, never a successor's.
            ...(generation === null ? {} : { occupantGeneration: generation }),
            ...(last ? { ownerMinIntervalS: minIntervalS, newSinceLastWake } : {}),
            evidence: Number.isFinite(shell) && seat.activity.needsInput.count === 0 ? "arbitrated-idle-at-prompt; background-shell-past-ceiling" : "arbitrated-idle-at-prompt",
            episodeClosures: closures,
            skippedSeats: skipped,
          },
        };
      }

      if (closures.length > 0) {
        return { action: "skip", reason: "episode-ended", notes: { episodeClosures: closures, skippedSeats: skipped } };
      }
      // Only queue-only seats already held, and nothing else: nothing new to record (#3076).
      if (skipped.length > 0 && skipped.every(({ why }) => why === "queue-only-seat-unchanged")) {
        return { action: "skip", reason: "queue_only_seat_unchanged", notes: { skippedSeats: skipped } };
      }
      // #3315: deferred only because the terminal server is gone: quiet, like the clean scan, so a long loss writes no
      // history per scan; the loss itself is recorded once (tmux.server_gone).
      if (skipped.length > 0 && skipped.every(entry => entry.why === "terminal-server-unreachable")) {
        return { action: "skip", reason: "terminal-server-unreachable", notes: { skippedSeats: skipped } };
      }
      if (skipped.length > 0) {
        return { action: "skip", reason: "all-parked-owners-deferred", notes: { skippedSeats: skipped } };
      }
      return { action: "skip", reason: "no-parked-owner", notes: { rig: rigName } };
    },
  };
}
