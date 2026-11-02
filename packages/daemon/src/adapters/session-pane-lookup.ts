import type { TmuxAdapter } from "./tmux.js";

/** Preserve explicit session-name semantics; older injected adapters keep their existing contract. */
export function listNamedSessionPanes(
  tmux: Pick<TmuxAdapter, "listPanes"> & Partial<Pick<TmuxAdapter, "listSessionPanes">>,
  session: string,
  allWindows = false,
  windowIndex?: number,
) {
  if (windowIndex !== undefined && (!Number.isSafeInteger(windowIndex) || windowIndex < 0)) throw new Error("Invalid window index");
  return tmux.listSessionPanes ? windowIndex === undefined ? tmux.listSessionPanes(session, allWindows) : tmux.listSessionPanes(session, allWindows, windowIndex)
    : windowIndex !== undefined ? tmux.listPanes(`=${session}:${windowIndex}`)
      : allWindows ? tmux.listPanes(session, true) : tmux.listPanes(session);
}

export function listNamedSessionWindows(
  tmux: Pick<TmuxAdapter, "listWindows"> & Partial<Pick<TmuxAdapter, "listSessionWindows">>, session: string, exactLegacy = false,
) {
  return tmux.listSessionWindows ? tmux.listSessionWindows(session) : tmux.listWindows(exactLegacy ? "=" + session : session);
}
