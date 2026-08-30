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
// legitimately wait and are never findings.

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { QueueItem, QueueRepository } from "./queue-repository.js";
import { stalledPickupFinding } from "./queue-pickup.js";
import { SettingsStore } from "./user-settings/settings-store.js";

export const STUCK_SWEEP_INTERVAL_KEY = "queue.stuck_sweep_interval_seconds";
export const DEFAULT_STUCK_SWEEP_INTERVAL_SECONDS = 300;
export const STUCK_SWEEP_UNCLAIMED_AGE_KEY = "queue.stuck_sweep_unclaimed_age_minutes";
export const DEFAULT_STUCK_SWEEP_UNCLAIMED_AGE_MINUTES = 60;

/** Stamp tag on every routed finding row: the sweep's self-exclusion mark. */
export const STUCK_SWEEP_FINDING_TAG = "stuck-sweep-finding";

// S01 ladder marker vocabulary (the seam contract). S01 writes these transition-note
// prefixes; the sweep derives "live ladder" from the latest marker. An attempt/rung is
// LIVE, an exhausted marker hands the row back, and a later attempt starts a live cycle
// again.
export const LADDER_ATTEMPT_PREFIX = "wake-attempt:";
export const LADDER_RUNG_PREFIX = "escalation-rung:";
export const LADDER_EXHAUSTED_PREFIX = "ladder-exhausted:";

export type StuckFindingKind =
  | "overdue-claim"
  | "stalled-after-claim"
  | "undelivered-wake"
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
  now?: Date;
  log?: (line: string) => void;
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

/** The durable session→node binding (the session-registry precedent: latest sessions row
 *  for the canonical name). Canonical session names (dash form, `review-r2@rig`) and node
 *  logical ids (dotted form, `review.r2`) are INDEPENDENT identities — the live fleet has
 *  zero cases where they match — so resolution NEVER string-converts between them. */
export function resolveSessionNodeId(db: Database.Database, session: string): string | null {
  const row = db
    .prepare("SELECT node_id FROM sessions WHERE session_name = ? ORDER BY id DESC LIMIT 1")
    .get(session) as { node_id: string } | undefined;
  return row?.node_id ?? null;
}

/** Default orchestrator derivation: the destination's BOUND node → the source of its
 *  delegates_to edge → that parent node's CURRENT canonical session binding. A session
 *  outside the recorded topology, or a parent with no session binding, resolves to null
 *  (there is no orchestrator session to wake — never synthesize one). */
export function defaultResolveOrchestrator(db: Database.Database, session: string): string | null {
  const nodeId = resolveSessionNodeId(db, session);
  if (!nodeId) return null;
  const row = db
    .prepare(
      `SELECT s.session_name AS parentSession FROM edges e
         JOIN sessions s ON s.node_id = e.source_id
        WHERE e.target_id = ? AND e.kind = 'delegates_to'
        ORDER BY s.created_at DESC, s.id DESC
        LIMIT 1`,
    )
    .get(nodeId) as { parentSession: string } | undefined;
  return row?.parentSession ?? null;
}

interface TransitionNoteRow {
  transition_note: string | null;
}

/** The latest ladder marker is authoritative: a retry after exhaustion makes the
 *  ladder live again. Unrelated transitions do not change the latest marker. */
function hasLiveLadder(db: Database.Database, qitemId: string): boolean {
  const notes = db
    .prepare("SELECT transition_note FROM queue_transitions WHERE qitem_id = ? ORDER BY transition_id DESC")
    .all(qitemId) as TransitionNoteRow[];
  for (const { transition_note: note } of notes) {
    if (!note) continue;
    if (note.startsWith(LADDER_EXHAUSTED_PREFIX)) return false;
    if (note.startsWith(LADDER_ATTEMPT_PREFIX) || note.startsWith(LADDER_RUNG_PREFIX)) return true;
  }
  return false;
}

function minutesSince(iso: string | null | undefined, now: Date): number {
  if (!iso) return 0;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return 0;
  return Math.max(0, Math.round((now.getTime() - then) / 60_000));
}

function lastTransitionLine(db: Database.Database, qitemId: string): string {
  const row = db
    .prepare("SELECT ts, transition_note FROM queue_transitions WHERE qitem_id = ? ORDER BY ts DESC LIMIT 1")
    .get(qitemId) as { ts: string; transition_note: string | null } | undefined;
  return row ? `${row.transition_note ?? "(no note)"} at ${row.ts}` : "(no transitions)";
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

/** QueueRepository.create already provides structural PK idempotence. Naming the
 *  row from the dedup key plus evidence watermark turns two overlapping sweeps
 *  into the same create instead of two random identities. */
function findingQitemId(dedupTag: string, evidenceAt: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([dedupTag, evidenceAt]))
    .digest("hex")
    .slice(0, 16);
  return `qitem-stuck-${digest}`;
}

