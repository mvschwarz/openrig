import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TmuxResult, TmuxCursorPosition } from "../adapters/tmux.js";

// OPR.0.4.0.38 - real-terminal session broker.
//
// The product invariant from the founder is: NO LIVE TERMINAL LIES. A live
// terminal surface must show the true session state and report honestly when a
// session dies - never a silently stale "live" pane.
//
// Before this slice, every WebSocket connection opened its OWN tmux pipe-pane
// for the same session (the per-connection bug): a second viewer of one seat
// fought the first for output. The broker fixes that: ONE tmux pipe per
// session, MANY subscribers, output fanned out to all, each subscriber seeded
// with a cursor-safe snapshot of the current screen on attach, fixed geometry
// (no client-driven resize), honest session-death reporting to ALL subscribers,
// and full cleanup when the last subscriber leaves.

const PIPE_PANE_POLL_MS = 50;
const MAX_OUTPUT_BUFFER = 64 * 1024;
const DEFAULT_LIVENESS_MS = 2000;

/**
 * Bounded size of the broker-owned recent-output history ring (AC-5 / FR-4).
 * Mirrors the 64KB per-read tail sizing: a session-level window of recent
 * output, replayed to late subscribers so they share the scrollback the
 * earlier subscribers have - NOT per-xterm local. Bounded so a long-lived
 * session never accumulates unbounded memory.
 */
const MAX_HISTORY_BYTES = 64 * 1024;

/**
 * Canonical fixed terminal geometry (FR-7). 120 cols is the styling slice's
 * measured live-plate width (~880px at fontSize 12, TerminalPreviewPopover).
 * 40 rows is a comfortable agent-TUI working area; subscribers fit/scroll/pan
 * their viewport but never resize the pane - so multiple viewers cannot shrink
 * the session to the smallest one.
 */
export const CANONICAL_COLS = 120;
export const CANONICAL_ROWS = 40;

/** A connected viewer of one broker. The route adapts a WebSocket to this. */
export interface TerminalSubscriber {
  send(data: string): void;
  close(code: number, reason: string): void;
}

/**
 * The subset of TmuxAdapter the broker drives. Declared structurally so the
 * broker is unit-testable with a plain mock; the real TmuxAdapter satisfies it.
 */
export interface BrokerTmux {
  hasSession(name: string): Promise<boolean>;
  setWindowOption(name: string, option: string, value: string): Promise<TmuxResult>;
  resizeWindow(name: string, cols: number, rows: number): Promise<TmuxResult>;
  startPipePane(name: string, outputPath: string): Promise<TmuxResult>;
  stopPipePane(name: string): Promise<TmuxResult>;
  sendKeys(name: string, keys: string[]): Promise<TmuxResult>;
  sendText(name: string, text: string): Promise<TmuxResult>;
  capturePaneScreen(name: string): Promise<string | null>;
  getPaneCursorPosition(name: string): Promise<TmuxCursorPosition | null>;
}

export interface BrokerOptions {
  /** File-tail poll interval (ms). Default 50. */
  pollMs?: number;
  /** Session-liveness probe interval (ms). Default 2000. */
  livenessMs?: number;
  /** Canonical pane width. Default 120. */
  cols?: number;
  /** Canonical pane height. Default 40. */
  rows?: number;
  /** Bounded size of the recent-output history ring in bytes. Default 64KB. */
  maxHistoryBytes?: number;
  /** Called when the broker has no remaining subscribers (or open failed). */
  onEmpty?: (sessionName: string) => void;
}

/** Client-driven input. There is deliberately NO resize message (FR-7). */
export type TerminalInputMessage =
  | { type: "keys"; keys: string[] }
  | { type: "text"; text: string };

/** ANSI 1-based absolute cursor move (terminal coords are 1-based; tmux is 0-based). */
export function cursorPositionEscape(x: number, y: number): string {
  return `\x1b[${y + 1};${x + 1}H`;
}

/**
 * Build the cursor-safe seed escape sequence for a captured screen. Each row is
 * painted with an ABSOLUTE cursor move so the client renders the screen at the
 * exact same rows tmux has it - never a relative append that drifts as content
 * scrolls. Normalizes CRLF, drops one trailing print newline, and (when a pane
 * height is known and the capture is taller) keeps only the last `height` rows.
 * Lifted from the FR-4 seed work.
 */
export function screenSnapshotEscape(
  snapshot: string,
  cursor: { x: number; y: number; height?: number } | null,
): string {
  const normalized = snapshot.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const withoutTrailingPrintNewline = normalized.endsWith("\n")
    ? normalized.slice(0, -1)
    : normalized;
  const rows = withoutTrailingPrintNewline.split("\n");
  const visibleRows = cursor?.height && rows.length > cursor.height
    ? rows.slice(rows.length - cursor.height)
    : rows;

  const paintedRows = visibleRows
    .map((row, index) => `\x1b[${index + 1};1H${row}`)
    .join("");

  return `\x1b[2J${paintedRows}${cursor ? cursorPositionEscape(cursor.x, cursor.y) : "\x1b[H"}`;
}

