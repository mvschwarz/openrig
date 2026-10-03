import type { ArbitratedSeatState } from "./activity-taxonomy.js";
import type { OperatorDeliveryEngine } from "./gateway/operator-delivery-engine.js";
import { openPromptRefusals, CLOSE_PREFIX, REFUSED_PREFIX } from "./policies/parked-owner-consumer.js";
import { findQueueRecovery, recoveryTag } from "./queue-recovery.js";
import { lastMeaningfulTransition, type WaitingView } from "./queue-waiting.js";
// S01 (OPR.0.5.5.1) — WAKE OR ESCALATE ON BATONS. A handoff whose wake fails must never
// silently park: today one failed nudge is recorded and nothing follows (the measured
// dominant 0.5.3 failure class — a perfect surviving packet, a recipient never woken).
// This module gives every baton (handed-off row) whose wake FAILED a bounded retry ladder,
// then named escalation rungs — the destination's orchestrator (aggregated per destination,
// never a duplicate row per baton), then the operator surface — each step a recorded
// transition, none silent.
//
// NAMED INVARIANT (mini-req 7): THE ROW CARRIES THE OBLIGATION EXACTLY-ONCE; THE WAKE IS
// AT-LEAST-ONCE. The ladder retries the NUDGE — an envelope pointer at the row — never the
// content, so a re-attempt can never double-deliver the obligation.
//
// AM-P3-F6: the transitions ARE the ladder state. Attempts, rungs, suspension and
// exhaustion are all markers on the row's transition log, and every tick DERIVES its
// position from them — a daemon restart can neither forget a ladder (silent park returns)
// nor restart its counts (cap violated by repetition). Marker vocabulary is imported from
// queue-stuck-sweep (AM-P3-F5): S02's undelivered half skips rows whose ladder is live and
// remains the net for the exhausted handback; created-with-destination obligations stay
// S02 territory (the baton filter here is handed_off_from — the named hole is explicit).
//
// AM-P3-F1: `rendered-unconfirmed`-class outcomes (queue grammar: delivered-ack-pending,
// indeterminate:*, gateway-owned:*) NEVER retry — the measured false-negative class — but
// they enter the ladder on a confirmation path: unconfirmed + zero pickup evidence within
// the config-keyed window escalates directly, skipping the retry rung entirely (escalation
// is not a re-send; it cannot double-deliver).
//
// AM-P3-F2: suspension is DERIVED, never declared — the destination's post-swap state
// (nodes.handover_at within a bounded grace; the handover txn itself is atomic and
// unobservable) suspends wake attempts, with suspend/resume recorded. The manually
// declared window survives ONLY as an operator override (OPENRIG_WAKE_SUSPEND, fresh-read).
//
// AM-P3-F4 + AM-R25: rungs DELIVER, not just record. The orchestrator rung attempts a real
// wake on the aggregate escalation row; a rung whose own wake fails advances after one
// bounded cycle. OPR.0.5.6.1 (A1.2/AM-F3): the operator rung's delivery leg IS the
// delivery rules engine — the rung dispatches through the injected engine port, records
// dispatched-to-engine with the decision, and the ladder does NOT advance past the rung
// until the engine's outcome resolves (a posted receipt or a delivery-termination record);
// exactly one delivery per episode, never immediate-plus-deferred. When no engine port is
// wired (fixtures, pre-wire boot), the rung keeps the pre-engine floor honestly
// (escalation view + daemon-health) and exhausts as before.

import type Database from "better-sqlite3";
import type { QueueItem, QueueRepository } from "./queue-repository.js";
import { deriveUsageLimitPools, type UsageLimitPool } from "./provider/provider-signals.js";
import type { FourBlockReadModel } from "./provider/provider-types.js";
import {
  USAGE_LIMIT_BLOCKER_TAG,
  USAGE_LIMIT_POOL_TAG_PREFIX,
} from "./queue-wake-repository.js";
import { SettingsStore } from "./user-settings/settings-store.js";
import {
  LADDER_ATTEMPT_PREFIX,
  LADDER_RUNG_PREFIX,
  LADDER_EXHAUSTED_PREFIX,
  defaultResolveOrchestrator,
  resolveSessionNodeId,
} from "./queue-stuck-sweep.js";

export const WAKE_RETRY_INTERVAL_KEY = "queue.wake_retry_interval_seconds";
export const DEFAULT_WAKE_RETRY_INTERVAL_SECONDS = 300;
export const WAKE_RETRY_CAP_KEY = "queue.wake_retry_cap";
export const DEFAULT_WAKE_RETRY_CAP = 3;
export const WAKE_UNCONFIRMED_WINDOW_KEY = "queue.wake_unconfirmed_window_minutes";
export const DEFAULT_WAKE_UNCONFIRMED_WINDOW_MINUTES = 30;
export const WAKE_SWAP_GRACE_KEY = "queue.wake_swap_grace_seconds";
export const DEFAULT_WAKE_SWAP_GRACE_SECONDS = 180;

// S16: this margin absorbs provider reset granularity and host/provider clock
// skew. Fleet dedup already prevents a thundering herd; narrowing it toward zero
// would recreate a wake delivered while the seat is still usage-limited.
export const USAGE_LIMIT_JITTER_FLOOR_SECONDS = 30;
export const USAGE_LIMIT_JITTER_CEILING_SECONDS = 90;
export function drawUsageLimitJitterSeconds(random: () => number = Math.random): number {
  return USAGE_LIMIT_JITTER_FLOOR_SECONDS + Math.floor(
    random() * (USAGE_LIMIT_JITTER_CEILING_SECONDS - USAGE_LIMIT_JITTER_FLOOR_SECONDS + 1),
  );
}

/** The operator-declared suspension override (F2: override, never the mechanism).
 *  Format: comma-separated `<session>:<untilIso>` pairs; fresh-read every tick. */
export const WAKE_SUSPEND_OVERRIDE_ENV = "OPENRIG_WAKE_SUSPEND";

/** Stamp tag on the per-destination aggregate escalation row. */
export const WAKE_ESCALATION_TAG = "wake-escalation";
export function escalationDedupTag(destination: string): string {
  return `wake-escalation:${destination}`;
}

// Suspension markers (attempt/rung/exhausted come from the S02 seam vocabulary).
export const LADDER_SUSPEND_PREFIX = "ladder-suspend:";
export const LADDER_RESUME_PREFIX = "ladder-resume:";

const LADDER_ACTOR = "wake-ladder@system";

export interface WakeLadderStatusSnapshot {
  lastTickAt: string | null;
  lastOutcome: "clean" | "actions" | "failed" | null;
  lastError: string | null;
  consecutiveFailures: number;
  activeLadders: number;
  escalationsOpen: number;
  exhaustedTotal: number;
}

export interface WakeLadderStatus {
  record(outcome: "clean" | "actions" | "failed", detail?: { error?: string; active?: number; escalations?: number; exhausted?: number }): void;
  snapshot(): WakeLadderStatusSnapshot;
}

/** The loop's observable heartbeat — rides /healthz beside the S02 sweep's. */
export function createWakeLadderStatus(): WakeLadderStatus {
  const state: WakeLadderStatusSnapshot = {
    lastTickAt: null,
    lastOutcome: null,
    lastError: null,
    consecutiveFailures: 0,
    activeLadders: 0,
    escalationsOpen: 0,
    exhaustedTotal: 0,
  };
  return {
    record(outcome, detail) {
      state.lastTickAt = new Date().toISOString();
      state.lastOutcome = outcome;
      state.lastError = outcome === "failed" ? (detail?.error ?? "unknown error") : null;
      state.consecutiveFailures = outcome === "failed" ? state.consecutiveFailures + 1 : 0;
      if (detail?.active !== undefined) state.activeLadders = detail.active;
      if (detail?.escalations !== undefined) state.escalationsOpen = detail.escalations;
      if (detail?.exhausted) state.exhaustedTotal += detail.exhausted;
    },
    snapshot() {
      return { ...state };
    },
  };
}

/** The operator seat for the self-skip floor (workspace.operator_seat_name — the
 *  conventional `operator-${USER}@kernel`); null when settings resolution fails. */
