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
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { CAPTURE_BATCH, type TmuxAdapter } from "../adapters/tmux.js";
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
export const DEFAULT_TRANSCRIPT_STALE_AFTER_MS = 10_000;
export const CAPTURE_RESULT_DEADLINE_MS = 5000;
export const ACTIVITY_HINT_DEADLINE_MS = 1000;
// A pane with no output and no pane change since its last capture is still captured in full this often. It bounds
// what the pane key cannot see (another client editing history lines) and how long a failing capture goes unnoticed.
export const IDLE_FULL_CAPTURE_MS = 10_000;

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
  idle: boolean; intervalMs: number; lines: number; idleCeilingMs: number;
}
const captureStats = new Map<string, CaptureStats>();
type WindowHint = { activity: number; size?: string };
let activitySnapshots = new WeakMap<TmuxAdapter, { at: number; pending: boolean; result: Promise<Map<string, WindowHint> | null> }>();

/** One shared window read per cadence: with readAllSessionWindows the size comes along at no extra call. */
function readWindowHints(adapter: TmuxAdapter): Promise<Map<string, WindowHint> | null> {
  if (typeof adapter.readAllSessionWindows === "function") return adapter.readAllSessionWindows();
  return adapter.readAllSessionWindowActivity().then((m) => m && new Map([...m].map(([s, activity]) => [s, { activity }])));
}

/** The window listing every reader of this adapter shares: one list-windows in flight at a time, reused while under a
 *  cadence old. `fresh` asks for a listing that starts now; while an older one is still running it gets null instead.
 *  A reader past the 1 s deadline gets null and captures; the pending listing stays owned until its child exits. */
export function windowSnapshot(adapter: TmuxAdapter, cadence: number, fresh = false): Promise<Map<string, WindowHint> | null> {
  let snapshot = activitySnapshots.get(adapter);
  if (snapshot?.pending && fresh) return Promise.resolve(null);
  if (!snapshot || (!snapshot.pending && (fresh || Date.now() - snapshot.at >= Math.min(cadence, 1000)))) {
    const next = { at: Date.now(), pending: true, result: Promise.resolve<Map<string, WindowHint> | null>(null) };
    // Hints are advisory. A stalled tmux metadata call must not block otherwise
    // functioning pane captures. Keep pending tied to the actual child, rather
    // than the deadline, so timeout fallback never starts an accumulating probe.
    const request = Promise.resolve().then(() => readWindowHints(adapter))
      .catch(() => null).finally(() => { next.pending = false; });
    next.result = new Promise((resolve) => {
      const deadline = setTimeout(() => resolve(null), ACTIVITY_HINT_DEADLINE_MS);
      deadline.unref?.();
      void request.then((result) => { clearTimeout(deadline); resolve(result); });
    });
    snapshot = next;
    activitySnapshots.set(adapter, snapshot);
  }
  return snapshot.result;
}

async function activityHint(adapter: TmuxAdapter, session: string, cadence: number): Promise<WindowHint | undefined> {
  if (typeof adapter.readAllSessionWindowActivity !== "function") return undefined;
  return (await windowSnapshot(adapter, cadence))?.get(session);
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
    maxIdleIntervalMs: entries.length ? entries.reduce((max, s) => Math.max(max, s.idleCeilingMs), 0) : null,
    settingsReloadError,
    activityHintDeadlineMs: ACTIVITY_HINT_DEADLINE_MS,
    captureResultDeadlineMs: CAPTURE_RESULT_DEADLINE_MS,
  };
}

// Sessions on one timer step tick together, so the captures due in a tick can share one batched call (#161).
const tickers = new Map<number, { timer: NodeJS.Timeout; ticks: Map<string, () => void> }>();
const activeSteps = new Map<string, number>();

interface CaptureRequest { sessionName: string; isCurrent: () => boolean; resolve: (content: string | null) => void }

// Sessions a batch's listing lacked: a seat that exited on its own keeps rotating until it is cleaned, relaunched or
// torn down (a stopped or removed seat stops at once, see wireTranscriptCaptureStops). They read per target,
// one fork that fails alone, instead of failing their chunk's chain every round. One that captures again rejoins.
let unlistedSessions = new Set<string>();
let pendingCaptures = new Map<TmuxAdapter, Map<number, CaptureRequest[]>>();

/** Queue a capture until the microtasks queued now have run. Ticks that share one timer and one activity-hint promise
 *  reach this point in the same microtask round, so their captures share one batch; a later one gets its own. */
