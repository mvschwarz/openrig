import type Database from "better-sqlite3";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { EventBus } from "./event-bus.js";
import type { SeatActivity } from "./types.js";
import type {
  ActivityEvidence,
  AdapterRungInventory,
  ArbitratedSeatState,
  RungHealthEvent,
} from "./activity-taxonomy.js";

/** Default polling cadence: 1Hz. The default silence window is 3s, so
 *  1Hz polling gives at-most ~1s freshness lag on the cached observation. */
export const DEFAULT_POLL_INTERVAL_MS = 1000;

/**
 * Slice 15 — daemon owner of the `terminal-active` primitive.
 *
 * Polls tmux's `#{window_activity}` last-activity timestamp per seat
 * (via TmuxAdapter.readPaneLastActivity) and keeps the latest
 * observation keyed by canonical session name. Active/idle is derived
 * by comparing the observed timestamp's age against the silence-window
 * threshold. Downstream consumers (ps-projection, node-inventory, UI
 * hooks) read via `getSeatActivity(canonicalSessionName)`.
 *
 * Non-inference contract (slice 15 IMPL-PRD §2.3, HG-4): this service
 * NEVER reads queue/assignment state. Its constructor surface
 * intentionally rejects any queue/assignment-shaped dependency so a
 * future contributor cannot wire one in without first amending the
 * design. The companion `hasAssignedWork` primitive lives in the
 * ps/queue projection and never imports this service either.
 */
export interface SeatActivityServiceDeps {
  tmux: Pick<TmuxAdapter, "readPaneLastActivity">;
  defaultWindowSeconds: number;
  eventBus?: EventBus;
  now?: () => Date;
}

export interface PollSeatOptions {
  silenceWindowSeconds?: number;
}

export class SeatActivityService {
  private readonly tmux: Pick<TmuxAdapter, "readPaneLastActivity">;
  private readonly defaultWindowSeconds: number;
  private readonly eventBus: EventBus | null;
  private readonly now: () => Date;
  private readonly latestByPaneId = new Map<string, SeatActivity>();
  // Single-flight guard: one whole-fleet window-activity sweep at a time, mirroring
  // seat-structural-activity-service (MUST-FIX 2). A slowed tmux can never accumulate
  // overlapping whole-fleet sweeps — at most one sweep's worth is ever in flight.
  private sweeping = false;

  constructor(deps: SeatActivityServiceDeps) {
    this.tmux = deps.tmux;
    this.defaultWindowSeconds = deps.defaultWindowSeconds;
    this.eventBus = deps.eventBus ?? null;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Read the window's last-activity timestamp for `paneId` once and
   * record an `isActiveWithinWindow` observation by comparing it to
   * the configured silence window.
   *
   * Returns the new SeatActivity record, or null when no signal is
   * available (transient tmux error, blank/unparseable timestamp).
   *
   * Slice 15 BLOCKING-fix: pivoted from reading the runtime's
   * `pane_silence_flag` (observed blank on tmux 3.6a, sticky-alert
   * behavior on others) to computing active/idle ourselves from
   * `window_activity` — the same timestamp tmux's own status-line
   * activity indicators consult.
   */
  async pollSeat(paneId: string, opts?: PollSeatOptions): Promise<SeatActivity | null> {
    const silenceWindowSeconds = opts?.silenceWindowSeconds ?? this.defaultWindowSeconds;
    let lastActivityEpochSeconds: number | null = null;
    try {
      lastActivityEpochSeconds = await this.tmux.readPaneLastActivity(paneId);
    } catch {
      lastActivityEpochSeconds = null;
    }
    if (lastActivityEpochSeconds === null) return null;

    const observedAt = this.now();
    const ageSeconds = observedAt.getTime() / 1000 - lastActivityEpochSeconds;
    // Active when the most recent activity is within the silence window.
    // Negative ageSeconds (clock skew) defensively reads as active too —
    // it means tmux reports activity in the (very near) future, which
    // happens when the daemon's monotonic clock lags briefly.
    const isActiveWithinWindow = ageSeconds < silenceWindowSeconds;

    const record: SeatActivity = {
      paneId,
      isActiveWithinWindow,
      silenceWindowSeconds,
      lastObservedAt: observedAt.toISOString(),
      // ARCH RULING 3a947fb1 (FR-7 additive): surface the RAW window_activity
      // timestamp as ISO — the same epoch we just consumed for `ageSeconds`,
      // no longer discarded. RAW, never clamped (skew may put it ahead of
      // lastObservedAt); consumers derive display-age from it + a reader clock.
      lastActivityAt: new Date(lastActivityEpochSeconds * 1000).toISOString(),
    };
    this.latestByPaneId.set(paneId, record);
    return record;
  }

  /**
   * Return the latest stored observation for a seat, or null when no
   * observation has been recorded yet (e.g. service hasn't polled this
   * seat). Distinct from `isActiveWithinWindow: false`.
   */
  getSeatActivity(paneId: string): SeatActivity | null {
    return this.latestByPaneId.get(paneId) ?? null;
  }

  /** Drop the latest stored observation for a seat (used on seat teardown). */
  forgetSeat(paneId: string): void {
    this.latestByPaneId.delete(paneId);
  }

  /**
   * Slice 15 — refresh observations for every running tmux-bound seat.
   * Drives the per-tick cadence from `start(intervalMs, db)`; callers
   * can also invoke directly for tests or one-shot refresh.
   */
  async pollAllRunningTmuxSeats(db: Database.Database): Promise<void> {
    // SINGLE-FLIGHT and HELD until the reads settle: a new sweep never starts while one is in flight,
    // so a slowed/stuck tmux can never accumulate overlapping whole-fleet window-activity sweeps — at
    // most one sweep's worth is ever in flight. This suppresses OVERLAP only; a non-overlapping tick
    // runs unchanged, so cadence and activity-freshness semantics are untouched.
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const rows = db.prepare(`
        SELECT s.session_name as session_name
        FROM nodes n
        JOIN sessions s ON s.node_id = n.id
          AND s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = n.id ORDER BY s2.id DESC LIMIT 1)
        LEFT JOIN bindings b ON b.node_id = n.id
        WHERE s.status = 'running'
          AND s.session_name IS NOT NULL
          AND COALESCE(b.attachment_type, 'tmux') = 'tmux'
      `).all() as Array<{ session_name: string }>;

      // Drop observations for seats that are no longer running (release
      // memory + avoid stale reads from `getSeatActivity`).
      const live = new Set(rows.map((r) => r.session_name));
      for (const pane of Array.from(this.latestByPaneId.keys())) {
        if (!live.has(pane)) this.latestByPaneId.delete(pane);
      }

      // Best-effort: a single seat's failure does not crash the loop.
      await Promise.all(rows.map(async (r) => {
        try { await this.pollSeat(r.session_name); } catch { /* swallow */ }
      }));
    } finally {
      this.sweeping = false;
    }
  }

