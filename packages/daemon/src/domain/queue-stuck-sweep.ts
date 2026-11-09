import { currentParkedOwnerNoInputFailure } from "./policies/parked-owner-consumer.js";
import { resolveEscalationOwner, ESCALATION_HOP_TAG, hasConsumedEscalationHop } from "./escalation-owner.js";
import { createRecoveryLookup, recoveryId, recoveryTag } from "./queue-recovery.js";
import { quietHoldCustody } from "./quiet-hold-custody.js";
import { queueWaitNotice } from "./queue-wait-backoff.js";
import { lastMeaningfulTransition, pendingSince } from "./queue-waiting.js";
import { resolvePickupThresholdMinutes } from "./queue-pickup.js";
// S02 (OPR.0.5.5.2) — STANDING STUCK SWEEP. `queue overdue` and `queue undelivered` are the
// two halves of "is anything silently stuck" — and they were verbs someone had to remember to
// run. This module makes the sweep a standing daemon loop's body: both halves swept on a
// config-keyed cadence, findings routed as durable rows to the owning seats, quiet sweeps
// cheap (one observable heartbeat, never a row), failures loud (named on the status surface).
//
// The verbs themselves are UNCHANGED — findOverdue/findUndelivered become this loop's
// library. Selection is by DESTINATION + obligation shape across ALL states, never by tag
// (the 0.5.3 custody-sweep lesson: tag sweeps miss founding rows; terminal states are read,
// not skipped). Sweep-finding rows self-exclude by their own stamp tag — exclusion, not
// selection.
//
// S01 seam (spec Amendment A1, cross-cited in both specs): the undelivered half SKIPS rows
// carrying a LIVE S01 wake-retry ladder — S01 records its ladder on the row's transitions
// exactly so this filter is derivable — and remains the net for what S01 excludes: the
// laddered-then-exhausted handback (exactly one finding, never double-reported) and
// created-with-destination obligations (S01's baton filter excludes them; the unclaimed
// net below sweeps them). S01 imports the marker vocabulary from HERE so the two slices
// share one contract instead of two guesses. S03 owns park/wake honesty: state=blocked rows
// legitimately wait; only an undelivered human notice is a delivery finding.

import { resolveOperatorSeat, resolveRecoveryAgentSeat, resolveSessionNodeId } from "./queue-owner.js";
import { nodeExecutorStoppedReason } from "./node-inventory.js";
import { isBoundTerminalSeat } from "./terminal-seat.js";
import type Database from "better-sqlite3";
import { createLinkedSuccessorLookup, deriveCrossHostSuccessorId, hasLinkedSuccessor, matchesRecordedHandoffTarget, QueueRepositoryError, type QueueItem, type QueueRepository } from "./queue-repository.js";
import { stalledPickupFinding } from "./queue-pickup.js";
import { SettingsStore } from "./user-settings/settings-store.js";
import { loadHostRegistry } from "./hosts/hosts-registry-reader.js";

export const STUCK_SWEEP_INTERVAL_KEY = "queue.stuck_sweep_interval_seconds";
export const DEFAULT_STUCK_SWEEP_INTERVAL_SECONDS = 300;
export const STUCK_SWEEP_UNCLAIMED_AGE_KEY = "queue.stuck_sweep_unclaimed_age_minutes";
export const DEFAULT_STUCK_SWEEP_UNCLAIMED_AGE_MINUTES = 60;
export const STUCK_SWEEP_CUSTODY_WINDOW_HOURS = 24;

/** Stamp tag on every routed finding row: the sweep's self-exclusion mark. */
export const STUCK_SWEEP_FINDING_TAG = "stuck-sweep-finding";

/** How a confirmed-missing seat's finding names the rule that chose its recovery seat, in the order tried. */
const RECOVERY_SEAT_RULES = [
  "the operator agent (agents.operator_session)",
  "the operator seat (workspace.operator_seat_name)",
  "the row's creator",
] as const;

/** How an unroutable destination's finding names the rule that chose its recipient, in the order tried. */
const NO_WAKE_ROUTE_RULES = [
  "the operator seat (workspace.operator_seat_name), a person",
  "the row's creator",
  "the operator agent (agents.operator_session)",
] as const;

// S01 ladder marker vocabulary (the seam contract). S01 writes these transition-note
// prefixes; the sweep derives "live ladder" from the latest marker. An attempt/rung is
// LIVE, an exhausted marker hands the row back, and a later attempt starts a live cycle
// again.
export const LADDER_ATTEMPT_PREFIX = "wake-attempt:";
export const LADDER_RUNG_PREFIX = "escalation-rung:";
export const LADDER_EXHAUSTED_PREFIX = "ladder-exhausted:";

/** Suppression floor: even at the ladder's default cadence, a marker suppresses for half
 *  an hour. */
export const LADDER_SUPPRESSION_MINIMUM_MINUTES = 30;

/** The ladder's own retry cadence, read from the setting the ladder itself uses
 *  (queue.wake_retry_interval_seconds, default 300s). Read by key here rather than
 *  imported: queue-wake-ladder imports this module for the marker prefixes, so an import
 *  back would close a cycle. A test pins the key to the ladder's own. */
const WAKE_RETRY_INTERVAL_SETTING_KEY = "queue.wake_retry_interval_seconds";
const DEFAULT_WAKE_RETRY_INTERVAL_SECONDS = 300;

/** How long a ladder marker suppresses re-reporting: half an hour, or two of the owning
 *  ladder's own retry intervals, whichever is longer. A working ladder must not lose its
 *  marker between its own attempts, or the sweep would report an item the ladder still
 *  owns. #1419. */
export function resolveLadderSuppressionMinutes(): number {
  let intervalSeconds = DEFAULT_WAKE_RETRY_INTERVAL_SECONDS;
  try {
    const v = new SettingsStore().resolveOne(WAKE_RETRY_INTERVAL_SETTING_KEY as never).value;
    const n = typeof v === "number" ? v : Number(v);
    if (Number.isFinite(n) && n > 0) intervalSeconds = n;
  } catch { /* a settings error must never shorten the bound */ }
  return Math.max(LADDER_SUPPRESSION_MINIMUM_MINUTES, (2 * intervalSeconds) / 60);
}

export type StuckFindingKind =
  | "parked-owner-no-input"
  | "unconsumed-wait"
  | "overdue-claim"
  | "stalled-after-claim"
  | "undelivered-wake"
  | "undelivered-human-notice"
  | "unclaimed-obligation"
  | "dangling-closure"
  /** One standing notice for an agent seat's unclaimed rows when their findings would go back to that seat (#2430). */
  | "unclaimed-backlog";

/** Idempotency key: one open finding row per (stuck row, finding kind). */
export function findingDedupTag(kind: StuckFindingKind, qitemId: string): string {
  return `stuck-sweep:${kind}:${qitemId}`;
}

/** Idempotency key of a seat's standing unclaimed-backlog notice: one open notice per seat. */
export function unclaimedBacklogTag(seat: string): string {
  return `stuck-sweep:unclaimed-backlog:${seat}`;
}

/** How many of a seat's unclaimed rows its standing notice lists by id; the rest are counted. */
export const UNCLAIMED_BACKLOG_LISTED_ROWS = 20;

export interface StuckSweepStatusSnapshot {
  lastSweepAt: string | null;
  lastOutcome: "clean" | "findings" | "failed" | null;
  lastError: string | null;
  consecutiveFailures: number;
  findingsRouted: number;
  /** Start of the pass in flight, or null between passes: a pass that never ends shows here, not only as a stale
   *  lastSweepAt. */
  runningSince: string | null;
  /** Scheduler ticks skipped because a pass was still running; reset when the next pass starts. */
  skippedTicks: number;
}

export interface StuckSweepStatus {
  record(outcome: "clean" | "findings" | "failed", detail?: { error?: string; findings?: number }): void;
  /** The scheduler's one-pass-at-a-time state, mirrored for /healthz. */
  pass(state: { runningSince: string | null; skippedTicks: number }): void;
  snapshot(): StuckSweepStatusSnapshot;
}

/** The loop's observable heartbeat — surfaced on /healthz so a quiet sweep is cheap but
 *  never invisible, and a failing sweep is loud without needing a row. */
export function createStuckSweepStatus(): StuckSweepStatus {
  const state: StuckSweepStatusSnapshot = {
    lastSweepAt: null,
    lastOutcome: null,
    lastError: null,
    consecutiveFailures: 0,
    findingsRouted: 0,
    runningSince: null,
    skippedTicks: 0,
  };
  return {
    record(outcome, detail) {
      state.lastSweepAt = new Date().toISOString();
      state.lastOutcome = outcome;
      state.lastError = outcome === "failed" ? (detail?.error ?? "unknown error") : null;
      state.consecutiveFailures = outcome === "failed" ? state.consecutiveFailures + 1 : 0;
      if (detail?.findings) state.findingsRouted += detail.findings;
    },
    pass(pass) {
      state.runningSince = pass.runningSince;
      state.skippedTicks = pass.skippedTicks;
    },
    snapshot() {
      return { ...state };
    },
  };
}

/** Cadence, fresh-read with fail-open defaults (the queue-pickup precedent: a config flip
 *  applies to the next tick, and a settings error never silences the sweep). */
export function resolveStuckSweepIntervalSeconds(): number {
  try {
    const v = new SettingsStore().resolveOne(STUCK_SWEEP_INTERVAL_KEY as never).value;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_STUCK_SWEEP_INTERVAL_SECONDS;
  } catch {
    return DEFAULT_STUCK_SWEEP_INTERVAL_SECONDS;
  }
}

export function resolveStuckSweepUnclaimedAgeMinutes(): number {
  try {
    const v = new SettingsStore().resolveOne(STUCK_SWEEP_UNCLAIMED_AGE_KEY as never).value;
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_STUCK_SWEEP_UNCLAIMED_AGE_MINUTES;
  } catch {
    return DEFAULT_STUCK_SWEEP_UNCLAIMED_AGE_MINUTES;
  }
}

