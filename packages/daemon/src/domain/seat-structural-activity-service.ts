import type Database from "better-sqlite3";
import type { PaneCapture, TmuxAdapter } from "../adapters/tmux.js";
import { communityHarnessPaneActivity, classifyPaneActivity, readSeatBeforePaste, type PaneActivityClassification } from "./session-transport.js";
import { communityHarnessOf } from "./built-in-runtimes.js";
import { detectCodexLimitBanner, type CodexLimitBanner } from "./provider/codex-limit-banner.js";
import { IDLE_FULL_CAPTURE_MS, windowSnapshot } from "./transcript-rotation.js";
import { sessionCommunityHarnessSelect } from "./session-registry.js";

/** A cached STRUCTURAL pane observation: the classifyPaneActivity verdict plus WHEN the pane was read
 *  as motion. observedAt is a LIVENESS timestamp (last time we saw the pane), NOT a hook-arrival age —
 *  that distinction is the whole point of constraint 2 (a real counter is not a real liveness verdict). */
export interface StructuralObservation {
  state: PaneActivityClassification["state"];
  reason: string;
  evidence: string | null;
  observedAt: string;
  /** A complete idle frame read for this capture's target, not a generic footer or hook. */
  idleFrame?: { sessionName: string; runtime: "claude-code" | "codex"; captureStartedAt: string };
  /** Set when a later sweep found the pane unchanged since observedAt without capturing it. Freshness counts from it;
   *  observedAt stays the capture. */
  checkedAt?: string;
}

export const DEFAULT_STRUCTURAL_POLL_INTERVAL_MS = 1000;
// A cached observation is authoritative only while CURRENT. Past this window with no fresh capture — a
// tmux/capture outage, a stalled poller, or a same-name occupant transition — the READ refuses it and
// evicts it, so a stale positive verdict can never masquerade as liveness (MUST-FIX 1). 5× the poll
// tolerates a few missed ticks; a persistently failing/stuck poller ages the row out and the ACTIVITY
// projection falls back to the honest hook/unknown state.
export const DEFAULT_STRUCTURAL_STALE_MS = 5000;

/**
 * 5b82324b — the STRUCTURAL activity cache. Sibling of SeatActivityService (which reads ONLY the tmux
 * window_activity TIMESTAMP and is deliberately text-blind): this service captures pane TEXT once per
 * running tmux seat per tick and classifies it STRUCTURALLY via classifyPaneActivity (spinner shapes,
 * `esc to interrupt`, idle-prompt / status-bar signatures — never a verb allowlist, so a "Drizzling"-
 * style spinner reads as motion instead of a false park). The cache is READ (capture-FREE) by
 * attachAgentActivity so the `rig ps` ACTIVITY column reflects real pane motion for hook-less / stale-
 * hook / turn-boundary seats WITHOUT reintroducing the per-request capture storm the healthz-wedge
 * cheap-default removed. Two safety rules make the BACKGROUND path itself safe:
 *   (MF1) a read refuses a stale observation and a failed capture invalidates the prior row — a stale
 *         positive verdict never survives a capture outage or a same-name occupant transition; and
 *   (MF2) sweeps are SINGLE-FLIGHT and HELD until the real captures settle — a slow/stuck tmux can
 *         never accumulate overlapping whole-fleet captures (only one sweep's captures are ever in
 *         flight). We deliberately do NOT time-out a capture to release the guard: execCommand has no
 *         AbortSignal, so a wrapper timeout would release single-flight while the child process lives,
 *         letting a later sweep spawn MORE children — the storm at the process level. A permanently
 *         stuck tmux therefore degrades to "no structural signal" (honest, via MF1 age-expiry), never
 *         a storm. A kill-backed capture primitive (bounded abort) is a tmux-adapter follow-on.
 */
