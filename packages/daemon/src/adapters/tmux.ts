export type ExecFn = (cmd: string) => Promise<string>;

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
      const output = await this.exec(`tmux list-windows -t ${sessionName} -F "${WINDOW_FORMAT}"`);
      return parseLines(output, parseWindowLine);
    } catch (err) {
      if (isNoServerError(err)) return [];
      throw err;
    }
  }

  async listPanes(target: string): Promise<TmuxPane[]> {
    try {
      const output = await this.exec(`tmux list-panes -t ${target} -F "${PANE_FORMAT}"`);
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
}
