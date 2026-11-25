import { vi } from "vitest";
import type { NativeProcessRow } from "../../src/domain/native-process-lineage.js";
import type { ComposerSnapshot } from "../../src/domain/composer-prompts.js";
import type { TmuxAdapter } from "../../src/adapters/tmux.js";
import { codexTwoRowComposer } from "./codex-two-row-composer.js";

// #3901 test fixture: a retired agent exits through its own shutdown, read from the process table; the pane is retired after it.
// The process shapes below are the ones measured in the lane (bash pane root; Claude typed in through OpenRig's staged
// subshell, which execs it; Codex under OpenRig's `/bin/sh <staged script>`).

export const timing = { pollMs: 1, timeoutMs: 5, sleep: async () => {} };
export const T = (s: string) => `Wed Nov 25 09:00:${s} 2026`;
/** Something else on the machine, so a pane's processes all gone never reads as an empty (unreadable) table. */
export const init: NativeProcessRow = { pid: 1, ppid: 0, pgid: 1, tpgid: -1, command: "/sbin/init", executableName: "systemd", startedAt: T("00") };
export const bash = (foreground: number): NativeProcessRow => ({ pid: 100, ppid: 1, pgid: 100, tpgid: foreground, command: "-bash", executableName: "bash", startedAt: T("00") });
export const claude = (startedAt = T("05")): NativeProcessRow => ({ pid: 200, ppid: 100, pgid: 200, tpgid: 200,
  command: "/usr/local/bin/claude --session-id 11111111-2222-3333-4444-555555555555", executableName: "claude", startedAt });
export const launchScript: NativeProcessRow = { pid: 250, ppid: 100, pgid: 250, tpgid: 250,
  command: "/bin/sh /tmp/openrig-tmux-send-1-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.txt", executableName: "sh", startedAt: T("06") };
export const codex: NativeProcessRow = { pid: 300, ppid: 250, pgid: 250, tpgid: 250, command: "/opt/codex/bin/codex --no-daemon", executableName: "codex", startedAt: T("07") };

export type Signal = "TERM" | "HUP" | "KILL";

/** A pane whose processes react as the measured ones do: an interactive shell ignores TERM and exits on HUP or KILL;
 *  Claude exits on TERM; Codex exits through a submitted /exit and dies at once on a signal. */
export class Pane {
  rows: NativeProcessRow[];
  dead = false;
  panePid: number;
  effects: string[] = [];
  composer: ComposerSnapshot | null = null;
  /** What the runtime does on a signal; default: Claude exits on TERM, anything dies on KILL. */
  runtimeIgnores = new Set<Signal>();
  beforeRuntimeEffect: (() => void) | null = null;
  afterTyping: ((text: string) => ComposerSnapshot | null) | null = (text) => codexTwoRowComposerAt(text);

  constructor(rows: NativeProcessRow[], panePid = 100) { this.rows = [init, ...rows]; this.panePid = panePid; }

  list = vi.fn(async () => this.rows.map((row) => ({ ...row })));

  private runtimeGone(pid: number): void {
    const gone = new Set([pid, ...this.rows.filter((row) => row.pid === launchScript.pid && pid === codex.pid).map((row) => row.pid)]);
    this.rows = this.rows.filter((row) => !gone.has(row.pid));
    if (pid === this.panePid) { this.dead = true; this.rows = [init]; return; }
    // The shell takes the terminal back.
    this.rows = this.rows.map((row) => row.pid === this.panePid ? { ...row, tpgid: this.panePid } : row);
  }

  tmux(): TmuxAdapter {
    return {
      setRemainOnExit: vi.fn(async () => { this.effects.push("remain-on-exit"); return { ok: true }; }),
      getPanePid: vi.fn(async (target: string) => (this.dead || target === "%other" ? (target === "%other" ? 999 : null) : this.panePid)),
      isPaneDead: vi.fn(async () => this.dead),
      signalPaneRuntime: vi.fn(async (_target: string, pid: number, signal: "TERM" | "KILL", still: (pane: string) => Promise<boolean>) => {
        this.beforeRuntimeEffect?.();
        if (!await still("%1")) { this.effects.push(`refused ${signal} ${pid}`); return { ok: false, code: "process_changed", message: "changed" }; }
        this.effects.push(`${signal} ${pid}`);
        if (!this.runtimeIgnores.has(signal)) this.runtimeGone(pid);
        return { ok: true };
      }),
      signalPaneProcess: vi.fn(async (_target: string, signal: Signal) => {
        this.effects.push(`root ${signal}`);
        const root = this.rows.find((row) => row.pid === this.panePid);
        if (root && root.executableName === "bash" && signal === "TERM") return { ok: true }; // an interactive shell ignores TERM
        if (root?.executableName === "claude" && signal === "TERM" && this.runtimeIgnores.has("TERM")) return { ok: true };
        // The root dies; the kernel HUPs the foreground job, and a HUP'd shell passes HUP on: the pane empties.
        this.dead = true; this.rows = [init];
        return { ok: true };
      }),
      captureComposerSnapshot: vi.fn(async () => this.composer),
      sendText: vi.fn(async (_target: string, text: string, _before?: unknown, options?: { bracketed?: boolean }) => {
        this.effects.push(`type ${text}${options?.bracketed === false ? " (keys)" : ""}`);
        this.composer = this.afterTyping?.(text) ?? this.composer;
        return { ok: true };
      }),
      sendKeys: vi.fn(async (_target: string, keys: string[]) => {
        this.effects.push(`keys ${keys.join(" ")}`);
        if (keys.includes("Enter") && this.rows.some((row) => row.pid === codex.pid)) this.runtimeGone(codex.pid);
        return { ok: true };
      }),
    } as unknown as TmuxAdapter;
  }
}

/** Codex's box after typing: the text, with the cursor at its end. */
export function codexTwoRowComposerAt(text: string): ComposerSnapshot {
  const frame = codexTwoRowComposer(text);
  frame.cursor.x = 2 + text.length;
  return frame;
}

export const claudePane = () => new Pane([bash(200), claude()]);
export const codexPane = () => { const pane = new Pane([bash(250), launchScript, codex]); pane.composer = codexTwoRowComposer(""); return pane; };

