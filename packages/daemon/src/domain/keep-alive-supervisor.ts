import type Database from "better-sqlite3";
import { ulid } from "ulid";
import type { EventBus } from "./event-bus.js";
import type { ReconcileResult } from "./reconciler.js";
import { launchStatusIsRunning, type NarrowLaunchResult } from "./restore-orchestrator.js";
import type { RuntimeAdapter } from "./runtime-adapter.js";
import { automaticRestoreInProgress } from "./existing-rig-restore.js";
import { resolveSeatKind, seatProcessOwner } from "./seat-kinds.js";
import type { RigEvent } from "./types.js";

/**
 * Keep-alive supervisor (#2940). A seat that declares `keep_alive` is relaunched when it falls while the daemon runs,
 * and left alone when it was stopped on purpose. Started by startup.ts after the boot reconcile and the kernel boot, and
 * stopped first during graceful shutdown. Inert while no seat declares keep_alive.
 *
 * Each tick, for each keep_alive seat of a rig that isn't archived:
 *   - it skips a seat with no session, a claimed session or a seat attached from outside; a seat whose latest session
 *     carries a stop request (a seat stop or a rig down, which also ends its incident); a rig whose restore is running;
 *     and a seat whose recovery ran out;
 *   - it reconciles the seat alone, asking for proof of absence, then acts only on a fall proven by absence: the latest
 *     session `detached` with no stop request, or the incident's own failed launch in any status, proven gone. Anything
 *     the reconcile couldn't settle on a session that decides the fall (the latest one and the seat's sessions under its
 *     tmux name, and the incident's own; never a claimed one, which is its owner's) leaves the seat as it was, and the
 *     tick does nothing for it: a probe that proves nothing, such as an unreachable tmux socket or a probe error; a row
 *     tmux still shows; a recorded process still running, or one an unreadable process table can't check. A tmux socket
 *     a reboot's /tmp cleanup removed is the exception when the seat's process recorded for its latest session is
 *     proven gone: as `rig down` does, the reconcile starts an empty server and probes again.
 *     An `exited` session without a stop request ended cleanly or by an internal action, and is left as it is;
 *   - it relaunches through the existing one-seat launch (`launchSingleNode` with `keepAlive`), which under the seat's
 *     lifecycle lease refuses if a stop was recorded meanwhile, or if the daemon began shutting down while the launch
 *     waited for the lease. It never asks for a fresh start.
 *
 * The budget is durable, in `node_keep_alive_budget`: an attempt is counted, with its event, in one transaction before
 * its launch starts, so a daemon restart mid-launch still counts it, and nothing resets on a restart or because a launch
 * returned. Every session a launch leaves behind is recorded as the incident's, whatever the outcome, so it is never
 * taken for a person's start. Attempts are spaced by a growing wait; when they run out, or a launch outcome needs a
 * person (a terminal status or refusal, a failed launch whose session was left running, a survivor that isn't the seat's
 * latest session or whose harness isn't started), the incident is exhausted once, with its event, and the seat shows
 * attention until someone starts or stops it. A launch refused because the daemon is shutting down gives its attempt
 * back only when it started nothing that remains: it stopped before its first effect, or every shell it started was
 * stopped (tmux confirmed it) and the seat's prior state put back. A refused launch whose stop wasn't confirmed keeps its
 * attempt: the session it may have left running is recorded as the incident's and reported, and the incident waits for
 * a person.
 *
 * A session counts as a recovered agent only once its harness's startup has completed (`startup_status` 'ready'): a
 * bare shell, its harness not started, or a startup still running is never marked recovered, never starts or completes
 * the stable period, and never ends an incident or resets its budget. It waits, and recovers once its startup completes
 * (a person who brings the agent up in the pane and clears its attention).
 *
 * An incident ends when a tick has seen the recovered session run for the stable period, when a person's stop of the
 * seat is confirmed (a request still pending keeps it), or when a person starts it (a session that is neither the
 * incident's fallen nor its launched one). An automatic restore at daemon start isn't a person's start: the session it
 * launches for a seat in an incident is recorded as the incident's as it is registered (`keepAliveIncidentAdopts`), so
 * the incident and its budget carry on, also when that restore replaces its provisional shell with a fresh launch from
 * the seat's recipe (the replacement's session is the one adopted); in an exhausted incident it ends the incident only
 * once a tick has seen it run for the stable period. The other exception is a launch whose outcome was never written
 * (the daemon stopped in the middle of it): a session created after that attempt began is taken as that launch's, so the
 * restart never resets the budget. The stable period counts only what a tick saw: a recovered seat that falls while the
 * daemon was down, without a tick having seen it run for the stable period, stays in its incident.
 *
 * Concurrency and shutdown follow the watchdog scheduler: one tick at a time, seats in sequence; stop() prevents any new
 * attempt at once and waits a bounded time for the tick in flight. A shutdown writes nothing to sessions.
 */