function resolveOperatorSeat(): string | null {
  try {
    const v = new SettingsStore().resolveOne("workspace.operator_seat_name" as never).value;
    return typeof v === "string" && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

function resolveNumber(key: string, fallback: number): number {
  try {
    const v = new SettingsStore().resolveOne(key as never).value;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  } catch {
    return fallback;
  }
}

export const resolveWakeRetryIntervalSeconds = (): number =>
  resolveNumber(WAKE_RETRY_INTERVAL_KEY, DEFAULT_WAKE_RETRY_INTERVAL_SECONDS);
export const resolveWakeRetryCap = (): number => resolveNumber(WAKE_RETRY_CAP_KEY, DEFAULT_WAKE_RETRY_CAP);
export const resolveWakeUnconfirmedWindowMinutes = (): number =>
  resolveNumber(WAKE_UNCONFIRMED_WINDOW_KEY, DEFAULT_WAKE_UNCONFIRMED_WINDOW_MINUTES);
export const resolveWakeSwapGraceSeconds = (): number =>
  resolveNumber(WAKE_SWAP_GRACE_KEY, DEFAULT_WAKE_SWAP_GRACE_SECONDS);

export interface WakeLadderDeps {
  db: Database.Database;
  queueRepo: QueueRepository;
  status?: WakeLadderStatus;
  /** Attempt a wake to `target` for `qitemId`; returns the outcome in the queue nudge
   *  grammar (verified | delivered-ack-pending | indeterminate:* | failed:*). Default
   *  rides maybeNudge — the wake is the envelope pointer, never the content. */
  attemptWake?: (qitemId: string, target: string) => Promise<string>;
  resolveOrchestrator?: (session: string) => string | null;
  retryIntervalSeconds?: number;
  retryCap?: number;
  unconfirmedWindowMinutes?: number;
  swapGraceSeconds?: number;
  /** Shipped provider telemetry, injected by the daemon. Absent/read failure keeps
   *  every pre-S16 ladder path byte-identical. */
  getProviderReadModel?: () => Promise<Pick<FourBlockReadModel, "signals" | "bindings">>;
  usageLimitJitterSeconds?: number;
  /** Cached arbitrated activity only: no new probe or native input. */
  readPromptState?: (destination: string, refusedAt: string) => "blocked" | "clear" | "unknown";
  now?: Date;
  log?: (line: string) => void;
  /** OPR.0.5.6.1 — the operator rung's delivery leg. dispatchEscalation delivers
   *  (or defers) through the rules engine and reports whether the outcome
   *  resolved synchronously; absent = pre-engine floor behavior. */
  deliveryEngine?: OperatorDeliveryEngine;
}

export interface WakeLadderAction {
  qitemId: string;
  action: "retry" | "escalate-orchestrator" | "escalate-operator" | "suspend" | "resume" | "exhaust" | "park-usage-limit";
  target?: string;
}

export interface WakeLadderTickResult {
  outcome: "clean" | "actions" | "failed";
  actions: WakeLadderAction[];
  error?: string;
}

interface MarkerRow {
  ts: string;
  transition_note: string | null;
}

interface LadderView {
  attempts: number;
  lastMarkerTs: number | null;
  orchRung: boolean;
  orchRungFailed: boolean;
  opRung: boolean;
  opEngineDispatched: boolean;
  opEngineKey: string | null;
  opOutcomeResolved: boolean;
  opUnresolved: string | null;
  exhausted: boolean;
  suspendEpisodeOpen: boolean;
  firstMarkerTs: number | null;
}

function readLadder(db: Database.Database, qitemId: string, after = lastMeaningfulTransition(db, qitemId)?.id ?? 0): LadderView {
  const rows = db
    .prepare("SELECT ts, transition_note FROM queue_transitions WHERE qitem_id = ? AND transition_id > ? ORDER BY transition_id")
    .all(qitemId, after) as MarkerRow[];
  const view: LadderView = {
    attempts: 0,
    lastMarkerTs: null,
    orchRung: false,
    orchRungFailed: false,
    opRung: false,
    opEngineDispatched: false,
    opEngineKey: null,
    opOutcomeResolved: false,
    opUnresolved: null,
    exhausted: false,
    suspendEpisodeOpen: false,
    firstMarkerTs: null,
  };
  let suspends = 0;
  let resumes = 0;
  for (const r of rows) {
    const note = r.transition_note ?? "";
    const isAttempt = note.startsWith(LADDER_ATTEMPT_PREFIX);
    const isRung = note.startsWith(LADDER_RUNG_PREFIX);
    if (isAttempt) view.attempts += 1;
    if (isRung && /^escalation-rung:\s*orchestrator/.test(note)) {
      view.orchRung = true;
      view.orchRungFailed = /outcome=failed:/.test(note);
    }
    if (isRung && /^escalation-rung:\s*operator/.test(note)) view.opRung = true;
    if (isRung && note.startsWith(`${LADDER_RUNG_PREFIX} operator unresolved-route decision=`)) {
      view.opUnresolved = note.slice(`${LADDER_RUNG_PREFIX} operator unresolved-route decision=`.length);
    }
    if (isRung && /^escalation-rung:\s*operator dispatched-to-engine/.test(note)) {
      view.opEngineDispatched = true;
      const keyMatch = note.match(/notification_key=(\S+)/);
      if (keyMatch) view.opEngineKey = keyMatch[1]!;
      // R2 003f4786: the key derives BEFORE any resolution note counts — a
      // receipt that PRECEDES this dispatch belongs to an older episode, so
      // any provisional resolution seen so far is discarded here.
      view.opOutcomeResolved = false;
    }
    // Outcome resolution (AM-F3, R1 B-3, R2 pre-marker discriminator): the S14
    // posted receipt or the termination record closes the episode ONLY when it
    // (a) follows the dispatch marker chronologically (this loop resets the
    // flag at each dispatch, so pre-marker notes never survive) and (b) carries
    // the dispatched key when the marker is keyed. An unkeyed dispatch
    // (injected legacy ports) keeps the any-following-note shape.
    if (note.startsWith("slack-owner-notification-posted ") || note.startsWith("delivery-termination:")) {
      if (view.opEngineKey === null || note.split(/\s+/).includes(`notification_key=${view.opEngineKey}`)) {
        view.opOutcomeResolved = true;
      }
    }
    if (note.startsWith(LADDER_EXHAUSTED_PREFIX)) view.exhausted = true;
    if (note.startsWith(LADDER_SUSPEND_PREFIX)) suspends += 1;
    if (note.startsWith(LADDER_RESUME_PREFIX)) resumes += 1;
    if (isAttempt || isRung) {
      const t = Date.parse(r.ts);
      if (!Number.isNaN(t)) {
        view.lastMarkerTs = Math.max(view.lastMarkerTs ?? t, t);
        view.firstMarkerTs = view.firstMarkerTs === null ? t : Math.min(view.firstMarkerTs, t);
      }
    }
  }
  view.suspendEpisodeOpen = suspends > resumes;
  return view;
}

/** Pickup evidence (the S04 receipt join, F1): a claim, a heartbeat, or any transition
 *  that is neither a founding record nor ladder machinery — someone real moved. */
function hasPickupEvidence(db: Database.Database, row: Pick<QueueItem, "qitemId" | "claimedAt" | "lastHeartbeat">): boolean {
  if (row.claimedAt) return true;
  // Keep this null arm for the 0.5.7 mechanized-pull turn-end hook that knows the in-flight row;
  // it is the first honest row-scoped writer, and wiring reopens only in that slice.
  if (row.lastHeartbeat) return true;
  const rows = db
    .prepare("SELECT transition_note FROM queue_transitions WHERE qitem_id = ?")
    .all(row.qitemId) as Array<{ transition_note: string | null }>;
  for (const r of rows) {
    const note = r.transition_note ?? "";
    if (note === "created") continue;
    if (note.startsWith("handoff")) continue;
    if (
      note.startsWith(LADDER_ATTEMPT_PREFIX) ||
      note.startsWith(LADDER_RUNG_PREFIX) ||
      note.startsWith(LADDER_EXHAUSTED_PREFIX) ||
      note.startsWith(LADDER_SUSPEND_PREFIX) ||
      note.startsWith(LADDER_RESUME_PREFIX) ||
      // OPR.0.5.6.1: delivery-leg records are ladder machinery, not pickup —
      // a receipt/termination/deferral stamp must not pull the row out of the
      // ladder before the resolution pass reads it.
      note.startsWith("slack-owner-notification-") ||
      note.startsWith("delivery-termination:") ||
      note.startsWith("delivery-deferral-")
    )
      continue;
    return true;
  }
  return false;
}

type WakeMode = "failed" | "unconfirmed";

function classifyWakeResult(lastNudgeResult: string | null): WakeMode | null {
  if (!lastNudgeResult) return null;
  if (lastNudgeResult.startsWith("failed:")) return "failed";
  // #344 follow-up — a typing-guard refusal (retained:) wrote NO pane input, so an
  // unclaimed baton keeps a retry path instead of stranding behind a terminal
  // recovery. Admission is scoped to unclaimed batons by unclaimedWakeMode(): the
  // claimed parked-owner arm's retry readback still selects `failed:%` only, so
  // admitting retained there would make recovery OWN a row that nothing retries.
  // Retry behaviour, as it actually runs: the first retry re-probes the guard and
  // records a fresh attempt; later retries reuse the same delivery id, whose
  // retained readback returns `retained` again even after the guard has cleared —
  // so the row re-probes once and then escalates rather than looping probes.
  if (lastNudgeResult.startsWith("retained:")) return "failed";
  if (
    lastNudgeResult === "delivered-ack-pending" ||
    lastNudgeResult.startsWith("indeterminate:") ||
    lastNudgeResult.startsWith("gateway-owned:")
  )
    return "unconfirmed";
  return null; // verified (or unknown vocabulary) — never enters the ladder
}

/** A retained (typing-guard) result is retryable ONLY for an unclaimed baton. The
 * ladder's claimed-row retry query selects `failed:%` only, so a claimed row whose
 * last result is `retained:` would be owned without ever being retried — the
 * parked-owner watchdog would then skip it. Keep the retained class scoped to the
 * unclaimed baton path the PR is about; every other state keeps the pre-change
 * `null` classification. */
function unclaimedWakeMode(row: Pick<QueueItem, "state" | "claimedAt" | "handedOffFrom" | "lastNudgeResult">): WakeMode | null {
  const mode = classifyWakeResult(row.lastNudgeResult);
  if (mode === null) return null;
  const retained = row.lastNudgeResult?.startsWith("retained:") ?? false;
  if (retained && !(row.state === "pending" && !row.claimedAt && row.handedOffFrom)) return null;
  return mode;
}

/** Another consumer may diagnose the same parked seat, but the existing
 * delivery ladder/disposition already owns these obligations' next wake.
 * Diagnosis remains visible; only duplicate delivery is suppressed. */
export function queueRecoveryOwnsWake(db: Database.Database, row: QueueItem | null): boolean {
  if (!row || !["pending", "in-progress", "blocked"].includes(row.state)) return false;
  const recovery = findQueueRecovery(db, row.qitemId);
  if (recovery) {
    const endedPrompt = !["pending", "in-progress", "blocked"].includes(recovery.state)
      && Boolean(db.prepare(`SELECT 1 FROM queue_items q WHERE q.qitem_id = ?
        AND json_valid(q.tags) AND EXISTS (SELECT 1 FROM json_each(q.tags) WHERE value = ?)
        AND EXISTS (SELECT 1 FROM queue_transitions t WHERE t.qitem_id = q.qitem_id
          AND t.actor_session = q.source_session AND t.transition_note = ?)`)
        .get(recovery.qitemId, PROMPT_ALERT_TAG, PROMPT_RETIRED_NOTE));
    if (!endedPrompt) return true;
  }
  const mode = unclaimedWakeMode(row);
  if (!mode) return false;
  if (row.state === "pending" && !row.claimedAt && row.handedOffFrom) {
    return mode === "failed" || !hasPickupEvidence(db, row);
  }
  return row.state === "in-progress" && mode === "failed" && Boolean(db.prepare(
    "SELECT 1 FROM queue_transitions WHERE qitem_id = ? AND transition_note LIKE 'parked-owner wake delivery failed:%' LIMIT 1",
  ).get(row.qitemId));
}

/** F2 — derived suspension: the destination's post-swap grace (nodes.handover_at within
 *  the bound), or the operator-declared override. Returns the reason, or null. */
function readSuspension(
  db: Database.Database,
  destination: string,
  graceSeconds: number,
  now: Date,
): { reason: string; until: string } | null {
  const override = process.env[WAKE_SUSPEND_OVERRIDE_ENV];
  if (override) {
    for (const entry of override.split(",")) {
      const idx = entry.lastIndexOf(":");
      const session = entry.slice(0, entry.indexOf(":"));
      const untilIso = entry.slice(entry.indexOf(":") + 1);
      void idx;
      if (session === destination) {
        const until = Date.parse(untilIso);
        if (!Number.isNaN(until) && now.getTime() < until) {
          return { reason: `operator override (${WAKE_SUSPEND_OVERRIDE_ENV}) until ${untilIso}`, until: untilIso };
        }
      }
    }
  }
  // The durable session→node binding — never a string transform of the session name
  // (canonical dash-form sessions and dotted logical ids are independent identities).
  const nodeId = resolveSessionNodeId(db, destination);
  if (!nodeId) return null;
  const row = db
    .prepare("SELECT handover_at AS handoverAt FROM nodes WHERE id = ? LIMIT 1")
    .get(nodeId) as { handoverAt: string | null } | undefined;
  if (!row?.handoverAt) return null;
  const swapAt = Date.parse(row.handoverAt);
  if (Number.isNaN(swapAt)) return null;
  const ageS = (now.getTime() - swapAt) / 1000;
  if (ageS >= 0 && ageS < graceSeconds) {
    return { reason: `destination in post-swap grace (handover ${Math.round(ageS)}s ago, grace ${graceSeconds}s)`, until: new Date(swapAt + graceSeconds * 1000).toISOString() };
  }
  return null;
}

function suspensionReason(db: Database.Database, destination: string, graceSeconds: number, now: Date): string | null {
  return readSuspension(db, destination, graceSeconds, now)?.reason ?? null;
}

/** Read the existing ladder's next eligible action; never create an intent,
 * reserve a retry, consume provider state or change its policy. The scheduler
 * still makes the final live-state decision at delivery time. */
export function readWakeLadderBackstop(db: Database.Database, qitemId: string): WaitingView["nextBackstop"] | null {
  const row = db.prepare(`SELECT qitem_id AS qitemId, state, source_session AS sourceSession,
    destination_session AS destinationSession, claimed_at AS claimedAt, handed_off_from AS handedOffFrom,
    last_heartbeat AS lastHeartbeat, last_nudge_result AS lastNudgeResult,
    last_nudge_attempt AS lastNudgeAttempt, ts_created AS tsCreated FROM queue_items WHERE qitem_id = ?`)
    .get(qitemId) as Pick<QueueItem, "qitemId" | "state" | "sourceSession" | "destinationSession" | "claimedAt" | "handedOffFrom" | "lastHeartbeat" | "lastNudgeResult" | "lastNudgeAttempt" | "tsCreated"> | undefined;
  if (!row || !["pending", "in-progress"].includes(row.state)) return null;
  const recovery = findQueueRecovery(db, qitemId);
  const disposition = recovery ? db.prepare("SELECT destination_session, tags FROM queue_items WHERE qitem_id = ?")
    .get(recovery.qitemId) as { destination_session: string; tags: string | null } : null;
  const recoveryBackstop = (): WaitingView["nextBackstop"] => ({
    owner: disposition!.destination_session, mechanism: `queue-recovery:${["pending", "in-progress", "blocked"].includes(recovery!.state) ? "delegated" : "resolved"}`,
    dueAt: null, intervalSeconds: null, recovery: { qitemId: recovery!.qitemId, state: recovery!.state },
    note: "Current recovery disposition owns the continuation; inspect that row. New source evidence is evaluated afresh.",
  });
  if (recovery && !["pending", "in-progress", "blocked"].includes(recovery.state)) return recoveryBackstop();
  if (recovery && disposition && JSON.parse(disposition.tags ?? "[]").includes(PROMPT_ALERT_TAG)) return recoveryBackstop();
  const mode = unclaimedWakeMode(row);
  const eligible = (row.state === "pending" && !row.claimedAt && row.handedOffFrom)
    || (row.state === "in-progress" && row.claimedAt && mode === "failed" && db.prepare(
      "SELECT 1 FROM queue_transitions WHERE qitem_id = ? AND transition_note LIKE 'parked-owner wake delivery failed:%' LIMIT 1",
    ).get(qitemId));
  if (!eligible || !mode || (mode === "unconfirmed" && hasPickupEvidence(db, row))) return recovery ? recoveryBackstop() : null;
  const ladder = readLadder(db, qitemId);
  if (ladder.exhausted) return recovery ? recoveryBackstop() : {
    owner: defaultResolveOrchestrator(db, row.destinationSession) ?? row.destinationSession,
    mechanism: "queue-wake-ladder:exhausted; queue-stuck-sweep:undelivered", dueAt: null, intervalSeconds: null,
    note: "No further ladder retry. Inspect the retained exhaustion and delivery evidence; the stuck sweep is the safety net.",
  };
  const interval = resolveWakeRetryIntervalSeconds(), cap = resolveWakeRetryCap(), now = new Date();
  const retry = mode === "failed" && ladder.attempts < cap;
  if (!retry && recovery && !JSON.parse(disposition!.tags ?? "[]").includes(WAKE_ESCALATION_TAG)) return recoveryBackstop();
  const last = ladder.lastMarkerTs ?? (row.lastNudgeAttempt ? Date.parse(row.lastNudgeAttempt) : null);
  let due = last === null || Number.isNaN(last) ? now.getTime() : last + interval * 1000;
  if (mode === "unconfirmed") {
    // The existing gate compares rounded age-minutes; display its actual
    // earliest eligibility, without changing that policy to fit the face.
    due = Math.max(due, Date.parse(row.tsCreated) + Math.max(0, resolveWakeUnconfirmedWindowMinutes() - 0.5) * 60_000);
  }
  if (retry) {
    // Same per-destination attempt budget as the executing ladder. An attempt
    // exactly on the lower bound still counts, hence the one millisecond edge.
    const attempts = db.prepare(`SELECT t.ts FROM queue_transitions t JOIN queue_items q ON q.qitem_id = t.qitem_id
      WHERE q.destination_session = ? AND t.transition_note LIKE ? AND t.ts >= ? ORDER BY t.ts DESC LIMIT ?`)
      .all(row.destinationSession, `${LADDER_ATTEMPT_PREFIX}%`, new Date(now.getTime() - interval * 1000).toISOString(), cap) as Array<{ ts: string }>;
    if (attempts.length >= cap) due = Math.max(due, Date.parse(attempts[cap - 1]!.ts) + interval * 1000 + 1);
  }
  const suspension = readSuspension(db, row.destinationSession, resolveWakeSwapGraceSeconds(), now);
  if (suspension) due = Math.max(due, Date.parse(suspension.until));
  const orch = defaultResolveOrchestrator(db, row.destinationSession);
  const operator = ladder.orchRung || orch === null || orch === row.destinationSession;
  return {
    owner: retry ? row.destinationSession : operator ? resolveOperatorSeat() ?? row.sourceSession : orch!,
    mechanism: retry ? "queue-wake-ladder:retry" : ladder.opEngineDispatched ? "queue-wake-ladder:operator-outcome" : operator ? "queue-wake-ladder:operator" : "queue-wake-ladder:orchestrator",
    dueAt: ladder.opEngineDispatched ? null : new Date(due).toISOString(), intervalSeconds: interval,
    ...(suspension ? { suspendedUntil: suspension.until, note: suspension.reason } : { note: "Earliest eligibility; the next scheduler pass rechecks provider state, custody and the shared destination budget." }),
  };
}

function appendMarker(repo: QueueRepository, row: QueueItem, note: string): void {
  repo.transitionLog.append({
    qitemId: row.qitemId,
    state: row.state,
    actorSession: LADDER_ACTOR,
    transitionNote: note,
  });
}

function minutesSince(ts: number | string | null | undefined, now: Date): number {
  if (ts === null || ts === undefined) return 0;
  const t = typeof ts === "number" ? ts : Date.parse(ts);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, Math.round((now.getTime() - t) / 60_000));
}

function usageLimitPoolTag(poolKey: string): string {
  return `${USAGE_LIMIT_POOL_TAG_PREFIX}${poolKey}`;
}

function rigOf(session: string): string {
  return session.slice(session.lastIndexOf("@") + 1);
}

async function ensureUsageLimitBlocker(
  deps: Pick<WakeLadderDeps, "db" | "queueRepo">,
  pool: UsageLimitPool,
  now: Date,
  jitterSeconds: number,
): Promise<QueueItem> {
  const poolTag = usageLimitPoolTag(pool.poolKey);
  const existing = deps.db.prepare(
    `SELECT qitem_id FROM queue_items
      WHERE state IN ('pending', 'in-progress', 'blocked')
        AND EXISTS (SELECT 1 FROM json_each(queue_items.tags) WHERE value = ?)
        AND EXISTS (SELECT 1 FROM json_each(queue_items.tags) WHERE value = ?)
      LIMIT 1`,
  ).get(USAGE_LIMIT_BLOCKER_TAG, poolTag) as { qitem_id: string } | undefined;

  let blocker = existing ? deps.queueRepo.getById(existing.qitem_id) : null;
  if (blocker) {
    const wake = deps.queueRepo.getParkWakeStatus(blocker.qitemId);
    if (wake?.kind === "timer" && wake.live) return blocker;
    if (wake) throw new Error(`usage-limit blocker ${blocker.qitemId} has a non-live timer`);
  } else {
    const rig = rigOf(pool.seatSessions[0]!);
    blocker = await deps.queueRepo.create({
      sourceSession: LADDER_ACTOR,
      destinationSession: `wake-ladder@${rig}`,
      body: `Provider usage limit for ${pool.poolKey}; release every dependent once at ${pool.expiresAt}.`,
      tags: [USAGE_LIMIT_BLOCKER_TAG, poolTag],
      expiresAt: new Date(Date.parse(pool.expiresAt) + jitterSeconds * 1000).toISOString(),
      nudge: false,
    });
  }

  const wakeAtMs = Date.parse(pool.expiresAt) + jitterSeconds * 1000;
  const wakeAfterSeconds = Math.max(1, Math.ceil((wakeAtMs - now.getTime()) / 1000));
  deps.queueRepo.update({
    qitemId: blocker.qitemId,
    actorSession: LADDER_ACTOR,
    state: "blocked",
    blockedOn: `external:provider-limit:${pool.poolKey}`,
    transitionNote: `usage-limit cause=${pool.source} pool=${pool.poolKey} reset=${pool.expiresAt} wake=${new Date(wakeAtMs).toISOString()}`,
    wakeAfterSeconds,
  });
  return deps.queueRepo.getById(blocker.qitemId)!;
}

/**
 * One ladder tick. Everything is derived from the row + transition log — the tick holds
 * no memory (F6). Never throws: a tick that cannot run is loud on the status surface
 * and the log, because a silent skip is the exact class this slice kills.
 */
export async function runWakeLadderTick(deps: WakeLadderDeps): Promise<WakeLadderTickResult> {
  const log = deps.log ?? ((line: string) => console.error(line));
  const status = deps.status;
  try {
    const now = deps.now ?? new Date();
    // Retire only aggregates whose explicitly tagged underlying members all
    // resolved. Legacy untagged history is not interpreted from its body.
    const aggregates = deps.db.prepare("SELECT qitem_id, source_session, tags, ts_created FROM queue_items WHERE state IN ('pending','in-progress','blocked') AND tags LIKE ?").all(`%"${WAKE_ESCALATION_TAG}"%`) as Array<{ qitem_id: string; source_session: string; tags: string; ts_created: string }>;
    for (const aggregate of aggregates) {
      if ((JSON.parse(aggregate.tags) as string[]).includes(PROMPT_ALERT_TAG)) continue;
      const ids = (JSON.parse(aggregate.tags) as string[]).filter(t => t.startsWith("recovery-for:")).map(t => t.slice("recovery-for:".length));
      if (ids.length && ids.every(id => {
        const row = deps.queueRepo.getById(id);
        return row && (!["pending", "in-progress", "blocked"].includes(row.state) || row.lastNudgeResult === "verified" || Boolean(row.claimedAt && row.claimedAt > aggregate.ts_created));
      })) await deps.queueRepo.update({ qitemId: aggregate.qitem_id, actorSession: aggregate.source_session, state: "done", closureReason: "no-follow-on", transitionNote: "wake recovery resolved: tagged obligations no longer require delivery recovery" });
    }
    const intervalS = deps.retryIntervalSeconds ?? resolveWakeRetryIntervalSeconds();
    const cap = deps.retryCap ?? resolveWakeRetryCap();
    const windowMin = deps.unconfirmedWindowMinutes ?? resolveWakeUnconfirmedWindowMinutes();
    const graceS = deps.swapGraceSeconds ?? resolveWakeSwapGraceSeconds();
    const resolveOrch =
      deps.resolveOrchestrator ?? ((session: string) => defaultResolveOrchestrator(deps.db, session));
    const attemptWake =
      deps.attemptWake ??
      (async (qitemId: string, target: string): Promise<string> => {
        await deps.queueRepo.maybeNudge(qitemId, target, true);
        return deps.queueRepo.getById(qitemId)?.lastNudgeResult ?? "indeterminate:no transport available";
      });

    const actions: WakeLadderAction[] = [];
    try {
      await advancePromptRefusals(deps, now, intervalS, graceS, resolveOrch, attemptWake, actions);
    } catch (err) {
      log(`[wake-ladder] prompt refusal pass failed; continuing existing ladder: ${err instanceof Error ? err.message : String(err)}`);
    }
    let exhaustedThisTick = 0;
    const usagePoolBySeat = new Map<string, UsageLimitPool>();
    if (deps.getProviderReadModel) {
      try {
        const model = await deps.getProviderReadModel();
        const pools = deriveUsageLimitPools({
          ...model,
          now,
          fallbackSeconds: intervalS,
        });
        for (const pool of pools) {
          for (const seat of pool.seatSessions) usagePoolBySeat.set(seat, pool);
        }
      } catch (err) {
        log(`[wake-ladder] provider signal read unavailable; preserving shipped ladder: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const blockerByPool = new Map<string, QueueItem>();

    // Batons: handed-off rows still pending and unclaimed. Created-with-destination rows
    // are explicitly NOT here — that hole is S02's net (F5).
    const batonRows = deps.db
      .prepare(
        `SELECT qitem_id FROM queue_items
          WHERE state = 'pending' AND claimed_at IS NULL AND handed_off_from IS NOT NULL`,
      )
      .all() as Array<{ qitem_id: string }>;

    // OPR.0.5.6.24 B2 (advisor-ruled one-engine arm): claimed in-progress rows
    // that a parked-owner consumer wake FAILED into join the SAME ladder flow.
    // Consumer ORIGIN is the row's durable FAILED transition note (the ladder's
    // own retries overwrite last_nudge_result with generic transport detail, so
    // the column carries only failed-CLASS eligibility, never origin — R2's
    // one-shot-entry finding). Retry cap and exhaustion stay bounded by the
    // ladder's own derived markers; the consumer never retries.
    const parkedOwnerFailureRows = deps.db
      .prepare(
        `SELECT q.qitem_id FROM queue_items q
          WHERE q.state = 'in-progress' AND q.claimed_at IS NOT NULL
            AND q.last_nudge_result LIKE 'failed:%'
            AND EXISTS (
              SELECT 1 FROM queue_transitions t
               WHERE t.qitem_id = q.qitem_id
                 AND t.transition_note LIKE 'parked-owner wake delivery failed:%'
            )`,
      )
      .all() as Array<{ qitem_id: string }>;

    interface Member {
      row: QueueItem;
      view: LadderView;
      mode: WakeMode;
      reason: string;
      /** Actions (wakes, rung advances) are due-gated and suspension-gated; the
       *  aggregate REFRESH is detection-gated only (the S02 shape — F3). */
      due: boolean;
      suspended: string | null;
    }
    /** Escalation-phase members grouped per destination (F3 aggregation). */
    const escalating = new Map<string, Member[]>();
    /** Per-destination wake attempts inside the current window, across ALL ladders (F3
     *  rate bound). Seeded from recorded markers so restarts keep the bound too. */
    const windowBudget = new Map<string, number>();
    let activeLadders = 0;

    const budgetFor = (dest: string): number => {
      if (!windowBudget.has(dest)) {
        const since = new Date(now.getTime() - intervalS * 1000).toISOString();
        const counted = deps.db
          .prepare(
            `SELECT COUNT(*) AS n FROM queue_transitions t JOIN queue_items q ON q.qitem_id = t.qitem_id
              WHERE q.destination_session = ? AND t.transition_note LIKE ? AND t.ts >= ?`,
          )
          .get(dest, `${LADDER_ATTEMPT_PREFIX}%`, since) as { n: number };
        windowBudget.set(dest, counted.n);
      }
      return windowBudget.get(dest)!;
    };

    for (const { qitem_id } of [...batonRows, ...parkedOwnerFailureRows]) {
      const row = deps.queueRepo.getById(qitem_id);
      if (!row) continue;
      const usagePool = usagePoolBySeat.get(row.destinationSession);
      // OPR.0.5.6.24: the usage-limit PARK mutation applies only to pending
      // batons — a claimed in-progress row is someone's live work and is never
      // state-mutated here; it falls through to ordinary mode classification.
      if (usagePool && row.state === "pending") {
        let blocker = blockerByPool.get(usagePool.poolKey);
        if (!blocker) {
          blocker = await ensureUsageLimitBlocker(
            deps,
            usagePool,
            now,
            deps.usageLimitJitterSeconds ?? drawUsageLimitJitterSeconds(),
          );
          blockerByPool.set(usagePool.poolKey, blocker);
        }
        deps.queueRepo.update({
          qitemId: row.qitemId,
          actorSession: LADDER_ACTOR,
          state: "blocked",
          blockedOn: blocker.qitemId,
          transitionNote: `usage-limit suppressed: pool=${usagePool.poolKey} reset=${usagePool.expiresAt}; waiting on shared blocker ${blocker.qitemId}`,
        });
        actions.push({ qitemId: row.qitemId, action: "park-usage-limit" });
        continue;
      }
      const mode = unclaimedWakeMode(row);
      if (!mode) continue;
      const disposition = findQueueRecovery(deps.db, row.qitemId);
      if (disposition && !["pending", "in-progress", "blocked"].includes(disposition.state)) continue;
      const view = readLadder(deps.db, row.qitemId);
      if (view.exhausted) continue; // finite: an exhausted ladder never re-fires

      // F1 gates for the unconfirmed class: never re-nudge; enter only past the window
      // with zero pickup evidence.
      if (mode === "unconfirmed") {
        if (minutesSince(row.tsCreated, now) < windowMin) continue;
        if (hasPickupEvidence(deps.db, row)) continue;
      }
      activeLadders += 1;

      // Due-ness: the latest ladder marker (or the original nudge attempt) is older than
      // the retry interval. No markers + no recorded attempt = due now. Gates ACTIONS
      // only — detection (and the aggregate refresh) is not throttled by it.
      const lastActivity =
        view.lastMarkerTs ?? (row.lastNudgeAttempt ? Date.parse(row.lastNudgeAttempt) : null);
      const due =
        lastActivity === null || Number.isNaN(lastActivity) || now.getTime() - lastActivity >= intervalS * 1000;
      const suspended = due ? suspensionReason(deps.db, row.destinationSession, graceS, now) : null;

      const recovery = findQueueRecovery(deps.db, row.qitemId);
      const recoveryRow = recovery ? deps.queueRepo.getById(recovery.qitemId) : null;
      // The open prompt recovery owns continuation before the retry cap too.
      // Do not retry the blocked original, duplicate its aggregate, or exhaust
      // the original (which would retire that aggregate).
      if (recoveryRow?.tags?.includes(PROMPT_ALERT_TAG)
        && ["pending", "in-progress", "blocked"].includes(recoveryRow.state)) continue;

      // Retry rung — failed outcomes only, under the cap, inside the destination budget.
      if (mode === "failed" && view.attempts < cap) {
        if (!due) continue;
        // F2 — derived suspension, checked only when the ladder would otherwise act.
        if (suspended) {
          if (!view.suspendEpisodeOpen) {
            appendMarker(deps.queueRepo, row, `${LADDER_SUSPEND_PREFIX} ${suspended}`);
            actions.push({ qitemId: row.qitemId, action: "suspend" });
          }
          continue;
        }
        if (view.suspendEpisodeOpen) {
          appendMarker(deps.queueRepo, row, `${LADDER_RESUME_PREFIX} suspension over; ladder resumes`);
          actions.push({ qitemId: row.qitemId, action: "resume" });
        }
        if (budgetFor(row.destinationSession) >= cap) continue; // destination-bounded (F3)
        windowBudget.set(row.destinationSession, budgetFor(row.destinationSession) + 1);
        const outcome = await attemptWake(row.qitemId, row.destinationSession);
        appendMarker(
          deps.queueRepo,
          row,
          `${LADDER_ATTEMPT_PREFIX} ${view.attempts + 1}/${cap} outcome=${outcome}`,
        );
        actions.push({ qitemId: row.qitemId, action: "retry", target: row.destinationSession });
        continue;
      }

      if (recovery && !recoveryRow?.tags?.includes(WAKE_ESCALATION_TAG)) {
        appendExhausted(deps.queueRepo, row, `recovery disposition already held by ${recovery.qitemId} (${recovery.state})`);
        continue;
      }

      // Escalation phase (past the cap, or the F1 direct path). Grouped per destination
      // regardless of due-ness so the aggregate refresh rides every detection pass.
      const reason =
        mode === "failed"
          ? `wake failed ${view.attempts} times over ${minutesSince(view.firstMarkerTs ?? row.tsCreated, now)} min`
          : `unconfirmed delivery with no pickup evidence over ${minutesSince(row.tsCreated, now)} min`;
      const dest = row.destinationSession;
      if (!escalating.has(dest)) escalating.set(dest, []);
      escalating.get(dest)!.push({ row, view, mode, reason, due, suspended });
    }

    // F3 — per-destination aggregation: ONE escalation carrying the row list, refreshed
    // not duplicated (the S02 idempotency shape), and rung markers on every member baton.
    for (const [dest, members] of escalating) {
      const orch = resolveOrch(dest);

      // F3 — the aggregate refresh is detection-gated (the S02 idempotency shape): a
      // live escalation group refreshes its one open row every pass, no wake attached.
      await refreshEscalationRowIfExists(deps, dest, members);

      const actionable = members.filter((m) => m.due && !m.suspended);
      const needsOrchRung = actionable.filter((m) => !m.view.orchRung);
      const reason = needsOrchRung[0]?.reason ?? members[0]!.reason;

      if (needsOrchRung.length > 0) {
        if (orch === null || orch === dest) {
          // F4: rung 1 self-skips when it resolves to the destination itself (or nowhere)
          // — never escalate INTO the dead seat; fall through to the operator rung now.
          // The operator floor must be a VISIBLE OBJECT, not markers alone: ensure the
          // per-destination escalation row exists (addressed to the operator seat, else
          // the obligation's own creator) so the escalations view and the health count
          // expose it — it stays open past the batons' exhaustion.
          const floorDest = resolveOperatorSeat() ?? needsOrchRung[0]!.row.sourceSession;
          await ensureEscalationRow(deps, dest, floorDest, needsOrchRung, reason);
          for (const m of needsOrchRung) {
            appendMarker(
              deps.queueRepo,
              m.row,
              `${LADDER_RUNG_PREFIX} orchestrator self-skip (resolves to ${orch === null ? "no orchestrator" : "destination"}) reason=${m.reason}`,
            );
            if (await operatorRung(deps, m.row, m.reason, actions, m.view)) {
              appendExhausted(deps.queueRepo, m.row, "operator rung resolved");
              exhaustedThisTick += 1;
            }
          }
        } else {
          const escRow = await ensureEscalationRow(deps, dest, orch, members, reason);
          const outcome = await attemptWake(escRow.qitemId, orch);
          for (const m of needsOrchRung) {
            appendMarker(
              deps.queueRepo,
              m.row,
              `${LADDER_RUNG_PREFIX} orchestrator -> ${orch} outcome=${outcome} reason=${m.reason}`,
            );
            actions.push({ qitemId: m.row.qitemId, action: "escalate-orchestrator", target: orch });
            if (!outcome.startsWith("failed:")) {
              // Delivered (or durable-unconfirmed — the aggregate row itself is now the
              // orchestrator's durable obligation; S02 nets it if it sits unclaimed).
              appendExhausted(
                deps.queueRepo,
                m.row,
                `escalated to orchestrator (${outcome === "verified" ? "delivered" : outcome})`,
              );
              exhaustedThisTick += 1;
            }
          }
        }
        continue; // one rung per destination per tick — bounded advance (F4)
      }

      // Orchestrator rung recorded and failed → advance to the operator rung.
      for (const m of actionable) {
        if (m.view.orchRung && (m.view.orchRungFailed || m.view.opUnresolved !== null) && !m.view.opEngineDispatched) {
          if (await operatorRung(deps, m.row, m.reason, actions, m.view)) {
            appendExhausted(deps.queueRepo, m.row, "operator rung resolved");
            exhaustedThisTick += 1;
          }
        }
      }

      // AM-F3 resolution pass: a rung whose engine outcome was pending exhausts
      // once the row carries its resolution (posted receipt or termination) —
      // never before, never silently.
      for (const m of members) {
        if (m.view.opEngineDispatched && !m.view.exhausted && m.view.opOutcomeResolved) {
          appendExhausted(deps.queueRepo, m.row, "engine outcome resolved");
          exhaustedThisTick += 1;
        }
      }
    }

    const escalationsOpen = (
      deps.db
        .prepare(
          `SELECT COUNT(*) AS n FROM queue_items
            WHERE state IN ('pending','in-progress','blocked') AND tags LIKE ?`,
        )
        .get(`%"${WAKE_ESCALATION_TAG}"%`) as { n: number }
    ).n;
    const outcome = actions.length > 0 ? "actions" : "clean";
    status?.record(outcome, { active: activeLadders, escalations: escalationsOpen, exhausted: exhaustedThisTick });
    return { outcome, actions };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`[wake-ladder] TICK FAILED (skipping loudly): ${message}`);
    status?.record("failed", { error: message });
    return { outcome: "failed", actions: [], error: message };
  }
}

/** An old idle observation cannot clear a newly observed transport refusal.
 * Keep uncertainty until the existing oracle supplies a newer clear state. */
export function classifyPromptAfterRefusal(
  state: Pick<ArbitratedSeatState, "activity" | "needsInput" | "changedAt" | "rungs"> | null | undefined,
  refusedAt: string,
): "blocked" | "clear" | "unknown" {
  if (!state || state.activity === "unknown") return "unknown";
  if (state.needsInput.count > 0) return "blocked";
  const canObservePrompt = state.rungs.some(({ rung, trust }) => trust === "authoritative"
    && (rung === "needs-input-chrome" || rung === "lifecycle-hooks" || rung === "self-report"));
  if (!canObservePrompt) return "unknown";
  return Date.parse(state.changedAt) > Date.parse(refusedAt) ? "clear" : "unknown";
}

const PROMPT_ALERT_TAG = "wake-prompt-refusal";
const PROMPT_EPISODE_TAG = "prompt-episode:";
const PROMPT_RETIRED_NOTE = "prompt escalation retired: prompt cleared or original episode ended; not a delivery receipt";

/** Positive refusals enter the existing rungs without ever retrying the blocked
 * seat. One aggregate carries the episode's obligations and notification key;
 * original work remains owned by its current recipient. */
async function advancePromptRefusals(
  deps: WakeLadderDeps,
  now: Date,
  intervalS: number,
  graceS: number,
  resolveOrch: (destination: string) => string | null,
  attemptWake: (qitemId: string, target: string) => Promise<string>,
  actions: WakeLadderAction[],
): Promise<void> {
  const groups = new Map<string, { keys: string[]; rows: Map<string, QueueItem>; refusedAt: string }>();
  const candidates = deps.db.prepare(`SELECT DISTINCT q.qitem_id FROM queue_items q
    JOIN queue_transitions t ON t.qitem_id = q.qitem_id
    WHERE t.transition_note LIKE ? AND (q.state IN ('pending','in-progress','blocked') OR EXISTS (
      SELECT 1 FROM queue_items a WHERE a.state IN ('pending','in-progress','blocked')
      AND json_valid(a.tags) AND EXISTS (SELECT 1 FROM json_each(a.tags) WHERE value = ?)
      AND EXISTS (SELECT 1 FROM json_each(a.tags) WHERE value = 'recovery-for:' || q.qitem_id)))`)
    .all(`${REFUSED_PREFIX}%`, PROMPT_ALERT_TAG) as Array<{ qitem_id: string }>;
  for (const { qitem_id } of candidates) {
    const primary = deps.queueRepo.getById(qitem_id);
    if (!primary) continue;
    // The shared no-route change is prospective, never a revival of old ladders.
    if (readLadder(deps.db, qitem_id).exhausted) continue;
    for (const episode of openPromptRefusals(deps.queueRepo.listTransitions(qitem_id))) {
      if (!episode.key.startsWith(`${primary.destinationSession}|`)) continue;
      // A closed disposition for this exact episode is final, even while the
      // original work remains open. Only a new refusal key can start again.
      if (deps.db.prepare(`SELECT 1 FROM queue_items WHERE state NOT IN ('pending','in-progress','blocked')
        AND json_valid(tags) AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)
        AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?) LIMIT 1`)
        .get(PROMPT_ALERT_TAG, `${PROMPT_EPISODE_TAG}${episode.key}`)) continue;
      const rows = episode.ids.map(id => deps.queueRepo.getById(id)).filter((row): row is QueueItem =>
        Boolean(row && row.destinationSession === primary.destinationSession && ["pending", "in-progress", "blocked"].includes(row.state)));
      if (!rows.length) continue;
      let group = groups.get(primary.destinationSession);
      if (!group) { group = { keys: [], rows: new Map(), refusedAt: episode.refusedAt }; groups.set(primary.destinationSession, group); }
      if (Date.parse(episode.refusedAt) > Date.parse(group.refusedAt)) group.refusedAt = episode.refusedAt;
      group.keys.push(`${PROMPT_EPISODE_TAG}${episode.key}`);
      for (const row of rows) group.rows.set(row.qitemId, row);
    }
  }

  const promptState = (dest: string) => {
    try { return deps.readPromptState?.(dest, groups.get(dest)?.refusedAt ?? now.toISOString()) ?? "unknown"; } catch { return "unknown"; }
  };
  const aggregates = deps.db.prepare(`SELECT qitem_id FROM queue_items WHERE state IN ('pending','in-progress','blocked')
    AND json_valid(tags) AND EXISTS (SELECT 1 FROM json_each(tags) WHERE value = ?)`)
    .all(PROMPT_ALERT_TAG) as Array<{ qitem_id: string }>;
  for (const { qitem_id } of aggregates) {
    const aggregate = deps.queueRepo.getById(qitem_id);
    if (!aggregate || !Array.isArray(aggregate.tags)) continue;
    const destinationTag = aggregate.tags.find(t => typeof t === "string" && t.startsWith("prompt-destination:"));
    const dest = destinationTag?.slice("prompt-destination:".length);
    if (!dest) continue;
    const group = groups.get(dest);
    const tags = aggregate.tags;
    const sameEpisode = group?.keys.some(key => tags.includes(key));
    if (!sameEpisode || promptState(dest) === "clear") {
      await deps.queueRepo.update({ qitemId: qitem_id, actorSession: aggregate.sourceSession, state: "done",
        closureReason: "no-follow-on", transitionNote: PROMPT_RETIRED_NOTE });
    }
  }

  for (const [dest, group] of groups) {
    const state = promptState(dest);
    if (state === "clear") {
      for (const row of group.rows.values()) {
        for (const { key } of openPromptRefusals(deps.queueRepo.listTransitions(row.qitemId))) {
          appendMarker(deps.queueRepo, row, `${CLOSE_PREFIX} ${key} (interactive prompt cleared)`);
        }
      }
      continue;
    }
    if (state !== "blocked" || suspensionReason(deps.db, dest, graceS, now)) continue;
    const members = [...group.rows.values()].map(row => ({ row, reason: "interactive prompt refuses the parked-owner wake" }));
    // Recovery owned elsewhere already has a route. A fallback finding sent
    // into this same blocked seat does not: include it in the aggregate while
    // retaining its original body/custody, rather than treating it as delivery.
    const selfRecoveries = new Map<string, QueueItem>();
    const ownedElsewhere = members.some(({ row }) => {
      const recovery = findQueueRecovery(deps.db, row.qitemId);
      if (!recovery || !["pending", "in-progress", "blocked"].includes(recovery.state)) return false;
      const held = deps.queueRepo.getById(recovery.qitemId);
      if (!held) return false;
      if (held.tags?.includes(PROMPT_ALERT_TAG)) return false;
      if (held.destinationSession !== dest) return true;
      selfRecoveries.set(held.qitemId, held);
      return false;
    });
    if (ownedElsewhere) continue;
    for (const row of selfRecoveries.values()) {
      if (!group.rows.has(row.qitemId)) members.push({ row, reason: "recovery fallback also targets the prompt-blocked seat" });
    }
    const orch = resolveOrch(dest);
    const toOperator = orch === null || orch === dest;
    const reason = "interactive prompt blocks outstanding work; no input was sent";
    const aggregate = await ensureEscalationRow(deps, dest,
      toOperator ? resolveOperatorSeat() ?? members[0]!.row.sourceSession : orch!, members, reason,
      `prompt-destination:${dest}`, [PROMPT_ALERT_TAG, ...group.keys]);
    const row = deps.queueRepo.getById(aggregate.qitemId);
    if (!row) continue;
    const addedKeys = group.keys.filter(key => !row.tags?.includes(key));
    if (addedKeys.length) {
      deps.db.prepare("UPDATE queue_items SET tags = ? WHERE qitem_id = ?")
        .run(JSON.stringify([...(row.tags ?? []), ...addedKeys]), row.qitemId);
    }
    // The aggregate ID is the episode. Claiming it does not start a second
    // delivery episode or erase its accepted dispatch/receipt history.
    const view = readLadder(deps.db, row.qitemId, 0);
    if (view.exhausted) continue;
    if (view.opEngineDispatched) {
      if (view.opOutcomeResolved) appendExhausted(deps.queueRepo, row, "engine outcome resolved");
      continue; // accepted/deferred delivery retains gateway custody
    }
    if (view.lastMarkerTs !== null && now.getTime() - view.lastMarkerTs < intervalS * 1000) continue;
    // Re-read at the send boundary after aggregate persistence.
    if (promptState(dest) !== "blocked" || !members.some(m => {
      const fresh = deps.queueRepo.getById(m.row.qitemId);
      return fresh && fresh.destinationSession === dest && ["pending", "in-progress", "blocked"].includes(fresh.state);
    })) continue;
    if (!view.orchRung) {
      if (!toOperator) {
        const outcome = await attemptWake(row.qitemId, orch!);
        appendMarker(deps.queueRepo, row, `${LADDER_RUNG_PREFIX} orchestrator -> ${orch} outcome=${outcome} reason=${reason}`);
        actions.push({ qitemId: row.qitemId, action: "escalate-orchestrator", target: orch! });
        if (!outcome.startsWith("failed:")) appendExhausted(deps.queueRepo, row, `escalated to orchestrator (${outcome})`);
        continue;
      }
      appendMarker(deps.queueRepo, row, `${LADDER_RUNG_PREFIX} orchestrator self-skip reason=${reason}`);
    }
    if (await operatorRung(deps, row, reason, actions, view)) appendExhausted(deps.queueRepo, row, "operator rung resolved");
  }
}

/** The operator rung (OPR.0.5.6.1 A1.2/AM-F3): the delivery rules engine IS the rung's
 *  delivery leg. With an engine port wired, the rung dispatches exactly once per episode,
 *  records the decision, and exhausts ONLY when the outcome resolves (synchronously, or
 *  later via the posted receipt / termination record the resolution pass reads). Without
 *  a port the pre-engine floor stands honestly and exhausts as before.
 *  Returns true when the ladder may append its exhausted marker now. */
async function operatorRung(
  deps: WakeLadderDeps,
  row: QueueItem,
  reason: string,
  actions: WakeLadderAction[],
  view: LadderView,
): Promise<boolean> {
  const repo = deps.queueRepo;
  if (!deps.deliveryEngine) {
    appendMarker(
      repo,
      row,
      `${LADDER_RUNG_PREFIX} operator floor=escalation view + daemon-health (delivery engine not wired) reason=${reason}`,
    );
    actions.push({ qitemId: row.qitemId, action: "escalate-operator" });
    return true;
  }
  if (view.opEngineDispatched) {
    // Exactly-once per episode: never re-dispatch; the resolution pass decides advance.
    return view.opOutcomeResolved;
  }
  const outcome = await deps.deliveryEngine.dispatchEscalation(row, reason);
  if (outcome.dispatched === false) {
    // A real policy change: no route used to exhaust. Re-resolution is silent
    // while the reason is unchanged; the scheduler supplies the retry cadence.
    if (view.opUnresolved !== outcome.decision) {
      appendMarker(repo, row, `${LADDER_RUNG_PREFIX} operator unresolved-route decision=${outcome.decision}`);
      actions.push({ qitemId: row.qitemId, action: "escalate-operator" });
    }
    return false;
  }
  appendMarker(
    repo,
    row,
    `${LADDER_RUNG_PREFIX} operator dispatched-to-engine decision=${outcome.decision} resolved=${outcome.resolved}${outcome.notificationKey ? ` notification_key=${outcome.notificationKey}` : ""}${outcome.decisionId ? ` decision_id=${outcome.decisionId}` : ""} reason=${reason}`,
  );
  actions.push({ qitemId: row.qitemId, action: "escalate-operator" });
  return outcome.resolved;
}

function appendExhausted(repo: QueueRepository, row: QueueItem, why: string): void {
  appendMarker(repo, row, `${LADDER_EXHAUSTED_PREFIX} ${why}`);
}

/** Ensure the per-destination aggregate escalation row (F3): one open row, deduped by
 *  tag, refreshed on re-detection — never one row per baton. The row is a NEW durable
 *  obligation addressed to the orchestrator; the baton itself is never duplicated. */
/** Refresh-only leg of the F3 aggregate: an already-open escalation row gains a
 *  detection-pass note naming the current member list; creation stays with the rung
 *  action so a row never exists before its first delivery attempt. */
async function refreshEscalationRowIfExists(
  deps: WakeLadderDeps,
  dest: string,
  members: Array<{ row: QueueItem }>,
  dedupTag = escalationDedupTag(dest),
): Promise<void> {
  const existing = deps.db
    .prepare(
      `SELECT qitem_id FROM queue_items
        WHERE state IN ('pending','in-progress','blocked') AND tags LIKE ? LIMIT 1`,
    )
    .get(`%"${dedupTag}"%`) as { qitem_id: string } | undefined;
  if (!existing) return;
  const row = deps.queueRepo.getById(existing.qitem_id)!;
  const tags = row.tags ?? [];
  const added = members.map(m => recoveryTag(m.row.qitemId)).filter(tag => !tags.includes(tag));
  if (!added.length) return;
  deps.db.transaction(() => {
    deps.db.prepare("UPDATE queue_items SET tags = ? WHERE qitem_id = ?").run(JSON.stringify([...tags, ...added]), existing.qitem_id);
    deps.queueRepo.transitionLog.append({ qitemId: existing.qitem_id, state: row.state, actorSession: LADDER_ACTOR,
      transitionNote: `wake-escalation members added: ${added.join(", ")}` });
  })();
}

async function ensureEscalationRow(
  deps: WakeLadderDeps,
  dest: string,
  orch: string,
  members: Array<{ row: QueueItem; reason: string }>,
  reason: string,
  dedupTag = escalationDedupTag(dest),
  extraTags: string[] = [],
): Promise<{ qitemId: string }> {
  const existing = deps.db
    .prepare(
      `SELECT qitem_id FROM queue_items
        WHERE state IN ('pending','in-progress','blocked') AND tags LIKE ? LIMIT 1`,
    )
    .get(`%"${dedupTag}"%`) as { qitem_id: string } | undefined;
  if (existing) {
    await refreshEscalationRowIfExists(deps, dest, members, dedupTag);
    return { qitemId: existing.qitem_id };
  }
  const body =
    `WAKE ESCALATION (aggregated per destination)\n` +
    `destination: ${dest}\n` +
    `reason: ${reason}\n` +
    `stuck batons (${members.length}):\n` +
    members.map((m) => `- ${m.row.qitemId}: ${m.row.summary ?? "outstanding work"} (${m.reason})`).join("\n") +
    `\nThe rows above still carry their obligations exactly-once; this escalation is the wake, not the content.`;
  const created = await deps.queueRepo.create({
    sourceSession: members[0]!.row.sourceSession,
    destinationSession: orch,
    body,
    summary: `Wake escalation: ${members.length} baton(s) stuck at ${dest} — ${reason}`,
    tags: [WAKE_ESCALATION_TAG, dedupTag, ...extraTags, ...members.map(m => recoveryTag(m.row.qitemId))],
    nudge: false, // delivery is the ladder's own rung attempt, recorded with its outcome
  });
  return { qitemId: created.qitemId };
}

export interface WakeLadderSchedulerDeps {
  runTick: () => Promise<WakeLadderTickResult>;
  tickIntervalMs?: number;
  setTimer?: (cb: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (handle: NodeJS.Timeout) => void;
  onTickError?: (err: unknown) => void;
}

/** The standing loop — the watchdog-scheduler pattern (injected seams, runTickNow, no
 *  overlapping ticks), so the ladder is unit-drivable without timers. */
export class WakeLadderScheduler {
  private readonly deps: Required<Pick<WakeLadderSchedulerDeps, "runTick">> & WakeLadderSchedulerDeps;
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<unknown> | null = null;
  private shuttingDown = false;
  private started = false;

  constructor(deps: WakeLadderSchedulerDeps) {
    this.deps = deps;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.shuttingDown = false;
    this.scheduleNext();
  }

  async stop(): Promise<void> {
    this.shuttingDown = true;
    if (this.timer) {
      (this.deps.clearTimer ?? clearTimeout)(this.timer);
      this.timer = null;
    }
    if (this.inflight) await this.inflight.catch(() => {});
    this.started = false;
  }

  async runTickNow(): Promise<void> {
    if (this.inflight) {
      await this.inflight;
      return;
    }
    this.inflight = this.deps.runTick().finally(() => {
      this.inflight = null;
    });
    await this.inflight;
  }

  private scheduleNext(): void {
    if (this.shuttingDown) return;
    const ms = this.deps.tickIntervalMs ?? DEFAULT_WAKE_RETRY_INTERVAL_SECONDS * 1000;
    this.timer = (this.deps.setTimer ?? setTimeout)(() => {
      void this.runTickNow()
        .catch((err) => (this.deps.onTickError ?? console.error)(err))
        .finally(() => this.scheduleNext());
    }, ms);
  }
}