export interface StuckSweepDeps {
  db: Database.Database;
  queueRepo: QueueRepository;
  status?: StuckSweepStatus;
  /** Route resolution for obligations nobody holds: the destination seat's orchestrator
   *  (delegates_to parentage). null = no orchestrator known → the finding stays with the
   *  destination, unless that session is confirmed missing (below): S01's ladder covers
   *  handed-off batons only, so a finding addressed to a dead seat would reach nobody.
   *  Injectable for tests; default derives from topology. */
  resolveOrchestrator?: (session: string) => string | null;
  /** Legacy missing-session override. The default also consumes an applicable pane_exited fact:
   *  such an executor's finding uses the same live recovery floor when one is available.
   *  Injectable for tests; default reads the seat identity verdicts. */
  sessionConfirmedMissing?: (session: string) => boolean;
  /** The agent a confirmed-missing session's finding goes to first. Injectable for tests;
   *  default reads agents.operator_session. */
  resolveRecoveryAgentSeat?: () => string | null;
  /** Where that finding goes next, before the stuck row's creator: the wake ladder's own
   *  floor. Injectable for tests; default reads workspace.operator_seat_name. */
  resolveOperatorSeat?: () => string | null;
  unclaimedAgeMinutes?: number;
  custodyWindowHours?: number;
  now?: Date;
  log?: (line: string) => void;
  /** Is this host id (or observed self-id) present in the operator's hosts registry?
   *  One of TWO conjunct conditions for the proof-at-write disposition — the other is
   *  that the successor id recomputes through `deriveCrossHostSuccessorId` from the
   *  row's own fields, because the cross-host close (routes/queue.ts) creates the
   *  successor on that host FIRST and records the derived `<id>@<host>` only after that
   *  create succeeded, while the generic update path can store any string. Registry
   *  membership alone never suppresses. Injectable for tests; default reads the local
   *  hosts.yaml once per sweep pass, and an unavailable registry degrades honestly to
   *  verification-required (more indeterminate findings, never a false verdict). */
  isRegisteredHost?: (hostId: string) => boolean;
  /** How long a ladder marker suppresses re-reporting, in minutes. Default: half an hour,
   *  or two of the owning ladder's own retry intervals, whichever is longer. Injectable for
   *  tests; the default reads the ladder's existing setting. */
  ladderSuppressionMinutes?: number;
}

export interface StuckSweepFindingAction {
  kind: StuckFindingKind;
  /** The stuck row; for an unclaimed-backlog notice, the seat it stands for. */
  qitemId: string;
  findingQitemId: string;
  action: "created" | "refreshed" | "closed";
}

export interface StuckSweepResult {
  outcome: "clean" | "findings" | "failed";
  findings: StuckSweepFindingAction[];
  error?: string;
}

export { resolveSessionNodeId, defaultResolveOrchestrator, resolveOperatorSeat } from "./queue-owner.js";

interface TransitionNoteRow {
  transition_note: string | null;
}

/** The latest ladder marker is authoritative: a retry after exhaustion makes the
 *  ladder live again. Unrelated transitions do not change the latest marker. */
/** Durable custody-verification disposition: a transition note on the CLOSED source row,
 *  written by whoever performed the registered-host read (never by this detector),
 *  `custody-verified: <exact-target> <free-form how/where>`. Prefix-anchored parse; the
 *  target is the first whitespace-delimited token after the prefix, matched exactly.
 *  Read from the ACTIVE table AND the retention archive: the daily archiver MOVES every
 *  transition of an aged terminal qitem into `queue_transitions_archive` (the exact class
 *  custody rows belong to) while the row itself keeps participating in this sweep, so an
 *  active-only read would forget the disposition after the retention window and re-mint
 *  the very finding the verifier already answered. The archive is never deleted, so the
 *  union is the complete audit history. */
export const CUSTODY_VERIFIED_PREFIX = "custody-verified:";

function custodyVerifiedTargets(db: Database.Database, qitemId: string): Set<string> {
  const notes = db
    .prepare(
      `SELECT transition_note FROM queue_transitions WHERE qitem_id = ? AND transition_note LIKE ?
       UNION ALL
       SELECT transition_note FROM queue_transitions_archive WHERE qitem_id = ? AND transition_note LIKE ?`,
    )
    .all(qitemId, `${CUSTODY_VERIFIED_PREFIX}%`, qitemId, `${CUSTODY_VERIFIED_PREFIX}%`) as TransitionNoteRow[];
  const verified = new Set<string>();
  for (const { transition_note: note } of notes) {
    if (!note) continue;
    const token = note.slice(CUSTODY_VERIFIED_PREFIX.length).trim().split(/\s+/)[0];
    if (token) {
      verified.add(token);
      for (const t of token.split(",")) {
        if (t.trim()) verified.add(t.trim());
      }
    }
  }
  return verified;
}

/** Default registry view for the proof-at-write arm: the operator's hosts.yaml, read
 *  lazily once per sweep pass. Registry unavailable → NO host is registered → every
 *  host-qualified target stays verification-required (honest degradation, logged once). */
function defaultIsRegisteredHost(log: (line: string) => void): (hostId: string) => boolean {
  let known: Set<string> | null | undefined;
  return (hostId: string) => {
    if (known === undefined) {
      const loaded = loadHostRegistry();
      if (loaded.ok) {
        known = new Set<string>();
        for (const host of loaded.registry.hosts) {
          known.add(host.id);
          if (host.hostId) known.add(host.hostId);
        }
      } else {
        known = null;
        log(`[stuck-sweep] host registry unavailable — host-qualified custody targets stay verification-required (${loaded.error})`);
      }
    }
    return known !== null && known.has(hostId);
  };
}

/** Custody verification for a human destination belongs to its closing agent.
 *  Use the closing transition, including archived history; later same-state notes
 *  and delivery receipts do not transfer responsibility. A newer cancellation
 *  without closure metadata still supersedes an older closing actor. */
function custodyFindingRoute(db: Database.Database, queueRepo: QueueRepository, row: QueueItem): string {
  // Unknown identity cannot establish a new owner. The caller retains this row's
  // established destination if the registry needed for classification is unavailable.
  if (!queueRepo.isHumanDestination(row.destinationSession)) return row.destinationSession;
  const closure = db.prepare(
    `SELECT actor_session FROM (
       SELECT transition_id, state, actor_session, closure_reason,
              LAG(state) OVER (ORDER BY transition_id) AS previous_state
         FROM (
           SELECT transition_id, state, actor_session, closure_reason FROM queue_transitions WHERE qitem_id = ?
           UNION ALL
           SELECT transition_id, state, actor_session, closure_reason FROM queue_transitions_archive WHERE qitem_id = ?
         )
     ) WHERE state IN ('done', 'canceled', 'handed-off')
         AND (state IS NOT previous_state OR closure_reason IS NOT NULL)
       ORDER BY transition_id DESC LIMIT 1`,
  ).get(row.qitemId, row.qitemId) as { actor_session: string } | undefined;
  for (const session of [closure?.actor_session, row.sourceSession]) {
    if (!session || session === "daemon@kernel" || session.endsWith("@system")) continue;
    if (!queueRepo.isHumanDestination(session) && queueRepo.acceptsDestination(session)) {
      return session;
    }
  }
  // No admitted agent is attributable: retain the established durable destination
  // rather than inventing a seat or failing the sweep on an unknown actor's rig.
  return row.destinationSession;
}

function hasLiveLadder(db: Database.Database, qitemId: string, now: Date, suppressionMinutes: number): boolean {
  const notes = db
    .prepare("SELECT ts, transition_note FROM queue_transitions WHERE qitem_id = ? ORDER BY transition_id DESC")
    .all(qitemId) as Array<{ ts: string | null; transition_note: string | null }>;
  for (const { ts, transition_note: note } of notes) {
    if (!note) continue;
    if (note.startsWith(LADDER_EXHAUSTED_PREFIX)) return false;
    if (note.startsWith(LADDER_ATTEMPT_PREFIX) || note.startsWith(LADDER_RUNG_PREFIX)) {
      // Freshness bounds the suppression (#1419): the marker's time decides, and a missing,
      // unparsable or future timestamp fails open for reporting instead of suppressing
      // forever.
      const tsMs = Date.parse(ts ?? "");
      const ageMs = now.getTime() - tsMs;
      return !Number.isNaN(tsMs) && tsMs <= now.getTime() && ageMs <= suppressionMinutes * 60_000;
    }
  }
  return false;
}


function minutesSince(iso: string | null | undefined, now: Date): number {
  if (!iso) return 0;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 0;
  return Math.max(0, Math.round((now.getTime() - then) / 60_000));
}

/** Whole minutes, floored as the pickup evidence counts them (queue-pickup.ts). */
function wholeMinutesSince(iso: string, now: Date): number {
  const then = Date.parse(iso);
  return Number.isNaN(then) ? 0 : Math.max(0, Math.floor((now.getTime() - then) / 60_000));
}

function lastTransitionLine(db: Database.Database, qitemId: string): string {
  const row = db
    .prepare(
      `SELECT ts, transition_note FROM queue_transitions
        WHERE qitem_id = ? AND actor_session NOT IN ('watchdog@system', 'wake-ladder@system', 'daemon@kernel', 'daemon@system')
        ORDER BY transition_id DESC LIMIT 1`,
    )
    .get(qitemId) as { ts: string; transition_note: string | null } | undefined;
  if (row) return `${row.transition_note ?? "(no note)"} at ${row.ts}`;
  const anyRow = db
    .prepare("SELECT ts, transition_note FROM queue_transitions WHERE qitem_id = ? ORDER BY transition_id DESC LIMIT 1")
    .get(qitemId) as { ts: string; transition_note: string | null } | undefined;
  return anyRow ? `${anyRow.transition_note ?? "(no note)"} at ${anyRow.ts}` : "(no transitions)";
}

interface Candidate {
  kind: StuckFindingKind;
  row: QueueItem;
  route: string;
  ageMinutes: number;
  /** Per-kind evidence watermark. A closed finding suppresses only evidence at
   *  or below this timestamp; newer evidence earns one new finding. */
  evidenceAt: string;
  why: string;
  verificationTargets?: string[];
  /** unconsumed-wait only: the watchdog job whose notice found it (its rule is keyed by the job). */
  jobId?: string;
}

function isFindingRow(item: QueueItem): boolean {
  return (item.tags ?? []).includes(STUCK_SWEEP_FINDING_TAG);
}

/** Without OWNER history a receipt has no recipient/episode key. A simple
 * legacy park is still identifiable, but a later state write or an earlier
 * notice/reroute makes that binding unknown. Even a same-state append may be
 * a re-park whose recipient could not be classified during a registry outage. */
function legacyHumanRecipientRetained(deps: StuckSweepDeps, row: QueueItem): boolean {
  const history = deps.queueRepo.transitionLog.listForQitem(row.qitemId);
  const isReceipt = (note: string | null) => note?.startsWith("slack-owner-notification-posted ")
    || note?.startsWith("slack-owner-notification-transport-failed ");
  const isReroute = (note: string | null) => note?.startsWith("fallback-routed:");
  if (row.state !== "blocked") {
    return !history.some((transition) => transition.state === "blocked" || isReroute(transition.transitionNote));
  }
  const firstPark = history.findIndex((transition) => transition.state === "blocked");
  if (firstPark < 0 || history.slice(0, firstPark).some((transition) =>
    isReceipt(transition.transitionNote) || isReroute(transition.transitionNote))) return false;
  // Receipts and asking-agent reroutes preserve blockedOn. Other appends do
  // not record whether it changed, so they cannot prove the original park.
  return history.slice(firstPark + 1).every((transition) => transition.state === "blocked"
    && (isReceipt(transition.transitionNote) || isReroute(transition.transitionNote)));
}