export class SeatStructuralActivityService {
  private readonly latestBySession = new Map<string, StructuralObservation>();
  // window_activity (epoch seconds) when each cached verdict's capture was taken, with that sweep's start second.
  private readonly capturedActivity = new Map<string, { activity: number; size?: string; startSec: number; fullAt: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false; // single-flight guard: one whole-fleet sweep at a time (MUST-FIX 2)
  private bannerEmitter:
    | ((sessionName: string, banner: CodexLimitBanner | null, observedAt: Date) => void)
    | null = null;

  constructor(
    private readonly tmuxAdapter: Pick<TmuxAdapter, "capturePaneContent"> & Partial<Pick<TmuxAdapter, "capturePanesContent" | "readAllSessionWindowActivity" | "readAllSessionWindows">>,
    private readonly now: () => Date = () => new Date(),
    private readonly captureLines: number = 20,
    private readonly staleAfterMs: number = DEFAULT_STRUCTURAL_STALE_MS,
  ) {}

  /**
   * Attach the Codex limit-banner emitter (#763). Kept as late attachment
   * (rather than a constructor dep) so construction order with the activity
   * store is untouched: startup attaches it once the store exists.
   */
  attachCodexLimitBanner(
    emitter: (sessionName: string, banner: CodexLimitBanner | null, observedAt: Date) => void,
  ): void {
    this.bannerEmitter = emitter;
  }

  /** The cached structural observation — ONLY while current (capture-FREE read). Returns null AND evicts
   *  once the observation is older than the freshness window, so a stalled/failed poller never leaves a
   *  stale positive verdict authoritative over an honest stale hook (MUST-FIX 1). */
  getStructuralActivity(sessionName: string): StructuralObservation | null {
    const obs = this.latestBySession.get(sessionName);
    if (!obs) return null;
    if (this.now().getTime() - Date.parse(obs.checkedAt ?? obs.observedAt) >= this.staleAfterMs) {
      this.latestBySession.delete(sessionName);
      return null;
    }
    return obs;
  }

  /** Capture + structurally classify one seat's pane, caching the observation keyed by session name. A
   *  null or failed capture INVALIDATES the prior row (never leaves a stale positive verdict) and
   *  returns null (MUST-FIX 1). `prefetched` (#308) is the sweep's batched capture: a session it holds (null = gone or
   *  empty) is used as is; one it lacks is captured here, per seat. */
  async pollSeat(sessionName: string, prefetched?: Map<string, PaneCapture> | null, runtime?: string | null, communityHarness?: string | null, prefetchedStartedAt?: Date): Promise<StructuralObservation | null> {
    let content: string | null;
    let observedAt: Date | null = null;
    // Completion can lag the bytes: use a lower bound taken before the actual read.
    const captureStartedAt = prefetched?.has(sessionName) ? prefetchedStartedAt : this.now();
    if (prefetched?.has(sessionName)) {
      const capture = prefetched.get(sessionName)!;
      content = capture.text;
      observedAt = capture.capturedAt; // the capture's own time, never the end of the sweep (#309 review)
    } else {
      try {
        content = await this.tmuxAdapter.capturePaneContent(sessionName, this.captureLines);
      } catch {
        this.latestBySession.delete(sessionName);
        return null;
      }
    }
    if (content === null) {
      this.latestBySession.delete(sessionName);
      return null;
    }
    const c = communityHarnessPaneActivity(classifyPaneActivity(content), communityHarness);
    const at = observedAt ?? this.now();
    const obs: StructuralObservation = {
      state: c.state,
      reason: c.reason,
      evidence: c.evidence,
      observedAt: at.toISOString(),
      ...(captureStartedAt && c.state === "agent_idle" && (runtime === "claude-code" || runtime === "codex")
        && readSeatBeforePaste(content, runtime, sessionName) === "idle"
        ? { idleFrame: { sessionName, runtime, captureStartedAt: captureStartedAt.toISOString() } } : {}),
    };
    this.latestBySession.set(sessionName, obs);
    // #763: a Codex usage-limit banner is invisible to the hook vocabulary,
    // so the reactive tap never fires for it. Report what the seat shows, on
    // transition only (the recorder skips an already-reported banner). A poll
    // ends the episode only with positive structural evidence and no banner.
    // Null/failed, blank and unrecognized captures cannot establish recovery.
    if (runtime === "codex" && this.bannerEmitter) {
      const banner = detectCodexLimitBanner(content);
      if (banner || (content.trim().length > 0 && c.state !== "unknown")) {
        this.bannerEmitter(sessionName, banner, at);
      }
    }
    return obs;
  }

  /** Refresh every running tmux-bound seat once. SINGLE-FLIGHT and HELD until the captures settle: a new
   *  sweep never starts while one is in flight (MUST-FIX 2), so a slow/stuck tmux can never accumulate
   *  overlapping whole-fleet captures — at most one sweep's worth (N seats) is ever in flight. */
  async pollAllRunningTmuxSeats(db: Database.Database): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const rows = db.prepare(`
        SELECT s.session_name as session_name, n.runtime as runtime, ${sessionCommunityHarnessSelect(db)} as community_harness
        FROM nodes n
        JOIN sessions s ON s.node_id = n.id
          AND s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = n.id ORDER BY s2.id DESC LIMIT 1)
        LEFT JOIN bindings b ON b.node_id = n.id
        WHERE s.status = 'running'
          AND s.session_name IS NOT NULL
          AND COALESCE(b.attachment_type, 'tmux') = 'tmux'
      `).all() as Array<{ session_name: string; runtime: string | null; community_harness: string | null }>;
      const live = new Set(rows.map((r) => r.session_name));
      const runtimeBySession = new Map(rows.map((r) => [r.session_name, r.runtime] as const));
      const communityHarnessBySession = new Map(rows.map((r) => [r.session_name, communityHarnessOf(r.community_harness, r.runtime)] as const));
      for (const s of Array.from(this.latestBySession.keys())) {
        if (!live.has(s)) this.latestBySession.delete(s); // release memory + never serve a stale read
      }
      for (const s of Array.from(this.capturedActivity.keys())) if (!live.has(s)) this.capturedActivity.delete(s);
      const sweepAt = this.now();
      const startSec = Math.floor(sweepAt.getTime() / 1000);
      // A listing started by this sweep, so a write before the sweep moves its activity; rotation reuses it. A listing
      // still running from earlier, or a stalled one, means no hint: every seat is captured, as before.
      const activity = this.tmuxAdapter.readAllSessionWindows || this.tmuxAdapter.readAllSessionWindowActivity
        ? await windowSnapshot(this.tmuxAdapter as TmuxAdapter, DEFAULT_STRUCTURAL_POLL_INTERVAL_MS, true) : null;
      // tmux bumps window_activity on every pane write: a seat whose activity is unchanged and older than the sweep
      // that captured it shows the same pane, so its cached verdict stays current (checkedAt) without a capture.
      const due = rows.filter((r) => {
        const seen = this.capturedActivity.get(r.session_name);
        const now = activity?.get(r.session_name);
        const obs = this.latestBySession.get(r.session_name);
        // The Codex limit row is refreshed by the capture that sees the banner, and ages out without it.
        if (runtimeBySession.get(r.session_name) === "codex" && this.bannerEmitter) return true;
        if (seen && obs && now !== undefined && now.activity === seen.activity && now.size === seen.size && now.activity < seen.startSec
          && sweepAt.getTime() - seen.fullAt < IDLE_FULL_CAPTURE_MS) {
          this.latestBySession.set(r.session_name, { ...obs, checkedAt: sweepAt.toISOString() });
          return false;
        }
        return true;
      });
      // #308: one batched capture for the whole fleet (a few tmux calls) instead of a fork per seat; anything the batch
      // didn't cover (no listing, a failed chunk) is read per seat inside pollSeat, as before.
      const captureStartedAt = this.now();
      const prefetched = this.tmuxAdapter.capturePanesContent && due.length > 0
        ? await this.tmuxAdapter.capturePanesContent(due.map((r) => r.session_name), this.captureLines, this.now).catch(() => null)
        : null;
      await Promise.all(due.map(async (r) => {
        try {
          const obs = await this.pollSeat(r.session_name, prefetched, runtimeBySession.get(r.session_name) ?? null, communityHarnessBySession.get(r.session_name), captureStartedAt);
          const seen = activity?.get(r.session_name);
          if (obs && seen !== undefined) this.capturedActivity.set(r.session_name, { activity: seen.activity, size: seen.size, startSec, fullAt: sweepAt.getTime() });
          else this.capturedActivity.delete(r.session_name);
        } catch { /* isolate: one seat's failure never crashes the sweep */ }
      }));
    } finally {
      this.sweeping = false;
    }
  }

  start(db: Database.Database, intervalMs: number = DEFAULT_STRUCTURAL_POLL_INTERVAL_MS): void {
    if (this.timer) return; // idempotent
    this.timer = setInterval(() => { void this.pollAllRunningTmuxSeats(db); }, intervalMs);
    if (this.timer && typeof this.timer === "object" && "unref" in this.timer) {
      (this.timer as NodeJS.Timeout).unref();
    }
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
}
