// #3416 (3): an opt-in per-seat throttle for the Claude status line that OpenRig's context collector runs. Claude Code
// runs the status line command on each update of the conversation (debounced at 300 ms), and each run starts Node. A
// throttled seat runs a short POSIX shell check first. It skips Node for an update that comes less than the interval
// after the last collection, in the same conversation, with the context not below the last COLLECTED reading, and only
// when that last collection actually wrote its reading. A reading below the last collected one (a compaction) or a new
// conversation collects at once, so a decision about a compaction or a new occupant never rests on a reading taken
// before it. The comparison is with the last collected reading, not the last one seen: after a skipped rise (collect at
// 40, skip at 80) a compaction to 50 is skipped too, which costs lag only (the reading kept, 40, is the lower one).
//
// The check never touches what the collector writes: the context-usage sidecar keeps the `sampled_at` of the last real
// collection, so every reader still sees the reading's true age and a throttled reading never reads as current. The
// interval is bounded (STATUSLINE_THROTTLE_MAX_SECONDS) well under the 10 minutes after which a sample reads as stale.
//
// The throttled command goes only into the seat's launch-local --settings value (like the hook bridge), never into the
// shared .claude/settings.local.json, so seats sharing a folder can choose different intervals, a seat without the
// throttle launches exactly as before, and the settings the folder keeps (and `rig down` takes back) don't change.

import nodePath from "node:path";
import { shellQuote } from "../adapters/shell-quote.js";
import { contextCollectorPath, contextUsageDirectory, providerUsageDirectory, telemetrySidecarFilename } from "./telemetry-state-paths.js";
import { managedClaudeNodeCommand } from "./claude-activity-hooks.js";
import { isOwnedCollectorCommand } from "./claude-owned-settings.js";

/** The shortest interval worth a check: one second, the resolution of `date +%s`. */
export const STATUSLINE_THROTTLE_MIN_SECONDS = 1;
/** The longest: two minutes, so the kept reading of a working seat lags its conversation by at most that, well inside the
 *  10 minutes after which a sample reads as stale (context-usage-store.ts). A seat that goes idle right after a skipped
 *  update keeps its earlier reading until its next update. */
export const STATUSLINE_THROTTLE_MAX_SECONDS = 120;

/** Validates a throttle interval in whole seconds, naming `field` in the error. */
export function validateStatuslineThrottle(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)
    || value < STATUSLINE_THROTTLE_MIN_SECONDS || value > STATUSLINE_THROTTLE_MAX_SECONDS) {
    throw new Error(`${field} must be a whole number of seconds from ${STATUSLINE_THROTTLE_MIN_SECONDS} to ${STATUSLINE_THROTTLE_MAX_SECONDS}`);
  }
  return value;
}

/** A stored throttle as the launch reads it: a number inside the bounds, else none. */
export function storedStatuslineThrottle(value: unknown): number | null {
  try { return value === null || value === undefined ? null : validateStatuslineThrottle(value, "statusline_throttle"); }
  catch { return null; }
}

/** The spec value (`statusline_throttle`): seconds from 1 to the maximum, or 0, which clears the seat's throttle on a
 *  re-apply. Absent keeps what the seat has. */
export function validateSpecStatuslineThrottle(value: unknown, field = "statusline_throttle"): number {
  if (value === 0) return 0;
  try { return validateStatuslineThrottle(value, field); }
  catch { throw new Error(`${field} must be 0 (off) or a whole number of seconds from ${STATUSLINE_THROTTLE_MIN_SECONDS} to ${STATUSLINE_THROTTLE_MAX_SECONDS}`); }
}

export interface ThrottledCollectorInput {
  /** The collector command OpenRig generates (the shape managedClaudeNodeCommand writes, starting with `exec`). */
  collectorCommand: string;
  /** The context-usage directory the collector writes its sidecar into. */
  contextDir: string;
  /** The seat's Claude session name (`--name`), which names the collector's sidecar. While Claude reports another
   *  session name, the check finds no sidecar under this one and collects on every update. */
  sessionName: string;
  seconds: number;
}

/**
 * The throttled status line command: one line of POSIX shell (dash, bash, zsh and BusyBox sh) in front of the collector.
 * `<f>` is the seat's sidecar path without `.json`; `<f>.throttle` holds `<epoch> s=<session id> u=<whole percent>` of the
 * last collection started. The status line input is read once (`p=$(cat)`); the session id and the whole percent of
 * `context_window.used_percentage` are cut out of it with parameter expansion, without starting anything, and only
 * when they match positively (`o=1`):
 * - `"session_id":"` is in the input and the id after it is not empty;
 * - `"context_window":{` is in the input, its object is taken whole by counting braces, and `"used_percentage":`
 *   appears in that object exactly once (never one of another object later in the input, such as `rate_limits`).
 * It leaves (exit 0, printing nothing, as the collector prints nothing) only when both matched, the seat's sidecar
 * exists, is not older than the stamp, names the same session id and holds the stamp's whole percent (a collection that
 * started and never wrote doesn't count, also where `-nt` compares whole seconds, as BusyBox's does: the sidecar must
 * be this conversation's and carry this collection's reading), the stamp names the same session id, both percents are
 * whole numbers from 0 to 100 and the new one is not below the last collected one, and the stamp's time is exactly ten
 * digits, not in the future and less than the interval old. Both braces in the brace count are escaped, so native zsh
 * (not only zsh as sh) parses the line too.
 * Anything else, a missing or unreadable field included, collects: the input goes to the collector unchanged.
 * The stamp is written through a temporary file and a rename, never into a directory left in its place.
 */
