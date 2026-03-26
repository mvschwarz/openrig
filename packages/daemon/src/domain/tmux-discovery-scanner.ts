import type { TmuxAdapter } from "../adapters/tmux.js";

/** A single pane observed during a scan */
export interface ScannedPane {
  tmuxSession: string;
  tmuxWindow: string;
  tmuxPane: string;
  pid: number | null;
  cwd: string | null;
  activeCommand: string | null;
}

/** Result of a full tmux scan */
export interface ScanResult {
  panes: ScannedPane[];
  scannedAt: string;
}

/**
 * Enumerates all tmux sessions/windows/panes and resolves PID, cwd,
 * and active foreground command per pane. Uses TmuxAdapter — no raw
 * tmux CLI strings in domain code.
 */
export class TmuxDiscoveryScanner {
  private tmux: TmuxAdapter;

  constructor(deps: { tmuxAdapter: TmuxAdapter }) {
    this.tmux = deps.tmuxAdapter;
  }

  /** Scan all tmux panes and resolve metadata. */
  async scan(): Promise<ScanResult> {
    const panes: ScannedPane[] = [];
    const scannedAt = new Date().toISOString();

    const sessions = await this.tmux.listSessions();

    for (const session of sessions) {
      const windows = await this.tmux.listWindows(session.name);

      for (const window of windows) {
        const target = `${session.name}:${window.index}`;
        const tmuxPanes = await this.tmux.listPanes(target);

        for (const pane of tmuxPanes) {
          let pid: number | null = null;
          let activeCommand: string | null = null;

          try {
            pid = await this.tmux.getPanePid(pane.id);
          } catch {
            // Pane metadata lookup failed — continue with null
          }

          try {
            activeCommand = await this.tmux.getPaneCommand(pane.id);
          } catch {
            // Pane metadata lookup failed — continue with null
          }

          panes.push({
            tmuxSession: session.name,
            tmuxWindow: `${window.index}`,
            tmuxPane: pane.id,
            pid,
            cwd: pane.cwd || null,
            activeCommand,
          });
        }
      }
    }

    return { panes, scannedAt };
  }
}
