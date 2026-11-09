import { resolveEscalationOwner, hasConsumedEscalationHop } from "./escalation-owner.js";
import type Database from "better-sqlite3";
import { resolvePickupThresholdMinutes } from "./queue-pickup.js";
import { SettingsStore } from "./user-settings/settings-store.js";
import type { ArbitratedSeatState } from "./activity-taxonomy.js";
import { nextDueAt } from "./watchdog-due.js";
import type { WatchdogJob } from "./watchdog-jobs-repository.js";

export type WaitingActivityReader = (session: string) => Pick<ArbitratedSeatState, "activity" | "needsInput" | "decidedBy" | "backgroundWork"> | null;

/** A blocked row's backstop when no live timer or watchdog is armed and its blocker isn't a row that can finish. */
export const NO_TIMED_BACKSTOP = "UNVERIFIED: no timed backstop";

/** A read of the existing transition log, not another progress receipt. Machine
 * actors and typed wake receipts are bookkeeping, never task progress. Historical
 * untyped author notes remain author testimony; their text is not classified.
 * Delivery bookkeeping uses the reserved daemon actors and must not reset the
 * ladder before it can join its dispatch marker to the delivery receipt. */
export function lastMeaningfulTransition(db: Database.Database, id: string): { id: number; at: string } | null {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'queue_transitions'").get()) return null;
  const hasWakes = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'queue_transition_wakes'").get();
  const row = db.prepare(`SELECT t.transition_id, t.ts FROM (
      SELECT *, LAG(state) OVER (ORDER BY transition_id) AS previous_state FROM queue_transitions WHERE qitem_id = ?
    ) t WHERE (t.actor_session NOT IN ('watchdog@system', 'wake-ladder@system', 'daemon@kernel', 'daemon@system') OR t.state IS NOT t.previous_state)
    ${hasWakes ? "AND NOT EXISTS (SELECT 1 FROM queue_transition_wakes w WHERE w.transition_id = t.transition_id AND w.phase = 'fired')" : ""}
    ORDER BY t.transition_id DESC LIMIT 1`).get(id) as { transition_id: number; ts: string } | undefined;
  return row ? { id: row.transition_id, at: row.ts } : null;
}

/** lastMeaningfulTransition for many rows in one read: the same LAG window, partitioned by row, and the same filters.
 * Every requested id is a key of the result; an id without a meaningful transition maps to null. */
export function lastMeaningfulTransitionMany(db: Database.Database, ids: readonly string[]): Map<string, { id: number; at: string } | null> {
  const unique = [...new Set(ids)];
  const out = new Map<string, { id: number; at: string } | null>(unique.map((id) => [id, null]));
  if (unique.length === 0) return out;
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'queue_transitions'").get()) return out;
  const hasWakes = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'queue_transition_wakes'").get();
  const rows = db.prepare(`SELECT qitem_id, transition_id, ts FROM (
      SELECT t.qitem_id, t.transition_id, t.ts, ROW_NUMBER() OVER (PARTITION BY t.qitem_id ORDER BY t.transition_id DESC) AS newest FROM (
        SELECT *, LAG(state) OVER (PARTITION BY qitem_id ORDER BY transition_id) AS previous_state FROM queue_transitions
         WHERE qitem_id IN (SELECT value FROM json_each(?))
      ) t WHERE (t.actor_session NOT IN ('watchdog@system', 'wake-ladder@system', 'daemon@kernel', 'daemon@system') OR t.state IS NOT t.previous_state)
      ${hasWakes ? "AND NOT EXISTS (SELECT 1 FROM queue_transition_wakes w WHERE w.transition_id = t.transition_id AND w.phase = 'fired')" : ""}
    ) WHERE newest = 1`).all(JSON.stringify(unique)) as Array<{ qitem_id: string; transition_id: number; ts: string }>;
  for (const row of rows) out.set(row.qitem_id, { id: row.transition_id, at: row.ts });
  return out;
}

/** The waiting view's statements, each prepared once, and the schema checks they depend on, each made once. A listing
 * holds one for all its rows; a single read uses a fresh one. A listing reads synchronously, so neither the statements
 * nor the schema checks can go stale under it. */
export class WaitingStatements {
  private readonly prepared = new Map<string, Database.Statement>();
  private readonly tables = new Map<string, boolean>();
  constructor(private readonly db: Database.Database) {}

  statement(sql: string): Database.Statement {
    let prepared = this.prepared.get(sql);
    if (!prepared) {
      prepared = this.db.prepare(sql);
      this.prepared.set(sql, prepared);
    }
    return prepared;
  }

