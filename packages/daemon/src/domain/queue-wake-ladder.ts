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
// bounded cycle. The operator rung's delivery floor here is the escalation view + the
// daemon-health surface, stated honestly in its marker — the human-layer connector attempt
// is S11 territory (0.5.6), cited, not built; the rung gains that leg when S11 lands.

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
  now?: Date;
  log?: (line: string) => void;
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
  exhausted: boolean;
  suspendEpisodeOpen: boolean;
  firstMarkerTs: number | null;
}

function readLadder(db: Database.Database, qitemId: string): LadderView {
  const rows = db
    .prepare("SELECT ts, transition_note FROM queue_transitions WHERE qitem_id = ? ORDER BY ts, rowid")
    .all(qitemId) as MarkerRow[];
  const view: LadderView = {
    attempts: 0,
    lastMarkerTs: null,
    orchRung: false,
    orchRungFailed: false,
    opRung: false,
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
function hasPickupEvidence(db: Database.Database, row: QueueItem): boolean {
  if (row.claimedAt) return true;
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
      note.startsWith(LADDER_RESUME_PREFIX)
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
  if (
    lastNudgeResult === "delivered-ack-pending" ||
    lastNudgeResult.startsWith("indeterminate:") ||
    lastNudgeResult.startsWith("gateway-owned:")
  )
    return "unconfirmed";
  return null; // verified (or unknown vocabulary) — never enters the ladder
}

/** F2 — derived suspension: the destination's post-swap grace (nodes.handover_at within
 *  the bound), or the operator-declared override. Returns the reason, or null. */
function suspensionReason(
  db: Database.Database,
  destination: string,
  graceSeconds: number,
  now: Date,
): string | null {
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
          return `operator override (${WAKE_SUSPEND_OVERRIDE_ENV}) until ${untilIso}`;
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
    return `destination in post-swap grace (handover ${Math.round(ageS)}s ago, grace ${graceSeconds}s)`;
  }
  return null;
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

    for (const { qitem_id } of batonRows) {
      const row = deps.queueRepo.getById(qitem_id);
      if (!row) continue;
      const usagePool = usagePoolBySeat.get(row.destinationSession);
      if (usagePool) {
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
      const mode = classifyWakeResult(row.lastNudgeResult);
      if (!mode) continue;
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
            operatorRung(deps.queueRepo, m.row, m.reason, actions);
            appendExhausted(deps.queueRepo, m.row, "operator rung reached");
            exhaustedThisTick += 1;
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
        if (m.view.orchRung && m.view.orchRungFailed && !m.view.opRung) {
          operatorRung(deps.queueRepo, m.row, m.reason, actions);
          appendExhausted(deps.queueRepo, m.row, "operator rung reached");
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

/** The operator rung: records and advances (AM-R25 trim). Its delivery floor here is the
 *  escalation view + the daemon-health surface, stated honestly on the marker; the
 *  human-layer connector attempt is S11 territory (0.5.6) and rides in when S11 lands. */
function operatorRung(
  repo: QueueRepository,
  row: QueueItem,
  reason: string,
  actions: WakeLadderAction[],
): void {
  appendMarker(
    repo,
    row,
    `${LADDER_RUNG_PREFIX} operator floor=escalation view + daemon-health (human-layer connector = S11/0.5.6, cited not built) reason=${reason}`,
  );
  actions.push({ qitemId: row.qitemId, action: "escalate-operator" });
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
): Promise<void> {
  const existing = deps.db
    .prepare(
      `SELECT qitem_id FROM queue_items
        WHERE state IN ('pending','in-progress','blocked') AND tags LIKE ? LIMIT 1`,
    )
    .get(`%"${escalationDedupTag(dest)}"%`) as { qitem_id: string } | undefined;
  if (!existing) return;
  deps.queueRepo.transitionLog.append({
    qitemId: existing.qitem_id,
    state: "pending",
    actorSession: LADDER_ACTOR,
    transitionNote: `wake-escalation refresh: ${members.length} stuck baton(s) for ${dest} — ${members
      .map((m) => m.row.qitemId)
      .join(", ")}`,
  });
}

async function ensureEscalationRow(
  deps: WakeLadderDeps,
  dest: string,
  orch: string,
  members: Array<{ row: QueueItem; reason: string }>,
  reason: string,
): Promise<{ qitemId: string }> {
  const dedupTag = escalationDedupTag(dest);
  const existing = deps.db
    .prepare(
      `SELECT qitem_id FROM queue_items
        WHERE state IN ('pending','in-progress','blocked') AND tags LIKE ? LIMIT 1`,
    )
    .get(`%"${dedupTag}"%`) as { qitem_id: string } | undefined;
  if (existing) {
    deps.queueRepo.transitionLog.append({
      qitemId: existing.qitem_id,
      state: "pending",
      actorSession: LADDER_ACTOR,
      transitionNote: `wake-escalation refresh: ${members.length} stuck baton(s) for ${dest} — ${members
        .map((m) => m.row.qitemId)
        .join(", ")}`,
    });
    return { qitemId: existing.qitem_id };
  }
  const body =
    `WAKE ESCALATION (aggregated per destination)\n` +
    `destination: ${dest}\n` +
    `reason: ${reason}\n` +
    `stuck batons (${members.length}):\n` +
    members.map((m) => `- ${m.row.qitemId} (${m.reason})`).join("\n") +
    `\nThe rows above still carry their obligations exactly-once; this escalation is the wake, not the content.`;
  const created = await deps.queueRepo.create({
    sourceSession: members[0]!.row.sourceSession,
    destinationSession: orch,
    body,
    summary: `Wake escalation: ${members.length} baton(s) stuck at ${dest} — ${reason}`,
    tags: [WAKE_ESCALATION_TAG, dedupTag],
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
