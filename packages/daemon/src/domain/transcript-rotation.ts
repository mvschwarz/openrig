// V1 pre-release CLI/daemon Item 1 — bounded-trail transcript rotation.
//
// Replaces the legacy `tmux pipe-pane` mechanism (infinite-growth file)
// with a periodic `tmux capture-pane -t <session> -p -S -<lines>` shellout
// that atomically overwrites the transcript file. File size stays bounded
// by trailing line count + line-byte ceiling, not by session duration.
//
// Tunables (env: OPENRIG_TRANSCRIPTS_LINES / OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS;
// allowlist keys transcripts.lines / transcripts.poll_interval_seconds):
//   - lines:           number of trailing lines to capture per tick (default 1000)
//   - pollIntervalMs:  millisecond cadence between ticks (default 2000)
//
// SC-29 EXCEPTION #4 declared in pre-release CLI/daemon ACK §5.

import * as fs from "node:fs";
import * as path from "node:path";
import type { TmuxAdapter } from "../adapters/tmux.js";
import { SettingsStore } from "./user-settings/settings-store.js";

export interface TranscriptRotationOptions {
  /** Trailing line count to capture each tick. */
  lines: number;
  /** Poll interval in milliseconds. */
  pollIntervalMs: number;
}

export const DEFAULT_TRANSCRIPT_LINES = 1000;
export const DEFAULT_TRANSCRIPT_POLL_INTERVAL_MS = 2000;
// Leave room below the default ingest-health stale window (10s) for timer
// spacing, activity hints and capture work on a busy host. Activity hints are
// advisory: reconciliation still reads the complete bounded trailing buffer.
export const MAX_IDLE_CAPTURE_INTERVAL_MS = 6000;
export const ACTIVITY_HINT_DEADLINE_MS = 1000;

/** A shared live resolver retains a usable policy during partial config writes.
 * Environment overrides keep their existing precedence over file settings. */
export function createTranscriptRotationOptionsResolver(store: SettingsStore, reportError?: (error: string | null) => void): () => TranscriptRotationOptions {
  let snapshot: { at: number; options: TranscriptRotationOptions } | undefined;
  return () => {
    if (snapshot && Date.now() - snapshot.at < 1000) return snapshot.options;
    let options = snapshot?.options ?? { lines: DEFAULT_TRANSCRIPT_LINES, pollIntervalMs: DEFAULT_TRANSCRIPT_POLL_INTERVAL_MS };
    try {
      options = {
        lines: store.resolveOne("transcripts.lines").value as number,
        pollIntervalMs: (store.resolveOne("transcripts.poll_interval_seconds").value as number) * 1000,
      };
      reportError?.(null);
    } catch {
      reportError?.("Configuration reload failed; capture is using the last usable settings.");
    }
    snapshot = { at: Date.now(), options };
    return options;
  };
}

let settingsReloadError: string | null = null;
let liveOptions = createTranscriptRotationOptionsResolver(new SettingsStore(), (error) => { settingsReloadError = error; });

/** Live environment > file > default settings; read at most once per second
 * across all production rotators in this daemon process. */
export function getTranscriptRotationOptionsFromEnv(): TranscriptRotationOptions {
  return liveOptions();
}

interface CaptureStats {
  captures: number; failures: number; bytes: number; durationMs: number;
  idle: boolean; intervalMs: number; lines: number;
}
const captureStats = new Map<string, CaptureStats>();
let activitySnapshots = new WeakMap<TmuxAdapter, { at: number; pending: boolean; result: Promise<Map<string, number> | null> }>();

