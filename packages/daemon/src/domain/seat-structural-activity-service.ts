import type Database from "better-sqlite3";
import type { TmuxAdapter } from "../adapters/tmux.js";
import { classifyPaneActivity, type PaneActivityClassification } from "./session-transport.js";

/** A cached STRUCTURAL pane observation: the classifyPaneActivity verdict plus WHEN the pane was read
 *  as motion. observedAt is a LIVENESS timestamp (last time we saw the pane), NOT a hook-arrival age —
 *  that distinction is the whole point of constraint 2 (a real counter is not a real liveness verdict). */
export interface StructuralObservation {
  state: PaneActivityClassification["state"];
  reason: string;
  evidence: string | null;
  observedAt: string;
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
  private timer: ReturnType<typeof setInterval> | null = null;
  private sweeping = false; // single-flight guard: one whole-fleet sweep at a time (MUST-FIX 2)

  constructor(
    private readonly tmuxAdapter: Pick<TmuxAdapter, "capturePaneContent">,
    private readonly now: () => Date = () => new Date(),
    private readonly captureLines: number = 20,
    private readonly staleAfterMs: number = DEFAULT_STRUCTURAL_STALE_MS,
  ) {}

  /** The cached structural observation — ONLY while current (capture-FREE read). Returns null AND evicts
   *  once the observation is older than the freshness window, so a stalled/failed poller never leaves a
   *  stale positive verdict authoritative over an honest stale hook (MUST-FIX 1). */
  getStructuralActivity(sessionName: string): StructuralObservation | null {
    const obs = this.latestBySession.get(sessionName);
    if (!obs) return null;
    if (this.now().getTime() - Date.parse(obs.observedAt) >= this.staleAfterMs) {
      this.latestBySession.delete(sessionName);
      return null;
    }
    return obs;
  }

  /** Capture + structurally classify one seat's pane, caching the observation keyed by session name. A
   *  null or failed capture INVALIDATES the prior row (never leaves a stale positive verdict) and
   *  returns null (MUST-FIX 1). */
  async pollSeat(sessionName: string): Promise<StructuralObservation | null> {
    let content: string | null;
    try {
      content = await this.tmuxAdapter.capturePaneContent(sessionName, this.captureLines);
    } catch {
      this.latestBySession.delete(sessionName);
      return null;
    }
    if (content === null) {
      this.latestBySession.delete(sessionName);
      return null;
    }
    const c = classifyPaneActivity(content);
    const obs: StructuralObservation = {
      state: c.state,
      reason: c.reason,
      evidence: c.evidence,
      observedAt: this.now().toISOString(),
    };
    this.latestBySession.set(sessionName, obs);
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
        SELECT s.session_name as session_name
        FROM nodes n
        JOIN sessions s ON s.node_id = n.id
          AND s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = n.id ORDER BY s2.id DESC LIMIT 1)
        LEFT JOIN bindings b ON b.node_id = n.id
        WHERE s.status = 'running'
          AND s.session_name IS NOT NULL
          AND COALESCE(b.attachment_type, 'tmux') = 'tmux'
      `).all() as Array<{ session_name: string }>;
      const live = new Set(rows.map((r) => r.session_name));
      for (const s of Array.from(this.latestBySession.keys())) {
        if (!live.has(s)) this.latestBySession.delete(s); // release memory + never serve a stale read
      }
      await Promise.all(rows.map(async (r) => {
        try { await this.pollSeat(r.session_name); } catch { /* isolate: one seat's failure never crashes the sweep */ }
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
