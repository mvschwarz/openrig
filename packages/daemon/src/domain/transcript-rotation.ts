// V1 pre-release CLI/daemon Item 1 — bounded-trail transcript rotation.
//
// Replaces the legacy `tmux pipe-pane` mechanism (infinite-growth file)
// with a periodic `tmux capture-pane -t <session> -p -S -<lines>` shellout
// that atomically overwrites the transcript file. File size stays bounded
// by trailing line count + line-byte ceiling, not by session duration.
//
// Tunables (env: OPENRIG_TRANSCRIPTS_LINES / OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS;
// legacy: RIGGED_*; allowlist keys transcripts.lines / transcripts.poll_interval_seconds
// declared in SC-29 EXCEPTION #4):
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
  const linesRaw = readOpenRigEnv("OPENRIG_TRANSCRIPTS_LINES", "RIGGED_TRANSCRIPTS_LINES");
  const pollRaw = readOpenRigEnv("OPENRIG_TRANSCRIPTS_POLL_INTERVAL_SECONDS", "RIGGED_TRANSCRIPTS_POLL_INTERVAL_SECONDS");
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

  const tick = async (): Promise<void> => {
    try {
      const content = await tmuxAdapter.capturePaneContent(sessionName, opts.lines);
      if (content === null) return;

      // Preserve SESSION BOUNDARY lines that the restore orchestrator
      // writes to the transcript file before launch. The capture-pane
      // overwrite would otherwise wipe them on the first tick. The
      // marker is the only structural header the transcript file is
      // expected to carry across rotations; everything else is
      // terminal-scrollback content from capture-pane.
      let header = "";
      try {
        if (fs.existsSync(outputPath)) {
          const prev = fs.readFileSync(outputPath, "utf8");
          const boundaryLines = prev
            .split("\n")
            .filter((line) => line.startsWith("--- SESSION BOUNDARY:"));
          if (boundaryLines.length > 0) header = boundaryLines.join("\n") + "\n";
        }
      } catch {
        // Best-effort header read; missing file or read error means no header.
      }

      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      const tmpPath = `${outputPath}.tmp.${process.pid}`;
      fs.writeFileSync(tmpPath, header + content);
      fs.renameSync(tmpPath, outputPath);
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
}