/** Falling out of a reporting query is not proof of delivery or pickup. Read the
 * source's receipts and dispositions before closing an existing finding; an
 * unavailable source or an unconfirmed send supplies no resolution evidence. */
function deliveryResolutionEvidence(
  deps: StuckSweepDeps,
  kind: "undelivered-wake" | "undelivered-human-notice" | "unclaimed-obligation",
  qitemId: string,
  now: Date,
): string | null {
  const row = deps.queueRepo.getById(qitemId);
  if (!row) return null;
  if (["done", "failed", "denied", "canceled", "handed-off"].includes(row.state)) {
    return `source closed (${row.state})`;
  }
  // An agent's claim/park resolves its failed wake or unclaimed work, not the
  // separate notification owed to a person while that agent is waiting on them.
  if (kind !== "undelivered-human-notice") {
    if (deps.queueRepo.isLocalHumanDecisionWithoutGateway(row)) return "local kernel decision remains on the attention feed; no gateway wake is configured";
    if (row.claimedAt) return `source claimed at ${row.claimedAt}`;
    if (row.state === "blocked") return "source parked";
    if (kind === "undelivered-wake") {
      if (row.lastNudgeResult === "verified") return "source wake verified";
      if (row.lastNudgeResult?.startsWith("wake-accepted:")) return "source wake accepted by its hosted trigger";
    }
  }
  if (deps.queueRepo.humanNotificationPostedThisEpisode(qitemId)) return "current human ask posted";
  if (kind === "undelivered-human-notice") {
    const notification = deps.queueRepo.transitionLog.latestOwnerNotificationForQitem(qitemId);
    // Park and resolution notices have their own current ledger; a row-scoped
    // legacy receipt cannot establish delivery of an unrelated agent wake/ask.
    if (notification && (row.state === "blocked" || notification.ownerNotificationKind === "human-decision-resolved")
      && deps.queueRepo.deliveryOutcomeFor(qitemId)?.outcome === "posted") {
      return "current human notification posted";
    }
    // Pre-OWNER notices have no episode to match. Their existing row-scoped
    // ledger can resolve that human notice, but never an unrelated agent wake.
    if (!notification && deps.queueRepo.deliveryOutcomeFor(qitemId)?.outcome === "posted") {
      const recipient = row.state === "blocked" ? row.blockedOn : row.destinationSession;
      const recipientRetained = legacyHumanRecipientRetained(deps, row);
      try {
        if (recipientRetained && recipient && deps.queueRepo.isHumanDestination(recipient)) return "legacy human notification posted";
      } catch { /* An unreadable registry does not establish the recipient. */ }
    }
  }
  if (row.state === "pending" && deps.queueRepo.humanAskWithoutAlert(qitemId)) return "current human ask placed on Steering without an alert";
  const quiet = quietHoldCustody(deps.db, qitemId, now);
  if (quiet && !quiet.unreadable && (quiet.state === "held" || quiet.state === "released")) {
    return `source held by quiet-release job for window ${quiet.windowId}`;
  }
  if (kind === "unclaimed-obligation" && !quiet && deps.queueRepo.isRegisteredHumanUpdate(row) && !deps.queueRepo.deliveryOutcomeFor(qitemId)) {
    return "informational update to a registered human requires no claim";
  }
  if (kind !== "undelivered-human-notice" && row.lastNudgeResult === "retained:typing_guard") {
    return "source wake held by the seat typing guard";
  }
  return null;
}

function latestIso(...values: Array<string | null | undefined>): string {
  let latest: { iso: string; time: number } | undefined;
  for (const iso of values) {
    if (!iso) continue;
    const time = Date.parse(iso);
    if (!Number.isNaN(time) && (!latest || time > latest.time)) latest = { iso, time };
  }
  return latest?.iso ?? new Date(0).toISOString();
}

function evidenceIsNewer(evidenceAt: string, closedAt: string): boolean {
  const evidence = Date.parse(evidenceAt);
  const closed = Date.parse(closedAt);
  return !Number.isNaN(evidence) && !Number.isNaN(closed) && evidence > closed;
}

export function verificationCommand(target: string): string {
  if (target.startsWith("qitem-")) {
    const successorId = target.split("@", 1)[0] ?? target;
    return `OPENRIG_URL=<registered-host> rig queue show ${successorId}`;
  }
  if (target === "(unspecified)") {
    return "OPENRIG_URL=<registered-host> rig queue list";
  }
  return `OPENRIG_URL=<registered-host> rig queue list --destination ${target}`;
}

/** The finding's headline says where custody was not checked, so its owner can act from the list. */
export function custodyHeadline(rowId: string, targets: string[], ageMinutes: number): string {
  const hosts = [...new Set(targets.flatMap((target) =>
    target.startsWith("qitem-") && target.includes("@") ? [target.slice(target.indexOf("@") + 1)] : []))];
  return hosts.length
    ? `Custody not checked on host ${hosts.join(", ")} for ${rowId} (${ageMinutes} min)`
    : `Custody not checked: no successor of ${rowId} in this store (${ageMinutes} min)`;
}

function evidenceBody(db: Database.Database, c: Candidate): string {
  if (c.verificationTargets?.length) {
    const checks = c.verificationTargets
      .map((target) => `- ${target}\n  ${verificationCommand(target)}`)
      .join("\n");
    return (
      `STUCK SWEEP FINDING (successor-verification-required)\n` +
      `row: ${c.row.qitemId}\n` +
      `destination: ${c.row.destinationSession} (source ${c.row.sourceSession}, state ${c.row.state})\n` +
      `age: ${c.ageMinutes} min\n` +
      `last transition: ${lastTransitionLine(db, c.row.qitemId)}\n` +
      `why: ${c.why}\n` +
      `verification targets (indeterminate until checked on the registered host):\n${checks}\n` +
      `After a registered-host read confirms a target, record it durably on the closed row so the sweep stops asking:\n` +
      `  rig queue update ${c.row.qitemId} --note "custody-verified: <target> <how verified>"\n` +
      `Do not rewrite historical custody from this local observation; record the verification result separately.`
    );
  }
  return (
    `STUCK SWEEP FINDING (${c.kind})\n` +
    `row: ${c.row.qitemId}\n` +
    `destination: ${c.row.destinationSession} (source ${c.row.sourceSession}, state ${c.row.state})\n` +
    `age: ${c.ageMinutes} min\n` +
    `last transition: ${lastTransitionLine(db, c.row.qitemId)}\n` +
    `why: ${c.why}\n` +
    `Resolve the underlying row; the sweep closes this finding itself once the row is no longer stuck.`
  );
}

/** One row a seat's standing notice stands for: its id, when it became actionable, who sent it, and its subject. */
interface BacklogRow { qitemId: string; since: string; from: string; summary?: string | null }

/** The last line of a standing notice's body: every row it stands for, so the sweep knows what it covered. */
const BACKLOG_ROWS_PREFIX = "Every row this notice stands for: ";

/** A seat's standing unclaimed-backlog notice: its rows by id, how to list them, and how to send their findings to a seat
 *  that watches this one. Built only from the rows' fixed facts, so a pass rewrites it only when the rows change. */
function unclaimedBacklogText(seat: string, rows: BacklogRow[], thresholdMinutes: number,
  node: { rig: string; logicalId: string } | null): { summary: string; body: string } {
  const sorted = [...rows].sort((a, b) => a.since.localeCompare(b.since) || a.qitemId.localeCompare(b.qitemId));
  const listed = sorted.slice(0, UNCLAIMED_BACKLOG_LISTED_ROWS).map((r) => {
    const about = r.summary ? `: ${r.summary.replace(/\s+/g, " ").trim().slice(0, 120)}` : "";
    return `- ${r.qitemId}, unclaimed since ${r.since}, from ${r.from}${about}`;
  });
  if (sorted.length > listed.length) listed.push(`- and ${sorted.length - listed.length} more`);
  const count = `${rows.length} ${rows.length === 1 ? "row" : "rows"}`;
  const edge = node ? `rig edge add ${node.rig} ${node.logicalId} <watching seat> --kind escalates_to` : "an escalates_to edge from this seat";
  return {
    summary: `Stuck sweep: unclaimed-backlog on ${seat} (${count})`,
    body:
      `STUCK SWEEP FINDING (unclaimed-backlog)\n` +
      `seat: ${seat}\n` +
      `unclaimed: ${count} (the threshold is ${thresholdMinutes} min)\n` +
      `${listed.join("\n")}\n` +
      `why: nobody has claimed these rows, and this seat has no delegation parent and no escalates_to route, so this one ` +
      `notice stands for them instead of a finding per row. It follows the rows as they come and go.\n` +
      `List them: rig queue list --destination ${seat} --state pending\n` +
      `To send these findings to a seat that watches this one, one finding per row: ${edge}\n` +
      `The sweep closes this notice itself once every row it stands for is claimed, parked or closed.\n` +
      `${BACKLOG_ROWS_PREFIX}${JSON.stringify(sorted.map((r) => r.qitemId))}`,
  };
}

/** The rows a standing notice's body says it stands for, or null when the line is missing or unreadable: unknown, which is
 *  never read as "none". */
function backlogRowsOf(body: string): Set<string> | null {
  const line = body.split("\n").reverse().find((l) => l.startsWith(BACKLOG_ROWS_PREFIX));
  if (!line) return null;
  try {
    const ids = JSON.parse(line.slice(BACKLOG_ROWS_PREFIX.length)) as unknown;
    return Array.isArray(ids) ? new Set(ids.filter((id): id is string => typeof id === "string")) : null;
  } catch {
    return null;
  }
}

/**
 * One sweep pass. Instance-wide (no rig scope — the loop is the net for every rig the
 * daemon carries). Never throws: a sweep that cannot run reports outcome=failed loudly
 * on the status surface and the log, because a silent skip is exactly the class this
 * slice exists to kill.
 */
/** Rows a sweep pass handles between two yields of the event loop. A pass over a large queue used to hold the loop
 *  for its whole length (seconds on a queue of tens of thousands of rows, with healthz and every request waiting);
 *  every this many rows it now lets timers and requests run. */
export const STUCK_SWEEP_YIELD_EVERY_ROWS = 50;