async function activityHint(adapter: TmuxAdapter, session: string, cadence: number): Promise<number | undefined> {
  if (typeof adapter.readAllSessionWindowActivity !== "function") return undefined;
  let snapshot = activitySnapshots.get(adapter);
  if (!snapshot || (!snapshot.pending && Date.now() - snapshot.at >= Math.min(cadence, 1000))) {
    const next = { at: Date.now(), pending: true, result: Promise.resolve<Map<string, number> | null>(null) };
    // Hints are advisory. A stalled tmux metadata call must not block otherwise
    // functioning pane captures. Keep pending tied to the actual child, rather
    // than the deadline, so timeout fallback never starts an accumulating probe.
    const request = Promise.resolve().then(() => adapter.readAllSessionWindowActivity())
      .catch(() => null).finally(() => { next.pending = false; });
    next.result = new Promise((resolve) => {
      const deadline = setTimeout(() => resolve(null), ACTIVITY_HINT_DEADLINE_MS);
      deadline.unref?.();
      void request.then((result) => { clearTimeout(deadline); resolve(result); });
    });
    snapshot = next;
    activitySnapshots.set(adapter, snapshot);
  }
  return (await snapshot.result)?.get(session);
}

/** Process-local capture observations, never provider readiness or per-process CPU. */
export function getTranscriptCaptureStats() {
  const entries = [...captureStats.values()];
  return {
    rotatingSeats: entries.length, idleSeats: entries.filter((s) => s.idle).length,
    captures: entries.reduce((n, s) => n + s.captures, 0),
    failures: entries.reduce((n, s) => n + s.failures, 0),
    capturedBytes: entries.reduce((n, s) => n + s.bytes, 0),
    captureDurationMs: entries.reduce((n, s) => n + s.durationMs, 0),
    activeIntervalMs: entries.length ? entries.reduce((max, s) => Math.max(max, s.intervalMs), 0) : null,
    lines: entries.length ? entries.reduce((max, s) => Math.max(max, s.lines), 0) : null,
    maxIdleIntervalMs: entries.reduce((max, s) => Math.max(max, s.intervalMs), MAX_IDLE_CAPTURE_INTERVAL_MS),
    settingsReloadError,
    activityHintDeadlineMs: ACTIVITY_HINT_DEADLINE_MS,
  };
}

const activeTimers = new Map<string, NodeJS.Timeout>();
// Shared across replacing starts: a stopped capture can still own a child.
// ponytail: bound overlap per session, leaving normal non-overlapping cost unchanged.
const capturingSessions = new Set<string>();

// Liveness decoupled from the file mtime. A COMPLETED HEALTHY tick records a
// timestamp here — on the unchanged-content early return (the file already holds
// the current bytes) or after a successful atomic rename — NOT merely on a
// successful capture: a capture whose required persistence then fails must not
// advertise freshness over stale on-disk bytes. getIngestHealth reads THIS
// (with an mtime fallback). Keyed by sessionName (globally unique: {pod}-{member}@{rig}).
const lastCaptureAtBySession = new Map<string, number>();

// Per-start generation token. stop() and a replacing start() invalidate the
// session's entry, so an in-flight tick that resumes after its async capture
// cannot resurrect liveness (or write the file) for a session that has since
// been stopped or replaced.
let rotationGeneration = 0;
const activeGeneration = new Map<string, number>();

/** Last successful capture time (epoch ms) for a session, or undefined if no
 *  rotation has captured for it in this process. getIngestHealth reads this so
 *  ingest liveness is decoupled from the (write-suppressed) file mtime. */
export function getLastCaptureAt(sessionName: string): number | undefined {
  return lastCaptureAtBySession.get(sessionName);
}

/** Start a per-session capture-pane rotation timer. Idempotent: a
 *  second start for the same session replaces the first timer. The
 *  first tick fires immediately unless an old capture for this session is
 *  still pending; replacement then waits for a scheduled tick after it settles. */