function verificationCommand(target: string): string {
  const successorId = target.split("@", 1)[0] ?? target;
  return `OPENRIG_URL=<registered-host> rig queue show ${successorId}`;
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
    const ageMinutes = deps.unclaimedAgeMinutes ?? resolveStuckSweepUnclaimedAgeMinutes();
    const resolveOrch =
      deps.resolveOrchestrator ?? ((session: string) => defaultResolveOrchestrator(deps.db, session));
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
        evidenceAt: latestIso(row.tsUpdated, row.closureRequiredAt, row.claimedAt),
        why: "claimed and past closure_required_at with no closure",
      });
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
      candidates.push({
        kind: stalled.kind,
        row,
        route: stalled.target,
        ageMinutes: minutesSince(row.claimedAt, now),
        // Keep this null arm for the 0.5.7 mechanized-pull turn-end hook that knows the in-flight row;
        // it is the first honest row-scoped writer, and wiring reopens only in that slice.
        evidenceAt: latestIso(row.tsUpdated, row.lastHeartbeat, row.claimedAt),
        why: stalled.evidence,
      });
    }

    // Half 2 — sender-believed-delivered-never-woken. Nobody holds it (the wake failed),
    // so it routes to the destination's orchestrator when one is derivable. Rows with a
    // live S01 ladder are S01's territory; an exhausted ladder is the handback and lands
    // here exactly once (the dedup tag keeps it to one finding).
    for (const row of deps.queueRepo.findUndelivered()) {
      if (isFindingRow(row)) continue;
      if (hasLiveLadder(deps.db, row.qitemId)) continue;
      candidates.push({
        kind: "undelivered-wake",
        row,
        route: resolveOrch(row.destinationSession) ?? row.destinationSession,
        ageMinutes: minutesSince(row.tsCreated, now),
        evidenceAt: latestIso(row.tsUpdated, row.lastNudgeAttempt),
        why: `wake failed (${row.lastNudgeResult ?? "failed"}) and nothing retried it`,
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
      if (hasLiveLadder(deps.db, row.qitemId)) continue;
      candidates.push({
        kind: "unclaimed-obligation",
        row,
        route: resolveOrch(row.destinationSession) ?? row.destinationSession,
        ageMinutes: minutesSince(row.tsCreated, now),
        evidenceAt: latestIso(row.tsUpdated, row.tsCreated),
        why: `created with a destination and unclaimed for ${minutesSince(row.tsCreated, now)} min (threshold ${ageMinutes})`,
      });
    }

    // The custody class — a terminal row whose closure names one or more successor
    // qitems. A local miss is never proof of absence: the successor may live in another
    // registered host's database. Host-qualified keys are therefore verification inputs,
    // not local lookup keys. Comma fan-out is checked member-by-member and only unresolved
    // members are reported. Historical source rows are never mutated by this detector.
    const custodyRows = deps.db
      .prepare(
        `SELECT q.qitem_id FROM queue_items q
          WHERE q.state IN ('done', 'canceled', 'handed-off')
            AND q.closure_target LIKE 'qitem-%'`,
      )
      .all() as Array<{ qitem_id: string }>;
    for (const { qitem_id } of custodyRows) {
      const row = deps.queueRepo.getById(qitem_id);
      if (!row || isFindingRow(row)) continue;
      const targets = (row.closureTarget ?? "").split(",").map((target) => target.trim()).filter(Boolean);
      const verificationTargets = targets.filter((target) => {
        if (target.includes("@")) return true;
        return !deps.queueRepo.getById(target);
      });
      if (verificationTargets.length === 0) continue;
      candidates.push({
        kind: "dangling-closure",
        row,
        route: row.destinationSession,
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
    for (const c of candidates) {
      const dedupTag = findingDedupTag(c.kind, c.row.qitemId);
      liveDedupTags.add(dedupTag);
      const existing = deps.db
        .prepare(
          `SELECT qitem_id, source_session, state, ts_updated FROM queue_items
            WHERE tags LIKE ?
            ORDER BY CASE WHEN state IN ('pending', 'in-progress', 'blocked') THEN 0 ELSE 1 END,
                     ts_updated DESC, ts_created DESC, qitem_id DESC
            LIMIT 1`,
        )
        .get(`%"${dedupTag}"%`) as
        | { qitem_id: string; source_session: string; state: string; ts_updated: string }
        | undefined;
      const existingIsOpen = existing && ["pending", "in-progress", "blocked"].includes(existing.state);
      if (existing && existingIsOpen) {
        await deps.queueRepo.update({
          qitemId: existing.qitem_id,
          actorSession: existing.source_session,
          transitionNote: `stuck-sweep refresh: age now ${c.ageMinutes} min (${c.kind} on ${c.row.qitemId})`,
        });
        findings.push({ kind: c.kind, qitemId: c.row.qitemId, findingQitemId: existing.qitem_id, action: "refreshed" });
      } else if (!existing || evidenceIsNewer(c.evidenceAt, existing.ts_updated)) {
        const created = await deps.queueRepo.create({
          qitemId: findingQitemId(dedupTag, c.evidenceAt),
          // The detector is machinery, not a seat: the obligation's own creator is the
          // finding's source (the workflow-exception precedent).
          sourceSession: c.row.sourceSession,
          destinationSession: c.route,
          body: evidenceBody(deps.db, c),
          summary: `Stuck sweep: ${c.verificationTargets ? "successor-verification-required" : c.kind} on ${c.row.qitemId} (${c.ageMinutes} min)`,
          tags: [STUCK_SWEEP_FINDING_TAG, dedupTag],
        });
        findings.push({ kind: c.kind, qitemId: c.row.qitemId, findingQitemId: created.qitemId, action: "created" });
      }
    }

    // Resolution: an open finding whose underlying condition is no longer detected closes
    // with its reason — the sweep cleans up after itself, no human unwind.
    const openFindings = deps.db
      .prepare(
        `SELECT qitem_id, source_session, tags FROM queue_items
          WHERE state IN ('pending', 'in-progress', 'blocked')
            AND tags LIKE ?`,
      )
      .all(`%"${STUCK_SWEEP_FINDING_TAG}"%`) as Array<{ qitem_id: string; source_session: string; tags: string }>;
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
      await deps.queueRepo.update({
        qitemId: f.qitem_id,
        actorSession: f.source_session,
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
