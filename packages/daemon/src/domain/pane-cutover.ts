import type { TmuxAdapter } from "../adapters/tmux.js";
import type { NativeProcessLister } from "./native-process-lineage.js";
import { exitPaneRuntime, type RuntimeExitTmux } from "./runtime-exit.js";

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
 *  `forced` when a signal it doesn't handle, or KILL after the window, ended it. `detail` says which, in a sentence. */
export type PaneTerminationResult = { ok: true; path: "graceful" | "forced"; detail: string } | { ok: false; message: string };

/** The occupant whose own exit comes before the pane's retirement: its runtime, and (tests) the process table it is read from. */
export interface PaneOccupant {
  runtime: string | null;
  listProcesses?: NativeProcessLister;
}

/**
 * Terminate the pane's occupant IN PLACE so a respawn (without -k) can reuse the pane and keep its scrollback.
 * `remain-on-exit` goes on FIRST so the pane survives dead instead of being destroyed. It leaves `remain-on-exit` on: the
 * caller decides when the pane no longer needs holding. Timing alone proves nothing about what the runtime saved before it
 * exited.
 *
 * #3901: with an `occupant` whose runtime has its own exit (runtime-exit.ts), that agent exits first and its exit is read
 * from the process table; then the pane is retired: a shell left at its prompt gets HUP (KILL after the window), which says
 * nothing about how the agent ended. Otherwise (another runtime, or no agent identified) the pane's root gets TERM, then
 * KILL after the window, as before.
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
  const remain = await tmux.setRemainOnExit(paneId, true);
  if (!remain.ok) failures.push(`remain-on-exit: ${remain.message}`);
  const detail = () => failures.length > 0 ? ` Tmux failures: ${failures.join("; ")}.` : "";

  const exited = occupant && tmux.getPanePid && tmux.signalPaneRuntime
    ? await exitPaneRuntime(tmux as RuntimeExitTmux, { pane: paneId, inputTarget, runtime: occupant.runtime }, timing, occupant.listProcesses)
    : null;
  if (exited?.state === "still_running") {
    return { ok: false, message: `${label} in pane "${paneId}" did not exit: ${exited.detail}${detail()}` };
  }
  if (exited?.state === "exited" || exited?.state === "no_runtime") {
    // The agent is gone; its shell (when it was typed into one) still holds the pane, which the respawn needs dead.
    if (!await retirePane(tmux, paneId, inputTarget, timing, failures)) {
      return { ok: false, message: `${label} in pane "${paneId}" ended (${exited.detail}), but the pane's shell did not exit after HUP + KILL.${detail()}` };
    }
    return { ok: true, path: exited.state === "exited" ? exited.path : "graceful", detail: exited.detail };
  }

  const term = await tmux.signalPaneProcess(inputTarget, "TERM");
  if (!term.ok) failures.push(`TERM: ${term.message}`);
  if (await waitPaneDead(tmux, paneId, timing)) {
    return { ok: true, path: "graceful", detail: exited ? `${exited.detail} The pane's process exited on TERM.` : "The pane's process exited on TERM." };
  }
  // Graceful window elapsed — force-kill (the pinned degraded path).
  const kill = await tmux.signalPaneProcess(inputTarget, "KILL");
  if (!kill.ok) failures.push(`KILL: ${kill.message}`);
  if (await waitPaneDead(tmux, paneId, timing)) {
    const window = `${(timing.timeoutMs / 1000).toFixed(1)} s`;
    return { ok: true, path: "forced", detail: exited ? `${exited.detail} The pane's process didn't exit within ${window} of TERM and was killed.`
      : `The pane's process didn't exit within ${window} of TERM and was killed.` };
  }
  return { ok: false, message: `${label} in pane "${paneId}" did not exit after graceful TERM + forced KILL.${detail()}` };
}

/** End the pane's remaining process (the shell an agent was typed into, now at its prompt) so the pane is dead: HUP, as a
 *  closing terminal sends, which a shell exits on (TERM is ignored by an interactive shell), then KILL after the window. */
async function retirePane(tmux: PaneCutoverTmux, paneId: string, inputTarget: string, timing: PaneCutoverTiming, failures: string[]): Promise<boolean> {
  if (await tmux.isPaneDead(paneId)) return true;
  const hup = await tmux.signalPaneProcess(inputTarget, "HUP");
  if (!hup.ok) failures.push(`HUP: ${hup.message}`);
  if (await waitPaneDead(tmux, paneId, timing)) return true;
  const kill = await tmux.signalPaneProcess(inputTarget, "KILL");
  if (!kill.ok) failures.push(`KILL: ${kill.message}`);
  return waitPaneDead(tmux, paneId, timing);
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