export const KEEP_ALIVE_DEFAULTS = {
  /** Attempts per incident. */
  attempts: 2,
  /** The wait before the 2nd attempt; it doubles for each later one. */
  backoffMs: 30_000,
  /** How long a recovered seat runs before its incident ends and the budget is whole again. */
  stableMs: 10 * 60_000,
  tickIntervalMs: 30_000,
  /** How long stop() waits for a tick in flight: short, within the daemon's 10 s shutdown budget. */
  stopWaitMs: 2_000,
} as const;

/** Launch refusals that a retry can't change: the seat waits for a person. */
const TERMINAL_REFUSALS = new Set(["stop_requested", "selection_changed", "no_matching_nodes", "no_usable_snapshot"]);
/** Launch statuses that started nothing a retry could fix, or left the seat for a person to decide. */
const TERMINAL_STATUSES = new Set(["awaiting-decision", "attention_required", "left_attached"]);

export interface KeepAliveSupervisorDeps {
  db: Database.Database;
  eventBus: EventBus;
  reconciler: {
    reconcile(rigId: string, opts?: { nodeIds?: readonly string[]; absenceProof?: "positive" }): Promise<ReconcileResult>;
  };
  restoreOrchestrator: {
    launchSingleNode(rigId: string, logicalId: string, opts?: {
      adapters?: Record<string, RuntimeAdapter>; fsOps?: { exists(path: string): boolean };
      keepAlive?: boolean | { shouldContinue?: () => boolean };
    }): Promise<NarrowLaunchResult>;
    restoreInProgress?(rigId: string): boolean;
  };
  adapters?: Record<string, RuntimeAdapter>;
  /** The file check every other one-seat launch passes (a saved cwd that is gone, a transcript to re-anchor). */
  fsOps?: { exists(path: string): boolean };
  attempts?: number;
  backoffMs?: number;
  stableMs?: number;
  tickIntervalMs?: number;
  stopWaitMs?: number;
  /** Override clock for tests. */
  now?: () => Date;
  /** Override timer scheduler for tests. */
  setTimer?: (cb: () => void, ms: number) => NodeJS.Timeout;
  clearTimer?: (handle: NodeJS.Timeout) => void;
  /** Notification on tick errors (defaults to console.error). */
  onTickError?: (err: unknown) => void;
}

interface Seat { nodeId: string; rigId: string; logicalId: string }
interface LatestSession {
  id: string; session_name: string; status: string; origin: string | null; flag: number; stop_attempt: string | null; created_at: string;
  /** The harness's startup: 'ready' once it completed; 'pending' while it runs; 'attention_required' or 'failed' when it
   *  didn't (a bare shell, its harness not started). */
  startup_status: string | null;
}
/** What the last attempt's launch came to; null while it runs, or when the daemon stopped before writing it.
 *  `adopted`: a session the supervisor didn't see launched taken as the incident's (a launch whose outcome was lost, or
 *  daemon start's automatic restore). `recovered` without `recovered_at`: the launch reported its seat running, but its
 *  harness's startup hadn't completed when it returned; a tick marks it recovered once it has. */
type LaunchOutcome = "recovered" | "failed" | "exhausted" | "adopted";
interface Budget {
  incident_id: string;
  fallen_session_id: string | null;
  launched_session_id: string | null;
  attempts: number;
  last_attempt_at: string | null;
  last_error: string | null;
  exhausted_at: string | null;
  recovered_at: string | null;
  last_outcome: LaunchOutcome | null;
}

