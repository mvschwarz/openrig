import { writeFile as fsWriteFile, unlink as fsUnlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join as pathJoin } from "node:path";
import { randomUUID } from "node:crypto";

export type ExecFn = (cmd: string) => Promise<string>;

/**
 * Injectable file/buffer operations for the large-payload `sendText` path.
 * Split out so tests can observe temp-file writes and unique-name generation
 * without touching the real filesystem; production wires node fs + os.tmpdir.
 */
export interface TmuxFileOps {
  writeFile(path: string, content: string): Promise<void>;
  unlink(path: string): Promise<void>;
  /** Unique temp-file path per call - parallel `rig up` stands up many seats. */
  tmpName(): string;
  /** Unique tmux buffer name per call - a fixed name would collide under concurrency. */
  bufferName(): string;
}

function defaultTmuxFileOps(): TmuxFileOps {
  return {
    writeFile: (p, content) => fsWriteFile(p, content, "utf8"),
    unlink: (p) => fsUnlink(p),
    tmpName: () => pathJoin(tmpdir(), `openrig-tmux-send-${process.pid}-${randomUUID()}.txt`),
    bufferName: () => `openrig_${process.pid}_${randomUUID().replace(/-/g, "")}`,
  };
}

/**
 * Payloads at or below this byte size go through the inline `send-keys -l`
 * path. Larger payloads are written to a temp file and delivered via a tmux
 * paste-buffer: a multi-hundred-KB startup pack embedded in one argv exceeds
 * the OS per-arg limit (Linux MAX_ARG_STRLEN is about 128KB) and the launch
 * silently fails. 100KB stays clear of that ceiling while leaving normal
 * command/control text on the unchanged inline path.
 */
const LARGE_PAYLOAD_THRESHOLD_BYTES = 100 * 1024;

export type TmuxResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

export interface TmuxSession {
  name: string;
  windows: number;
  created: string;
  attached: boolean;
}

export interface TmuxWindow {
  index: number;
  name: string;
  panes: number;
  active: boolean;
}

export interface TmuxPane {
  id: string;
  index: number;
  cwd: string;
  width: number;
  height: number;
  active: boolean;
}

const SESSION_FORMAT = "#{session_name}\t#{session_windows}\t#{session_created}\t#{session_attached}";
const WINDOW_FORMAT = "#{window_index}\t#{window_name}\t#{window_panes}\t#{window_active}";
const PANE_FORMAT = "#{pane_id}\t#{pane_index}\t#{pane_current_path}\t#{pane_width}\t#{pane_height}\t#{pane_active}";

function isNoServerError(err: unknown): boolean {
  return err instanceof Error && err.message.includes("no server running");
}

function isSessionAbsenceError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes("session not found") ||
    msg.includes("can't find session") ||
    msg.includes("no session");
}

// Post-reboot the tmux socket file at /tmp/tmux-<uid>/<name> is gone, so
// `tmux has-session` exits non-zero with a transport-absent message rather than
// a server/session-absent message. Treat that case as "no session" so cold-start
// reconciliation can detach stale rows. Permission errors must remain rethrown.
function isTmuxTransportAbsentError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  // Fail-closed: never classify a permission/authorization failure as absence.
  if (/permission denied|operation not permitted|EACCES|EPERM/i.test(msg)) {
    return false;
  }
  // tmux's socket-transport failure prefix; the parenthetical names the cause.
  //   "error connecting to /private/tmp/tmux-501/default (No such file or directory)"
  //   "error connecting to /private/tmp/tmux-501/default (Connection refused)"
  if (msg.startsWith("error connecting to")) {
    return /No such file or directory|Connection refused/.test(msg);
  }
  // Conservative bare-message variants that still reference a tmux socket path.
  if (/tmux-\d+/.test(msg) && /No such file or directory|Connection refused/.test(msg)) {
    return true;
  }
  return false;
}

function classifyWriteError(err: unknown): TmuxResult {
  if (!(err instanceof Error)) {
    return { ok: false, code: "unknown", message: String(err) };
  }
  if (err.message.includes("duplicate session")) {
    return { ok: false, code: "duplicate_session", message: err.message };
  }
  if (err.message.includes("can't find session") || err.message.includes("no server running")) {
    return { ok: false, code: "session_not_found", message: err.message };
  }
  return { ok: false, code: "unknown", message: err.message };
}

