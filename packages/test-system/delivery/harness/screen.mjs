// The seat's screen over a case, as frames: each distinct screen once, with the time it was first seen. This is the
// harness's own record of the pane, read with capture-pane only. OpenRig pipes the pane into its transcript, and a
// second pipe would replace that one, so the harness never pipes it.

import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Record frames of `target` into `path` every `everyMs` until `stop()`. Returns { stop, frames, last, okAt, failures }.
 *  `last()` is the screen as it is now: null while the newest capture failed, so a reader never takes an old screen for
 *  the current one. A capture is credited with the time it STARTED (performance.now() just before capture-pane), not
 *  when its reads finished: its content can be no newer than that. `okAt()` is the start of the newest successful
 *  capture, changed or not, so `okAt() > t` proves a capture began after t. A frame keeps both times. */
export function recordScreen(cell, path, { everyMs = 250, target = cell.session } = {}) {
  const frames = [];
  let running = true;
  let previous = null;
  let lastOk = -Infinity;
  let latestFailed = false;
  let failures = 0;
  const loop = (async () => {
    while (running) {
      const startedAt = performance.now();
      const at = new Date().toISOString();
      try {
        const screen = await cell.tmux(["capture-pane", "-p", "-t", target]);
        const state = (await cell.tmux(["display-message", "-p", "-t", target, "#{pane_in_mode}\t#{window_width}x#{window_height}"])).trim().split("\t");
        const completedAt = performance.now();
        const sha256 = createHash("sha256").update(screen).digest("hex");
        lastOk = startedAt;
        latestFailed = false;
        if (sha256 !== previous) {
          previous = sha256;
          const frame = { at, monotonicMs: startedAt, completedMs: completedAt, inMode: state[0] === "1", size: state[1], sha256, screen };
          frames.push(frame);
          appendFileSync(path, `${JSON.stringify(frame)}\n`);
        }
      } catch (error) {
        latestFailed = true;
        failures += 1;
        const frame = { at, monotonicMs: startedAt, completedMs: performance.now(), error: String(error.message ?? error) };
        frames.push(frame);
        appendFileSync(path, `${JSON.stringify(frame)}\n`);
      }
      await sleep(everyMs);
    }
  })();
  return {
    frames,
    last: () => (latestFailed ? null : frames.findLast((f) => f.screen !== undefined) ?? null),
    okAt: () => lastOk,
    failures: () => failures,
    stop: async () => { running = false; await loop; },
  };
}

/** The input box's text on a screen: the rows from the program's prompt marker down to the box's rule or footer.
 *  Claude Code draws `❯ ` inside a box ruled with `─`; Codex draws `› `. Null when no prompt row is on screen. */
export function composerText(kind, screen) {
  const rows = screen.split("\n");
  const marker = kind === "claude" ? "❯" : "›";
  // The input box is the last prompt row on screen; earlier ones are the conversation's history.
  const start = rows.findLastIndex((row) => row.trimStart().startsWith(marker));
  if (start < 0) return null;
  const out = [];
  for (let i = start; i < rows.length; i++) {
    const row = rows[i];
    if (i > start && (/^\s*─{4,}/.test(row) || row.trim() === "")) break;
    out.push(i === start ? row.trimStart().slice(marker.length).replace(/^ /, "") : row.replace(/^ {2}/, ""));
  }
  return out.join("\n").trimEnd();
}
