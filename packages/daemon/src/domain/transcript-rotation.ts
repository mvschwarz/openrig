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
import { readOpenRigEnv } from "../openrig-compat.js";
import type { TmuxAdapter } from "../adapters/tmux.js";

export interface TranscriptRotationOptions {
  /** Trailing line count to capture each tick. */
  lines: number;
  /** Poll interval in milliseconds. */
  pollIntervalMs: number;
}

export const DEFAULT_TRANSCRIPT_LINES = 1000;
export const DEFAULT_TRANSCRIPT_POLL_INTERVAL_MS = 2000;

/** Resolve rotation options from env vars, falling back to defaults.
 *  File-stored config (rig config set transcripts.lines …) is loaded
 *  via the daemon settings-store at startup; consumers that need the
 *  file-stored value can pass an explicit options object instead. */
export function getTranscriptRotationOptionsFromEnv(): TranscriptRotationOptions {
  const linesRaw = readOpenRigEnv("OPENRIG_TRANSCRIPTS_LINES");
  const pollRaw = readOpenRigEnv("OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS");
  const lines = parsePositiveInt(linesRaw, DEFAULT_TRANSCRIPT_LINES);
  const pollSeconds = parsePositiveInt(pollRaw, DEFAULT_TRANSCRIPT_POLL_INTERVAL_MS / 1000);
  return { lines, pollIntervalMs: pollSeconds * 1000 };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

const activeTimers = new Map<string, NodeJS.Timeout>();

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
 *  first tick fires immediately so the transcript file is populated
 *  before the first poll interval elapses. */
export function startTranscriptRotation(
  tmuxAdapter: TmuxAdapter,
  sessionName: string,
  outputPath: string,
  opts: TranscriptRotationOptions,
): void {
  stopTranscriptRotation(sessionName);

  const myGeneration = ++rotationGeneration;
  activeGeneration.set(sessionName, myGeneration);
  // True only while THIS start is the current rotation for the session — false
  // once stop() or a replacing start() has run. Guards the async gap so a stale
  // in-flight tick performs no write and records no liveness.
  const isCurrent = (): boolean => activeGeneration.get(sessionName) === myGeneration;

  const tick = async (): Promise<void> => {
    try {
      if (!isCurrent()) return;
      const content = await tmuxAdapter.capturePaneContent(sessionName, opts.lines);
      // Re-check AFTER the async capture: stop()/replacement may have run while we
      // awaited. A dead session (null) is deliberately not recorded either way,
      // so getIngestHealth falls back to a stale mtime for it.
      if (content === null || !isCurrent()) return;

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
          const boundaryLines = prev
            .split("\n")
            .filter((line) => line.startsWith("--- SESSION BOUNDARY:"));
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
    } catch {
      // Best-effort capture: target session may have died, output path
      // may be unwritable, etc. The next tick retries; failure here
      // does not bubble up to the daemon's launch / lifecycle paths.
    }
  };

  void tick();
  const timer = setInterval(tick, opts.pollIntervalMs);
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
}