/** Shell-quote a string using single quotes (POSIX-safe). */
function shellQuote(s: string): string {
  // Replace each ' with '"'"' (end quote, double-quote the apostrophe, resume quote)
  return "'" + s.replace(/'/g, "'\"'\"'") + "'";
}

function parseSessionLine(line: string): TmuxSession | null {
  const parts = line.split("\t");
  if (parts.length < 4) return null;
  const windows = parseInt(parts[1]!, 10);
  if (isNaN(windows)) return null;
  return {
    name: parts[0]!,
    windows,
    created: parts[2]!,
    attached: parts[3] === "1",
  };
}

function parseWindowLine(line: string): TmuxWindow | null {
  const parts = line.split("\t");
  if (parts.length < 4) return null;
  const index = parseInt(parts[0]!, 10);
  const panes = parseInt(parts[2]!, 10);
  if (isNaN(index) || isNaN(panes)) return null;
  return {
    index,
    name: parts[1]!,
    panes,
    active: parts[3] === "1",
  };
}

function parsePaneLine(line: string): TmuxPane | null {
  const parts = line.split("\t");
  if (parts.length < 6) return null;
  const index = parseInt(parts[1]!, 10);
  const width = parseInt(parts[3]!, 10);
  const height = parseInt(parts[4]!, 10);
  if (isNaN(index) || isNaN(width) || isNaN(height)) return null;
  return {
    id: parts[0]!,
    index,
    cwd: parts[2]!,
    width,
    height,
    active: parts[5] === "1",
  };
}

function parseLines<T>(output: string, parser: (line: string) => T | null): T[] {
  return output
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map(parser)
    .filter((result): result is T => result !== null);
}

export class TmuxAdapter {
  constructor(private exec: ExecFn, private fileOps: TmuxFileOps = defaultTmuxFileOps()) {}

  async listSessions(): Promise<TmuxSession[]> {
    try {
      const output = await this.exec(`tmux list-sessions -F "${SESSION_FORMAT}"`);
      return parseLines(output, parseSessionLine);
    } catch (err) {
      if (isNoServerError(err) || isTmuxTransportAbsentError(err)) return [];
      throw err;
    }
  }

  async listWindows(sessionName: string): Promise<TmuxWindow[]> {
    try {
      const output = await this.exec(`tmux list-windows -t ${shellQuote(sessionName)} -F "${WINDOW_FORMAT}"`);
      return parseLines(output, parseWindowLine);
    } catch (err) {
      if (isNoServerError(err) || isTmuxTransportAbsentError(err)) return [];
      throw err;
    }
  }

  async listPanes(target: string): Promise<TmuxPane[]> {
    try {
      const output = await this.exec(`tmux list-panes -t ${shellQuote(target)} -F "${PANE_FORMAT}"`);
      return parseLines(output, parsePaneLine);
    } catch (err) {
      if (isNoServerError(err) || isTmuxTransportAbsentError(err)) return [];
      throw err;
    }
  }

  async hasSession(name: string): Promise<boolean> {
    try {
      // Use `tmux has-session` directly for reliable existence check — avoids
      // parsing format-string output from `list-sessions` which can fail when
      // tab delimiters are malformed across tmux versions.
      await this.exec(`tmux has-session -t ${shellQuote(name)}`);
      return true; // exit 0 = session exists
    } catch (err) {
      // Known-absence patterns: session genuinely doesn't exist, tmux not running,
      // or the tmux socket file is gone post-reboot.
      // Return false so cold-start reconciliation can detach stale rows.
      if (isNoServerError(err) || isSessionAbsenceError(err) || isTmuxTransportAbsentError(err)) {
        return false;
      }
      // Unexpected probe failure (permission denied, etc.) — rethrow so callers
      // can fail closed rather than treating a probe failure as absence.
      throw err;
    }
  }