export function throttledCollectorCommand(input: ThrottledCollectorInput): string {
  const seconds = validateStatuslineThrottle(input.seconds, "statusline throttle");
  const base = shellQuote(nodePath.join(input.contextDir, telemetrySidecarFilename(input.sessionName).replace(/\.json$/, "")));
  return [
    "f=" + base,
    "p=$(cat)",
    "o=1; s=; u=",
    "case $p in *'\"session_id\":\"'*) s=${p#*'\"session_id\":\"'}; s=${s%%'\"'*};; *) o=0;; esac",
    "[ -n \"$s\" ] || o=0",
    // The context_window object, whole: from its `{` to the `}` that closes it, counting the braces in between (its
    // values are numbers and a nested object, never a string with a brace).
    "case $p in *'\"context_window\":{'*) w=${p#*'\"context_window\":{'}; d=1; c=;"
      + " while [ \"$d\" -gt 0 ]; do r=${w#*[\\{\\}]}; if [ \"$r\" = \"$w\" ]; then d=-1; break; fi; h=${w%\"$r\"}; c=$c$h;"
      + " case $h in *'{') d=$((d + 1));; *) d=$((d - 1));; esac; w=$r; done;"
      + " if [ \"$d\" = 0 ]; then case $c in *'\"used_percentage\":'*'\"used_percentage\":'*) o=0;;"
      + " *'\"used_percentage\":'*) u=${c#*'\"used_percentage\":'}; u=${u%%[!0-9]*};; *) o=0;; esac; else o=0; fi;;"
      + " *) o=0;; esac",
    "if [ \"$o\" = 1 ] && [ -f \"$f.json\" ] && [ ! \"$f.throttle\" -nt \"$f.json\" ]"
      + " && { read -r t ts tu < \"$f.throttle\"; } 2>/dev/null && [ \"x$ts\" = \"xs=$s\" ]"
      + " && { IFS= read -r j || [ -n \"$j\" ]; } < \"$f.json\" 2>/dev/null"
      + " && case $j in *'\"session_id\":\"'\"$s\"'\"'*) true;; *) false;; esac"
      // The sidecar holds the stamped collection's own reading: its first used_percentage (the collector writes
      // context_window first) has the stamp's whole percent. A collection that never wrote leaves the earlier one.
      + " && x=${j#*'\"used_percentage\":'} && x=${x%%[!0-9]*} && [ \"x$x\" = \"x${tu#u=}\" ]; then v=${tu#u=};"
      + " case $u in [0-9]|[1-9][0-9]|100) case $v in [0-9]|[1-9][0-9]|100) if [ \"$u\" -ge \"$v\" ]; then"
      + " case $t in [1-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) a=$(( $(date +%s) - t ));"
      + ` if [ "$a" -ge 0 ] && [ "$a" -lt ${seconds} ]; then exit 0; fi;; esac; fi;; esac;; esac; fi`,
    "[ -d \"$f.throttle\" ] || { printf '%s s=%s u=%s\\n' \"$(date +%s)\" \"$s\" \"$u\" > \"$f.throttle.$$\" && mv -f \"$f.throttle.$$\" \"$f.throttle\"; }",
    "printf '%s' \"$p\" | " + input.collectorCommand,
  ].join("; ");
}

export interface ThrottledStatusLineInput {
  readFile(path: string): string;
  exists(path: string): boolean;
  /** The seat's working folder, where its Claude settings live. */
  cwd: string;
  /** The OpenRig home the collector writes its sidecars under. */
  stateDir: string;
  nodeExecutable: string;
  sessionName: string;
  seconds: number;
}

/**
 * The status line a throttled seat's launch puts into its --settings value, or why it doesn't. The folder's own status
 * line wins, as it does for the collector install: a status line command in `.claude/settings.local.json` that isn't
 * OpenRig's collector, or settings that can't be read, keep the launch unthrottled, with a note. The other fields of
 * the folder's status line (padding, for example) are kept.
 */
export function throttledStatusLineForLaunch(input: ThrottledStatusLineInput): { statusLine: Record<string, unknown> } | { note: string } {
  const settingsPath = nodePath.join(input.cwd, ".claude", "settings.local.json");
  let current: Record<string, unknown> = {};
  if (input.exists(settingsPath)) {
    let parsed: unknown;
    try {
      const text = input.readFile(settingsPath);
      parsed = text.trim() === "" ? {} : JSON.parse(text);
    } catch {
      return { note: `The status line throttle wasn't applied: ${settingsPath} couldn't be read as settings.` };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { note: `The status line throttle wasn't applied: ${settingsPath} isn't a settings object.` };
    }
    const statusLine = (parsed as Record<string, unknown>)["statusLine"];
    if (typeof statusLine === "object" && statusLine !== null && !Array.isArray(statusLine)) current = statusLine as Record<string, unknown>;
  }
  const own = current["command"];
  if (typeof own === "string" && own.trim() !== "" && !isOwnedCollectorCommand(own)) {
    return { note: `The status line throttle wasn't applied: ${settingsPath} sets its own status line command, which wins.` };
  }
  const contextDir = contextUsageDirectory(input.stateDir);
  const collector = managedClaudeNodeCommand(input.nodeExecutable, contextCollectorPath(input.stateDir),
    contextDir, providerUsageDirectory(input.stateDir));
  const statusLine = { ...current, type: "command",
    command: throttledCollectorCommand({ collectorCommand: collector, contextDir, sessionName: input.sessionName, seconds: input.seconds }) };
  // No legacy cleanup here: this only builds the launch's --settings value, it does not write the seat's settings
  // file. The legacy file goes away when the settings poll repoints `.claude/settings.local.json` to the instance
  // collector — deleting it now would leave the persisted settings naming a missing file if this launch fails.
  return { statusLine };
}