function captureSoon(adapter: TmuxAdapter, sessionName: string, lines: number, isCurrent: () => boolean): Promise<string | null> {
  // The batch lists sessions by name, so pane, window and `session:window` targets read per target.
  if (typeof adapter.capturePanesContent !== "function" || /^[%@$]\d+$/.test(sessionName) || sessionName.includes(":")) {
    return Promise.resolve().then(() => adapter.capturePaneContent(sessionName, lines));
  }
  if (unlistedSessions.has(sessionName)) {
    return Promise.resolve().then(() => adapter.capturePaneContent(sessionName, lines)).then((content) => {
      if (content !== null) unlistedSessions.delete(sessionName);
      return content;
    });
  }
  return new Promise((resolve) => {
    if (pendingCaptures.size === 0) queueMicrotask(flushCaptures);
    let byLines = pendingCaptures.get(adapter);
    if (!byLines) pendingCaptures.set(adapter, byLines = new Map());
    let requests = byLines.get(lines);
    if (!requests) byLines.set(lines, requests = []);
    requests.push({ sessionName, isCurrent, resolve });
  });
}

function flushCaptures(): void {
  const batches = pendingCaptures;
  pendingCaptures = new Map();
  for (const [adapter, byLines] of batches) {
    for (const [lines, requests] of byLines) {
      // One batch per chunk, so a stalled chain holds only its own sessions.
      for (let i = 0; i < requests.length; i += CAPTURE_BATCH) void captureBatch(adapter, lines, requests.slice(i, i + CAPTURE_BATCH));
    }
  }
}

/** One chained call, with a listing beside it. A session the batch left out reads per target. */
async function captureBatch(adapter: TmuxAdapter, lines: number, requests: CaptureRequest[]): Promise<void> {
  const perTarget = (r: CaptureRequest) => Promise.resolve().then(() => adapter.capturePaneContent(r.sessionName, lines)).then(r.resolve, () => r.resolve(null));
  if (requests.length === 1) return void perTarget(requests[0]!);
  const panes = await Promise.resolve().then(() => adapter.capturePanesContent(requests.map((r) => r.sessionName), lines)).catch(() => null);
  for (const r of requests) {
    const pane = panes?.get(r.sessionName);
    if (pane) {
      // A stopped or replaced start must not mark the name for its successor.
      if (pane.missing && r.isCurrent()) unlistedSessions.add(r.sessionName);
      r.resolve(pane.text);
      // Each session writes its transcript as it resumes. Yielding to the loop between them keeps a chunk's writes
      // out of one task; a burst of immediates queued at once would still run in one check phase.
      await yieldToLoop();
    }
    // No listing means tmux is unreachable: each session records a failed capture without a fork each.
    else if (!panes) r.resolve(null);
    else void perTarget(r);
  }
}

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
// When a skipped tick last found the pane unchanged since its last capture. It keeps ingest live between captures;
// the capture time stays the last real capture.
const lastCheckedAtBySession = new Map<string, number>();

// Per-start generation token. stop() and a replacing start() invalidate the
// session's entry, so an in-flight tick that resumes after its async capture
// cannot resurrect liveness (or write the file) for a session that has since
// been stopped or replaced.
let rotationGeneration = 0;
const activeGeneration = new Map<string, number>();

/** Last successful capture time (epoch ms) for a session, or undefined if no
 *  rotation has captured for it in this process. getIngestHealth reads this so
 *  ingest liveness is decoupled from the (write-suppressed) file mtime. */
/** The file's size and mtime, or "" when it is missing or unreadable. */
function fileStamp(filePath: string): string {
  try { const st = fs.statSync(filePath); return `${st.size}:${st.mtimeMs}`; } catch { return ""; }
}

export function getLastCaptureAt(sessionName: string): number | undefined {
  return lastCaptureAtBySession.get(sessionName);
}