  async createSession(name: string, cwd?: string, env?: Record<string, string>): Promise<TmuxResult> {
    const cwdFlag = cwd != null ? ` -c ${shellQuote(cwd)}` : "";
    const envFlags = env
      ? Object.entries(env).map(([k, v]) => ` -e ${shellQuote(`${k}=${v}`)}`).join("")
      : "";
    const cmd = `tmux new-session -d -s ${shellQuote(name)}${cwdFlag}${envFlags}`;
    try {
      await this.exec(cmd);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  async sendText(target: string, text: string): Promise<TmuxResult> {
    if (Buffer.byteLength(text, "utf8") > LARGE_PAYLOAD_THRESHOLD_BYTES) {
      return this.sendTextViaBuffer(target, text);
    }
    // `--` (end-of-options) is required so text beginning with `-` (e.g. `---`
    // YAML frontmatter) is taken literally, not parsed as flags. OPR.0.3.3.17.
    const cmd = `tmux send-keys -t ${shellQuote(target)} -l -- ${shellQuote(text)}`;
    try {
      await this.exec(cmd);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /**
   * Large-payload delivery path (the point of this transport change): a
   * >100KB startup pack must NOT be embedded in a tmux/shell argv. The text is
   * written to a unique temp file via Node fs (never shell-embedded), loaded
   * into a unique tmux buffer, and pasted with `-d -r`:
   *   `-r`  preserve raw LF. tmux's default paste-buffer replaces every LF with
   *         CR, and CR (= `C-m` = Enter) is SUBMIT in the Claude/Codex TUIs - a
   *         default paste of a multi-line pack would submit on every newline.
   *   `-d`  drop the buffer after a successful paste.
   * The single trailing submit stays the caller's separate `sendKeys(["C-m"])`,
   * exactly as the inline `send-keys -l` path relies on (behavior-preserving).
   * Cleanup unlinks the temp file in `finally`; if the buffer was loaded but the
   * paste failed (e.g. missing target), an explicit `delete-buffer` runs so no
   * buffer leaks. Unique temp + buffer names per call keep parallel `rig up`
   * seats from colliding.
   */
  private async sendTextViaBuffer(target: string, text: string): Promise<TmuxResult> {
    const path = this.fileOps.tmpName();
    const buffer = this.fileOps.bufferName();
    let bufferLoaded = false;
    try {
      await this.fileOps.writeFile(path, text);
      await this.exec(`tmux load-buffer -b ${shellQuote(buffer)} ${shellQuote(path)}`);
      bufferLoaded = true;
      await this.exec(`tmux paste-buffer -t ${shellQuote(target)} -b ${shellQuote(buffer)} -d -r`);
      return { ok: true };
    } catch (err) {
      if (bufferLoaded) {
        // paste failed after load - `-d` never ran, so the buffer is still
        // resident. Best-effort delete to avoid leaking it.
        try {
          await this.exec(`tmux delete-buffer -b ${shellQuote(buffer)}`);
        } catch { /* best-effort cleanup */ }
      }
      return classifyWriteError(err);
    } finally {
      try {
        await this.fileOps.unlink(path);
      } catch { /* best-effort cleanup */ }
    }
  }

  async sendKeys(target: string, keys: string[]): Promise<TmuxResult> {
    const cmd = `tmux send-keys -t ${shellQuote(target)} ${keys.map(shellQuote).join(" ")}`;
    try {
      await this.exec(cmd);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  async killSession(name: string): Promise<TmuxResult> {
    const cmd = `tmux kill-session -t ${shellQuote(name)}`;
    try {
      await this.exec(cmd);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /** Get the PID of the foreground process in a pane. Returns null if unavailable. */
  async getPanePid(paneId: string): Promise<number | null> {
    try {
      const output = await this.exec(`tmux display-message -p -t ${shellQuote(paneId)} "#{pane_pid}"`);
      const trimmed = output.trim();
      const parsed = parseInt(trimmed, 10);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    } catch {
      return null;
    }
  }

  /** Get the current foreground command in a pane. Returns null if unavailable. */
  async getPaneCommand(paneId: string): Promise<string | null> {
    try {
      const output = await this.exec(`tmux display-message -p -t ${shellQuote(paneId)} "#{pane_current_command}"`);
      const trimmed = output.trim();
      return trimmed || null;
    } catch {
      return null;
    }
  }

  /** Start pipe-pane to capture terminal output to a file. */
  async startPipePane(sessionName: string, outputPath: string): Promise<TmuxResult> {
    // Shell-quote the path for safe injection into the pipe-pane command.
    // The entire pipe command is passed as a single argument to tmux,
    // which executes it via sh -c. We use shellQuote on the path.
    const cmd = `tmux pipe-pane -t ${shellQuote(sessionName)} ${shellQuote("cat >> " + shellQuote(outputPath))}`;
    try {
      await this.exec(cmd);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /** Stop pipe-pane on a session. */
  async stopPipePane(sessionName: string): Promise<TmuxResult> {
    const cmd = `tmux pipe-pane -t ${shellQuote(sessionName)}`;
    try {
      await this.exec(cmd);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /** Capture pane content (last N lines). Returns null if unavailable. */
  async capturePaneContent(paneId: string, lines: number = 20): Promise<string | null> {
    try {
      const output = await this.exec(`tmux capture-pane -p -t ${shellQuote(paneId)} -S -${lines}`);
      return output || null;
    } catch {
      return null;
    }
  }

  /** Set a session-scoped user option (@-prefixed key). */
  async setSessionOption(sessionName: string, key: string, value: string): Promise<TmuxResult> {
    const cmd = `tmux set-option -t ${shellQuote(sessionName)} ${shellQuote(key)} ${shellQuote(value)}`;
    try {
      await this.exec(cmd);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /** Get a session-scoped user option value. Returns null if not set or error. */
  async getSessionOption(sessionName: string, key: string): Promise<string | null> {
    try {
      const output = await this.exec(`tmux show-option -v -t ${shellQuote(sessionName)} ${shellQuote(key)}`);
      return output.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * Slice 15 — configure tmux's per-window `monitor-silence` option for
   * the target's containing window. The runtime flips
   * `pane_silence_flag` to "1" when the pane has been silent past the
   * threshold; "0" while producing output. This is the v0 source of
   * the `terminal-active` primitive (README §v0). Window-scoped is the
   * correct level: tmux's monitor-silence is a window option (see
   * `man tmux` §OPTIONS); `-w` targets the window containing the pane.
   *
   * Validates `seconds` at the adapter boundary so a bad caller can't
   * inject negative / zero / fractional / NaN values into the shell
   * command — those would either silently coerce or fail with an
   * opaque tmux error.
   */
  async setMonitorSilence(target: string, seconds: number): Promise<TmuxResult> {
    if (!Number.isFinite(seconds) || !Number.isInteger(seconds) || seconds < 1) {
      return {
        ok: false,
        code: "validation_error",
        message: `setMonitorSilence: seconds must be a positive integer, got ${seconds}`,
      };
    }
    const cmd = `tmux set-option -w -t ${shellQuote(target)} monitor-silence ${shellQuote(String(seconds))}`;
    try {
      await this.exec(cmd);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
    }
  }

  /**
   * Slice 15 — read the timestamp (Unix epoch seconds) of the last
   * activity on the pane's window. The daemon's SeatActivityService
   * compares this against the configured silence window: if the
   * timestamp is within the window the seat is `terminal-active`,
   * otherwise it's silent past the threshold.
   *
   * Why not `pane_silence_flag`: tmux 3.6a was observed to return a
   * blank value for `#{pane_silence_flag}` during slice 15 dogfood
   * (sticky-alert behavior + version-dependent emit semantics), so
   * we cannot rely on it as the primary signal. `#{window_activity}`
   * is reliably populated (the runtime updates it whenever the
   * window receives output) and is the timestamp the tmux status-line
   * activity indicators use themselves.
   *
   * Returns:
   *   - a Unix-epoch-seconds integer when the runtime exposed the value
   *   - `null` when the target is missing OR the value is unparseable
   *     (consumers treat null as "no signal", distinct from "idle").
   */
  async readPaneLastActivity(paneId: string): Promise<number | null> {
    try {
      const output = await this.exec(
        `tmux display-message -p -t ${shellQuote(paneId)} '#{window_activity}'`,
      );
      const trimmed = output.trim();
      if (!/^\d+$/.test(trimmed)) return null;
      const n = Number(trimmed);
      if (!Number.isFinite(n) || n <= 0) return null;
      return n;
    } catch {
      return null;
    }
  }
}