export function startTranscriptRotation(
  tmuxAdapter: TmuxAdapter,
  sessionName: string,
  outputPath: string,
  opts: TranscriptRotationOptions,
  resolveOptions?: () => TranscriptRotationOptions,
): void {
  stopTranscriptRotation(sessionName);

  const myGeneration = ++rotationGeneration;
  activeGeneration.set(sessionName, myGeneration);
  // True only while THIS start is the current rotation for the session — false
  // once stop() or a replacing start() has run. Guards the async gap so a stale
  // in-flight tick performs no write and records no liveness.
  const isCurrent = (): boolean => activeGeneration.get(sessionName) === myGeneration;
  const stats: CaptureStats = { captures: 0, failures: 0, bytes: 0, durationMs: 0, idle: false, intervalMs: opts.pollIntervalMs, lines: opts.lines };
  captureStats.set(sessionName, stats);
  let nextCaptureAt = 0;
  let lastCaptureStartedAt = 0;
  let previousHint: number | undefined;
  let idleIntervalMs = opts.pollIntervalMs;

  const tick = async (): Promise<void> => {
    if (!isCurrent() || capturingSessions.has(sessionName)) return;
    const tickStartedAt = Date.now();
    capturingSessions.add(sessionName);
    let captureStartedAt: number | undefined;
    try {
      const currentOptions = resolveOptions?.() ?? opts;
      if (currentOptions.pollIntervalMs !== opts.pollIntervalMs || currentOptions.lines !== opts.lines) {
        opts = currentOptions;
        idleIntervalMs = opts.pollIntervalMs;
        nextCaptureAt = 0;
        stats.idle = false;
      }
      stats.intervalMs = opts.pollIntervalMs;
      stats.lines = opts.lines;
      const hint = typeof tmuxAdapter.readAllSessionWindowActivity === "function"
        ? await activityHint(tmuxAdapter, sessionName, opts.pollIntervalMs) : undefined;
      if (!isCurrent()) return;
      const activityChanged = hint !== undefined && hint !== previousHint;
      if (activityChanged) {
        idleIntervalMs = opts.pollIntervalMs;
        stats.idle = false;
        nextCaptureAt = Math.min(nextCaptureAt, lastCaptureStartedAt + opts.pollIntervalMs);
      }
      previousHint = hint;
      // Unknown hints never mean idle; keep the configured full-capture cadence.
      if (hint === undefined) {
        stats.idle = false;
        idleIntervalMs = opts.pollIntervalMs;
        nextCaptureAt = Math.min(nextCaptureAt, lastCaptureStartedAt + opts.pollIntervalMs);
      }
      if (Date.now() < nextCaptureAt) return;
      // Schedule from this tick, not its eventual completion: work inside a
      // fixed-step timer must not shift an active capture past the next tick.
      lastCaptureStartedAt = tickStartedAt;
      captureStartedAt = performance.now();
      stats.captures += 1;
      const content = await tmuxAdapter.capturePaneContent(sessionName, opts.lines);
      // Re-check AFTER the async capture: stop()/replacement may have run while we
      // awaited. A dead session (null) is deliberately not recorded either way,
      // so getIngestHealth falls back to a stale mtime for it.
      if (!isCurrent()) return;
      if (content === null) {
        stats.failures += 1;
        stats.idle = false;
        nextCaptureAt = tickStartedAt + opts.pollIntervalMs;
        return;
      }
      stats.bytes += Buffer.byteLength(content, "utf8");

      // Preserve SESSION BOUNDARY lines that the restore orchestrator
      // writes to the transcript file before launch. The capture-pane
      // overwrite would otherwise wipe them on the first tick. The
      // marker is the only structural header the transcript file is
      // expected to carry across rotations; everything else is
      // terminal-scrollback content from capture-pane.
      let header = "";
      let prevContent: string | null = null;
      try {
        if (fs.existsSync(outputPath)) {
          const prev = fs.readFileSync(outputPath, "utf8");
          prevContent = prev;
          // A pane may echo a boundary marker (for example while inspecting a
          // transcript). Retain each structural marker once so repeated captures
          // cannot promote the same scrollback line into an ever-growing header.
          const boundaryLines = [...new Set(prev
            .split("\n")
            .filter((line) => line.startsWith("--- SESSION BOUNDARY:")))];
          if (boundaryLines.length > 0) header = boundaryLines.join("\n") + "\n";
        }
      } catch {
        // Best-effort header read; missing file or read error means no header
        // (and no prevContent, so the guard below cannot suppress a real write).
      }

      // Unchanged-content guard: if the transcript file already holds exactly
      // these bytes, skip the temp-write + rename. The 2s-cadence tick otherwise
      // rewrote every transcript file unconditionally, which macOS amplifies
      // through fseventsd into a host CPU/RSS storm across hundreds of seats.
      // `prevContent` is the SAME read used for boundary extraction — no extra I/O.
      const payload = header + content;
      if (prevContent !== null && prevContent === payload) {
        // The file already holds exactly these bytes (persisted + current), so
        // this IS a completed healthy tick — record liveness, skip the rewrite.
        lastCaptureAtBySession.set(sessionName, Date.now());
        stats.idle = hint !== undefined && !activityChanged;
        idleIntervalMs = stats.idle ? Math.min(Math.max(opts.pollIntervalMs, MAX_IDLE_CAPTURE_INTERVAL_MS), idleIntervalMs * 2) : opts.pollIntervalMs;
        nextCaptureAt = tickStartedAt + idleIntervalMs;
        return;
      }

      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      const tmpPath = `${outputPath}.tmp.${process.pid}`;
      fs.writeFileSync(tmpPath, payload);
      fs.renameSync(tmpPath, outputPath);
      // Persistence succeeded — only NOW is the tick healthy, so record liveness.
      // A throw above jumps to the catch and never reaches here, so a failed
      // required write leaves liveness un-advanced and getIngestHealth reads the
      // (correctly stale) file mtime.
      lastCaptureAtBySession.set(sessionName, Date.now());
      stats.idle = false;
      idleIntervalMs = opts.pollIntervalMs;
      nextCaptureAt = tickStartedAt + idleIntervalMs;
    } catch {
      stats.failures += 1;
      stats.idle = false;
      nextCaptureAt = tickStartedAt + opts.pollIntervalMs;
      // Best-effort capture: target session may have died, output path
      // may be unwritable, etc. The next tick retries; failure here
      // does not bubble up to the daemon's launch / lifecycle paths.
    } finally {
      if (captureStartedAt !== undefined) stats.durationMs += performance.now() - captureStartedAt;
      capturingSessions.delete(sessionName);
    }
  };

  void tick();
  const timer = setInterval(tick, resolveOptions ? Math.min(opts.pollIntervalMs, 1000) : opts.pollIntervalMs);
  // Don't keep the daemon process alive solely on transcript timers.
  if (typeof timer.unref === "function") timer.unref();
  activeTimers.set(sessionName, timer);
}

