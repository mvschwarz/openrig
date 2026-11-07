import type { TmuxAdapter } from "../adapters/tmux.js";

/** The tmux operations an in-place cutover needs: hold the pane, signal its root process, watch it die. */
export type PaneCutoverTmux = Pick<TmuxAdapter, "setRemainOnExit" | "signalPaneProcess" | "isPaneDead">;

export interface PaneCutoverTiming {
  pollMs: number;
  /** Bounded wait for each phase (TERM, then KILL). */
  timeoutMs: number;
  sleep: (ms: number) => Promise<void>;
}

export type PaneTerminationResult = { ok: true; path: "graceful" | "forced" } | { ok: false; message: string };

/**
 * Terminate the pane's root process IN PLACE so a respawn (without -k) can reuse the pane and keep its
 * scrollback. `remain-on-exit` goes on FIRST so the pane survives dead instead of being destroyed; then a
 * graceful TERM, and a bounded-timeout KILL as the degraded fallback. It leaves `remain-on-exit` on: the
 * caller decides when the pane no longer needs holding. Timing alone proves nothing about what the runtime
 * saved before it exited.
 */
export async function terminatePaneInPlace(
  tmux: PaneCutoverTmux,
  paneId: string,
  timing: PaneCutoverTiming,
  label = "Retiree",
  inputTarget = paneId,
): Promise<PaneTerminationResult> {
  const failures: string[] = [];
  const remain = await tmux.setRemainOnExit(paneId, true);
  if (!remain.ok) failures.push(`remain-on-exit: ${remain.message}`);
  const term = await tmux.signalPaneProcess(inputTarget, "TERM");
  if (!term.ok) failures.push(`TERM: ${term.message}`);
  if (await waitPaneDead(tmux, paneId, timing)) return { ok: true, path: "graceful" };
  // Graceful window elapsed — force-kill (the pinned degraded path).
  const kill = await tmux.signalPaneProcess(inputTarget, "KILL");
  if (!kill.ok) failures.push(`KILL: ${kill.message}`);
  if (await waitPaneDead(tmux, paneId, timing)) return { ok: true, path: "forced" };
  const detail = failures.length > 0 ? ` Tmux failures: ${failures.join("; ")}.` : "";
  return { ok: false, message: `${label} in pane "${paneId}" did not exit after graceful TERM + forced KILL.${detail}` };
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
