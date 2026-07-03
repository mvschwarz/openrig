import type Database from "better-sqlite3";
import type { TmuxAdapter } from "../adapters/tmux.js";
import type { SeatIdentityVerdict } from "./types.js";
import { SeatIdentityStore } from "./seat-identity-store.js";

/** Default identity-reconcile cadence: 5s. Process identity changes rarely
 *  (a seat's pane/process is stable for its whole life), and the check is
 *  more expensive than the 1Hz activity poll (per-seat pane PID + command
 *  tmux reads), so a slower cadence is the right cost/freshness trade. */
export const DEFAULT_IDENTITY_POLL_INTERVAL_MS = 5000;

/** Foreground commands that read as a bare shell (a seat that dropped to a
 *  prompt, or an orphan/QA-squat shell occupying the pane). Mirrors the
 *  SessionFingerprinter SHELL_NAMES vocabulary. `pane_current_command` may
 *  carry a login-shell `-` prefix. */
const SHELL_COMMANDS = new Set([
  "bash", "zsh", "fish", "sh", "dash", "tcsh", "csh",
  "-bash", "-zsh", "-fish", "-sh", "-dash", "-tcsh", "-csh",
]);

/**
 * Classify the pane's foreground command against the registered runtime.
 *
 * Deliberately LENIENT to preserve the slice-15 no-false-green-for-live-seats
 * invariant: a genuinely-live claude/codex TUI usually reports its host
 * process (`node`) as `pane_current_command`, NOT the literal runtime name, so
 * we only declare `mismatch` on a POSITIVE contradiction — a different known
 * agent runtime, or a bare shell where an agent was expected (the process
 * died / an orphan shell squatted the pane). Ambiguous commands (`node`,
 * `python`, empty) never down-rank.
 *
 * Mirrors SessionFingerprinter's Layer-1 process-command vocabulary; we do NOT
 * run the full 4-layer scan (cmux query + pane-content capture) per poll — it
 * is far more expensive at fleet scale and its content layer would not change
 * the down-rank decision here (the reconcile only needs to distinguish
 * "process contradicts the seat" from "no contradiction").
 */
export function classifyPaneRuntimeMatch(
  command: string | null,
  expectedRuntime: string | null,
): "match" | "mismatch" {
  if (!command) return "match"; // no signal — never false-mismatch a present pane
  const cmd = command.trim().toLowerCase();
  const expectsAgent = expectedRuntime === "claude-code" || expectedRuntime === "codex";

  // Positive same-runtime signal.
  if (expectedRuntime === "claude-code" && cmd.includes("claude")) return "match";
  if (expectedRuntime === "codex" && cmd.includes("codex")) return "match";

  // Cross-runtime contradiction (a DIFFERENT agent occupies the pane).
  if (expectedRuntime === "claude-code" && cmd.includes("codex")) return "mismatch";
  if (expectedRuntime === "codex" && cmd.includes("claude")) return "mismatch";

  // A bare shell where an agent runtime was expected — the agent process is
  // gone or an orphan/squat shell occupies the pane.
  if (expectsAgent && SHELL_COMMANDS.has(cmd)) return "mismatch";

  // Ambiguous / expected-shell (terminal nodes) — no contradiction.
  return "match";
}

interface RunningSeatRow {
  node_id: string;
  runtime: string | null;
  session_name: string;
  tmux_pane: string | null;
}

export interface SeatIdentityReconcilerDeps {
  db: Database.Database;
  tmux: Pick<TmuxAdapter, "listSessions" | "getPanePid" | "getPaneCommand">;
  now?: () => Date;
}

/**
 * OPR.0.4.3.19 — periodic reconciler for the liveness identity verdict (the
 * THIRD axis). Mirrors SeatActivityService.start(): polls every running
 * tmux-bound managed seat, reconciles the current pane PID/command against the
 * registered seat, and persists the verdict to `seat_identity_verdicts`.
 * Projections then read the cheap persisted verdict synchronously.
 *
 * Non-inference: this reconciler reads ONLY tmux pane process identity vs the
 * registered binding. It NEVER reads queue/classifier/hook heartbeats, and it
 * does NOT touch `terminalActive` / `hasAssignedWork`.
 */
