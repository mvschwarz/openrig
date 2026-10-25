import { findQueueRecovery, recoveryId, recoveryTag } from "./queue-recovery.js";
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

import { defaultResolveOrchestrator } from "./queue-owner.js";
import type Database from "better-sqlite3";
import { deriveCrossHostSuccessorId, hasLinkedSuccessor, matchesRecordedHandoffTarget, QueueRepositoryError, type QueueItem, type QueueRepository } from "./queue-repository.js";
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
  | "unconsumed-wait"
  | "overdue-claim"
  | "stalled-after-claim"
  | "undelivered-wake"
  | "undelivered-human-notice"
  | "unclaimed-obligation"
  | "dangling-closure";

/** Idempotency key: one open finding row per (stuck row, finding kind). */
export function findingDedupTag(kind: StuckFindingKind, qitemId: string): string {
  return `stuck-sweep:${kind}:${qitemId}`;
}

export interface StuckSweepStatusSnapshot {
  lastSweepAt: string | null;
  lastOutcome: "clean" | "findings" | "failed" | null;
  lastError: string | null;
  consecutiveFailures: number;
  findingsRouted: number;
}

export interface StuckSweepStatus {
  record(outcome: "clean" | "findings" | "failed", detail?: { error?: string; findings?: number }): void;
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
  };
  return {
    record(outcome, detail) {
      state.lastSweepAt = new Date().toISOString();
      state.lastOutcome = outcome;
      state.lastError = outcome === "failed" ? (detail?.error ?? "unknown error") : null;
      state.consecutiveFailures = outcome === "failed" ? state.consecutiveFailures + 1 : 0;
      if (detail?.findings) state.findingsRouted += detail.findings;
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
   *  destination (the row is durable there even if the seat is dead — S01 is the wake
   *  layer). Injectable for tests; default derives from topology. */
  resolveOrchestrator?: (session: string) => string | null;
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
  qitemId: string;
  findingQitemId: string;
  action: "created" | "refreshed" | "closed";
}

export interface StuckSweepResult {
  outcome: "clean" | "findings" | "failed";
  findings: StuckSweepFindingAction[];
  error?: string;
}

export { resolveSessionNodeId, defaultResolveOrchestrator } from "./queue-owner.js";

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
}