export async function runStuckSweep(deps: StuckSweepDeps): Promise<StuckSweepResult> {
  const log = deps.log ?? ((line: string) => console.error(line));
  const status = deps.status;
  try {
    const now = deps.now ?? new Date();
    // One recovery index and one linked-successor read per stretch of the pass, instead of one json_each scan per
    // candidate and per custody row. Each is a snapshot that is only valid while no other code runs, so both are
    // dropped (and rebuilt on the next lookup) after every yield and every awaited write.
    const recoveries = createRecoveryLookup(deps.db);
    let successors: ReturnType<typeof createLinkedSuccessorLookup> | null = null;
    // Every yield and every awaited write lets other code run: indexes read before it are dropped, and `othersRan`
    // tells a list read before it that its rows need a fresh read.
    let othersRan = 0;
    const othersMayHaveRun = (): void => { othersRan++; recoveries.invalidate(); successors?.invalidate(); };
    // A synchronous read with both indexes lent to what it calls deep inside (a getById's waiting view and handoff
    // advisory ask the same questions per row). Never spans an await: the lend ends when fn returns.
    const indexed = <T>(fn: () => T): T => recoveries.run(() => (successors ? successors.run(fn) : fn()));
    // `if (dueToYield()) await yieldLoop();` and never a bare await per row: even an await that does not yield lets
    // queued microtasks (other requests' continuations) run and write between two rows the snapshot still covers.
    let rowsSinceYield = 0;
    const dueToYield = (): boolean => ++rowsSinceYield >= STUCK_SWEEP_YIELD_EVERY_ROWS;
    const yieldLoop = async (): Promise<void> => {
      rowsSinceYield = 0;
      await new Promise<void>((resolve) => setImmediate(resolve));
      othersMayHaveRun();
    };
    const suppressionMinutes = deps.ladderSuppressionMinutes ?? resolveLadderSuppressionMinutes();
    /** The dedup tags of the candidates the LADDER suppressed in this pass, and only those:
     *  a row the ladder alone would have stopped. A finding for such a row stays open,
     *  because the marker only ever stopped the re-report — it never resolved anything.
     *  Other delivery/pickup findings still need source evidence before closure. */
    const suppressedTags = new Set<string>();
    const ageMinutes = deps.unclaimedAgeMinutes ?? resolveStuckSweepUnclaimedAgeMinutes();
    const routeNotes = new Map<string, string>();
    const routed = new Set<string>();
    const resolveOrch = (session: string, row: QueueItem): string | null => {
      if (hasConsumedEscalationHop(deps.db, row.qitemId)) {
        routeNotes.set(row.qitemId, "escalates_to one-hop delivery already used; existing fallback retained");
        return null;
      }
      if (deps.resolveOrchestrator) return deps.resolveOrchestrator(session);
      const route = resolveEscalationOwner(deps.db, session, target => deps.queueRepo.acceptsDestination(target));
      if (route.outcome !== "none" && route.outcome !== "parent") routeNotes.set(row.qitemId, route.reason);
      if (route.outcome === "routed") routed.add(row.qitemId);
      return route.owner;
    };
    const isRegisteredHost = deps.isRegisteredHost ?? defaultIsRegisteredHost(log);
    const candidates: Candidate[] = [];
    const nowIso = now.toISOString();
    // SQLite's LIKE ignores ASCII case; the per-row rules below match the queries they stand in for.
    const startsWithCI = (value: string | null | undefined, prefix: string): boolean => (value ?? "").toLowerCase().startsWith(prefix);

    // Each kind's rule for ONE row, applied to the row as it is now. The loops below enumerate the rows; the same
    // rules run again on a fresh read right before a finding is created (stillStuck), because a pass that yields
    // cannot trust what it read before the yield: a claim, a delivered wake, a moved deadline, a note or a new
    // successor may have landed since.

    // Half 1 — claimed-never-closed. The claimant holds the obligation; the finding
    // routes to them.
    const overdueCandidate = (row: QueueItem): Candidate | null => {
      if (isFindingRow(row)) return null;
      return {
        kind: "overdue-claim",
        row,
        route: row.destinationSession,
        ageMinutes: minutesSince(row.closureRequiredAt ?? row.claimedAt, now),
        evidenceAt: latestIso(lastMeaningfulTransition(deps.db, row.qitemId)?.at, row.closureRequiredAt, row.claimedAt),
        why: "claimed and past closure_required_at with no closure",
      };
    };

    // S04 seam — a claimed row with no later motion past the pickup threshold. The
    // pickup module remains the ONE derivation rule; this only enumerates and routes.
    const stalledCandidate = (qitemId: string): Candidate | null => {
      const row = indexed(() => deps.queueRepo.getById(qitemId));
      if (!row || isFindingRow(row)) return null;
      if ((row.state !== "pending" && row.state !== "in-progress") || !row.claimedAt) return null;
      const stalled = stalledPickupFinding(row);
      if (!stalled) return null;
      // Keep this null arm for the 0.5.7 mechanized-pull turn-end hook that knows the in-flight row;
      // it is the first honest row-scoped writer, and wiring reopens only in that slice.
      const evidenceAt = latestIso(lastMeaningfulTransition(deps.db, row.qitemId)?.at, row.lastHeartbeat, row.claimedAt);
      return {
        kind: stalled.kind,
        row,
        route: resolveOrch(stalled.target, row) ?? stalled.target,
        // The stall's own age: from the anchor the pickup decision uses, floored as its "why" counts, so a claim
        // parked and resumed doesn't count its parked time and the headline matches the why to the minute.
        ageMinutes: wholeMinutesSince(evidenceAt, now),
        evidenceAt,
        why: stalled.evidence,
      };
    };

    // The timer delivered one transition-specific notice (or recorded a failed
    // attempt). This existing sweep owns its bounded recovery, not another full
    // packet or a parked-owner replay. A real owner response ends the occurrence.
    const waitCandidate = (jobId: string): Candidate | null => {
      const job = deps.db.prepare("SELECT spec_yaml FROM watchdog_jobs WHERE job_id = ? AND state = 'active' AND policy = 'periodic-reminder'")
        .get(jobId) as { spec_yaml: string } | undefined;
      const notice = job ? queueWaitNotice(job.spec_yaml) : null;
      if (!notice || now.getTime() - Date.parse(notice.at) <= resolvePickupThresholdMinutes() * 60_000) return null;
      const binding = deps.db.prepare("SELECT qitem_id FROM queue_transition_wakes WHERE wake_ref = ? AND phase = 'armed' ORDER BY transition_id DESC LIMIT 1").get(jobId) as { qitem_id: string } | undefined;
      const row = binding ? indexed(() => deps.queueRepo.getById(binding.qitem_id)) : null;
      if (!row || row.state !== "blocked" || deps.queueRepo.getParkWakeStatus(row.qitemId)?.ref !== jobId) return null;
      const response = lastMeaningfulTransition(deps.db, row.qitemId);
      if (response && Date.parse(response.at) > Date.parse(notice.at)) return null;
      const ownerActivity = deps.queueRepo.ownerActivity(row.destinationSession);
      if (ownerActivity?.activity === "working" && !ownerActivity.needsInput.count && notice.deliveryStatus === "ok") return null;
      return { kind: "unconsumed-wait", row, route: resolveOrch(row.destinationSession, row) ?? row.sourceSession,
        ageMinutes: minutesSince(notice.at, now), evidenceAt: notice.at, jobId,
        why: `wait notice delivery=${notice.deliveryStatus}; no later owner response; activity=${ownerActivity?.activity ?? "unknown"}; inspect exact blocker ${row.blockedOn}` };
    };

    // The parked policy stops repeating a positively no-input failure. Unhealthy blocked rows
    // have no retry ladder: the same sweep/recovery route owns their actionable disposition.
    const parkedCandidate = (qitemId: string): Candidate | null => {
      const row = indexed(() => deps.queueRepo.getById(qitemId));
      if (!row || isFindingRow(row)) return null;
      if (row.state !== "blocked" || !startsWithCI(row.lastNudgeResult, "failed:")) return null;
      const wake = deps.queueRepo.getParkWakeStatus(qitemId);
      if ((wake?.live === true && (!wake.unconsumed || wake.recoveryOwner === "queue-stuck-sweep"))
        || deps.queueRepo.parkWakeServedByOwnReminder(qitemId)) return null;
      const transitions = deps.queueRepo.listTransitions(qitemId);
      const failure = currentParkedOwnerNoInputFailure(transitions);
      if (!failure) return null;
      // Another seat's incidental note is not the owner's response. This kind follows
      // the parked policy's owner-or-state-change rule, leaving other sweep kinds alone.
      if (transitions.some((t, i) => t.transitionId > (failure.transitionId ?? Number.POSITIVE_INFINITY)
        && (t.actorSession === row.destinationSession || t.state !== transitions[i - 1]?.state))) return null;
      return { kind: "parked-owner-no-input", row, route: resolveOrch(row.destinationSession, row) ?? row.sourceSession,
        ageMinutes: minutesSince(failure.ts, now), evidenceAt: failure.ts,
        why: `Automated parked-owner reminder refused before input (${failure.code}); repeated input stopped. Inspect the retained quota/guard or route terminal work to an agent. Original blocker remains ${row.blockedOn}` };
    };

    // Half 2 — sender-believed-delivered-never-woken. Nobody holds it (the wake failed),
    // so it routes to the destination's orchestrator when one is derivable. Rows with a
    // live S01 ladder are S01's territory; an exhausted ladder is the handback and lands
    // here exactly once (the dedup tag keeps it to one finding).
    // A wake recorded unroutable because the seat's pane wasn't bound yet (#2151). Once its binding exists, deliver the
    // row's own wake intent instead of reporting it: the intent is claimed and settled, so a startup drain doesn't send it
    // again, and one already in flight or settled isn't sent twice. The next tick reads the new result, so a failed send
    // is reported then. A row with a live retry ladder is left to the ladder.
    // The rule is shared with the reachable-seat retry; a live retry ladder is this sweep's own check.
    const wakeToRetry = (row: QueueItem): boolean => deps.queueRepo.unroutableWakeRetryable(row, now)
      && !hasLiveLadder(deps.db, row.qitemId, now, suppressionMinutes);
    const isHumanNotice = (row: QueueItem): boolean => row.deliveryOutcome === "never-posted" || row.deliveryOutcome === "transport-failed";
    /** `row` comes from findUndelivered (it carries the delivery verdict). Call it after any wake retry the row needs. */
    const undeliveredCandidate = (row: QueueItem, recordSuppression: boolean): Candidate | null => {
      if (isFindingRow(row)) return null;
      const humanNotice = isHumanNotice(row);
      // A claim supersedes a retained failed wake, including on a row returned to
      // pending. Its pickup finding must not be replaced by that historical failure;
      // a separate human notification still needs its own delivery evidence.
      if (!humanNotice && row.claimedAt) return null;
      if (!humanNotice && deps.queueRepo.isLocalHumanDecisionWithoutGateway(row)) return null;
      const notification = humanNotice ? deps.queueRepo.transitionLog.latestOwnerNotificationForQitem(row.qitemId) : null;
      const resolutionNotice = notification?.ownerNotificationKind === "human-decision-resolved";
      // Match the notification source in slack/queue-access.ts, not the agent wake's escalator.
      const noticeOwner = row.state === "blocked" || resolutionNotice ? row.destinationSession : row.sourceSession;
      const noticeRecipient = resolutionNotice ? notification.actorSession : row.state === "blocked" ? row.blockedOn : row.destinationSession;
      const failure = humanNotice
        ? `human notice ${row.deliveryOutcome} to ${noticeRecipient}: ${row.deliveryFailureDetail}`
        : `wake failed (${row.lastNudgeResult ?? "failed"})`;
      // Quiet hours: a held, turned-back or released ask belongs to its window's release job, so a failed wake, or a post
      // not yet made, isn't "nothing retried it". A release whose post failed is a failed delivery, and a hold with no
      // live release job is orphaned: both stay findings, with their own reason.
      const quiet = quietHoldCustody(deps.db, row.qitemId, now);
      if (quiet && (quiet.state === "held" || quiet.state === "released")) return null;
      // The ladder check runs LAST, so only a row the ladder ALONE would have stopped counts
      // as ladder-suppressed (#1419). Agent wake retries do not own the separate notice to a
      // person: a human notice is never the ladder's to suppress.
      if (!humanNotice && hasLiveLadder(deps.db, row.qitemId, now, suppressionMinutes)) {
        if (recordSuppression) suppressedTags.add(findingDedupTag("undelivered-wake", row.qitemId));
        return null;
      }
      return {
        kind: humanNotice ? "undelivered-human-notice" : "undelivered-wake",
        row,
        route: humanNotice ? noticeOwner : resolveOrch(row.destinationSession, row) ?? row.destinationSession,
        ageMinutes: minutesSince(row.tsCreated, now),
        evidenceAt: latestIso(row.tsUpdated, row.lastNudgeAttempt),
        why: quiet?.state === "orphaned"
          ? `held for quiet hours (window ${quiet.windowId}), but no release job is live for that window: nothing will release it (${failure})`
          : quiet?.state === "release-failed"
            ? `released after quiet hours; its post failed (${quiet.failure}); the release stays queued for redelivery`
            : humanNotice
              ? `${failure}; check human-notification delivery rather than retrying the agent wake`
              : `${failure} and nothing retried it`,
      };
    };
    const undeliveredNow = (qitemId: string): QueueItem | undefined => indexed(() => deps.queueRepo.findUndelivered({ qitemId }))[0];

    // The A1 net — created-with-destination rows carrying real obligations, unclaimed past
    // the config-keyed age. Parks (state=blocked) legitimately wait and never appear here;
    // failed-nudge rows already surfaced in half 2; laddered rows are S01's.
    const cutoff = new Date(now.getTime() - ageMinutes * 60_000).toISOString();
    const unclaimedCandidate = (qitemId: string, recordSuppression: boolean): Candidate | null => {
      const row = indexed(() => deps.queueRepo.getById(qitemId));
      if (!row || isFindingRow(row)) return null;
      // The query's own predicate, on the row as it is now.
      if (row.state !== "pending" || row.claimedAt || !row.destinationSession || row.tsCreated > cutoff
        || startsWithCI(row.lastNudgeResult, "failed:")) return null;
      if (deps.queueRepo.isLocalHumanDecisionWithoutGateway(row)) return null;
      const actionableAt = pendingSince(deps.db, row.qitemId) ?? row.tsCreated;
      if (actionableAt > cutoff) return null;
      // #514 — an ask already posted to its registered human in the current delivery episode waits on
      // that human; it is not stuck, and a finding would post the human again. Unposted, failed,
      // legacy and non-human rows keep this net.
      if (deps.queueRepo.humanNotificationPostedThisEpisode(row.qitemId)) return null;
      // An ask placed on Steering without an alert waits on its person there by design; a finding would alert them.
      if (deps.queueRepo.humanAskWithoutAlert(row.qitemId)) return null;
      // Quiet hours: a held ask whose window's release job is live waits on that job, and one already released waits on
      // its post; neither is stuck. A release whose post failed is reported once, by the undelivered-wake loop above. A
      // hold with no live release job is stuck: nothing will ever release it.
      const quiet = quietHoldCustody(deps.db, row.qitemId, now);
      if (quiet && quiet.state !== "orphaned") return null;
      // An explicit informational update to a currently registered human is for reading, not an obligation to claim,
      // unless its quiet-hours hold has been orphaned before release.
      if (!quiet && deps.queueRepo.isRegisteredHumanUpdate(row)) return null;
      // The seat's typing guard or interruption level held its wake on purpose: it's held and readable at the seat, not
      // stuck. (A handed-off baton's one held notice is the wake ladder's.)
      if (row.lastNudgeResult === "retained:typing_guard") return null;
      // The ladder check runs LAST here too: a row the ladder alone would have stopped is
      // ladder-suppressed, and its finding stays open (#1419).
      if (hasLiveLadder(deps.db, row.qitemId, now, suppressionMinutes)) {
        if (recordSuppression) suppressedTags.add(findingDedupTag("unclaimed-obligation", row.qitemId));
        return null;
      }
      return {
        kind: "unclaimed-obligation",
        row,
        route: resolveOrch(row.destinationSession, row) ?? row.destinationSession,
        ageMinutes: minutesSince(actionableAt, now),
        evidenceAt: actionableAt,
        why: quiet?.state === "orphaned"
          ? `held for quiet hours (window ${quiet.windowId}) for ${minutesSince(actionableAt, now)} min, but no release job is live for that window: nothing will release it`
          : `actionable with a destination and unclaimed for ${minutesSince(actionableAt, now)} min (threshold ${ageMinutes})${
            unreadableOwner(row.destinationSession) ? "; owner activity unknown (can't read the seat)" : ""}`,
      };
    };

    /** The seat's activity can't be read (no reading, or one that reads unknown): said in the finding, so an unreadable
     *  seat isn't taken for one ignoring its work. The stalled finding says the same (`queue-pickup.ts`). A person has no
     *  seat to read, so their row never says so; nor does a row whose destination can't be classified, since it may be a
     *  person's. A classification fault never stops the sweep. */
    function unreadableOwner(session: string): boolean {
      try {
        if (deps.queueRepo.isHumanDestination(session)) return false;
      } catch {
        return false;
      }
      const activity = deps.queueRepo.ownerActivity(session)?.activity;
      return !activity || activity === "unknown";
    }

    // The custody class — a terminal row whose closure names one or more successor
    // qitems or seat-address targets (closure_reason = 'handed_off_to'). A local miss is
    // never proof of absence: the successor may live in another registered host's database.
    // Comma fan-out is checked member-by-member and only unresolved members are reported.
    // Three dispositions satisfy a member without a local hit / check:
    // (1) proof-at-write — a REGISTERED host qualifier whose successor id RECOMPUTES
    // from this row's own (qitem_id, handed_off_to, host) through the same deterministic
    // derivation the cross-host close uses. The close path records that key only AFTER
    // its forwarded successor-create succeeded, and the generic update path (which
    // accepts arbitrary closure targets) cannot accidentally synthesize the sha256-derived
    // id — registered-host SYNTAX alone is never trusted;
    // (2) linked local successor for seat targets — a row in the local store whose
    // destination matches the target seat and carries this source row's lineage (either
    // handed_off_from or chain_of_record); and
    // (3) a durable `custody-verified:` transition note written on the source row by
    // whoever performed the registered-host read (read from active + archived transitions).
    // Historical source rows are never mutated by this detector — the disposition note is the
    // verifier's act, not ours.
    // Internal handoffs record handed_off_to. A generic reclose can retain an old
    // owner, so skip only recorded handoffs whose current target still matches (#341).
    // Closures outside the recent 24-hour window without open findings are skipped so upgrading
    // a real queue history does not raise a flood of historical findings.
    /** `recheck`: read live without the lent indexes, and don't log the registry fallback a second time. */
    const custodyCandidate = (qitemId: string, hasSuccessor: (source: string, target: string) => boolean, recheck = false): Candidate | null => {
      // A recheck reads live, without the lent indexes: one row's own queries cost less than a rebuilt successor index.
      const row = recheck ? deps.queueRepo.getById(qitemId) : indexed(() => deps.queueRepo.getById(qitemId));
      if (!row || isFindingRow(row)) return null;
      // The query's own predicate, on the row as it is now.
      const closed = row.state === "done" || row.state === "canceled"
        || (row.state === "handed-off" && (row.handedOffTo == null || (row.closureTarget ?? null) !== row.handedOffTo));
      if (!closed || !(startsWithCI(row.closureTarget, "qitem-") || row.closureReason === "handed_off_to")) return null;
      // Local recorded targets were filtered in SQL; remote keys use the same
      // derivation as the cross-host close, without reading successor history.
      if (row.state === "handed-off" && matchesRecordedHandoffTarget(row.qitemId, row.handedOffTo, row.closureTarget)) return null;
      const targets = (row.closureTarget ?? row.handedOffTo ?? "")
        .split(",")
        .map((target) => target.trim())
        .filter(Boolean);
      if (targets.length === 0 && row.closureReason === "handed_off_to") {
        targets.push("(unspecified)");
      }
      const verified = custodyVerifiedTargets(deps.db, row.qitemId);
      const verificationTargets = targets.filter((target) => {
        if (verified.has(target)) return false;
        if (target.startsWith("qitem-")) {
          const at = target.indexOf("@");
          if (at !== -1) {
            const hostId = target.slice(at + 1);
            const successorId = target.slice(0, at);
            return !(
              isRegisteredHost(hostId) &&
              row.handedOffTo !== null &&
              successorId === deriveCrossHostSuccessorId(row.qitemId, row.handedOffTo, hostId)
            );
          }
          if (target === row.qitemId) return true;
          return !indexed(() => deps.queueRepo.getById(target));
        }
        try {
          return !hasSuccessor(row.qitemId, target);
        } catch {
          return true;
        }
      });
      if (verificationTargets.length === 0) return null;
      let route = row.destinationSession;
      try {
        route = custodyFindingRoute(deps.db, deps.queueRepo, row);
      } catch (err) {
        if (!(err instanceof QueueRepositoryError) || err.code !== "human_registry_unavailable") throw err;
        // The registry may not exist before the first human is registered. Losing
        // owner refinement must not stop unrelated findings or their resolution.
        if (!recheck) log(`[stuck-sweep] keeping custody route for ${row.qitemId} at ${row.destinationSession}: ${err.message}`);
      }
      return {
        kind: "dangling-closure",
        row,
        route,
        ageMinutes: minutesSince(row.tsUpdated, now),
        evidenceAt: latestIso(row.tsUpdated),
        why: `closed (${row.closureReason ?? "?"}) with successor custody that this local store cannot fully verify`,
        verificationTargets,
      };
    };

    const armedJobOf = (qitemId: string): string | undefined => (deps.db.prepare(
      "SELECT wake_ref FROM queue_transition_wakes WHERE qitem_id = ? AND phase = 'armed' ORDER BY transition_id DESC LIMIT 1",
    ).get(qitemId) as { wake_ref: string } | undefined)?.wake_ref;
    /** A kind's rule, again, on the row as it is now (read live, without the lent indexes): the candidate it makes now,
     *  with its current route, reason and targets, or null when it no longer holds. */
    const freshCandidate = (kind: StuckFindingKind, id: string, jobId?: string): Candidate | null => {
      switch (kind) {
        case "overdue-claim": {
          const row = deps.queueRepo.findOverdue({ now: nowIso, qitemId: id })[0];
          return row ? overdueCandidate(row) : null;
        }
        case "stalled-after-claim": return stalledCandidate(id);
        case "unconsumed-wait": {
          const job = jobId ?? armedJobOf(id);
          const c = job ? waitCandidate(job) : null;
          return c?.row.qitemId === id ? c : null;
        }
        case "parked-owner-no-input": return parkedCandidate(id);
        case "undelivered-wake":
        case "undelivered-human-notice": {
          const row = undeliveredNow(id);
          // the wake retry already ran in this pass; a row that still needs it now was not woken by it
          const c = row ? undeliveredCandidate(row, false) : null;
          return c?.kind === kind ? c : null;
        }
        case "unclaimed-obligation": return unclaimedCandidate(id, false);
        case "dangling-closure": return custodyCandidate(id, (source, target) => hasLinkedSuccessor(deps.db, source, target), true);
        default: return null;
      }
    };
    /** Whether a kind's rule still holds now, leaving the routing notes (routeNotes, routed) as they were. */
    const ruleHolds = (kind: StuckFindingKind, id: string, jobId?: string): boolean => {
      const notes = new Map(routeNotes);
      const wasRouted = new Set(routed);
      try {
        return !!freshCandidate(kind, id, jobId);
      } finally {
        routeNotes.clear();
        for (const [k, v] of notes) routeNotes.set(k, v);
        routed.clear();
        for (const k of wasRouted) routed.add(k);
      }
    };
    const stillStuck = (c: Candidate): boolean => ruleHolds(c.kind, c.row.qitemId, c.jobId);
    /** The kinds the resolution closes on "no longer detected" alone (the others need source evidence). */
    const resolvedByRule = new Set<string>(["overdue-claim", "stalled-after-claim", "unconsumed-wait", "parked-owner-no-input", "dangling-closure"]);

    // The rows each rule looks at. The id lists are judged on a fresh getById per row; the two finders return whole
    // rows, which are read again by id once other code may have run since the list was read.
    let listedAt = othersRan;
    for (const listed of indexed(() => deps.queueRepo.findOverdue({ now: nowIso }))) {
      if (dueToYield()) await yieldLoop();
      const row = listedAt !== othersRan ? indexed(() => deps.queueRepo.findOverdue({ now: nowIso, qitemId: listed.qitemId }))[0] : listed;
      const c = row ? overdueCandidate(row) : null;
      if (!c) continue;
      candidates.push(c);
      try {
        // Only a transition and an event: no index or listed row changes.
        deps.queueRepo.recordClosureOverdue(row!.qitemId, { now: nowIso });
      } catch (err) {
        log(`[stuck-sweep] failed to record closure-overdue for ${row!.qitemId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    for (const { qitem_id } of deps.db
      .prepare("SELECT qitem_id FROM queue_items WHERE state IN ('pending', 'in-progress') AND claimed_at IS NOT NULL")
      .all() as Array<{ qitem_id: string }>) {
      if (dueToYield()) await yieldLoop();
      const c = stalledCandidate(qitem_id);
      if (c) candidates.push(c);
    }

    for (const { job_id } of deps.db.prepare("SELECT job_id FROM watchdog_jobs WHERE state = 'active' AND policy = 'periodic-reminder'")
      .all() as Array<{ job_id: string }>) {
      if (dueToYield()) await yieldLoop();
      const c = waitCandidate(job_id);
      if (c) candidates.push(c);
    }

    for (const { qitem_id } of deps.db.prepare("SELECT qitem_id FROM queue_items WHERE state='blocked' AND last_nudge_result LIKE 'failed:%'")
      .all() as Array<{ qitem_id: string }>) {
      if (dueToYield()) await yieldLoop();
      const c = parkedCandidate(qitem_id);
      if (c) candidates.push(c);
    }

    listedAt = othersRan;
    for (const listed of indexed(() => deps.queueRepo.findUndelivered())) {
      if (dueToYield()) await yieldLoop();
      let row = listedAt !== othersRan ? undeliveredNow(listed.qitemId) : listed;
      if (!row || isFindingRow(row)) continue;
      if (wakeToRetry(row)) {
        await deps.queueRepo.deliverWakeForSuccessor(row.qitemId, row.destinationSession, true, row.sourceSession);
        othersMayHaveRun();
        // judged again on the row as the send (and anyone else during it) left it
        row = undeliveredNow(row.qitemId);
        if (!row?.lastNudgeResult?.startsWith("unroutable:")) continue;
      }
      const c = undeliveredCandidate(row, true);
      if (c) candidates.push(c);
    }

    for (const { qitem_id } of deps.db
      .prepare(
        `SELECT qitem_id FROM queue_items
          WHERE state = 'pending'
            AND claimed_at IS NULL
            AND destination_session IS NOT NULL AND destination_session != ''
            AND ts_created <= ?
            AND (last_nudge_result IS NULL OR last_nudge_result NOT LIKE 'failed:%')`,
      )
      .all(cutoff) as Array<{ qitem_id: string }>) {
      if (dueToYield()) await yieldLoop();
      const c = unclaimedCandidate(qitem_id, true);
      if (c) candidates.push(c);
    }

    const custodyHours = deps.custodyWindowHours ?? STUCK_SWEEP_CUSTODY_WINDOW_HOURS;
    const custodyCutoff = new Date(now.getTime() - custodyHours * 3_600_000).toISOString();
    const openDanglingIds: string[] = [];
    const danglingPrefix = "stuck-sweep:dangling-closure:";
    for (const { tags } of deps.db
      .prepare(`SELECT tags FROM queue_items WHERE state IN ('pending', 'in-progress', 'blocked') AND tags LIKE ?`)
      .all(`%"${danglingPrefix}%`) as Array<{ tags: string }>) {
      try {
        for (const tag of JSON.parse(tags) as string[]) {
          if (tag.startsWith(danglingPrefix)) {
            openDanglingIds.push(tag.slice(danglingPrefix.length));
          }
        }
      } catch {
        // Skip malformed tags
      }
    }
    const custodyRows = deps.db
      .prepare(
        // Bound candidates before checking state: including handed-off in the
        // state index scan would otherwise revisit all historical atomic handoffs.
        `WITH custody_candidates AS MATERIALIZED (
           SELECT qitem_id, state, handed_off_to, closure_target, closure_reason
             FROM queue_items WHERE ts_updated >= ?
           UNION
           SELECT qitem_id, state, handed_off_to, closure_target, closure_reason
             FROM queue_items WHERE qitem_id IN (SELECT value FROM json_each(?))
         )
         SELECT q.qitem_id FROM custody_candidates q
          WHERE (q.state IN ('done', 'canceled') OR (q.state = 'handed-off'
            AND (q.handed_off_to IS NULL OR q.closure_target IS NOT q.handed_off_to)))
            AND (q.closure_target LIKE 'qitem-%' OR q.closure_reason = 'handed_off_to')`,
      )
      .all(custodyCutoff, JSON.stringify(openDanglingIds)) as Array<{ qitem_id: string }>;
    successors = createLinkedSuccessorLookup(deps.db, custodyRows.map((r) => r.qitem_id));
    const lookup = successors;
    for (const { qitem_id } of custodyRows) {
      if (dueToYield()) await yieldLoop();
      const c = custodyCandidate(qitem_id, (source, target) => lookup.has(source, target));
      if (c) candidates.push(c);
    }

    // A finding for a confirmed-missing session goes to a live recovery seat when one is available,
    // since nothing would ever wake the missing one (the ladder covers handed-off batons only): the
    // operator agent, else the operator seat (the ladder's own floor, the person approvals use), else
    // the stuck row's creator, skipping any that is unset, confirmed missing or this seat. When none
    // qualifies, the finding stays addressed to the missing session and says so; it's never dropped.
    // A live seat keeps its own.
    const stoppedReason = (session: string) => {
      const nodeId = resolveSessionNodeId(deps.db, session);
      return nodeId === null ? null : nodeExecutorStoppedReason(deps.db, nodeId);
    };
    const sessionMissing = deps.sessionConfirmedMissing ?? ((session: string) => stoppedReason(session) !== null);
    let recoverySeats: Array<string | null> | undefined;
    const routeAroundMissing = (c: Candidate): void => {
      if (!sessionMissing(c.route)) return;
      const stoppedDescription = stoppedReason(c.route) === "pane_exited"
        ? "has a confirmed exited pane (pane_exited)" : "is confirmed missing (session_missing)";
      recoverySeats ??= [(deps.resolveRecoveryAgentSeat ?? resolveRecoveryAgentSeat)(), (deps.resolveOperatorSeat ?? resolveOperatorSeat)()];
      const choices = [...recoverySeats, c.row.sourceSession];
      const chosen = choices.findIndex((seat) => !!seat && seat !== c.route && !sessionMissing(seat));
      const floor = chosen < 0 ? null : choices[chosen]!;
      if (!floor) {
        c.why += `; ${c.route} ${stoppedDescription} and no live recovery seat is available (operator agent, operator seat and creator are each unset, missing or this seat; an operator agent setting that's unreadable or isn't an agent's session counts as unset), so this finding stays addressed to it`;
        return;
      }
      // Name the rule that chose it, so whoever receives the finding knows why, and which setting to change.
      c.why += `; ${c.route} ${stoppedDescription}, so this finding goes to ${floor}, ${RECOVERY_SEAT_RULES[chosen]}`;
      c.route = floor;
    };

    // A destination its own wake found unroutable, and still is (no terminal, not a person: a hosted member, or a
    // mistyped address), can't hear its finding either; a seat launched since its wake keeps its own. A hosted member
    // OpenRig rings, whose work is still unclaimed (its ring failed, or it didn't pick the work up by the unclaimed
    // age), goes the same way; one that claimed and stalled keeps its own finding, which rings it. Only a person can
    // make a hosted member check its work, so the person goes first: the operator seat when it's a person's address,
    // else the row's creator, else the operator agent, skipping any that is unset, this seat, confirmed missing,
    // unroutable or a terminal seat itself. A bound terminal seat goes the same way: the queue wake types nothing into
    // it, and nothing there can claim work.
    const classOf = (seat: string) => deps.queueRepo.classifyDestinationOf(seat).class;
    const routeAroundNoWake = (c: Candidate): void => {
      if (c.route !== c.row.destinationSession) return;
      const destination = classOf(c.row.destinationSession);
      const noRoute = destination === "unroutable" && !!c.row.lastNudgeResult?.startsWith("unroutable:");
      const terminalSeat = destination === "pane-bound" && isBoundTerminalSeat(deps.db, c.row.destinationSession);
      if (!noRoute && !terminalSeat && !(destination === "hosted" && !c.row.claimedAt)) return;
      const operatorSeat = (deps.resolveOperatorSeat ?? resolveOperatorSeat)();
      const person = operatorSeat && classOf(operatorSeat) === "gateway-routable" ? operatorSeat : null;
      const choices = [person, c.row.sourceSession, (deps.resolveRecoveryAgentSeat ?? resolveRecoveryAgentSeat)()];
      const chosen = choices.findIndex((seat) => !!seat && seat !== c.route && !sessionMissing(seat) && classOf(seat) !== "unroutable"
        && !isBoundTerminalSeat(deps.db, seat));
      c.why += noRoute
        ? `; ${c.route} has no wake route on this daemon (no terminal, not a person). If it's a hosted member, it sees this work only when it next checks, so ask it to; otherwise fix the address`
        : terminalSeat
          ? `; ${c.route} is a terminal seat; nothing there can claim this work, and no wake is typed into it. Route the work to an agent seat`
          : `; ${c.route} is a hosted member. OpenRig rang its trigger (${c.row.lastNudgeResult ?? "no ring recorded"}), and it hasn't claimed this work. It sees work only when it checks, so ask it to`;
      if (chosen < 0) {
        c.why += `. No person, creator or operator agent that can be reached is available, so this finding stays addressed to it`;
        return;
      }
      c.why += `. This finding goes to ${choices[chosen]}, ${NO_WAKE_ROUTE_RULES[chosen]}`;
      c.route = choices[chosen]!;
    };
    /** The two re-routes, in order, for one candidate. */
    const routeCandidate = (c: Candidate): void => { routeAroundMissing(c); routeAroundNoWake(c); };
    for (const c of candidates) {
      if (dueToYield()) await yieldLoop();
      routeAroundMissing(c);
    }
    for (const c of candidates) {
      if (dueToYield()) await yieldLoop();
      routeAroundNoWake(c);
    }

    // Route: idempotent per (row, kind). An existing open finding refreshes its age; a
    // new one is created durable + waking (the create path's default nudge).
    const findings: StuckSweepFindingAction[] = [];
    const liveDedupTags = new Set<string>();
    const candidateIds = new Set(candidates.map((c) => c.row.qitemId));
    // A finding that could not be created (a row whose destination no longer resolves, say) must not
    // stop the others: it is reported, its row stays detected, and the pass is still a failure.
    const failedCreates: string[] = [];
    // #2430: an unclaimed row whose finding would go back to its own agent seat (no delegation parent and no escalates_to
    // route declared) tells that seat nothing: it already holds the row. A seat that reads its rows without claiming
    // them, a person's front door, got one such finding per row. Those rows share one standing notice per seat instead
    // (below). A finding per row stays for a person's address or a terminal seat, for a declared route that failed (its
    // finding names why, and a declared delegation parent with no session is one), and for a row that already has a
    // recovery.
    const agentSeats = new Map<string, { logicalId: string; rig: string } | null>();
    /** An agent seat's node: one whose runtime isn't a terminal, with no declared delegation parent, at an address that
     *  isn't a person's. An address the human registry can't classify counts as a person's. null for anything else. Read
     *  once per seat per pass. */
    const agentSeatNode = (session: string): { logicalId: string; rig: string } | null => {
      if (agentSeats.has(session)) return agentSeats.get(session)!;
      const nodeId = resolveSessionNodeId(deps.db, session);
      const node = nodeId ? deps.db.prepare(`SELECT n.logical_id AS logicalId, n.runtime AS runtime, r.name AS rig,
          EXISTS (SELECT 1 FROM edges e WHERE e.target_id = n.id AND e.kind = 'delegates_to') AS parent
          FROM nodes n JOIN rigs r ON r.id = n.rig_id WHERE n.id = ?`)
        .get(nodeId) as { logicalId: string; runtime: string | null; rig: string; parent: number } | undefined : undefined;
      let agent: { logicalId: string; rig: string } | null = null;
      try {
        if (node && node.runtime !== "terminal" && !node.parent && !deps.queueRepo.isHumanDestination(session)) {
          agent = { logicalId: node.logicalId, rig: node.rig };
        }
      } catch { /* unclassifiable: a person's, as above */ }
      agentSeats.set(session, agent);
      return agent;
    };
    const selfRoutedUnclaimed = (c: Candidate): boolean => c.kind === "unclaimed-obligation"
      && c.route === c.row.destinationSession && !routeNotes.has(c.row.qitemId) && agentSeatNode(c.route) !== null;
    const unclaimedBacklog = new Map<string, Candidate[]>();
    for (const c of [...new Map(candidates.map(c => [c.row.qitemId, c])).values()]) {
      if (dueToYield()) await yieldLoop();
      const dedupTag = findingDedupTag(c.kind, c.row.qitemId);
      const shared = recoveries.find(c.row.qitemId);
      if (!shared && selfRoutedUnclaimed(c)) {
        const rows = unclaimedBacklog.get(c.route);
        if (rows) rows.push(c); else unclaimedBacklog.set(c.route, [c]);
        continue;
      }
      const sharedRow = shared ? indexed(() => deps.queueRepo.getById(shared.qitemId)) : null;
      // A later accepted deadline can expire after the previous finding closed.
      // Its newer time is fresh evidence even when the pickup candidate wins this row.
      // An OPEN recovery still owns custody.
      const renewedDeadline = c.row.state === "in-progress" && sharedRow
        && Date.parse(c.row.closureRequiredAt ?? "") <= now.getTime()
        && !["pending", "in-progress", "blocked"].includes(sharedRow.state)
        && evidenceIsNewer(c.row.closureRequiredAt ?? "", sharedRow.tsUpdated);
      if (shared && !renewedDeadline) {
        const existingTags = sharedRow?.tags ?? [];
        for (const tag of existingTags) if (tag.startsWith("stuck-sweep:")) liveDedupTags.add(tag);
        // Keep the original evidence as history, but do not leave it presented as
        // the current reason when a different condition now owns this recovery.
        // Only the sweep's own findings are mutable here; other recovery rows
        // can share custody and must retain their author's text.
        if (sharedRow && isFindingRow(sharedRow) && sharedRow.summary?.startsWith("Stuck sweep: ")) {
          const currentKind = sharedRow.summary.match(/^Stuck sweep: ([a-z-]+) on /)?.[1];
          const pickupOrDeadline = (kind: string) => kind === "stalled-after-claim" || kind === "overdue-claim";
          const humanUpdateNotice = currentKind === "unclaimed-obligation"
            && c.kind === "undelivered-human-notice"
            && deps.queueRepo.isRegisteredHumanUpdate(c.row);
          if (currentKind && currentKind !== c.kind && ((pickupOrDeadline(currentKind) && pickupOrDeadline(c.kind)) || humanUpdateNotice)
            && stillStuck(c)) { // the new reason must still hold on the row as it is now
            const marker = "\n\n--- Original finding (historical) ---\n";
            const original = sharedRow.body.includes(marker) ? sharedRow.body.split(marker, 2)[1]! : sharedRow.body;
            const body = evidenceBody(deps.db, c) + marker + original;
            const summary = `Stuck sweep: ${c.kind} on ${c.row.qitemId} (${c.ageMinutes} min)`;
            deps.db.prepare("UPDATE queue_items SET body = ?, summary = ? WHERE qitem_id = ? AND body = ? AND summary = ? AND state IN ('pending', 'in-progress', 'blocked')")
              .run(body, summary, shared.qitemId, sharedRow.body, sharedRow.summary);
          }
        }
        if (["pending", "in-progress", "blocked"].includes(shared.state)) findings.push({ kind: c.kind, qitemId: c.row.qitemId, findingQitemId: shared.qitemId, action: "refreshed" });
        continue;
      }
      liveDedupTags.add(dedupTag);
      const existing = deps.db
        .prepare(
          // The first term is implied by the second (its pattern starts with that literal); it lets
          // the planner use idx_queue_items_recovery_tags (migration 099) instead of a full scan.
          `SELECT qitem_id, source_session, state, ts_updated FROM queue_items
            WHERE (tags LIKE '%"stuck-sweep:%') AND tags LIKE ?
            ORDER BY CASE WHEN state IN ('pending', 'in-progress', 'blocked') THEN 0 ELSE 1 END,
                     ts_updated DESC, ts_created DESC, qitem_id DESC
            LIMIT 1`,
        )
        .get(`%"${dedupTag}"%`) as
        | { qitem_id: string; source_session: string; state: string; ts_updated: string }
        | undefined;
      const existingIsOpen = existing && ["pending", "in-progress", "blocked"].includes(existing.state);
      if (existing && existingIsOpen) {
        // Age is derived at read time; an unchanged scan is not a transition.
        findings.push({ kind: c.kind, qitemId: c.row.qitemId, findingQitemId: existing.qitem_id, action: "refreshed" });
      } else if (renewedDeadline || !existing || evidenceIsNewer(c.evidenceAt, existing.ts_updated)) {
        // The row was found stuck before the pass's later yields and awaited writes: its rule runs again on the row as
        // it is now, and a row that no longer qualifies gets no new finding (its dedup tag stays live this pass).
        // the escalation note and hop recorded at listing belong to that route; keep only what this run records
        routeNotes.delete(c.row.qitemId);
        routed.delete(c.row.qitemId);
        const now_ = freshCandidate(c.kind, c.row.qitemId, c.jobId);
        if (!now_) continue;
        routeCandidate(now_); // its destination, reason and targets as they are now
        const input = {
          qitemId: recoveryId(deps.db, c.row.qitemId, renewedDeadline ? c.row.closureRequiredAt! : undefined),
          // The detector is machinery, not a seat: the obligation's own creator is the
          // finding's source (the workflow-exception precedent).
          sourceSession: c.row.sourceSession,
          destinationSession: now_.route,
          body: evidenceBody(deps.db, now_) + (routeNotes.has(c.row.qitemId) ? `\nescalation route: ${routeNotes.get(c.row.qitemId)}` : ""),
          summary: now_.verificationTargets
            ? custodyHeadline(c.row.qitemId, now_.verificationTargets, now_.ageMinutes)
            : `Stuck sweep: ${c.kind} on ${c.row.qitemId} (${now_.ageMinutes} min)`,
          evidenceRef: `rig queue show ${c.row.qitemId}`,
          tags: [STUCK_SWEEP_FINDING_TAG, dedupTag, recoveryTag(c.row.qitemId),
            ...(routed.has(c.row.qitemId) || now_.row.tags?.includes(ESCALATION_HOP_TAG) ? [ESCALATION_HOP_TAG] : []),
            ...(now_.row.tags ?? []).filter((tag) => /^(project|mission|slice):/.test(tag))],
          // OpenRig's own finding, whoever created the stuck row.
          wakeTrigger: "openrig" as const,
        };
        try {
          const created = await deps.queueRepo.create(input);
          othersMayHaveRun();
          findings.push({ kind: c.kind, qitemId: c.row.qitemId, findingQitemId: created.qitemId, action: "created" });
        } catch (err) {
          const message = `${c.kind} finding for ${c.row.qitemId} to ${now_.route} not created: ${err instanceof Error ? err.message : String(err)}`;
          othersMayHaveRun();
          log(`[stuck-sweep] ${message}`);
          failedCreates.push(message);
        }
      }
    }

    // A seat's standing notice for those rows. It stands for every row it has listed until that row is resolved at its
    // source (the evidence a finding per row needs to close: claimed, parked, closed) or gets a finding of its own, so a
    // detection filter (a raised threshold, the wake ladder) never reads as done. While any is left it stays open and is
    // rewritten in place; once none is, the sweep closes it. A closed notice, dismissed or resolved, holds back only the
    // rows it stood for, each only until it has newer evidence than the close: any other row files a new notice. It wakes
    // the seat once, when it's filed.
    const backlogRow = (c: Candidate): BacklogRow => ({ qitemId: c.row.qitemId, since: c.evidenceAt, from: c.row.sourceSession, summary: c.row.summary });
    const backlogPrefix = unclaimedBacklogTag("");
    const backlogSeats = new Set(unclaimedBacklog.keys());
    for (const { tags } of deps.db.prepare(`SELECT tags FROM queue_items WHERE state IN ('pending', 'in-progress', 'blocked')
        AND (tags LIKE '%"stuck-sweep:%') AND tags LIKE ?`).all(`%"${backlogPrefix}%`) as Array<{ tags: string }>) {
      try {
        for (const tag of JSON.parse(tags) as string[]) if (tag.startsWith(backlogPrefix)) backlogSeats.add(tag.slice(backlogPrefix.length));
      } catch { /* Skip malformed tags */ }
    }
    for (const seat of backlogSeats) {
      if (dueToYield()) await yieldLoop();
      const rows = unclaimedBacklog.get(seat) ?? [];
      const tag = unclaimedBacklogTag(seat);
      liveDedupTags.add(tag);
      const node = agentSeatNode(seat);
      const last = deps.db
        .prepare(
          // The first term lets the planner use idx_queue_items_recovery_tags, as the finding lookup above does.
          `SELECT qitem_id, state, ts_updated, summary, body FROM queue_items
            WHERE (tags LIKE '%"stuck-sweep:%') AND tags LIKE ? ESCAPE '\\'
            ORDER BY CASE WHEN state IN ('pending', 'in-progress', 'blocked') THEN 0 ELSE 1 END,
                     ts_updated DESC, ts_created DESC, qitem_id DESC
            LIMIT 1`,
        )
        .get(`%"${tag.replace(/[\\%_]/g, (ch) => `\\${ch}`)}"%`) as
        | { qitem_id: string; state: string; ts_updated: string; summary: string | null; body: string }
        | undefined;
      if (last && ["pending", "in-progress", "blocked"].includes(last.state)) {
        const listedNow = new Set(rows.map((c) => c.row.qitemId));
        const stoodFor = backlogRowsOf(last.body);
        const still = [...(stoodFor ?? [])].filter((id) => !listedNow.has(id)).flatMap((id): BacklogRow[] => {
          const row = indexed(() => deps.queueRepo.getById(id));
          // Gone, someone else's now, resolved at its source, or held by a finding or recovery of its own: one actually
          // written, so a create that failed this pass leaves the row here.
          if (!row || row.destinationSession !== seat || recoveries.find(id)
            || deliveryResolutionEvidence(deps, "unclaimed-obligation", id, now)) return [];
          return [{ qitemId: id, since: pendingSince(deps.db, id) ?? row.tsCreated, from: row.sourceSession, summary: row.summary }];
        });
        const standsFor = [...rows.map(backlogRow), ...still];
        // With its list unreadable, the notice may still stand for rows: it's left as it is, never closed.
        if (standsFor.length === 0 && !stoodFor) {
          findings.push({ kind: "unclaimed-backlog", qitemId: seat, findingQitemId: last.qitem_id, action: "refreshed" });
          continue;
        }
        if (standsFor.length === 0) {
          await deps.queueRepo.update({
            qitemId: last.qitem_id,
            actorSession: "stuck-sweep@system",
            state: "done",
            closureReason: "no-follow-on",
            transitionNote: `stuck-sweep resolved: unclaimed-backlog on ${seat}: every row it stood for is claimed, parked, closed or has its own finding`,
          });
          othersMayHaveRun();
          findings.push({ kind: "unclaimed-backlog", qitemId: seat, findingQitemId: last.qitem_id, action: "closed" });
          continue;
        }
        const text = unclaimedBacklogText(seat, standsFor, ageMinutes, node);
        if (text.summary !== last.summary || text.body !== last.body) {
          deps.db.prepare("UPDATE queue_items SET body = ?, summary = ? WHERE qitem_id = ? AND body = ? AND summary IS ? AND state IN ('pending', 'in-progress', 'blocked')")
            .run(text.body, text.summary, last.qitem_id, last.body, last.summary);
        }
        findings.push({ kind: "unclaimed-backlog", qitemId: seat, findingQitemId: last.qitem_id, action: "refreshed" });
        continue;
      }
      if (rows.length === 0) continue;
      // Each row's rule again, on the row as it is now, as a finding per row is checked right before it's created.
      const current = rows.flatMap((c) => {
        routeNotes.delete(c.row.qitemId);
        routed.delete(c.row.qitemId);
        const now_ = freshCandidate(c.kind, c.row.qitemId);
        if (now_) routeCandidate(now_);
        return now_ && selfRoutedUnclaimed(now_) && now_.route === seat && !recoveries.find(now_.row.qitemId) ? [now_] : [];
      });
      if (current.length === 0) continue;
      // A closed notice whose list is unreadable holds back every row, each until it has newer evidence than the close.
      const covered = last ? backlogRowsOf(last.body) : null;
      if (last && !current.some((c) => (covered !== null && !covered.has(c.row.qitemId)) || evidenceIsNewer(c.evidenceAt, last.ts_updated))) continue;
      const text = unclaimedBacklogText(seat, current.map(backlogRow), ageMinutes, node);
      try {
        const created = await deps.queueRepo.create({
          // A notice to a seat about its own rows comes from that seat, as a restore notice does; OpenRig wakes it.
          sourceSession: seat,
          destinationSession: seat,
          body: text.body,
          summary: text.summary,
          evidenceRef: `rig queue list --destination ${seat} --state pending`,
          tags: [STUCK_SWEEP_FINDING_TAG, tag],
          wakeTrigger: "openrig" as const,
        });
        othersMayHaveRun();
        findings.push({ kind: "unclaimed-backlog", qitemId: seat, findingQitemId: created.qitemId, action: "created" });
      } catch (err) {
        const message = `unclaimed-backlog notice for ${seat} not created: ${err instanceof Error ? err.message : String(err)}`;
        othersMayHaveRun();
        log(`[stuck-sweep] ${message}`);
        failedCreates.push(message);
      }
    }

    // Resolution: an open finding whose underlying condition is no longer detected closes
    // with its reason — the sweep cleans up after itself, no human unwind.
    const openFindings = deps.db
      .prepare(
        `SELECT qitem_id, tags FROM queue_items
          WHERE state IN ('pending', 'in-progress', 'blocked')
            AND tags LIKE ?`,
      )
      .all(`%"${STUCK_SWEEP_FINDING_TAG}"%`) as Array<{ qitem_id: string; tags: string }>;
    for (const f of openFindings) {
      if (dueToYield()) await yieldLoop();
      let tags: string[] = [];
      try {
        tags = JSON.parse(f.tags) as string[];
      } catch {
        continue;
      }
      const dedupTag = tags.find((t) => t.startsWith("stuck-sweep:"));
      if (!dedupTag || liveDedupTags.has(dedupTag)) continue;
      const [, kind, stuckId] = dedupTag.match(/^stuck-sweep:([a-z-]+):(.+)$/) ?? [];
      // A retry marker only suppresses reporting. Other reporting filters (a new
      // unconfirmed send, a fresh post window, or a larger unclaimed age) do not
      // prove resolution either: delivery/pickup findings need source evidence.
      if (suppressedTags.has(dedupTag)) continue;
      // #2661: a claim working only on a grace (a background shell, a pending managed restore) is not resolved: the
      // grace stops new detection, and an open stall recovery stays open, so the ceiling's expiry stays actionable.
      if (kind === "stalled-after-claim" && stuckId && deps.queueRepo.getById(stuckId)?.pickup?.grace) continue;
      let resolution = "no longer detected";
      if (stuckId && (kind === "undelivered-wake" || kind === "undelivered-human-notice" || kind === "unclaimed-obligation")) {
        const evidence = deliveryResolutionEvidence(deps, kind, stuckId, now);
        if (!evidence) continue;
        resolution = evidence;
      }
      // The list was read before this loop's yields: the finding's owner may have closed it since (done -> done is
      // refused, and would fail the whole pass).
      const current = deps.db.prepare("SELECT state FROM queue_items WHERE qitem_id = ?").get(f.qitem_id) as { state: string } | undefined;
      if (!current || !["pending", "in-progress", "blocked"].includes(current.state)) continue;
      // "No longer detected" rests on lists read before this loop's yields: a row that came back (blocked, then
      // in-progress past its deadline) during the pass still holds, so its rule runs again on the row as it is now.
      // (A row this pass did find, whose finding isn't live because another recovery now holds its custody, closes as
      // the base closed it.)
      if (kind && stuckId && resolvedByRule.has(kind) && !candidateIds.has(stuckId) && ruleHolds(kind as StuckFindingKind, stuckId)) continue;
      await deps.queueRepo.update({
        qitemId: f.qitem_id,
        // The sweep performed this transition; ownership stays on the existing row.
        actorSession: "stuck-sweep@system",
        state: "done",
        closureReason: "no-follow-on",
        transitionNote: `stuck-sweep resolved: ${kind ?? "finding"} on ${stuckId ?? "row"} ${resolution}`,
      });
      othersMayHaveRun();
      if (kind && stuckId) {
        findings.push({
          kind: kind as StuckFindingKind,
          qitemId: stuckId,
          findingQitemId: f.qitem_id,
          action: "closed",
        });
      }
    }

    if (failedCreates.length > 0) {
      // Not a clean or complete pass: say so, while keeping the findings that were made.
      const error = failedCreates.join("; ");
      status?.record("failed", { error, findings: findings.filter((f) => f.action !== "closed").length });
      return { outcome: "failed", findings, error };
    }
    const outcome = findings.length > 0 ? "findings" : "clean";
    status?.record(outcome, { findings: findings.filter((f) => f.action !== "closed").length });
    return { outcome, findings };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Loud, never silent: the failure lands on the log AND the status surface (healthz).
    log(`[stuck-sweep] SWEEP FAILED (skipping this tick loudly): ${message}`);
    status?.record("failed", { error: message });
    return { outcome: "failed", findings: [], error: message };
  }
}