  private timer: ReturnType<typeof setInterval> | null = null;

  /**
   * Start the scheduler. Polls every running tmux-bound seat once per
   * `intervalMs`. Idempotent — calling twice is a no-op.
   */
  start(db: Database.Database, intervalMs: number = DEFAULT_POLL_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.pollAllRunningTmuxSeats(db);
    }, intervalMs);
    if (this.timer && typeof this.timer === "object" && "unref" in this.timer) {
      (this.timer as NodeJS.Timeout).unref();
    }
  }

  /** Stop the scheduler. Safe to call before start or multiple times. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ── S19 (OPR.0.5.5.19): the ranked evidence ladder above the sampler ──
  // The non-inference contract is UNCHANGED: nothing below reads queue/assignment
  // state; the parked join lives in the parked-query surface, never here.
  // S19 A3 RED: surfaces declared UNWIRED so the pins fail at the arbitration layer.

  /** An adapter (or an occupant swap) declares which rungs this seat's sources staff.
   *  The binding ties the durable seat nodeId to its current pane/session name so the
   *  internal sampler can feed the window-sampling rung for this seat. */
  declareRungInventory(
    _binding: { seatNodeId: string; sessionName: string },
    _inventory: AdapterRungInventory,
  ): void {
    throw new Error("not implemented (S19 A3 RED)");
  }

  /** Adapters push rung evidence (hooks, self-report, chrome, sampling). */
  reportEvidence(_evidence: ActivityEvidence): void {
    throw new Error("not implemented (S19 A3 RED)");
  }

  /** A handover/generation swap: its OWN visible event, never an activity transition;
   *  clears rung trust to the inventory's initial values (AM-1 corollary). */
  declareOccupantSwap(_seatNodeId: string, _generation: string): void {
    throw new Error("not implemented (S19 A3 RED)");
  }

  /** The arbitrated, seat-keyed state every surface renders from. */
  getSeatState(_seatNodeId: string): ArbitratedSeatState | null {
    throw new Error("not implemented (S19 A3 RED)");
  }

  /** Wait-after-seq read primitive (T1 seam, exposed not consumed here): resolves when
   *  the arbitrated seq passes `afterSeq` (transient transitions still satisfy it). */
  waitForSeatState(
    _seatNodeId: string,
    _opts: { afterSeq: number; timeoutMs: number },
  ): Promise<ArbitratedSeatState | null> {
    throw new Error("not implemented (S19 A3 RED)");
  }

  /** Rung-health transitions (AM-1): degradations are VISIBLE, never silent. */
  onRungHealth(_listener: (event: RungHealthEvent) => void): void {
    throw new Error("not implemented (S19 A3 RED)");
  }
}

// S19 arbitration constants — chosen against OUR 1Hz poll / 3s silence window (the SPEC
// requires the numbers recorded; rationale in the GREEN commit + reference doc):
/** Hook evidence older than this no longer decides working/idle (time-bounded authority). */
export const HOOK_AUTHORITY_WINDOW_MS = 15_000;
/** Persistent hook-vs-sampler contradiction beyond this window degrades the hook rung. */
export const CROSS_RUNG_CONTRADICTION_WINDOW_MS = 10_000;
/** Sampling-decided working→idle needs this many consecutive idle evaluations… */
export const SAMPLING_IDLE_DEBOUNCE_TICKS = 2;
/** …bounded by this hard cap; authoritative turn boundaries and idle chrome bypass instantly. */
export const SAMPLING_IDLE_DEBOUNCE_CAP_MS = 2_500;
/** AM-2 promotion: a trial rung earns authority after this many agreeing observations… */
export const RUNG_PROMOTION_AGREEMENT_COUNT = 50;
/** …spread over at least this window of production time. */
export const RUNG_PROMOTION_MIN_WINDOW_MS = 60 * 60 * 1000;