  hasTable(name: string): boolean {
    let known = this.tables.get(name);
    if (known === undefined) {
      known = this.statement("SELECT 1 FROM sqlite_master WHERE name = ?").get(name) !== undefined;
      this.tables.set(name, known);
    }
    return known;
  }
}

/** The queue_items columns a waiting view reads from its own row. */
export interface WaitingRow {
  qitem_id: string; source_session: string; destination_session: string; state: string; blocked_on: string | null; closure_required_at: string | null; tags: string | null;
}

/** What a listing has already read for all its rows, lent to each row's waiting view. */
export interface WaitingReads {
  /** The row in hand (a listing's own SELECT *), read in the same synchronous pass; used only when its id is the view's. */
  row?: WaitingRow;
  /** The listing's statements and schema checks, shared by all its rows. */
  statements?: WaitingStatements;
  /** lastMeaningfulTransitionMany over the listing's rows and their qitem blockers; an id it lacks is read alone. */
  meaningful?: ReadonlyMap<string, { id: number; at: string } | null>;
}

/** One row's last meaningful transition: from the listing's batch when it read this id, else read alone. */
export function meaningfulFor(db: Database.Database, id: string, reads?: WaitingReads): { id: number; at: string } | null {
  const known = reads?.meaningful;
  return known && known.has(id) ? known.get(id) ?? null : lastMeaningfulTransition(db, id);
}

/** Grace starts when a row becomes actionable again, not at its birth before a
 * long healthy park. Same-state notes and deliveries cannot move this boundary. */
export function pendingSince(db: Database.Database, id: string, statements = new WaitingStatements(db)): string | null {
  const created = () => (statements.statement("SELECT ts_created FROM queue_items WHERE qitem_id = ?").get(id) as { ts_created: string } | undefined)?.ts_created ?? null;
  if (!statements.hasTable("queue_transitions")) return created();
  const row = statements.statement(`SELECT ts, previous_state FROM (SELECT ts, state, transition_id,
    LAG(state) OVER (ORDER BY transition_id) AS previous_state FROM queue_transitions WHERE qitem_id = ?)
    WHERE state = 'pending' AND previous_state IS NOT 'pending' ORDER BY transition_id DESC LIMIT 1`)
    .get(id) as { ts: string; previous_state: string | null } | undefined;
  if (!row || row.previous_state === null) return created();
  return row.ts;
}
function unclaimedSeconds(): number {
  const value = Number(new SettingsStore().resolveOne("queue.stuck_sweep_unclaimed_age_minutes").value);
  return (Number.isFinite(value) && value > 0 ? value : 60) * 60;
}

function sweepSeconds(): number {
  try {
    const value = Number(new SettingsStore().resolveOne("queue.stuck_sweep_interval_seconds").value);
    return Number.isFinite(value) && value > 0 ? value : 300;
  } catch { return 300; }
}

export interface WaitingView {
  obligation: string;
  owner: string;
  state: string;
  actionableSince: string | null;
  blocker: { ref: string; owner: string | null; state: string | null } | null;
  lastMeaningfulChange: { id: number; at: string } | null;
  liveness: { subject: string; activity: string; needsInput: { count: number; reason: string | null }; confidence: "oracle" | "unknown" };
  nextBackstop: { owner: string; mechanism: string; dueAt: string | null; intervalSeconds: number | null; suspendedUntil?: string; recovery?: { qitemId: string; state: string }; note?: string;
    /** The seat's typing guard or interruption level is holding the wake: nothing was typed, and it isn't stuck. */
    held?: true };
  /** Conditional later safety net, retained when delivery/recovery owns the next action. */
  laterBackstop?: WaitingView["nextBackstop"];
  deadlineAt: string | null;
  attention?: { scope: string; revision: string; source: "last observed by wait timer" };
}

