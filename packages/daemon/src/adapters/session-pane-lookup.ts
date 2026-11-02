import type { TmuxAdapter } from "./tmux.js";

/** Preserve explicit session-name semantics; older injected adapters keep their existing contract. */
export function listNamedSessionPanes(
  tmux: Pick<TmuxAdapter, "listPanes"> & Partial<Pick<TmuxAdapter, "listSessionPanes">>,
  session: string,
  allWindows = false,
) {
  return tmux.listSessionPanes ? tmux.listSessionPanes(session, allWindows)
    : allWindows ? tmux.listPanes(session, true) : tmux.listPanes(session);
}