export class KeepAliveSupervisor {
  private readonly db: Database.Database;
  private readonly eventBus: EventBus;
  private readonly reconciler: KeepAliveSupervisorDeps["reconciler"];
  private readonly restoreOrchestrator: KeepAliveSupervisorDeps["restoreOrchestrator"];
  private readonly adapters?: Record<string, RuntimeAdapter>;
  private readonly fsOps?: { exists(path: string): boolean };
  private readonly attempts: number;
  private readonly backoffMs: number;
  private readonly stableMs: number;
  private readonly tickIntervalMs: number;
  private readonly stopWaitMs: number;
  private readonly now: () => Date;
  private readonly setTimer: (cb: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearTimer: (handle: NodeJS.Timeout) => void;
  private readonly onTickError: (err: unknown) => void;

  private sessionsHaveStopAttempt: boolean | null = null;
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<void> | null = null;
  private stopping = false;
  private started = false;

  constructor(deps: KeepAliveSupervisorDeps) {
    this.db = deps.db;
    this.eventBus = deps.eventBus;
    this.reconciler = deps.reconciler;
    this.restoreOrchestrator = deps.restoreOrchestrator;
    this.adapters = deps.adapters;
    this.fsOps = deps.fsOps;
    this.attempts = deps.attempts ?? KEEP_ALIVE_DEFAULTS.attempts;
    this.backoffMs = deps.backoffMs ?? KEEP_ALIVE_DEFAULTS.backoffMs;
    this.stableMs = deps.stableMs ?? KEEP_ALIVE_DEFAULTS.stableMs;
    this.tickIntervalMs = deps.tickIntervalMs ?? KEEP_ALIVE_DEFAULTS.tickIntervalMs;
    this.stopWaitMs = deps.stopWaitMs ?? KEEP_ALIVE_DEFAULTS.stopWaitMs;
    this.now = deps.now ?? (() => new Date());
    this.setTimer = deps.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle));
    this.onTickError = deps.onTickError ?? ((err) => console.error("[keep-alive] tick error", err));
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    this.scheduleNextTick();
  }

  /** No new attempt starts once this is called; a tick in flight is waited for at most `stopWaitMs`. Idempotent. */
  async stop(): Promise<void> {
    this.stopping = true;
    if (!this.started) return;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    if (this.inflight) {
      let bound: NodeJS.Timeout | null = null;
      await Promise.race([
        this.inflight.catch(() => undefined),
        new Promise<void>((resolve) => { bound = this.setTimer(resolve, this.stopWaitMs); }),
      ]);
      if (bound) this.clearTimer(bound);
    }
    this.started = false;
  }

  isRunning(): boolean {
    return this.started && !this.stopping;
  }

  /** Run one tick and wait for it. Exposed for tests; the timer loop calls it in production. */
  async runTickNow(): Promise<void> {
    if (this.inflight) {
      await this.inflight;
      return;
    }
    this.inflight = this.tick();
    try {
      await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  private scheduleNextTick(): void {
    if (this.stopping) return;
    this.timer = this.setTimer(() => {
      void this.runTickNow()
        .catch((err) => this.onTickError(err))
        .finally(() => this.scheduleNextTick());
    }, this.tickIntervalMs);
  }

  private async tick(): Promise<void> {
    if (this.stopping) return;
    const seats = this.db.prepare(
      `SELECT n.id AS nodeId, n.rig_id AS rigId, n.logical_id AS logicalId
       FROM nodes n JOIN rigs r ON r.id = n.rig_id
       WHERE n.keep_alive = 1 AND r.archived_at IS NULL
       ORDER BY n.rig_id, n.created_at`,
    ).all() as Seat[];
    for (const seat of seats) {
      if (this.stopping) return;
      try {
        await this.superviseSeat(seat);
      } catch (err) {
        this.onTickError(err);
      }
    }
  }

  private async superviseSeat(seat: Seat): Promise<void> {
    const latest = this.latestSession(seat.nodeId);
    if (!latest || latest.origin === "claimed" || this.attachedFromOutside(seat.nodeId)) return;
    let budget = this.readBudget(seat.nodeId);
    if (latest.flag === 1) {
      // A seat stop or a rig down: the seat stays down, and its incident, if any, ends once the stop is confirmed. An
      // exhausted seat a person stopped stops asking for attention, and a later start begins clean. A request still
      // pending keeps the incident as it is: a checked stop whose kill proves to have had no effect puts the request
      // back, and the seat was never stopped.
      if (budget && latest.stop_attempt === null) this.endIncident(seat.nodeId);
      return;
    }
    if (this.restoreInProgress(seat.rigId)) return;
    if (budget && !inIncident(latest.id, budget)) {
      if (launchOutcomeLost(budget, latest)) {
        // The last attempt's launch never wrote its outcome (the daemon stopped in the middle of it), and this session
        // came after that attempt began: it is that launch's, so the restart never resets the budget.
        this.db.prepare(
          "UPDATE node_keep_alive_budget SET launched_session_id = ?, last_outcome = 'adopted', updated_at = ? WHERE node_id = ? AND incident_id = ?",
        ).run(latest.id, this.now().toISOString(), seat.nodeId, budget.incident_id);
        budget = { ...budget, launched_session_id: latest.id, last_outcome: "adopted" };
      } else {
        // A person started the seat: its incident is over, whatever state it was in, and a later fall opens a new one.
        this.endIncident(seat.nodeId);
        budget = null;
      }
    }
    // An exhausted incident waits for a person, save for the session an automatic restore brought back into it: a tick
    // that sees that session run for the stable period ends the incident, below.
    if (budget?.exhausted_at && !(budget.last_outcome === "adopted" && latest.id === budget.launched_session_id)) return;

    const reconciled = await this.reconciler.reconcile(seat.rigId, { nodeIds: [seat.nodeId], absenceProof: "positive" });
    if (this.stopping) return;
    // A probe that proved nothing, a detached session tmux still shows, or a recorded process still running: no proven
    // fall, so nothing is done for the seat.
    if (reconciled?.undetermined?.some((entry) => entry.sessionId === latest.id)
      || reconciled?.unseen?.some((entry) => entry.sessionId === latest.id)
      || reconciled?.errors?.some((entry) => entry.sessionId === latest.id)) return;
    const current = this.latestSession(seat.nodeId);
    // Something else moved the seat meanwhile (a start, a stop): the next tick looks again.
    if (!current || current.id !== latest.id || current.flag === 1) return;

    const open = !!budget && !budget.recovered_at && budget.attempts > 0;
    if (current.status === "running") {
      if (!budget || current.id !== budget.launched_session_id) return;
      // A session running is a recovered agent only once its harness's startup has completed. A bare shell (its harness
      // not started) or a startup still running recovers nothing and ends nothing: the incident and its budget stay as
      // they are, and the stable period counts only from a tick that sees the startup complete.
      const started = current.startup_status === "ready";
      if (budget.exhausted_at) {
        // An automatic restore's session in an exhausted incident: the first tick that sees it running with its harness
        // started begins its stable period, and one that sees it so after that period ends the incident.
        if (!started) {
          if (budget.recovered_at) {
            this.db.prepare("UPDATE node_keep_alive_budget SET recovered_at = NULL, updated_at = ? WHERE node_id = ? AND incident_id = ?")
              .run(this.now().toISOString(), seat.nodeId, budget.incident_id);
          }
        } else if (!budget.recovered_at) {
          const at = this.now().toISOString();
          this.db.prepare("UPDATE node_keep_alive_budget SET recovered_at = ?, updated_at = ? WHERE node_id = ? AND incident_id = ?")
            .run(at, at, seat.nodeId, budget.incident_id);
        } else if (this.ranStable(budget)) {
          this.endIncident(seat.nodeId);
        }
      } else if (open) {
        // Only a launch's own session counts. One whose outcome the daemon lost to a restart, an automatic restore's, or
        // one whose launch returned before its startup completed recovers once its harness has started; one a failed
        // launch left behind is a pane without its agent, and waits for a person.
        if (budget.last_outcome === "adopted" || budget.last_outcome === "recovered") {
          if (started) this.markRecovered(seat, budget, current.id, "running");
        } else {
          this.markExhausted(seat, budget, "failed", `${budget.last_error ?? "the launch failed"}; the failed launch left its session running`);
        }
      } else if (started && this.ranStable(budget)) {
        this.endIncident(seat.nodeId);
      }
      return;
    }
    // An automatic restore's session that fell keeps its exhausted incident waiting for a person.
    if (budget?.exhausted_at) return;
    // A fall is a session the reconcile proved absent. A probe that proved nothing or a recorded process still running
    // leaves it as it was above. An open incident's own failed launch counts as down whatever status it left, once the
    // reconcile proved it gone.
    const ownFailedLaunch = open && current.id === budget!.launched_session_id;
    if (current.status !== "detached" && !ownFailedLaunch) return;
    // A retry needs positive absence. The reconcile covers this seat alone, so anything it couldn't settle on any of the
    // seat's sessions (a probe that proved nothing, a row tmux still shows, a recorded process still running or one the
    // process table couldn't check, an error) leaves the seat as it is. A claimed session is the exception: released, it
    // runs on in its owner's tmux, and it would hold the seat back forever.
    const claimed = this.claimedSessions(seat.nodeId);
    const unsettled = (entries?: ReadonlyArray<{ sessionId: string }>) => !!entries?.some((entry) => !claimed.has(entry.sessionId));
    if (unsettled(reconciled?.undetermined) || unsettled(reconciled?.unseen) || unsettled(reconciled?.errors)
      || !reconciled?.provenAbsent?.includes(current.id)) return;

    if (budget && budget.attempts >= this.attempts) {
      this.markExhausted(seat, budget, undefined, budget.last_error ?? "the recovery attempts ran out");
      return;
    }
    if (budget && budget.attempts >= 1 && budget.last_attempt_at
      && this.now().getTime() < Date.parse(budget.last_attempt_at) + this.backoffMs * 2 ** (budget.attempts - 1)) {
      return;
    }
    if (this.stopping) return;
    const attempt = this.recordAttempt(seat, budget, current.id);

    let result: NarrowLaunchResult | null = null;
    let thrown: string | null = null;
    try {
      result = await this.restoreOrchestrator.launchSingleNode(seat.rigId, seat.logicalId, {
        ...(this.adapters ? { adapters: this.adapters } : {}), ...(this.fsOps ? { fsOps: this.fsOps } : {}),
        keepAlive: { shouldContinue: () => !this.stopping },
      });
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err);
    }
    this.recordOutcome(seat, budget, attempt, current.id, result, thrown);
  }

  private recordOutcome(
    seat: Seat, before: Budget | null, budget: Budget, fallenId: string, result: NarrowLaunchResult | null, thrown: string | null,
  ): void {
    if (thrown !== null) return this.recordFailure(seat, budget, fallenId, "failed", thrown);
    if (!result!.ok) {
      if (result!.code === "shutting_down") {
        // The daemon began shutting down. A launch that stopped before its first effect, or whose shells were stopped
        // (tmux confirmed it) with the seat's prior state put back, started nothing that remains: the attempt is given
        // back, and the next daemon start finds the incident as it was. A stop that wasn't confirmed may have left its
        // session running: the attempt stays counted, and that session is recorded as the incident's and reported.
        const own = (result!.launched ?? []).filter((entry) => entry.nodeId === seat.nodeId || entry.intendedNodeId === seat.nodeId);
        const left = own.find((entry) => !entry.notStarted && !entry.compensated);
        if (!left) return this.revertAttempt(seat, before, budget);
        return this.recordFailure(seat, budget, fallenId, "shutting_down", left.error ?? result!.message ?? "the launch was refused for a shutdown");
      }
      const error = result!.message ?? result!.code ?? "the launch was refused";
      return TERMINAL_REFUSALS.has(result!.code ?? "")
        ? this.markExhausted(seat, budget, result!.code, error)
        : this.recordFailure(seat, budget, fallenId, result!.code ?? "failed", error);
    }
    if (result!.alreadyRunning?.some((entry) => entry.nodeId === seat.nodeId)) {
      // A live session survived. When it is the seat's latest session nothing is down: the incident closes and the
      // attempt isn't spent. An older session still running behind a fallen latest one is a state a relaunch can't
      // fix: the seat waits for a person, so the same fall doesn't open a new incident on every tick.
      const latest = this.latestSession(seat.nodeId);
      if (latest?.status === "running") {
        if (latest.startup_status === "ready") return this.endIncident(seat.nodeId);
        // A live session whose harness's startup hasn't completed (a bare shell) isn't a running agent: the seat waits for
        // a person rather than the budget being reset on it.
        return this.markExhausted(seat, budget, "already_running",
          `the seat's latest session '${latest.session_name}' is running, but its harness's startup hasn't completed (startup status '${latest.startup_status ?? "unknown"}')`);
      }
      const live = this.db.prepare(
        "SELECT session_name FROM sessions WHERE node_id = ? AND status = 'running' ORDER BY created_at DESC, id DESC LIMIT 1",
      ).get(seat.nodeId) as { session_name: string } | undefined;
      return this.markExhausted(seat, budget, "already_running",
        `an older session${live ? ` '${live.session_name}'` : ""} is still running behind the seat's latest session, which fell`);
    }
    const launched = result!.launched?.find((entry) => entry.nodeId === seat.nodeId);
    if (!launched) return this.recordFailure(seat, budget, fallenId, "failed", "the launch reported no outcome for this seat");
    const error = launched.error ?? `the launch ended '${launched.status}'`;
    if (TERMINAL_STATUSES.has(launched.status)) return this.markExhausted(seat, budget, launched.status, error);
    if (launchStatusIsRunning(launched.status)) {
      // A running status counts only with a new session running: a launch can report one without starting anything
      // (a seat whose continuity recovery is in progress), and then the seat is still down.
      const after = this.latestSession(seat.nodeId);
      if (after && after.id !== fallenId && after.status === "running") {
        // Recovered only once the harness's startup has completed. One still starting is recorded as the launch's, and a
        // tick marks it recovered once it has; one left as a bare shell (its startup didn't complete) is a failed launch
        // that left its session running, and waits for a person.
        if (after.startup_status === "ready") return this.markRecovered(seat, budget, after.id, launched.status);
        if (after.startup_status === "pending") {
          this.db.prepare(
            "UPDATE node_keep_alive_budget SET launched_session_id = ?, last_outcome = 'recovered', updated_at = ? WHERE node_id = ? AND incident_id = ?",
          ).run(after.id, this.now().toISOString(), seat.nodeId, budget.incident_id);
          return;
        }
        return this.recordFailure(seat, budget, fallenId, launched.status,
          `the launch reported '${launched.status}' but its harness's startup didn't complete (startup status '${after.startup_status ?? "unknown"}')`);
      }
      return this.recordFailure(seat, budget, fallenId, launched.status, `the launch reported '${launched.status}' but started no session`);
    }
    return this.recordFailure(seat, budget, fallenId, launched.status, error);
  }

  /** A failed attempt, or one whose effect is unknown: it stays counted, and the next waits for its turn. The last
   *  allowed attempt failing exhausts the incident, and so does a failed launch that left its new session running (its
   *  pane kept without the agent): a relaunch would collide with it, so the seat waits for a person. */
  private recordFailure(seat: Seat, budget: Budget, fallenId: string, status: string, error: string): void {
    const after = this.latestSession(seat.nodeId);
    if (after && after.id !== fallenId && after.status === "running") {
      return this.markExhausted(seat, budget, status, `${error}; the failed launch left its session running`);
    }
    // A session the failed launch left behind stays this incident's, so it isn't taken for a person's start.
    const launchedId = after && after.id !== fallenId ? after.id : budget.launched_session_id;
    this.db.prepare(
      "UPDATE node_keep_alive_budget SET last_error = ?, launched_session_id = ?, last_outcome = 'failed', updated_at = ? WHERE node_id = ? AND incident_id = ?",
    ).run(error, launchedId, this.now().toISOString(), seat.nodeId, budget.incident_id);
    if (budget.attempts >= this.attempts) this.markExhausted(seat, budget, status, error);
  }

  /** Count an attempt and persist its event, in one transaction, before its launch starts. Its outcome is unwritten
   *  (`last_outcome` NULL) until the launch returns. */
  private recordAttempt(seat: Seat, budget: Budget | null, fallenId: string): Budget {
    const at = this.now().toISOString();
    const next: Budget = budget
      ? { ...budget, attempts: budget.attempts + 1, last_attempt_at: at, fallen_session_id: fallenId, recovered_at: null,
        exhausted_at: null, last_outcome: null }
      : {
        incident_id: ulid(), fallen_session_id: fallenId, launched_session_id: null, attempts: 1, last_attempt_at: at,
        last_error: null, exhausted_at: null, recovered_at: null, last_outcome: null,
      };
    this.persist(() => {
      this.db.prepare(
        `INSERT INTO node_keep_alive_budget
           (node_id, incident_id, fallen_session_id, launched_session_id, attempts, last_attempt_at, last_error, exhausted_at,
            recovered_at, last_outcome, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?)
         ON CONFLICT(node_id) DO UPDATE SET incident_id = excluded.incident_id, fallen_session_id = excluded.fallen_session_id,
           launched_session_id = excluded.launched_session_id, attempts = excluded.attempts, last_attempt_at = excluded.last_attempt_at,
           last_error = excluded.last_error, exhausted_at = NULL, recovered_at = NULL, last_outcome = NULL,
           updated_at = excluded.updated_at`,
      ).run(seat.nodeId, next.incident_id, next.fallen_session_id, next.launched_session_id, next.attempts, at, next.last_error, at);
      return { type: "seat.keep_alive.attempted", rigId: seat.rigId, nodeId: seat.nodeId, logicalId: seat.logicalId,
        incidentId: next.incident_id, attempts: next.attempts };
    });
    return next;
  }

  /** Put back what an attempt that started nothing replaced. Only that attempt's own write is undone (the row still
   *  holds its incident, count and time); the attempted event stays, as it was emitted. */
  private revertAttempt(seat: Seat, before: Budget | null, attempt: Budget): void {
    const match = "node_id = ? AND incident_id = ? AND attempts = ? AND last_attempt_at = ?";
    const keys = [seat.nodeId, attempt.incident_id, attempt.attempts, attempt.last_attempt_at];
    if (!before || before.incident_id !== attempt.incident_id) {
      this.db.prepare(`DELETE FROM node_keep_alive_budget WHERE ${match}`).run(...keys);
      return;
    }
    this.db.prepare(
      `UPDATE node_keep_alive_budget SET fallen_session_id = ?, launched_session_id = ?, attempts = ?, last_attempt_at = ?,
         last_error = ?, exhausted_at = ?, recovered_at = ?, last_outcome = ?, updated_at = ?
       WHERE ${match}`,
    ).run(before.fallen_session_id, before.launched_session_id, before.attempts, before.last_attempt_at, before.last_error,
      before.exhausted_at, before.recovered_at, before.last_outcome, this.now().toISOString(), ...keys);
  }

  private markRecovered(seat: Seat, budget: Budget, sessionId: string, status: string): void {
    const at = this.now().toISOString();
    this.persist(() => {
      this.db.prepare(
        `UPDATE node_keep_alive_budget SET recovered_at = ?, launched_session_id = ?, last_error = NULL, last_outcome = 'recovered',
           updated_at = ? WHERE node_id = ? AND incident_id = ?`,
      ).run(at, sessionId, at, seat.nodeId, budget.incident_id);
      return { type: "seat.keep_alive.recovered", rigId: seat.rigId, nodeId: seat.nodeId, logicalId: seat.logicalId,
        incidentId: budget.incident_id, attempts: budget.attempts, status };
    });
  }

  /** The incident waits for a person: marked once, with its event; later calls change nothing. A session the launch
   *  left behind is recorded as the incident's in the same write, so it is never taken for a person's start. */
  private markExhausted(seat: Seat, budget: Budget, status: string | undefined, error: string): void {
    const at = this.now().toISOString();
    const after = this.latestSession(seat.nodeId);
    const launchedId = after && after.id !== budget.fallen_session_id ? after.id : budget.launched_session_id;
    this.persist(() => {
      const changed = this.db.prepare(
        `UPDATE node_keep_alive_budget SET exhausted_at = ?, last_error = ?, launched_session_id = ?, last_outcome = 'exhausted',
           updated_at = ? WHERE node_id = ? AND incident_id = ? AND exhausted_at IS NULL`,
      ).run(at, error, launchedId, at, seat.nodeId, budget.incident_id).changes;
      if (!changed) return null;
      return { type: "seat.keep_alive.exhausted", rigId: seat.rigId, nodeId: seat.nodeId, logicalId: seat.logicalId,
        incidentId: budget.incident_id, attempts: budget.attempts, ...(status ? { status } : {}), lastError: error };
    });
  }

  /** Whether the incident's recovered session, which this tick sees running, has run for the stable period since it
   *  recovered. Only a tick that sees it running ends the incident, so a daemon restart alone never makes a recovery
   *  stable: a recovered seat that falls before a tick has seen that keeps its incident. */
  private ranStable(budget: Budget): boolean {
    return !!budget.recovered_at && this.now().getTime() - Date.parse(budget.recovered_at) >= this.stableMs;
  }

  private endIncident(nodeId: string): void {
    this.db.prepare("DELETE FROM node_keep_alive_budget WHERE node_id = ?").run(nodeId);
  }

  /** Run the writes and persist the event they return in one transaction, then notify subscribers. */
  private persist(write: () => RigEvent | null): void {
    const persisted = this.db.transaction(() => {
      const event = write();
      return event ? this.eventBus.persistWithinTransaction(event) : null;
    })();
    if (persisted) this.eventBus.notifySubscribers(persisted);
  }

  private restoreInProgress(rigId: string): boolean {
    return automaticRestoreInProgress(this.db, rigId) || (this.restoreOrchestrator.restoreInProgress?.(rigId) ?? false);
  }

  private latestSession(nodeId: string): LatestSession | null {
    this.sessionsHaveStopAttempt ??= (this.db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name?: string }>)
      .some((column) => column.name === "stop_attempt");
    return (this.db.prepare(
      `SELECT id, session_name, status, origin, intentionally_stopped AS flag,
         ${this.sessionsHaveStopAttempt ? "stop_attempt" : "NULL AS stop_attempt"}, created_at, startup_status
       FROM sessions WHERE node_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    ).get(nodeId) as LatestSession | undefined) ?? null;
  }

  /** The seat's claimed sessions, released ones included. Each is its owner's: its tmux session may run on under its
   *  owner, and it says nothing about this seat's own. */
  private claimedSessions(nodeId: string): Set<string> {
    const rows = this.db.prepare("SELECT id FROM sessions WHERE node_id = ? AND origin = 'claimed'").all(nodeId) as Array<{ id: string }>;
    return new Set(rows.map((row) => row.id));
  }

  private attachedFromOutside(nodeId: string): boolean {
    const binding = this.db.prepare("SELECT attachment_type FROM bindings WHERE node_id = ?").get(nodeId) as
      { attachment_type: string | null } | undefined;
    return seatProcessOwner(resolveSeatKind(binding?.attachment_type)) === "external";
  }

  private readBudget(nodeId: string): Budget | null {
    return (this.db.prepare(
      `SELECT incident_id, fallen_session_id, launched_session_id, attempts, last_attempt_at, last_error, exhausted_at, recovered_at,
         last_outcome
       FROM node_keep_alive_budget WHERE node_id = ?`,
    ).get(nodeId) as Budget | undefined) ?? null;
  }
}

/** #2940: an automatic restore at daemon start is not a person's start. The session it launches for a seat in a
 *  keep_alive incident becomes the incident's (`adopted`), so the budget carries on: an open incident takes it as its
 *  recovery once its harness's startup has completed, and an exhausted one keeps waiting for a person until a tick has
 *  seen that session run, started, for the stable period, which ends the incident. Either way the stable period counts
 *  from a tick that sees it running with its harness started. Called as the restore registers each session, its
 *  recipe-backed fresh replacement's included, so the last one registered is the incident's; never throws, so it can't
 *  fail a restore. */
export function keepAliveIncidentAdopts(db: Database.Database, nodeId: string, sessionId: string, now = new Date()): void {
  try {
    db.prepare(
      `UPDATE node_keep_alive_budget SET launched_session_id = ?, last_outcome = 'adopted', recovered_at = NULL, updated_at = ?
       WHERE node_id = ?`,
    ).run(sessionId, now.toISOString(), nodeId);
  } catch {
    // A database without the budget table has no incident to keep.
  }
}

/** Whether a session belongs to the budget's incident: the one that fell, or one a recovery launched. */
function inIncident(sessionId: string, budget: Budget): boolean {
  return sessionId === budget.fallen_session_id || sessionId === budget.launched_session_id;
}

/** Whether a session unknown to the incident is its last launch's own, cut off before the outcome was written: that
 *  outcome is still unwritten and the session was created when the attempt began or later (to the second, the
 *  precision of a session's creation time). */
function launchOutcomeLost(budget: Budget, session: LatestSession): boolean {
  if (budget.last_outcome !== null || budget.exhausted_at || budget.attempts < 1 || !budget.last_attempt_at) return false;
  const created = Date.parse(/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(session.created_at) ? session.created_at : `${session.created_at.replace(" ", "T")}Z`);
  return Number.isFinite(created) && created >= Math.floor(Date.parse(budget.last_attempt_at) / 1000) * 1000;
}
