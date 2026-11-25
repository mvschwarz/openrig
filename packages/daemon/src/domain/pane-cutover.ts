import type { PaneTerminal, TmuxAdapter } from "../adapters/tmux.js";
import type { NativeProcessLister } from "./native-process-lineage.js";
import { exitPaneRuntime, pinTerminal, type RuntimeExitTmux, type TerminalPin } from "./runtime-exit.js";

/** The tmux operations an in-place cutover needs: hold the pane, signal its root process, watch it die. With the runtime
 *  exit's operations too (the real adapter has them), a Claude Code or Codex occupant exits through its own shutdown first. */
export type PaneCutoverTmux = Pick<TmuxAdapter, "setRemainOnExit" | "signalPaneProcess" | "isPaneDead"> & Partial<RuntimeExitTmux>;

export interface PaneCutoverTiming {
  pollMs: number;
  /** Bounded wait for each phase (TERM, then KILL). */
  timeoutMs: number;
  sleep: (ms: number) => Promise<void>;
}

/** `path` is how the occupant ended: `graceful` when it exited through its own shutdown (or no agent was left running),
 *  `forced` when a signal it doesn't handle, or KILL after the window, ended it, or when the pane was stopped without its
 *  own exit being verified. `detail` says which, in a sentence. A failure's `code` is `guard_target_changed` when the pane
 *  was seen in another tmux session or on another server (#3901), and absent otherwise. */
export type PaneTerminationResult = { ok: true; path: "graceful" | "forced"; detail: string }
  | { ok: false; message: string; code?: "guard_target_changed" };

/** The occupant whose own exit comes before the pane's retirement: its runtime, and (tests) the process table it is read from.
 *  `terminal` is the pane's terminal as the caller read it when it resolved the pane (null: unreadable); without it, it's
 *  read when the cutover starts. */
export interface PaneOccupant {
  runtime: string | null;
  listProcesses?: NativeProcessLister;
  terminal?: PaneTerminal | null;
}

/**
 * Terminate the pane's occupant IN PLACE so a respawn (without -k) can reuse the pane and keep its scrollback.
 * `remain-on-exit` goes on FIRST so the pane survives dead instead of being destroyed. It leaves `remain-on-exit` on: the
 * caller decides when the pane no longer needs holding. Timing alone proves nothing about what the runtime saved before it
 * exited.
 *
 * #3901: with an `occupant` whose runtime has its own exit (runtime-exit.ts), that agent exits first and its exit is read
 * from the process table; then the pane is retired: a shell left at its prompt gets HUP (KILL after the window), which says
 * nothing about how the agent ended. Otherwise (another runtime, no agent identified, or an exit that couldn't be
 * verified) the pane's root gets TERM, then KILL after the window, as before, reported forced. The cutover fails only for
 * an agent seen still running after its KILL, or when the pane's own end can't be established (its dead state unreadable).
 * With an occupant, the pane's terminal (its tmux session and server) is read first, and the destructive effects after it
 * (the agent's signals, the typed input, and the pane-level retirement signals) are held to it: a pane seen in another
 * session or on another server is left alone (`guard_target_changed`). Setting remain-on-exit and the later respawn aren't.
 */