export function getLastCheckedAt(sessionName: string): number | undefined {
  return lastCheckedAtBySession.get(sessionName);
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
  const timerStepMs = resolveOptions ? Math.min(opts.pollIntervalMs, 1000) : opts.pollIntervalMs;
  // Reserve the worst-case hint, capture result and timer spacing in the
  // default freshness window. Longer configured cadences remain explicit.
  const idleCeiling = () => Math.max(opts.pollIntervalMs, Math.min(MAX_IDLE_CAPTURE_INTERVAL_MS,
    DEFAULT_TRANSCRIPT_STALE_AFTER_MS - ACTIVITY_HINT_DEADLINE_MS - CAPTURE_RESULT_DEADLINE_MS - timerStepMs));
  const stats: CaptureStats = { captures: 0, failures: 0, bytes: 0, durationMs: 0, idle: false, intervalMs: opts.pollIntervalMs, lines: opts.lines, idleCeilingMs: idleCeiling() };
  captureStats.set(sessionName, stats);
  let nextCaptureAt = 0;
  let lastCaptureStartedAt = 0;
  let previousHint: number | undefined;
  let previousSize: string | undefined;
  let idleIntervalMs = opts.pollIntervalMs;
  // window_activity (epoch seconds) at the start of the last healthy capture, and that capture's start second.
  let capturedHint: number | undefined;
  let capturedSize: string | undefined;
  let capturedStartSec = 0;
  let persistedStamp = ""; // the transcript's size and mtime after the last healthy capture
  let lastFullCaptureAt = 0;

  const tick = async (): Promise<void> => {
    if (!isCurrent() || capturingSessions.has(sessionName)) return;
    const tickStartedAt = Date.now();
    capturingSessions.add(sessionName);
    let captureStartedAt: number | undefined;
    let captureStillRunning = false;
    let captureTimedOut = false;
    let captureDeadline: NodeJS.Timeout | undefined;
    try {
      const currentOptions = resolveOptions?.() ?? opts;
      if (currentOptions.pollIntervalMs !== opts.pollIntervalMs || currentOptions.lines !== opts.lines) {
        opts = currentOptions;
        idleIntervalMs = opts.pollIntervalMs;
        nextCaptureAt = 0;
        stats.idle = false;
        capturedHint = undefined;
      }
      stats.intervalMs = opts.pollIntervalMs;
      stats.lines = opts.lines;
      stats.idleCeilingMs = idleCeiling();
      const window = typeof tmuxAdapter.readAllSessionWindowActivity === "function"
        ? await activityHint(tmuxAdapter, sessionName, opts.pollIntervalMs) : undefined;
      const hint = window?.activity;
      if (!isCurrent()) return;
      // A pane change that is not output (respawn, pane switch, zoom, clear-history) moves the window key instead.
      const activityChanged = hint !== undefined && (hint !== previousHint || window?.size !== previousSize);
      if (activityChanged) {
        idleIntervalMs = opts.pollIntervalMs;
        stats.idle = false;
        nextCaptureAt = Math.min(nextCaptureAt, lastCaptureStartedAt + opts.pollIntervalMs);
      }
      previousHint = hint;
      previousSize = window?.size;
      // A transcript deleted or truncated behind rotation's back is rewritten at once.
      const filePersisted = persistedStamp === "" || fileStamp(outputPath) === persistedStamp;
      if (!filePersisted) nextCaptureAt = 0;
      // Unknown hints never mean idle; keep the configured full-capture cadence.
      if (hint === undefined) {
        stats.idle = false;
        idleIntervalMs = opts.pollIntervalMs;
        nextCaptureAt = Math.min(nextCaptureAt, lastCaptureStartedAt + opts.pollIntervalMs);
      }
      // Due at the nearest shared tick: a session started between ticks keeps its cadence instead of slipping a step.
      if (Date.now() + timerStepMs / 2 < nextCaptureAt) return;
      // tmux bumps window_activity on every pane write. A hint older than the last capture's start second, and unchanged
      // since, means the transcript already holds the pane's bytes: the tick skips the capture and records no capture time.
      if (hint !== undefined && hint === capturedHint && window?.size === capturedSize && hint < capturedStartSec
        && tickStartedAt - lastFullCaptureAt < IDLE_FULL_CAPTURE_MS && persistedStamp !== "" && filePersisted) {
        lastCaptureStartedAt = tickStartedAt;
        lastCheckedAtBySession.set(sessionName, Date.now());
        stats.idle = true;
        idleIntervalMs = Math.min(idleCeiling(), idleIntervalMs * 2);
        nextCaptureAt = Date.now() + idleIntervalMs;
        return;
      }
      // Schedule from this tick, not its eventual completion: work inside a
      // fixed-step timer must not shift an active capture past the next tick.
      lastCaptureStartedAt = tickStartedAt;
      const startHint = hint;
      const startSize = window?.size;
      capturedHint = undefined;
      captureStartedAt = performance.now();
      stats.captures += 1;
      captureStillRunning = true;
      const request = captureSoon(tmuxAdapter, sessionName, opts.lines, isCurrent)
        .finally(() => {
          captureStillRunning = false;
          // A result deadline never releases ownership of an unfinished child.
          if (captureTimedOut) capturingSessions.delete(sessionName);
        });
      const content = await Promise.race([
        request,
        new Promise<null>((resolve) => {
          captureDeadline = setTimeout(() => { captureTimedOut = true; resolve(null); }, CAPTURE_RESULT_DEADLINE_MS);
          captureDeadline.unref?.();
        }),
      ]);
      clearTimeout(captureDeadline);
      // Re-check AFTER the async capture: stop()/replacement may have run while we
      // awaited. A dead session (null) is deliberately not recorded either way,
      // so getIngestHealth falls back to a stale mtime for it.
      if (!isCurrent()) return;
      if (content === null) {
        lastCheckedAtBySession.delete(sessionName);
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
        capturedHint = startHint; capturedSize = startSize; capturedStartSec = Math.floor(tickStartedAt / 1000); lastFullCaptureAt = tickStartedAt;
        persistedStamp = fileStamp(outputPath);
        stats.idle = hint !== undefined && !activityChanged;
        idleIntervalMs = stats.idle ? Math.min(idleCeiling(), idleIntervalMs * 2) : opts.pollIntervalMs;
        // Idle work starts after the last healthy completion; the derived
        // ceiling reserves enough time for the following bounded capture.
        nextCaptureAt = (stats.idle ? Date.now() : tickStartedAt) + idleIntervalMs;
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
      capturedHint = startHint; capturedSize = startSize; capturedStartSec = Math.floor(tickStartedAt / 1000); lastFullCaptureAt = tickStartedAt;
      persistedStamp = fileStamp(outputPath);
      stats.idle = false;
      idleIntervalMs = opts.pollIntervalMs;
      nextCaptureAt = tickStartedAt + idleIntervalMs;
    } catch {
      lastCheckedAtBySession.delete(sessionName);
      stats.failures += 1;
      stats.idle = false;
      nextCaptureAt = tickStartedAt + opts.pollIntervalMs;
      // Best-effort capture: target session may have died, output path
      // may be unwritable, etc. The next tick retries; failure here
      // does not bubble up to the daemon's launch / lifecycle paths.
    } finally {
      if (captureStartedAt !== undefined) stats.durationMs += performance.now() - captureStartedAt;
      clearTimeout(captureDeadline);
      if (!captureStillRunning) capturingSessions.delete(sessionName);
    }
  };

  void tick();
  let ticker = tickers.get(timerStepMs);
  if (!ticker) {
    const ticks = new Map<string, () => void>();
    const timer = setInterval(() => { for (const t of ticks.values()) t(); }, timerStepMs);
    // Don't keep the daemon process alive solely on transcript timers.
    if (typeof timer.unref === "function") timer.unref();
    tickers.set(timerStepMs, ticker = { timer, ticks });
  }
  ticker.ticks.set(sessionName, () => void tick());
  activeSteps.set(sessionName, timerStepMs);
}

/** Clear the rotation timer for a session. Safe to call when no timer
 *  is registered. */
export function stopTranscriptRotation(sessionName: string): void {
  const step = activeSteps.get(sessionName);
  const ticker = step === undefined ? undefined : tickers.get(step);
  activeSteps.delete(sessionName);
  if (ticker) {
    ticker.ticks.delete(sessionName);
    if (ticker.ticks.size === 0) { clearInterval(ticker.timer); tickers.delete(step!); }
  }
  // Drop the liveness record: once rotation stops, capture really has stopped,
  // so getIngestHealth should fall back to mtime (which correctly reads stale).
  lastCaptureAtBySession.delete(sessionName);
  lastCheckedAtBySession.delete(sessionName);
  // Invalidate the generation so any in-flight tick from this start bails out
  // after its async capture instead of resurrecting liveness / writing.
  activeGeneration.delete(sessionName);
  captureStats.delete(sessionName);
  unlistedSessions.delete(sessionName);
}

/** Test-only: count of active rotators. Production code should not
 *  depend on this. */
export function getActiveRotationCount(): number {
  return activeSteps.size;
}

/** Test-only: clear all active rotators. Production code should not
 *  call this; use stopTranscriptRotation for individual sessions. */
export function clearAllTranscriptRotationsForTest(): void {
  for (const { timer } of tickers.values()) clearInterval(timer);
  tickers.clear();
  activeSteps.clear();
  lastCaptureAtBySession.clear();
  lastCheckedAtBySession.clear();
  activeGeneration.clear();
  captureStats.clear();
  settingsReloadError = null;
  liveOptions = createTranscriptRotationOptionsResolver(new SettingsStore(), (error) => { settingsReloadError = error; });
  activitySnapshots = new WeakMap();
  unlistedSessions = new Set();
}