function isFindingRow(item: QueueItem): boolean {
  return (item.tags ?? []).includes(STUCK_SWEEP_FINDING_TAG);
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

/**
 * One sweep pass. Instance-wide (no rig scope — the loop is the net for every rig the
 * daemon carries). Never throws: a sweep that cannot run reports outcome=failed loudly
 * on the status surface and the log, because a silent skip is exactly the class this
 * slice exists to kill.
 */
export async function runStuckSweep(deps: StuckSweepDeps): Promise<StuckSweepResult> {
  const log = deps.log ?? ((line: string) => console.error(line));
  const status = deps.status;
  try {
    const now = deps.now ?? new Date();
    const suppressionMinutes = deps.ladderSuppressionMinutes ?? resolveLadderSuppressionMinutes();
    /** The dedup tags of the candidates the LADDER suppressed in this pass, and only those:
     *  a row the ladder alone would have stopped. A finding for such a row stays open,
     *  because the marker only ever stopped the re-report — it never resolved anything.
     *  Every other finding resolves as soon as the sweep no longer detects its condition. */
    const suppressedTags = new Set<string>();
    const ageMinutes = deps.unclaimedAgeMinutes ?? resolveStuckSweepUnclaimedAgeMinutes();
    const resolveOrch =
      deps.resolveOrchestrator ?? ((session: string) => defaultResolveOrchestrator(deps.db, session));
    const isRegisteredHost = deps.isRegisteredHost ?? defaultIsRegisteredHost(log);
    const candidates: Candidate[] = [];

    // Half 1 — claimed-never-closed. The claimant holds the obligation; the finding
    // routes to them.
    for (const row of deps.queueRepo.findOverdue({ now: now.toISOString() })) {
      if (isFindingRow(row)) continue;
      candidates.push({
        kind: "overdue-claim",
        row,
        route: row.destinationSession,
        ageMinutes: minutesSince(row.closureRequiredAt ?? row.claimedAt, now),
        evidenceAt: latestIso(lastMeaningfulTransition(deps.db, row.qitemId)?.at, row.closureRequiredAt, row.claimedAt),
        why: "claimed and past closure_required_at with no closure",
      });
      try {
        deps.queueRepo.recordClosureOverdue(row.qitemId, { now: now.toISOString() });
      } catch (err) {
        log(`[stuck-sweep] failed to record closure-overdue for ${row.qitemId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // S04 seam — a claimed row with no later motion past the pickup threshold. The
    // pickup module remains the ONE derivation rule; this loop only enumerates and routes.
    const claimedRows = deps.db
      .prepare("SELECT qitem_id FROM queue_items WHERE state = 'in-progress' AND claimed_at IS NOT NULL")
      .all() as Array<{ qitem_id: string }>;
    for (const { qitem_id } of claimedRows) {
      const row = deps.queueRepo.getById(qitem_id);
      if (!row || isFindingRow(row)) continue;
      const stalled = stalledPickupFinding(row);
      if (!stalled) continue;
      // Keep this null arm for the 0.5.7 mechanized-pull turn-end hook that knows the in-flight row;
      // it is the first honest row-scoped writer, and wiring reopens only in that slice.
      const evidenceAt = latestIso(lastMeaningfulTransition(deps.db, row.qitemId)?.at, row.lastHeartbeat, row.claimedAt);
      candidates.push({
        kind: stalled.kind,
        row,
        route: resolveOrch(stalled.target) ?? stalled.target,
        // The stall's own age: from the anchor the pickup decision uses, floored as its "why" counts, so a claim
        // parked and resumed doesn't count its parked time and the headline matches the why to the minute.
        ageMinutes: wholeMinutesSince(evidenceAt, now),
        evidenceAt,
        why: stalled.evidence,
      });
    }

    // The timer delivered one transition-specific notice (or recorded a failed
    // attempt). This existing sweep owns its bounded recovery, not another full
    // packet or a parked-owner replay. A real owner response ends the occurrence.
    const waitJobs = deps.db.prepare("SELECT job_id, spec_yaml FROM watchdog_jobs WHERE state = 'active' AND policy = 'periodic-reminder'").all() as Array<{ job_id: string; spec_yaml: string }>;
    for (const job of waitJobs) {
      const notice = queueWaitNotice(job.spec_yaml);
      if (!notice || now.getTime() - Date.parse(notice.at) <= resolvePickupThresholdMinutes() * 60_000) continue;
      const binding = deps.db.prepare("SELECT qitem_id FROM queue_transition_wakes WHERE wake_ref = ? AND phase = 'armed' ORDER BY transition_id DESC LIMIT 1").get(job.job_id) as { qitem_id: string } | undefined;
      const row = binding ? deps.queueRepo.getById(binding.qitem_id) : null;
      if (!row || row.state !== "blocked" || deps.queueRepo.getParkWakeStatus(row.qitemId)?.ref !== job.job_id) continue;
      const response = lastMeaningfulTransition(deps.db, row.qitemId);
      if (response && Date.parse(response.at) > Date.parse(notice.at)) continue;
      const ownerActivity = deps.queueRepo.ownerActivity(row.destinationSession);
      if (ownerActivity?.activity === "working" && !ownerActivity.needsInput.count && notice.deliveryStatus === "ok") continue;
      candidates.push({ kind: "unconsumed-wait", row, route: resolveOrch(row.destinationSession) ?? row.sourceSession,
        ageMinutes: minutesSince(notice.at, now), evidenceAt: notice.at,
        why: `wait notice delivery=${notice.deliveryStatus}; no later owner response; activity=${ownerActivity?.activity ?? "unknown"}; inspect exact blocker ${row.blockedOn}` });
    }

    // Half 2 — sender-believed-delivered-never-woken. Nobody holds it (the wake failed),
    // so it routes to the destination's orchestrator when one is derivable. Rows with a
    // live S01 ladder are S01's territory; an exhausted ladder is the handback and lands
    // here exactly once (the dedup tag keeps it to one finding).
    for (const row of deps.queueRepo.findUndelivered()) {
      if (isFindingRow(row)) continue;
      const humanNotice = row.deliveryOutcome === "never-posted" || row.deliveryOutcome === "transport-failed";
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
      if (quiet && (quiet.state === "held" || quiet.state === "released")) continue;
      // The ladder check runs LAST, so only a row the ladder ALONE would have stopped counts
      // as ladder-suppressed (#1419). Agent wake retries do not own the separate notice to a
      // person: a human notice is never the ladder's to suppress.
      if (!humanNotice && hasLiveLadder(deps.db, row.qitemId, now, suppressionMinutes)) {
        suppressedTags.add(findingDedupTag("undelivered-wake", row.qitemId));
        continue;
      }
      candidates.push({
        kind: humanNotice ? "undelivered-human-notice" : "undelivered-wake",
        row,
        route: humanNotice ? noticeOwner : resolveOrch(row.destinationSession) ?? row.destinationSession,
        ageMinutes: minutesSince(row.tsCreated, now),
        evidenceAt: latestIso(row.tsUpdated, row.lastNudgeAttempt),
        why: quiet?.state === "orphaned"
          ? `held for quiet hours (window ${quiet.windowId}), but no release job is live for that window: nothing will release it (${failure})`
          : quiet?.state === "release-failed"
            ? `released after quiet hours; its post failed (${quiet.failure}); the release stays queued for redelivery`
            : humanNotice
              ? `${failure}; check human-notification delivery rather than retrying the agent wake`
              : `${failure} and nothing retried it`,
      });
    }

    // The A1 net — created-with-destination rows carrying real obligations, unclaimed past
    // the config-keyed age. Parks (state=blocked) legitimately wait and never appear here;
    // failed-nudge rows already surfaced in half 2; laddered rows are S01's.
    const cutoff = new Date(now.getTime() - ageMinutes * 60_000).toISOString();
    const unclaimedRows = deps.db
      .prepare(
        `SELECT qitem_id FROM queue_items
          WHERE state = 'pending'
            AND claimed_at IS NULL
            AND destination_session IS NOT NULL AND destination_session != ''
            AND ts_created <= ?
            AND (last_nudge_result IS NULL OR last_nudge_result NOT LIKE 'failed:%')`,
      )
      .all(cutoff) as Array<{ qitem_id: string }>;
    for (const { qitem_id } of unclaimedRows) {
      const row = deps.queueRepo.getById(qitem_id);
      if (!row || isFindingRow(row)) continue;
      const actionableAt = pendingSince(deps.db, row.qitemId) ?? row.tsCreated;
      if (actionableAt > cutoff) continue;
      // #514 — an ask already posted to its registered human in the current delivery episode waits on
      // that human; it is not stuck, and a finding would post the human again. Unposted, failed,
      // legacy and non-human rows keep this net.
      if (deps.queueRepo.humanNotificationPostedThisEpisode(row.qitemId)) continue;
      // An ask placed on Steering without an alert waits on its person there by design; a finding would alert them.
      if (deps.queueRepo.humanAskWithoutAlert(row.qitemId)) continue;
      // Quiet hours: a held ask whose window's release job is live waits on that job, and one already released waits on
      // its post; neither is stuck. A release whose post failed is reported once, by the undelivered-wake loop above. A
      // hold with no live release job is stuck: nothing will ever release it.
      const quiet = quietHoldCustody(deps.db, row.qitemId, now);
      if (quiet && quiet.state !== "orphaned") continue;
      // The seat's typing guard or interruption level held its wake on purpose: it's held and readable at the seat, not
      // stuck. (A handed-off baton's one held notice is the wake ladder's.)
      if (row.lastNudgeResult === "retained:typing_guard") continue;
      // The ladder check runs LAST here too: a row the ladder alone would have stopped is
      // ladder-suppressed, and its finding stays open (#1419).
      if (hasLiveLadder(deps.db, row.qitemId, now, suppressionMinutes)) {
        suppressedTags.add(findingDedupTag("unclaimed-obligation", row.qitemId));
        continue;
      }
      candidates.push({
        kind: "unclaimed-obligation",
        row,
        route: resolveOrch(row.destinationSession) ?? row.destinationSession,
        ageMinutes: minutesSince(actionableAt, now),
        evidenceAt: actionableAt,
        why: quiet?.state === "orphaned"
          ? `held for quiet hours (window ${quiet.windowId}) for ${minutesSince(actionableAt, now)} min, but no release job is live for that window: nothing will release it`
          : `actionable with a destination and unclaimed for ${minutesSince(actionableAt, now)} min (threshold ${ageMinutes})`,
      });
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
    for (const { qitem_id } of custodyRows) {
      const row = deps.queueRepo.getById(qitem_id);
      if (!row || isFindingRow(row)) continue;
      // Local recorded targets were filtered in SQL; remote keys use the same
      // derivation as the cross-host close, without reading successor history.
      if (row.state === "handed-off" && matchesRecordedHandoffTarget(row.qitemId, row.handedOffTo, row.closureTarget)) continue;
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
          return !deps.queueRepo.getById(target);
        }
        try {
          return !hasLinkedSuccessor(deps.db, row.qitemId, target);
        } catch {
          return true;
        }
      });
      if (verificationTargets.length === 0) continue;
      let route = row.destinationSession;
      try {
        route = custodyFindingRoute(deps.db, deps.queueRepo, row);
      } catch (err) {
        if (!(err instanceof QueueRepositoryError) || err.code !== "human_registry_unavailable") throw err;
        // The registry may not exist before the first human is registered. Losing
        // owner refinement must not stop unrelated findings or their resolution.
        log(`[stuck-sweep] keeping custody route for ${row.qitemId} at ${row.destinationSession}: ${err.message}`);
      }
      candidates.push({
        kind: "dangling-closure",
        row,
        route,
        ageMinutes: minutesSince(row.tsUpdated, now),
        evidenceAt: latestIso(row.tsUpdated),
        why: `closed (${row.closureReason ?? "?"}) with successor custody that this local store cannot fully verify`,
        verificationTargets,
      });
    }

    // Route: idempotent per (row, kind). An existing open finding refreshes its age; a
    // new one is created durable + waking (the create path's default nudge).
    const findings: StuckSweepFindingAction[] = [];
    const liveDedupTags = new Set<string>();
    // A finding that could not be created (a row whose destination no longer resolves, say) must not
    // stop the others: it is reported, its row stays detected, and the pass is still a failure.
    const failedCreates: string[] = [];
    for (const c of [...new Map(candidates.map(c => [c.row.qitemId, c])).values()]) {
      const dedupTag = findingDedupTag(c.kind, c.row.qitemId);
      const shared = findQueueRecovery(deps.db, c.row.qitemId);
      if (shared) {
        const existingTags = deps.queueRepo.getById(shared.qitemId)?.tags ?? [];
        for (const tag of existingTags) if (tag.startsWith("stuck-sweep:")) liveDedupTags.add(tag);
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
      } else if (!existing || evidenceIsNewer(c.evidenceAt, existing.ts_updated)) {
        const input = {
          qitemId: recoveryId(deps.db, c.row.qitemId),
          // The detector is machinery, not a seat: the obligation's own creator is the
          // finding's source (the workflow-exception precedent).
          sourceSession: c.row.sourceSession,
          destinationSession: c.route,
          body: evidenceBody(deps.db, c),
          summary: c.verificationTargets
            ? custodyHeadline(c.row.qitemId, c.verificationTargets, c.ageMinutes)
            : `Stuck sweep: ${c.kind} on ${c.row.qitemId} (${c.ageMinutes} min)`,
          evidenceRef: `rig queue show ${c.row.qitemId}`,
          tags: [STUCK_SWEEP_FINDING_TAG, dedupTag, recoveryTag(c.row.qitemId)],
          // OpenRig's own finding, whoever created the stuck row.
          wakeTrigger: "openrig" as const,
        };
        try {
          const created = await deps.queueRepo.create(input);
          findings.push({ kind: c.kind, qitemId: c.row.qitemId, findingQitemId: created.qitemId, action: "created" });
        } catch (err) {
          const message = `${c.kind} finding for ${c.row.qitemId} to ${c.route} not created: ${err instanceof Error ? err.message : String(err)}`;
          log(`[stuck-sweep] ${message}`);
          failedCreates.push(message);
        }
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
      let tags: string[] = [];
      try {
        tags = JSON.parse(f.tags) as string[];
      } catch {
        continue;
      }
      const dedupTag = tags.find((t) => t.startsWith("stuck-sweep:"));
      if (!dedupTag || liveDedupTags.has(dedupTag)) continue;
      const [, kind, stuckId] = dedupTag.match(/^stuck-sweep:([a-z-]+):(.+)$/) ?? [];
      // Suppression is not resolution (#1419), and only the ladder's own suppression counts:
      // a finding whose row the ladder stopped in THIS pass stays open, because the marker
      // only ever stopped the re-report. Every other finding resolves as soon as the sweep
      // no longer detects its condition — a resumed claim, a verified custody disposition, a
      // notice that has since posted, or a row the ladder never owned.
      if (suppressedTags.has(dedupTag)) continue;
      await deps.queueRepo.update({
        qitemId: f.qitem_id,
        // The sweep performed this transition; ownership stays on the existing row.
        actorSession: "stuck-sweep@system",
        state: "done",
        closureReason: "no-follow-on",
        transitionNote: `stuck-sweep resolved: ${kind ?? "finding"} on ${stuckId ?? "row"} no longer detected`,
      });
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
