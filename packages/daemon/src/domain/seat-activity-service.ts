import type Database from "better-sqlite3";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { EventBus } from "./event-bus.js";
import type { SeatActivity } from "./types.js";
import type {
  ActivityEvidence,
  ActivityValue,
  AdapterRungInventory,
  ArbitratedSeatState,
  EvidenceRungId,
  RungHealthEvent,
  RungTrust,
} from "./activity-taxonomy.js";
import { EVIDENCE_RUNG_RANK, runtimeRungInventory } from "./activity-taxonomy.js";

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
  /** S19: the self-report rung producer (Claude pid.json). Consulted per sweep for seats
   *  whose declared inventory staffs self-report; absent = the rung is absent. */
  selfReportReader?: (sessionName: string, seatNodeId: string) => ActivityEvidence | null;
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

  private readonly selfReportReader: ((sessionName: string, seatNodeId: string) => ActivityEvidence | null) | null;

  constructor(deps: SeatActivityServiceDeps) {
    this.tmux = deps.tmux;
    this.defaultWindowSeconds = deps.defaultWindowSeconds;
    this.eventBus = deps.eventBus ?? null;
    this.now = deps.now ?? (() => new Date());
    this.selfReportReader = deps.selfReportReader ?? null;
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

    // S19: the sampler IS the window-sampling rung — feed the ladder for bound seats,
    // and consult the self-report rung (when declared) in the same pass.
    const seatNodeId = this.sessionToSeat.get(paneId);
    if (seatNodeId) {
      const seq = (this.samplerSeqBySession.get(paneId) ?? 0) + 1;
      this.samplerSeqBySession.set(paneId, seq);
      this.reportEvidence({
        seatNodeId,
        sessionName: paneId,
        rung: "window-sampling",
        sourceId: "tmux:window-activity",
        seq,
        observedAt: record.lastObservedAt,
        activity: isActiveWithinWindow ? "working" : "idle-at-prompt",
      });
      const seat = this.ladder.get(seatNodeId);
      if (this.selfReportReader && seat?.inventory?.rungs.some((r) => r.rung === "self-report")) {
        const evd = this.selfReportReader(paneId, seatNodeId);
        if (evd) this.reportEvidence(evd); // null = unreadable ⇒ the rung simply stales
      }
    }
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
        SELECT s.session_name as session_name, n.id as node_id, n.runtime as runtime
        FROM nodes n
        JOIN sessions s ON s.node_id = n.id
          AND s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = n.id ORDER BY s2.id DESC LIMIT 1)
        LEFT JOIN bindings b ON b.node_id = n.id
        WHERE s.status = 'running'
          AND s.session_name IS NOT NULL
          AND COALESCE(b.attachment_type, 'tmux') = 'tmux'
      `).all() as Array<{ session_name: string; node_id: string; runtime: string | null }>;

      // S19: every running tmux seat gets a ladder binding; undeclared seats are
      // auto-declared from their runtime's inventory (claude authoritative standing,
      // codex hooks-at-trial, generic sampling floor) — production-complete without
      // touching the launch machinery.
      for (const r of rows) {
        const known = this.ladder.get(r.node_id);
        if (!known || known.inventory === null) {
          this.declareRungInventory(
            { seatNodeId: r.node_id, sessionName: r.session_name },
            runtimeRungInventory(r.runtime),
          );
        }
      }

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

  private readonly ladder = new Map<string, SeatLadderState>();
  private readonly sessionToSeat = new Map<string, string>();
  private readonly healthListeners: Array<(event: RungHealthEvent) => void> = [];
  private readonly samplerSeqBySession = new Map<string, number>();

  /** An adapter (or an occupant swap) declares which rungs this seat's sources staff.
   *  The binding ties the durable seat nodeId to its current pane/session name so the
   *  internal sampler can feed the window-sampling rung for this seat. */
  declareRungInventory(
    binding: { seatNodeId: string; sessionName: string },
    inventory: AdapterRungInventory,
  ): void {
    const seat = this.seatLadder(binding.seatNodeId, binding.sessionName);
    seat.sessionName = binding.sessionName;
    this.sessionToSeat.set(binding.sessionName, binding.seatNodeId);
    seat.inventory = inventory;
    seat.trust.clear();
    for (const decl of inventory.rungs) seat.trust.set(decl.rung, decl.initialTrust);
    seat.promotion.clear();
    this.arbitrate(seat);
  }

  /** Adapters push rung evidence (hooks, self-report, chrome, sampling). Per-source
   *  monotonic seq: stale or reordered reports are dropped — a late lower-seq event
   *  never revives an idle seat (the SubagentStop class at the service layer). */
  reportEvidence(evidence: ActivityEvidence): void {
    const seat = this.seatLadder(evidence.seatNodeId, evidence.sessionName);
    this.sessionToSeat.set(evidence.sessionName, evidence.seatNodeId);
    const prior = seat.sources.get(evidence.sourceId);
    if (prior && evidence.seq <= prior.latest.seq) return; // stale/reordered — dropped
    seat.sources.set(evidence.sourceId, {
      latest: evidence,
      latestActivity: evidence.activity !== undefined ? evidence : prior?.latestActivity ?? null,
    });
    this.measureTrialAgreement(seat, evidence);
    this.arbitrate(seat);
  }

  /** A handover/generation swap: its OWN visible event, never an activity transition.
   *  Evidence, debounce, contradiction and promotion state are cleared; every known
   *  rung's trust drops to `absent` until the successor's adapter RE-DECLARES its
   *  inventory (AM-1 corollary: a successor never inherits rung authority). */
  declareOccupantSwap(seatNodeId: string, generation: string): void {
    const seat = this.ladder.get(seatNodeId);
    if (!seat) return;
    seat.sources.clear();
    seat.pendingIdle = null;
    seat.contradictionSinceMs = null;
    seat.promotion.clear();
    for (const rung of seat.trust.keys()) seat.trust.set(rung, "absent");
    seat.inventory = null;
    const at = this.now().toISOString();
    seat.arbitrated = {
      ...seat.arbitrated,
      activity: "unknown",
      needsInput: { count: 0, reason: null },
      decidedBy: null,
      seq: seat.arbitrated.seq + 1, // the swap IS a visible event
      changedAt: at,
      rungs: this.rungsView(seat),
      lastSwap: { generation, at },
    };
    this.resolveWaiters(seat);
  }

  /** Whether this seat currently has a DECLARED rung inventory (a swap clears it —
   *  the successor must re-declare before its rungs regain any trust). */
  hasRungInventory(seatNodeId: string): boolean {
    return this.ladder.get(seatNodeId)?.inventory != null;
  }

  /** Resolve by CURRENT session name (projection convenience) — state itself stays
   *  keyed by the durable seat nodeId. */
  getSeatStateBySession(sessionName: string): ArbitratedSeatState | null {
    const seatNodeId = this.sessionToSeat.get(sessionName);
    return seatNodeId ? this.getSeatState(seatNodeId) : null;
  }

  /** The arbitrated, seat-keyed state every surface renders from. */
  getSeatState(seatNodeId: string): ArbitratedSeatState | null {
    const seat = this.ladder.get(seatNodeId);
    if (!seat) return null;
    this.arbitrate(seat); // lazy re-evaluation picks up time-based expiry/caps
    return seat.arbitrated;
  }

  /** Wait-after-seq read primitive (T1 seam, exposed not consumed here): resolves when
   *  the arbitrated seq passes `afterSeq` (a fast pass-through transition still
   *  satisfies the wait — the lost-wakeup guard). Timeout resolves null, never throws. */
  waitForSeatState(
    seatNodeId: string,
    opts: { afterSeq: number; timeoutMs: number },
  ): Promise<ArbitratedSeatState | null> {
    const seat = this.ladder.get(seatNodeId);
    if (!seat) return Promise.resolve(null);
    if (seat.arbitrated.seq > opts.afterSeq) return Promise.resolve(seat.arbitrated);
    return new Promise((resolve) => {
      const waiter: SeatWaiter = {
        afterSeq: opts.afterSeq,
        resolve,
        timer: setTimeout(() => {
          seat.waiters = seat.waiters.filter((w) => w !== waiter);
          resolve(null);
        }, opts.timeoutMs),
      };
      if (typeof waiter.timer === "object" && "unref" in waiter.timer) waiter.timer.unref();
      seat.waiters.push(waiter);
    });
  }

  /** Rung-health transitions (AM-1): degradations and promotions are VISIBLE, never silent. */
  onRungHealth(listener: (event: RungHealthEvent) => void): void {
    this.healthListeners.push(listener);
  }

  private seatLadder(seatNodeId: string, sessionName: string): SeatLadderState {
    let seat = this.ladder.get(seatNodeId);
    if (!seat) {
      seat = {
        sessionName,
        inventory: null,
        sources: new Map(),
        trust: new Map(),
        promotion: new Map(),
        contradictionSinceMs: null,
        pendingIdle: null,
        waiters: [],
        arbitrated: {
          seatNodeId,
          activity: "unknown",
          needsInput: { count: 0, reason: null },
          decidedBy: null,
          seq: 0,
          changedAt: this.now().toISOString(),
          rungs: [],
          lastSwap: null,
        },
      };
      this.ladder.set(seatNodeId, seat);
    }
    return seat;
  }

  /** Trust for a rung: declared trust when an inventory exists; without a declaration
   *  the generic tmux floor (window-sampling) is authoritative and everything else is
   *  identity-only — partial-coverage honesty by default. */
  private rungTrust(seat: SeatLadderState, rung: EvidenceRungId): RungTrust {
    const declared = seat.trust.get(rung);
    if (declared) return declared;
    if (seat.inventory) return "absent"; // declared inventory, undeclared rung
    return rung === "window-sampling" ? "authoritative" : "identity-only";
  }

  /** Latest evidence for a rung. kind "activity" returns the newest ACTIVITY-BEARING
   *  evidence — a needs-input-only event from the same source (e.g. PermissionRequest
   *  mid-turn) must not erase what the source last said about working/idle. */
  private latestByRung(
    seat: SeatLadderState,
    rung: EvidenceRungId,
    kind: "any" | "activity" = "any",
  ): ActivityEvidence | null {
    let best: ActivityEvidence | null = null;
    for (const entry of seat.sources.values()) {
      const evd = kind === "activity" ? entry.latestActivity : entry.latest;
      if (!evd || evd.rung !== rung) continue;
      if (!best || evd.seq > best.seq) best = evd;
    }
    return best;
  }

  /** AM-2: a TRIAL rung's evidence is measured against the current authoritative
   *  CANDIDATE value (raw ladder decision, pre-debounce) — evidence against evidence,
   *  never against the debounced display. Enough agreements over at least the minimum
   *  window promote the rung to authoritative, visibly. */
  private measureTrialAgreement(seat: SeatLadderState, evidence: ActivityEvidence): void {
    if (evidence.activity === undefined) return;
    if (this.rungTrust(seat, evidence.rung) !== "trial") return;
    const authority = this.rawCandidate(seat, { excludeRung: evidence.rung });
    if (!authority || authority.activity === undefined) return;
    const entry = seat.promotion.get(evidence.rung) ?? { agreements: 0, firstAgreementAtMs: null };
    if (authority.activity === evidence.activity) {
      entry.agreements += 1;
      if (entry.firstAgreementAtMs === null) entry.firstAgreementAtMs = this.now().getTime();
      const spanMs = this.now().getTime() - (entry.firstAgreementAtMs ?? 0);
      if (entry.agreements >= RUNG_PROMOTION_AGREEMENT_COUNT && spanMs >= RUNG_PROMOTION_MIN_WINDOW_MS) {
        seat.trust.set(evidence.rung, "authoritative");
        this.emitRungHealth(seat, evidence.rung, evidence.sourceId, "trial", "authoritative",
          `promoted: ${entry.agreements} agreeing observations over ${Math.round(spanMs / 60000)}min (threshold ${RUNG_PROMOTION_AGREEMENT_COUNT} over ${Math.round(RUNG_PROMOTION_MIN_WINDOW_MS / 60000)}min)`);
        seat.promotion.delete(evidence.rung);
        return;
      }
    } else {
      entry.agreements = 0; // agreement must be consecutive within the measured window
      entry.firstAgreementAtMs = null;
    }
    seat.promotion.set(evidence.rung, entry);
  }

  /** The raw ladder decision for working/idle: highest authoritative rung with usable,
   *  in-window evidence. Hook evidence is TIME-BOUNDED (the one rung that does not
   *  self-date its lifecycle) — expired hook evidence falls through, never errors. */
  private rawCandidate(seat: SeatLadderState, opts: { excludeRung?: EvidenceRungId } = {}): ActivityEvidence | null {
    const nowMs = this.now().getTime();
    for (const rung of EVIDENCE_RUNG_RANK) {
      if (rung === opts.excludeRung) continue;
      if (this.rungTrust(seat, rung) !== "authoritative") continue;
      const evd = this.latestByRung(seat, rung, "activity");
      if (!evd || evd.activity === undefined) continue;
      if (rung === "lifecycle-hooks" && nowMs - Date.parse(evd.observedAt) > HOOK_AUTHORITY_WINDOW_MS) continue;
      return evd;
    }
    return null;
  }

  private emitRungHealth(
    seat: SeatLadderState,
    rung: EvidenceRungId,
    sourceId: string,
    from: RungTrust,
    to: RungTrust,
    reason: string,
  ): void {
    const event: RungHealthEvent = {
      seatNodeId: seat.arbitrated.seatNodeId,
      rung,
      sourceId,
      from,
      to,
      reason,
      at: this.now().toISOString(),
    };
    for (const listener of this.healthListeners) listener(event);
    this.eventBus?.emit({ type: "seat.rung_health", ...event } as never);
  }

  /** AM-1: persistent cross-rung contradiction (hook claims working while a lower
   *  authoritative rung sees idle-at-prompt beyond the stated window) degrades the hook
   *  rung to identity-only, VISIBLY — arbitration can never make a silently-dead source
   *  authoritative. */
  private checkContradiction(seat: SeatLadderState): void {
    if (this.rungTrust(seat, "lifecycle-hooks") !== "authoritative") return;
    const hook = this.latestByRung(seat, "lifecycle-hooks", "activity");
    const sampler = this.latestByRung(seat, "window-sampling", "activity");
    const nowMs = this.now().getTime();
    const hookFresh = hook && hook.activity !== undefined
      && nowMs - Date.parse(hook.observedAt) <= HOOK_AUTHORITY_WINDOW_MS;
    const contradicts = hookFresh && hook!.activity === "working"
      && sampler?.activity === "idle-at-prompt"
      && this.rungTrust(seat, "window-sampling") === "authoritative";
    if (!contradicts) {
      seat.contradictionSinceMs = null;
      return;
    }
    if (seat.contradictionSinceMs === null) {
      seat.contradictionSinceMs = nowMs;
      return;
    }
    if (nowMs - seat.contradictionSinceMs > CROSS_RUNG_CONTRADICTION_WINDOW_MS) {
      seat.trust.set("lifecycle-hooks", "identity-only");
      seat.contradictionSinceMs = null;
      this.emitRungHealth(seat, "lifecycle-hooks", hook!.sourceId, "authoritative", "identity-only",
        `cross-rung contradiction: hook claims working while window-sampling sees idle-at-prompt beyond ${CROSS_RUNG_CONTRADICTION_WINDOW_MS / 1000}s — degraded to identity-only (a silently-dropping source can never stay authoritative)`);
    }
  }

  private rungsView(seat: SeatLadderState): ArbitratedSeatState["rungs"] {
    const rungIds = new Set<EvidenceRungId>();
    if (seat.inventory) for (const d of seat.inventory.rungs) rungIds.add(d.rung);
    for (const r of seat.trust.keys()) rungIds.add(r);
    return [...rungIds].map((rung) => {
      const evd = this.latestByRung(seat, rung);
      return {
        rung,
        sourceId: evd?.sourceId ?? `${seat.inventory?.adapterId ?? "undeclared"}:${rung}`,
        trust: this.rungTrust(seat, rung),
        lastEvidenceAt: evd?.observedAt ?? null,
      };
    });
  }

  /** Recompute the arbitrated state. Debounce: a sampling-decided working→idle
   *  transition holds until the stated consecutive idle observations or the hard cap;
   *  an authoritative turn boundary (hooks/self-report idle) or idle chrome publishes
   *  instantly. Chosen against our 1Hz/3s cadence: the 3s silence window already
   *  absorbs sub-3s lulls; the 2-tick arbitration debounce absorbs the
   *  window-boundary flap. */
  private arbitrate(seat: SeatLadderState): void {
    this.checkContradiction(seat);
    const candidate = this.rawCandidate(seat);
    let nextActivity: ActivityValue = candidate?.activity ?? "unknown";
    let decidedBy: EvidenceRungId | null = candidate?.rung ?? null;

    // Debounce bookkeeping runs on the SAMPLING OBSERVATIONS themselves (regardless of
    // which rung currently decides): consecutive idle observations while the arbitrated
    // state is working accumulate; any sampling `working` resets. The hold applies only
    // when sampling would DECIDE the flip — an authoritative turn boundary (hooks or
    // self-report idle) or idle chrome bypasses instantly.
    const nowMs = this.now().getTime();
    const sampling = this.latestByRung(seat, "window-sampling");
    if (seat.arbitrated.activity === "working" && sampling?.activity === "idle-at-prompt") {
      if (!seat.pendingIdle) {
        seat.pendingIdle = { sinceMs: nowMs, ticks: 1, lastSeq: sampling.seq };
      } else if (sampling.seq > seat.pendingIdle.lastSeq) {
        seat.pendingIdle.ticks += 1;
        seat.pendingIdle.lastSeq = sampling.seq;
      }
    } else if (sampling?.activity === "working" || seat.arbitrated.activity !== "working") {
      seat.pendingIdle = null;
    }
    if (candidate?.rung === "window-sampling" && candidate.activity === "idle-at-prompt"
        && seat.arbitrated.activity === "working" && seat.pendingIdle) {
      const capped = nowMs - seat.pendingIdle.sinceMs >= SAMPLING_IDLE_DEBOUNCE_CAP_MS;
      if (seat.pendingIdle.ticks < SAMPLING_IDLE_DEBOUNCE_TICKS && !capped) {
        nextActivity = "working"; // held — the mid-turn lull must not flip the state
        decidedBy = seat.arbitrated.decidedBy;
      } else {
        seat.pendingIdle = null;
      }
    }

    // needs-input: visible chrome outranks hook-carried evidence; hooks carry it when a
    // PermissionRequest-class event fired and the next turn boundary clears it. NOT
    // time-bounded like working/idle hook authority — an unanswered block persisting is
    // exactly the founder-observed park cause and must stay visible.
    const chrome = this.latestByRung(seat, "needs-input-chrome");
    const hooksEv = this.latestByRung(seat, "lifecycle-hooks");
    const selfEv = this.latestByRung(seat, "self-report");
    const needsInput: NeedsInputShape =
      chrome?.needsInput && this.rungTrust(seat, "needs-input-chrome") === "authoritative"
        ? chrome.needsInput
        : hooksEv?.needsInput && this.rungTrust(seat, "lifecycle-hooks") === "authoritative"
          ? hooksEv.needsInput
          : selfEv?.needsInput && this.rungTrust(seat, "self-report") === "authoritative"
            ? selfEv.needsInput
            : { count: 0, reason: null };

    const changed = nextActivity !== seat.arbitrated.activity
      || needsInput.count !== seat.arbitrated.needsInput.count
      || needsInput.reason !== seat.arbitrated.needsInput.reason;
    seat.arbitrated = {
      ...seat.arbitrated,
      activity: nextActivity,
      needsInput,
      decidedBy,
      seq: changed ? seat.arbitrated.seq + 1 : seat.arbitrated.seq,
      changedAt: changed ? this.now().toISOString() : seat.arbitrated.changedAt,
      rungs: this.rungsView(seat),
    };
    if (changed) this.resolveWaiters(seat);
  }

  private resolveWaiters(seat: SeatLadderState): void {
    const ready = seat.waiters.filter((w) => seat.arbitrated.seq > w.afterSeq);
    seat.waiters = seat.waiters.filter((w) => seat.arbitrated.seq <= w.afterSeq);
    for (const w of ready) {
      clearTimeout(w.timer);
      w.resolve(seat.arbitrated);
    }
  }
}

interface SeatWaiter {
  afterSeq: number;
  resolve: (s: ArbitratedSeatState | null) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface NeedsInputShape {
  count: number;
  reason: string | null;
}

interface SeatLadderState {
  sessionName: string;
  inventory: AdapterRungInventory | null;
  sources: Map<string, { latest: ActivityEvidence; latestActivity: ActivityEvidence | null }>;
  trust: Map<EvidenceRungId, RungTrust>;
  promotion: Map<EvidenceRungId, { agreements: number; firstAgreementAtMs: number | null }>;
  contradictionSinceMs: number | null;
  pendingIdle: { sinceMs: number; ticks: number; lastSeq: number } | null;
  waiters: SeatWaiter[];
  arbitrated: ArbitratedSeatState;
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