/**
 * One broker per live tmux session. Owns a single pipe-pane and fans its output
 * out to every attached subscriber.
 */
export class TerminalSessionBroker {
  readonly sessionName: string;
  private readonly tmux: BrokerTmux;
  private readonly pollMs: number;
  private readonly livenessMs: number;
  private readonly cols: number;
  private readonly rows: number;
  private readonly maxHistoryBytes: number;
  private readonly onEmpty?: (sessionName: string) => void;

  private readonly subscribers = new Set<TerminalSubscriber>();
  // Broker-owned recent-output ring (AC-5): raw fanned-out bytes, bounded,
  // replayed to late subscribers so their scrollback matches the earlier ones.
  private history: string[] = [];
  private historyBytes = 0;
  private outputPath: string | null = null;
  private pipeActive = false;
  private tailInterval: ReturnType<typeof setInterval> | null = null;
  private livenessInterval: ReturnType<typeof setInterval> | null = null;
  private lastSize = 0;
  private inputQueue: Promise<void> = Promise.resolve();
  // Singleflight the pipe-open as a shared promise so EVERY concurrent attach
  // awaits the SAME open result before it seeds/adds (a bare boolean would let a
  // later attach add itself before the open result is known, then never be
  // closed if the open fails). Null until the first attach starts the open.
  private openPromise: Promise<{ ok: true } | { ok: false; code: number; reason: string }> | null = null;
  private tailStarted = false;
  private torndown = false;

