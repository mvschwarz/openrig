import { spawnSync } from "node:child_process";
import type { TmuxAdapter } from "../adapters/tmux.js";

export interface TmuxOptionDefaultsDeps {
  tmuxAdapter: TmuxAdapter;
  /**
   * OPR.0.4.6.02 S1 — reads the daemon's tmux option defaults at APPLY time.
   * Resolved fresh per call (from the SettingsStore in startup) so an
   * operator's `terminal.status_bar` flip applies to FUTURE launches only.
   * Defaults to `statusBar: false` (bar hidden) when omitted.
   */
  readTmuxOptionDefaults?: () => { statusBar: boolean };
  /**
   * OPR.0.4.6.02 S1 — platform selector for the server-scope `copy-command`
   * table. Defaults to `process.platform`; injectable for the scope tests.
   */
  platform?: NodeJS.Platform;
  /**
   * OPR.0.4.6.02 S1 — cheap `command -v <bin>` probe for the linux
   * copy-command fallback chain. Defaults to a real shell probe; injectable
   * for deterministic tests.
   */
  hasCommand?: (bin: string) => boolean;
}

/**
 * OPR.0.4.6.02 S1 — applies the daemon's tmux option defaults to a
 * FRESHLY-CREATED session. Shared by `NodeLauncher` (the launch path) and
 * `SuccessorSessionLauncher` (the fresh seat-handover successor path) so
 * every fresh operator/agent seat gets consistent mouse/status/clipboard
 * defaults (orch C1 scope ruling: fold fresh successors in via ONE helper).
 *
 * Scope discipline (guard b2): SESSION-scope options (`mouse`, `status`) are
 * applied ONLY to the just-created session name passed in — never a
 * pre-existing/discovered session — so the never-retro-flip rail (BR-1)
 * holds and a `terminal.status_bar` flip affects future launches only.
 * SERVER-scope options (`set-clipboard`, `copy-command`) are asserted ONCE
 * per daemon lifetime via the shared memo on this single instance; a daemon
 * RESTART re-asserts (a fresh applier). Callers MUST only invoke this after
 * a successful `createSession` on a freshly-created session.
 */
export class TmuxOptionDefaultsApplier {
  private tmuxAdapter: TmuxAdapter;
  private readTmuxOptionDefaults: () => { statusBar: boolean };
  private platform: NodeJS.Platform;
  private hasCommand: (bin: string) => boolean;
  private serverDefaultsAsserted = false;

  constructor(deps: TmuxOptionDefaultsDeps) {
    this.tmuxAdapter = deps.tmuxAdapter;
    this.readTmuxOptionDefaults = deps.readTmuxOptionDefaults ?? (() => ({ statusBar: false }));
    this.platform = deps.platform ?? process.platform;
    this.hasCommand = deps.hasCommand ?? defaultHasCommand;
  }

  /**
   * Apply the option defaults to a JUST-CREATED session. `mouse` is always
   * on; the inner status bar follows the `terminal.status_bar` config key
   * (default off), read at apply time so a flip applies to FUTURE launches
   * only (this touches only `sessionName`). Then assert the server-scope
   * defaults once per daemon lifetime.
   *
   * Returns the list of non-fatal warnings (empty when all sets succeed) so
   * the caller can fold them into its own launch-warning channel. NEVER
   * throws for an option-set failure — a seat without mouse-scroll is
   * degraded, not dead (and a handover successor must not be handover-fatal
   * over a cosmetic option).
   */
  async applyToFreshSession(sessionName: string): Promise<string[]> {
    const warnings: string[] = [];

    const mouse = await this.tmuxAdapter.setSessionOption(sessionName, "mouse", "on");
    if (!mouse.ok) {
      warnings.push(`tmux "mouse" option not set for ${sessionName}: ${mouse.message}`);
    }

    let statusBar = false;
    try {
      statusBar = this.readTmuxOptionDefaults().statusBar === true;
    } catch {
      statusBar = false;
    }
    const status = await this.tmuxAdapter.setSessionOption(sessionName, "status", statusBar ? "on" : "off");
    if (!status.ok) {
      warnings.push(`tmux "status" option not set for ${sessionName}: ${status.message}`);
    }

    await this.ensureServerDefaults(warnings);
    return warnings;
  }

  /**
   * Assert the SERVER-scope tmux defaults (`set-clipboard on` + the
   * per-platform `copy-command`) on the daemon's OWN tmux server, ONCE per
   * daemon lifetime. Written only through `setServerOption` (`set-option
   * -s`) — never a `-t` session target (guard b2 scope contract).
   *
   * Per-process memoization means a daemon RESTART re-asserts these (a fresh
   * applier instance): an operator's manual `copy-command` / `set-clipboard`
   * override does NOT survive a daemon restart — the named off-switch
   * follow-up is the customization path. Re-running is harmless (idempotent
   * set of the same values); the memo is an optimization, not a correctness
   * gate.
   */
  private async ensureServerDefaults(warnings: string[]): Promise<void> {
    if (this.serverDefaultsAsserted) return;
    // Set first so concurrent applies don't double-assert; either way the
    // sets are idempotent.
    this.serverDefaultsAsserted = true;

    const clip = await this.tmuxAdapter.setServerOption("set-clipboard", "on");
    if (!clip.ok) {
      warnings.push(`tmux "set-clipboard" server option not set: ${clip.message}`);
    }

    const copyCommand = resolveCopyCommand(this.platform, this.hasCommand);
    if (copyCommand !== null) {
      const cc = await this.tmuxAdapter.setServerOption("copy-command", copyCommand);
      if (!cc.ok) {
        warnings.push(`tmux "copy-command" server option not set: ${cc.message}`);
      }
    }
  }
}

/**
 * OPR.0.4.6.02 S1 — the per-platform tmux `copy-command` table (arch rail
 * b). Ref: the tmux "Clipboard" wiki — `copy-command` is the shell command
 * tmux pipes a copy-mode selection into to reach the system clipboard.
 *  - darwin → `pbcopy`
 *  - linux  → `wl-copy` if present, else `xclip -selection clipboard -i`,
 *             else UNSET (null) — fall back to `set-clipboard on` OSC 52.
 *  - other  → UNSET (null).
 * Pure: platform + a `command -v` probe in, the command string (or null)
 * out. One table, no side effects — the applier decides whether to write.
 */
export function resolveCopyCommand(
  platform: NodeJS.Platform,
  hasCommand: (bin: string) => boolean,
): string | null {
  if (platform === "darwin") return "pbcopy";
  if (platform === "linux") {
    if (hasCommand("wl-copy")) return "wl-copy";
    if (hasCommand("xclip")) return "xclip -selection clipboard -i";
    return null;
  }
  return null;
}

/**
 * OPR.0.4.6.02 S1 — default `command -v <bin>` probe (POSIX shell builtin).
 * Returns true when the binary resolves on PATH. Cheap + best-effort; any
 * failure (spawn error, non-shell env) reads as absent.
 */
function defaultHasCommand(bin: string): boolean {
  try {
    const r = spawnSync(`command -v ${bin}`, { shell: true, stdio: "ignore" });
    return r.status === 0;
  } catch {
    return false;
  }
}