export class SeatIdentityReconciler {
  private readonly db: Database.Database;
  private readonly tmux: SeatIdentityReconcilerDeps["tmux"];
  private readonly now: () => Date;
  private readonly store: SeatIdentityStore;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: SeatIdentityReconcilerDeps) {
    this.db = deps.db;
    this.tmux = deps.tmux;
    this.now = deps.now ?? (() => new Date());
    this.store = new SeatIdentityStore(deps.db);
  }

  private runningSeats(): RunningSeatRow[] {
    return this.db.prepare(`
      SELECT n.id as node_id, n.runtime as runtime,
             s.session_name as session_name, b.tmux_pane as tmux_pane
      FROM nodes n
      JOIN sessions s ON s.node_id = n.id
        AND s.id = (SELECT s2.id FROM sessions s2 WHERE s2.node_id = n.id ORDER BY s2.id DESC LIMIT 1)
      LEFT JOIN bindings b ON b.node_id = n.id
      WHERE s.status = 'running'
        AND s.session_name IS NOT NULL
        AND COALESCE(b.attachment_type, 'tmux') = 'tmux'
    `).all() as RunningSeatRow[];
  }

  /** Reconcile every running tmux-bound seat once and persist the verdicts. */
  async reconcileAll(): Promise<void> {
    const seats = this.runningSeats();
    // Prune verdicts for nodes no longer running (keep the table bounded).
    this.store.pruneExcept(seats.map((s) => s.node_id));
    if (seats.length === 0) return;

    const observedAt = this.now().toISOString();

    // One tmux availability probe per poll. If tmux is entirely unreachable
    // (throws) OR reports zero live sessions while we have running seats in
    // the DB, treat it as a transient tmux blip and record `tmux_unavailable`
    // for every seat — NEVER down-rank a live fleet on an infra hiccup.
    let liveSessions: Set<string> | null = null;
    try {
      const sessions = await this.tmux.listSessions();
      liveSessions = new Set(sessions.map((s) => s.name));
    } catch {
      liveSessions = null;
    }
    if (liveSessions === null || liveSessions.size === 0) {
      for (const seat of seats) {
        this.store.upsert(this.tmuxUnavailableVerdict(seat, observedAt));
      }
      return;
    }

    for (const seat of seats) {
      try {
        this.store.upsert(await this.computeVerdict(seat, liveSessions, observedAt));
      } catch {
        // A single seat's tmux failure must not crash the loop; record it as
        // an unknown (non-down-ranking) observation.
        this.store.upsert(this.tmuxUnavailableVerdict(seat, observedAt));
      }
    }
  }

  private tmuxUnavailableVerdict(seat: RunningSeatRow, observedAt: string): SeatIdentityVerdict {
    return {
      nodeId: seat.node_id,
      verdict: "tmux_unavailable",
      evidenceSource: null,
      reason: "tmux_unavailable",
      evidence: { registeredPane: seat.tmux_pane, observedPid: null, observedCommand: null, matchedLayer: null },
      sessionName: seat.session_name,
      observedAt,
    };
  }

  private async computeVerdict(
    seat: RunningSeatRow,
    liveSessions: Set<string>,
    observedAt: string,
  ): Promise<SeatIdentityVerdict> {
    const base = {
      nodeId: seat.node_id,
      sessionName: seat.session_name,
      observedAt,
    };

    // No registered pane to reconcile against — we cannot verify identity.
    // Non-down-ranking (unknown), so a missing binding pane never flips a live
    // seat non-green.
    if (!seat.tmux_pane) {
      return {
        ...base,
        verdict: "tmux_unavailable",
        evidenceSource: null,
        reason: "tmux_unavailable",
        evidence: { registeredPane: null, observedPid: null, observedCommand: null, matchedLayer: null },
      };
    }

    const pid = await this.tmux.getPanePid(seat.tmux_pane);
    if (pid === null) {
      // The registered pane no longer resolves. Distinguish "the whole tmux
      // session is gone" from "the pane within a live session is gone".
      const sessionAlive = liveSessions.has(seat.session_name);
      return {
        ...base,
        verdict: "pane_missing",
        evidenceSource: sessionAlive ? "pane_process" : "tmux_session",
        reason: sessionAlive ? "pane_pid_gone" : "session_missing",
        evidence: { registeredPane: seat.tmux_pane, observedPid: null, observedCommand: null, matchedLayer: null },
      };
    }

    const command = await this.tmux.getPaneCommand(seat.tmux_pane);
    const match = classifyPaneRuntimeMatch(command, seat.runtime);
    if (match === "mismatch") {
      return {
        ...base,
        verdict: "mismatch",
        evidenceSource: "pane_process",
        reason: "process_identity_mismatch",
        evidence: { registeredPane: seat.tmux_pane, observedPid: pid, observedCommand: command, matchedLayer: 1 },
      };
    }

    return {
      ...base,
      verdict: "verified",
      evidenceSource: "pane_process",
      reason: null,
      evidence: { registeredPane: seat.tmux_pane, observedPid: pid, observedCommand: command, matchedLayer: 1 },
    };
  }

  /** Start the scheduler. Idempotent — calling twice is a no-op. */
  start(intervalMs: number = DEFAULT_IDENTITY_POLL_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.reconcileAll();
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