export async function terminatePaneInPlace(
  tmux: PaneCutoverTmux,
  paneId: string,
  timing: PaneCutoverTiming,
  label = "Retiree",
  inputTarget = paneId,
  occupant?: PaneOccupant,
): Promise<PaneTerminationResult> {
  const failures: string[] = [];
  // The pane's terminal (null: unreadable), which the signals and typed input below are held to.
  const terminal = occupant?.terminal !== undefined ? occupant.terminal : occupant && tmux.paneTerminal ? await tmux.paneTerminal(paneId) : undefined;
  const pin = terminal ? pinTerminal(tmux as Pick<TmuxAdapter, "paneTerminal">, terminal) : terminal;
  const signalPane = paneSignal(tmux, inputTarget, pin);
  const remain = await tmux.setRemainOnExit(paneId, true);
  if (!remain.ok) failures.push(`remain-on-exit: ${remain.message}`);
  const detail = () => failures.length > 0 ? ` Tmux failures: ${failures.join("; ")}.` : "";
  const changed = (): PaneTerminationResult => ({ ok: false, code: "guard_target_changed", message: `${label} in pane "${paneId}" was left `
    + `alone: the pane is no longer in the tmux session and server it was first read in (the server may have been replaced), so nothing more was sent to it.${detail()}` });

  const exited = occupant && tmux.getPanePid && tmux.signalPaneRuntime
    ? await exitPaneRuntime(tmux as RuntimeExitTmux, { pane: paneId, inputTarget, runtime: occupant.runtime, ...(pin !== undefined ? { pin } : {}) },
      timing, occupant.listProcesses)
    : null;
  if (exited?.state === "terminal_changed" || pin?.changed) return changed();
  if (exited?.state === "still_running") {
    return { ok: false, message: `${label} in pane "${paneId}" did not exit: ${exited.detail}${detail()}` };
  }
  if (exited?.state === "exited" || exited?.state === "no_runtime") {
    // The agent is gone; its shell (when it was typed into one) still holds the pane, which the respawn needs dead.
    if (!await retirePane(tmux, paneId, inputTarget, timing, failures, pin)) {
      if (pin?.changed) return changed();
      return { ok: false, message: `${label} in pane "${paneId}" ended (${exited.detail}), but the pane's shell did not exit after HUP + KILL.${detail()}` };
    }
    return { ok: true, path: exited.state === "exited" ? exited.path : "graceful", detail: exited.detail };
  }

  // Not identified, or its exit not verified (unknown, never "still running"): the pane-level stop, as before.
  const term = await signalPane("TERM");
  if (!term.ok) failures.push(`TERM: ${term.message}`);
  if (pin?.changed) return changed();
  if (await waitPaneDead(tmux, paneId, timing)) {
    // The runtime's own exit wasn't verified. A successful pane-level stop still proceeds, but doesn't prove its shutdown.
    return { ok: true, path: exited ? "forced" : "graceful", detail: exited ? `${exited.detail} The pane's process exited on TERM.` : "The pane's process exited on TERM." };
  }
  // Graceful window elapsed — force-kill (the pinned degraded path).
  const kill = await signalPane("KILL");
  if (!kill.ok) failures.push(`KILL: ${kill.message}`);
  if (pin?.changed) return changed();
  if (await waitPaneDead(tmux, paneId, timing)) {
    const window = `${(timing.timeoutMs / 1000).toFixed(1)} s`;
    return { ok: true, path: "forced", detail: exited ? `${exited.detail} The pane's process didn't exit within ${window} of TERM and was killed.`
      : `The pane's process didn't exit within ${window} of TERM and was killed.` };
  }
  return { ok: false, message: `${label} in pane "${paneId}" did not exit after graceful TERM + forced KILL.${detail()}` };
}

/** End the pane's remaining process (the shell an agent was typed into, now at its prompt) so the pane is dead: HUP, as a
 *  closing terminal sends, which a shell exits on (TERM is ignored by an interactive shell), then KILL after the window. */
async function retirePane(tmux: PaneCutoverTmux, paneId: string, inputTarget: string, timing: PaneCutoverTiming, failures: string[],
  pin: TerminalPin | null | undefined): Promise<boolean> {
  const signalPane = paneSignal(tmux, inputTarget, pin);
  if (await tmux.isPaneDead(paneId)) return true;
  const hup = await signalPane("HUP");
  if (!hup.ok) failures.push(`HUP: ${hup.message}`);
  if (pin?.changed) return false;
  if (await waitPaneDead(tmux, paneId, timing)) return true;
  const kill = await signalPane("KILL");
  if (!kill.ok) failures.push(`KILL: ${kill.message}`);
  return waitPaneDead(tmux, paneId, timing);
}

/** Signal the pane's root process, held to `pin`'s terminal when there is one (#3901). */
function paneSignal(tmux: PaneCutoverTmux, inputTarget: string, pin: TerminalPin | null | undefined) {
  return (signal: "TERM" | "HUP" | "KILL") => pin
    ? tmux.signalPaneProcess(inputTarget, signal, (pane) => pin.holds(pane))
    : tmux.signalPaneProcess(inputTarget, signal);
}

/** Poll `isPaneDead` up to the bounded timeout (count-bounded so injected no-op sleeps stay fast). */
export async function waitPaneDead(tmux: Pick<TmuxAdapter, "isPaneDead">, paneId: string, timing: PaneCutoverTiming): Promise<boolean> {
  const maxPolls = Math.max(1, Math.ceil(timing.timeoutMs / timing.pollMs));
  for (let i = 0; i < maxPolls; i++) {
    if (await tmux.isPaneDead(paneId)) return true;
    await timing.sleep(timing.pollMs);
  }
  return tmux.isPaneDead(paneId);
}