  constructor(sessionName: string, tmux: BrokerTmux, opts: BrokerOptions = {}) {
    this.sessionName = sessionName;
    this.tmux = tmux;
    this.pollMs = opts.pollMs ?? PIPE_PANE_POLL_MS;
    this.livenessMs = opts.livenessMs ?? DEFAULT_LIVENESS_MS;
    this.cols = opts.cols ?? CANONICAL_COLS;
    this.rows = opts.rows ?? CANONICAL_ROWS;
    this.maxHistoryBytes = opts.maxHistoryBytes ?? MAX_HISTORY_BYTES;
    this.onEmpty = opts.onEmpty;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  /** Current size of the broker-owned history ring in bytes (bounded). */
  get historyByteLength(): number {
    return this.historyBytes;
  }

  /** The session-scoped pipe output file (one per session). Null until open. */
  get pipeOutputPath(): string | null {
    return this.outputPath;
  }

  /**
   * Attach a subscriber. The FIRST subscriber stands up the single pipe-pane
   * (fixed geometry, one outputPath, tail + liveness). Every subscriber - first
   * or later - is seeded with the current screen BEFORE it joins the fanout, so
   * it sees coherent state immediately and does not depend on a resize message.
   */
  async attach(sub: TerminalSubscriber): Promise<void> {
    if (this.torndown) {
      sub.close(1011, "terminal broker unavailable");
      return;
    }
    // Start the single pipe-open exactly once; every concurrent attach awaits
    // the SAME result before it seeds/adds.
    if (!this.openPromise) {
      this.openPromise = this.openPipe();
    }
    const open = await this.openPromise;

    // The broker may have been torn down while we awaited - a co-waiter's open
    // failed, or the session died. Close this subscriber HONESTLY; never leave a
    // live-looking subscriber on a dead broker (the no-live-terminal-lies rule).
    if (this.torndown) {
      if (open.ok) sub.close(1011, "terminal broker unavailable");
      else sub.close(open.code, open.reason);
      return;
    }

    if (!open.ok) {
      // Open failed: tear the broker down ONCE, then close THIS subscriber with
      // the shared honest 1008/1011 reason. Every co-waiter takes the torndown
      // branch above and is closed with the same reason - none is left live.
      this.torndown = true;
      this.teardownResources();
      this.onEmpty?.(this.sessionName);
      sub.close(open.code, open.reason);
      return;
    }

    // Open succeeded: seed this subscriber (ring replay + current screen) BEFORE
    // it joins the fanout, then start the single tail + liveness exactly once.
    await this.seed(sub);
    this.subscribers.add(sub);
    if (!this.tailStarted) {
      this.tailStarted = true;
      this.startTail();
      this.startLiveness();
    }
  }

  /** Forward client input to tmux, serialized so rapid input keeps order (FR-3). */
  async input(msg: TerminalInputMessage): Promise<void> {
    if (this.torndown) return;
    await this.enqueueInput(async () => {
      if (msg.type === "keys") {
        await this.tmux.sendKeys(this.sessionName, msg.keys);
      } else if (msg.type === "text") {
        await this.tmux.sendText(this.sessionName, msg.text);
      }
    });
  }

  /**
   * Detach a subscriber. The broker SURVIVES while other subscribers remain
   * (FR-6); the LAST detach tears the pipe down and deletes the temp file.
   */
  detach(sub: TerminalSubscriber): void {
    if (!this.subscribers.delete(sub)) return;
    if (this.subscribers.size === 0) {
      void this.teardown();
    }
  }

  /** Force teardown (used by the registry/route on shutdown and by tests). */
  dispose(): void {
    if (this.torndown) return;
    this.torndown = true;
    this.subscribers.clear();
    if (this.pipeActive) {
      this.pipeActive = false;
      void this.tmux.stopPipePane(this.sessionName).catch(() => {});
    }
    this.teardownResources();
    this.onEmpty?.(this.sessionName);
  }

  private async openPipe(): Promise<{ ok: true } | { ok: false; code: number; reason: string }> {
    // Close codes mirror the pre-broker route so the UI keeps its semantics:
    // 1008 (policy) = the session genuinely does not exist; 1011 (server error)
    // = the pipe/temp-file machinery failed. Both are honest; neither is a lie.
    const alive = await this.tmux.hasSession(this.sessionName);
    if (!alive) return { ok: false, code: 1008, reason: `session not found: ${this.sessionName}` };

    // FR-7 fixed geometry: window-size manual so tmux will NOT auto-shrink the
    // window to the smallest attached client; then the canonical width/height
    // ONCE. Deliberately NOT aggressive-resize, which does the opposite.
    await this.tmux.setWindowOption(this.sessionName, "window-size", "manual").catch(() => {});
    await this.tmux.resizeWindow(this.sessionName, this.cols, this.rows).catch(() => {});

    const outputPath = path.join(
      os.tmpdir(),
      `openrig-term-${this.sessionName.replace(/[^a-zA-Z0-9@-]/g, "_")}-${Date.now()}.log`,
    );
    try {
      fs.writeFileSync(outputPath, "", "utf-8");
    } catch (err) {
      return { ok: false, code: 1011, reason: `pipe output file failed: ${String(err)}` };
    }
    this.outputPath = outputPath;

    const pipe = await this.tmux.startPipePane(this.sessionName, outputPath);
    if (!pipe.ok) {
      return { ok: false, code: 1011, reason: `pipe-pane failed: ${pipe.message}` };
    }
    this.pipeActive = true;

    // Nudge a redraw so the freshly attached pipe captures current pane content
    // (parity with the prior single-connection behavior; FR-9 no regression).
    await this.tmux.sendKeys(this.sessionName, ["", ""]).catch(() => {});
    return { ok: true };
  }

  private async seed(sub: TerminalSubscriber): Promise<void> {
    // AC-5: replay the broker-owned recent-output ring FIRST so the late
    // subscriber's xterm builds the same scrollback the earlier subscribers
    // have (raw bytes write into xterm's scrollback). The visible-screen seed
    // then paints a cursor-correct current screen on top - screenSnapshotEscape
    // opens with ESC[2J, which clears only the VISIBLE viewport, NOT the
    // scrollback, so the recent scrolled-off output is preserved above. The
    // first subscriber's ring is empty, so it gets only the visible seed.
    if (this.historyBytes > 0) {
      try { sub.send(this.history.join("")); } catch { /* dead subscriber */ }
    }
    // Best-effort: a failed capture (or an adapter without the seed methods)
    // must never break the attach - the tail still streams live output.
    let snapshot: string | null = null;
    let cursor: TmuxCursorPosition | null = null;
    try {
      snapshot = await this.tmux.capturePaneScreen(this.sessionName);
    } catch {
      snapshot = null;
    }
    try {
      cursor = await this.tmux.getPaneCursorPosition(this.sessionName);
    } catch {
      cursor = null;
    }
    if (snapshot != null) {
      try {
        sub.send(screenSnapshotEscape(snapshot, cursor));
      } catch {
        // a dead subscriber is harmless here; the route handles its own close
      }
    }
  }

  private startTail(): void {
    if (this.tailInterval) return;
    this.tailInterval = setInterval(() => {
      const p = this.outputPath;
      if (!p) return;
      try {
        const stat = fs.statSync(p);
        if (stat.size > this.lastSize) {
          const fd = fs.openSync(p, "r");
          const buf = Buffer.alloc(Math.min(stat.size - this.lastSize, MAX_OUTPUT_BUFFER));
          fs.readSync(fd, buf, 0, buf.length, this.lastSize);
          fs.closeSync(fd);
          this.lastSize += buf.length;
          this.fanout(buf.toString("utf-8"));
        }
      } catch {
        // transient stat/read failures are tolerated; liveness owns death
      }
    }, this.pollMs);
  }

  private fanout(data: string): void {
    // Feed the broker-owned ring from the SAME single tail that fans out, so
    // late subscribers can replay the recent window before going live (AC-5).
    this.appendHistory(data);
    // One subscriber whose send throws must not break delivery to the others,
    // and it should be detached cleanly (a throwing send means a dead socket).
    let dead: TerminalSubscriber[] | null = null;
    for (const sub of this.subscribers) {
      try {
        sub.send(data);
      } catch {
        (dead ??= []).push(sub);
      }
    }
    // Detach AFTER the loop so we never mutate the set mid-iteration.
    if (dead) {
      for (const sub of dead) this.detach(sub);
    }
  }

  /** Append to the bounded ring, dropping oldest chunks past the byte cap. */
  private appendHistory(data: string): void {
    if (!data) return;
    this.history.push(data);
    this.historyBytes += Buffer.byteLength(data, "utf-8");
    // Keep at least the most recent chunk so a single large burst is never
    // fully discarded; otherwise drop oldest until within the cap.
    while (this.historyBytes > this.maxHistoryBytes && this.history.length > 1) {
      const dropped = this.history.shift()!;
      this.historyBytes -= Buffer.byteLength(dropped, "utf-8");
    }
  }

  private startLiveness(): void {
    if (this.livenessInterval) return;
    this.livenessInterval = setInterval(() => {
      this.tmux
        .hasSession(this.sessionName)
        .then((alive) => {
          if (!alive) this.handleSessionDeath();
        })
        .catch(() => {
          this.handleSessionDeath();
        });
    }, this.livenessMs);
  }

  /** FR-5: a dead session closes ALL subscribers honestly - never silent stale-live. */
  private handleSessionDeath(): void {
    if (this.torndown) return;
    this.torndown = true;
    const subs = [...this.subscribers];
    this.subscribers.clear();
    if (this.pipeActive) {
      this.pipeActive = false;
      void this.tmux.stopPipePane(this.sessionName).catch(() => {});
    }
    this.teardownResources();
    for (const sub of subs) {
      try {
        sub.close(1001, "tmux session terminated");
      } catch {
        // already-closed subscriber is fine
      }
    }
    this.onEmpty?.(this.sessionName);
  }

  private async teardown(): Promise<void> {
    if (this.torndown) return;
    this.torndown = true;
    if (this.pipeActive) {
      this.pipeActive = false;
      await this.tmux.stopPipePane(this.sessionName).catch(() => {});
    }
    this.teardownResources();
    this.onEmpty?.(this.sessionName);
  }

  private teardownResources(): void {
    if (this.tailInterval) {
      clearInterval(this.tailInterval);
      this.tailInterval = null;
    }
    if (this.livenessInterval) {
      clearInterval(this.livenessInterval);
      this.livenessInterval = null;
    }
    if (this.outputPath) {
      try {
        fs.unlinkSync(this.outputPath);
      } catch {
        // temp file may already be gone
      }
      this.outputPath = null;
    }
    this.lastSize = 0;
    // Clear the history ring so a torn-down broker leaks no retained output.
    this.history = [];
    this.historyBytes = 0;
  }

  private enqueueInput(op: () => Promise<void>): Promise<void> {
    const run = this.inputQueue.then(op, op);
    this.inputQueue = run.catch(() => {});
    return run;
  }
}

/**
 * Daemon-owned registry of brokers keyed by canonical session name. Create the
 * broker on the first subscriber for a session; reuse it for later subscribers
 * (so only one pipe-pane exists per session); evict it when it empties.
 */
export class TerminalBrokerRegistry {
  private readonly brokers = new Map<string, TerminalSessionBroker>();

  constructor(private readonly tmux: BrokerTmux, private readonly opts: BrokerOptions = {}) {}

  get size(): number {
    return this.brokers.size;
  }

  get(sessionName: string): TerminalSessionBroker | undefined {
    return this.brokers.get(sessionName);
  }

  /** Get-or-create the broker for a session, attach the subscriber, return the broker. */
  async attach(sessionName: string, sub: TerminalSubscriber): Promise<TerminalSessionBroker> {
    let broker = this.brokers.get(sessionName);
    if (!broker) {
      broker = new TerminalSessionBroker(sessionName, this.tmux, {
        ...this.opts,
        onEmpty: (name) => {
          this.brokers.delete(name);
          this.opts.onEmpty?.(name);
        },
      });
      this.brokers.set(sessionName, broker);
    }
    await broker.attach(sub);
    return broker;
  }
}
