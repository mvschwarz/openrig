export type ExecFn = (cmd: string) => Promise<string>;

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
  constructor(private exec: ExecFn) {}

  async listSessions(): Promise<TmuxSession[]> {
    try {
      const output = await this.exec(`tmux list-sessions -F "${SESSION_FORMAT}"`);
      return parseLines(output, parseSessionLine);
    } catch (err) {
      if (isNoServerError(err)) return [];
      throw err;
    }
  }

  async listWindows(sessionName: string): Promise<TmuxWindow[]> {
    try {
      const output = await this.exec(`tmux list-windows -t ${shellQuote(sessionName)} -F "${WINDOW_FORMAT}"`);
      return parseLines(output, parseWindowLine);
    } catch (err) {
      if (isNoServerError(err)) return [];
      throw err;
    }
  }

  async listPanes(target: string): Promise<TmuxPane[]> {
    try {
      const output = await this.exec(`tmux list-panes -t ${shellQuote(target)} -F "${PANE_FORMAT}"`);
      return parseLines(output, parsePaneLine);
    } catch (err) {
      if (isNoServerError(err)) return [];
      throw err;
    }
  }

  async hasSession(name: string): Promise<boolean> {
    const sessions = await this.listSessions();
    return sessions.some((s) => s.name === name);
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
    const cmd = `tmux send-keys -t ${shellQuote(target)} -l ${shellQuote(text)}`;
    try {
      await this.exec(cmd);
      return { ok: true };
    } catch (err) {
      return classifyWriteError(err);
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
}