/** Clear the rotation timer for a session. Safe to call when no timer
 *  is registered. */
export function stopTranscriptRotation(sessionName: string): void {
  const timer = activeTimers.get(sessionName);
  if (timer) {
    clearInterval(timer);
    activeTimers.delete(sessionName);
  }
  // Drop the liveness record: once rotation stops, capture really has stopped,
  // so getIngestHealth should fall back to mtime (which correctly reads stale).
  lastCaptureAtBySession.delete(sessionName);
  // Invalidate the generation so any in-flight tick from this start bails out
  // after its async capture instead of resurrecting liveness / writing.
  activeGeneration.delete(sessionName);
  captureStats.delete(sessionName);
}

/** Test-only: count of active rotators. Production code should not
 *  depend on this. */
export function getActiveRotationCount(): number {
  return activeTimers.size;
}

/** Test-only: clear all active rotators. Production code should not
 *  call this; use stopTranscriptRotation for individual sessions. */
export function clearAllTranscriptRotationsForTest(): void {
  for (const timer of activeTimers.values()) clearInterval(timer);
  activeTimers.clear();
  lastCaptureAtBySession.clear();
  activeGeneration.clear();
  captureStats.clear();
  settingsReloadError = null;
  liveOptions = createTranscriptRotationOptionsResolver(new SettingsStore(), (error) => { settingsReloadError = error; });
  activitySnapshots = new WeakMap();
}
