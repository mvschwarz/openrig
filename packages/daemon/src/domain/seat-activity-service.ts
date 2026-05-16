import type Database from "better-sqlite3";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { EventBus } from "./event-bus.js";
import type { SeatActivity } from "./types.js";

/** Default polling cadence: 1Hz. The default silence window is 3s, so
 *  1Hz polling gives at-most ~1s freshness lag on the cached observation. */
export const DEFAULT_POLL_INTERVAL_MS = 1000;

/**
 * Slice 15 — daemon owner of the `terminal-active` primitive.
 *
 * Polls tmux's per-pane `pane_silence_flag` (configured by
 * `monitor-silence`) and keeps the latest observation per seat,
 * keyed by canonical session name. Downstream consumers (ps-projection,
 * node-inventory, UI hooks) read the latest observation through
 * `getSeatActivity(canonicalSessionName)`.
 *
 * Non-inference contract (slice 15 IMPL-PRD §2.3, HG-4): this service
 * NEVER reads queue/assignment state. Its constructor surface
 * intentionally rejects any queue/assignment-shaped dependency so a
 * future contributor cannot wire one in without first amending the
 * design. The companion `hasAssignedWork` primitive lives in the
 * ps/queue projection and never imports this service either.
 */
export interface SeatActivityServiceDeps {
  tmux: Pick<TmuxAdapter, "readPaneSilenceFlag">;
  defaultWindowSeconds: number;
  eventBus?: EventBus;
  now?: () => Date;
}

export interface PollSeatOptions {
  silenceWindowSeconds?: number;
}

export class SeatActivityService {
  private readonly tmux: Pick<TmuxAdapter, "readPaneSilenceFlag">;
  private readonly defaultWindowSeconds: number;
  private readonly eventBus: EventBus | null;
  private readonly now: () => Date;
  private readonly latestByPaneId = new Map<string, SeatActivity>();

  constructor(deps: SeatActivityServiceDeps) {
    this.tmux = deps.tmux;
    this.defaultWindowSeconds = deps.defaultWindowSeconds;
    this.eventBus = deps.eventBus ?? null;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Read the silence flag for `paneId` once and record the observation.
   * Returns the new SeatActivity record, or null when no signal is
   * available (transient tmux error or unparseable output).
   */
  async pollSeat(paneId: string, opts?: PollSeatOptions): Promise<SeatActivity | null> {
    const silenceWindowSeconds = opts?.silenceWindowSeconds ?? this.defaultWindowSeconds;
    let isSilent: boolean | null = null;
    try {
      isSilent = await this.tmux.readPaneSilenceFlag(paneId);
    } catch {
      isSilent = null;
    }
    if (isSilent === null) return null;

    const record: SeatActivity = {
      paneId,
      isActiveWithinWindow: !isSilent,
      silenceWindowSeconds,
      lastObservedAt: this.now().toISOString(),
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
}