export function readWaitingView(db: Database.Database, id: string, readActivity?: WaitingActivityReader, acceptsDestination?: (destination: string) => boolean,
  reads?: WaitingReads): WaitingView | null {
  const statements = reads?.statements ?? new WaitingStatements(db);
  const held = reads?.row;
  const row = held && held.qitem_id === id ? held : statements.statement(`SELECT qitem_id, source_session, destination_session, state, blocked_on, closure_required_at, tags
    FROM queue_items WHERE qitem_id = ?`).get(id) as WaitingRow | undefined;
  if (!row) return null;
  const blocker = row.blocked_on?.startsWith("qitem-") ? statements.statement(
    "SELECT destination_session, state FROM queue_items WHERE qitem_id = ?",
  ).get(row.blocked_on) as { destination_session: string; state: string } | undefined : undefined;
  let recoveryOwner: string | null = null;
  try { recoveryOwner = hasConsumedEscalationHop(db, id)
    ? null : resolveEscalationOwner(db, row.destination_session, acceptsDestination).owner; } catch { /* bootstrap schema has no routing evidence */ }
  const subject = row.blocked_on ? blocker?.destination_session ?? row.blocked_on : row.destination_session;
  let observed: ReturnType<WaitingActivityReader> = null;
  try { observed = readActivity?.(subject) ?? null; } catch { /* unavailable remains unknown */ }
  const meaningful = meaningfulFor(db, row.blocked_on?.startsWith("qitem-") ? row.blocked_on : id, reads);
  const sweepInterval = sweepSeconds();
  const view: WaitingView = {
    obligation: id, owner: row.destination_session, state: row.state, actionableSince: row.state === "pending" ? pendingSince(db, id, statements) : null,
    blocker: row.blocked_on ? { ref: row.blocked_on, owner: blocker?.destination_session ?? null, state: blocker?.state ?? null } : null,
    lastMeaningfulChange: meaningful,
    liveness: { subject, activity: observed?.activity ?? "unknown", needsInput: observed?.needsInput ?? { count: 0, reason: null }, confidence: observed && observed.activity !== "unknown" ? "oracle" : "unknown" },
    nextBackstop: { owner: row.destination_session, mechanism: "queue-stuck-sweep", dueAt: row.closure_required_at, intervalSeconds: sweepInterval },
    deadlineAt: row.closure_required_at,
  };
  if (row.state === "pending" || row.state === "in-progress") {
    const base = row.state === "pending" ? view.actionableSince : meaningful?.at;
    const delay = row.state === "pending" ? unclaimedSeconds() : resolvePickupThresholdMinutes() * 60;
    view.nextBackstop.owner = recoveryOwner ?? row.destination_session;
    view.nextBackstop.dueAt = base ? new Date(Date.parse(base) + delay * 1000).toISOString() : null;
    view.nextBackstop.mechanism = row.state === "pending" ? "queue-stuck-sweep:unclaimed" : "queue-stuck-sweep:pickup (activity checked at detection)";
  }
  if (row.state === "blocked") {
    const hasTimers = statements.hasTable("queue_transition_wakes");
    const timer = hasTimers ? statements.statement(`SELECT j.job_id, j.policy, j.last_evaluation_at, j.registered_at, j.interval_seconds, j.scan_interval_seconds, j.spec_yaml
      FROM queue_transition_wakes w JOIN watchdog_jobs j ON j.job_id = w.wake_ref
      WHERE w.qitem_id = ? AND w.phase = 'armed' AND j.state = 'active'
      ORDER BY w.transition_id DESC LIMIT 1`).get(id) as { job_id: string; policy: WatchdogJob["policy"]; last_evaluation_at: string | null; registered_at: string; interval_seconds: number; scan_interval_seconds: number | null; spec_yaml: string } | undefined : undefined;
    // The scheduler's own due time: a never-evaluated reminder fires one interval after registration (#801),
    // and the wake-now marker is due now (#860).
    const timerDue = timer ? nextDueAt({ policy: timer.policy, specYaml: timer.spec_yaml, registeredAt: timer.registered_at,
      intervalSeconds: timer.interval_seconds, scanIntervalSeconds: timer.scan_interval_seconds, lastEvaluationAt: timer.last_evaluation_at }) : null;
    view.nextBackstop = timer ? {
      owner: row.destination_session, mechanism: `watchdog:${timer.job_id}`, intervalSeconds: timer.interval_seconds,
      dueAt: new Date(timerDue ?? Date.now()).toISOString(),
    } :{ owner: blocker?.destination_session ?? row.destination_session, mechanism: blocker ? "blocker-transition / queue-stuck-sweep" : NO_TIMED_BACKSTOP, dueAt: null, intervalSeconds: blocker ? sweepInterval : null };
    if (timer) {
      let notice: { at: string; deliveryStatus: string } | undefined;
      try {
        const state = JSON.parse(timer.spec_yaml).context?.queue_wait;
        notice = state?.notice;
        if (state?.evidence?.attention?.scope && state.attentionRevision) view.attention = { scope: state.evidence.attention.scope, revision: state.attentionRevision, source: "last observed by wait timer" };
      } catch { /* operator YAML has no queue notice */ }
      if (notice) view.nextBackstop = { owner: recoveryOwner ?? row.source_session, mechanism: `unconsumed wait notice; delivery=${notice.deliveryStatus}`, intervalSeconds: sweepInterval,
        dueAt: new Date(Date.parse(notice.at) + resolvePickupThresholdMinutes() * 60_000).toISOString() };
    }
  }
  if (!["pending", "in-progress", "blocked"].includes(row.state)) view.nextBackstop = { owner: row.destination_session, mechanism: "none (terminal obligation)", dueAt: null, intervalSeconds: null };
  return view;
}
