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

export function readNamedSessionPid(tmux: Pick<TmuxAdapter, "getPanePid"> & Partial<Pick<TmuxAdapter, "getSessionPanePid">>, session: string) {
  return tmux.getSessionPanePid ? tmux.getSessionPanePid(session) : tmux.getPanePid(session);
}
export function readNamedSessionCommand(tmux: Pick<TmuxAdapter, "getPaneCommand"> & Partial<Pick<TmuxAdapter, "getSessionPaneCommand">>, session: string) {
  return tmux.getSessionPaneCommand ? tmux.getSessionPaneCommand(session) : tmux.getPaneCommand(session);
}
export function captureNamedSessionContent(tmux: Pick<TmuxAdapter, "capturePaneContent"> & Partial<Pick<TmuxAdapter, "captureSessionContent">>, session: string,
  lines = 20, opts?: { escapeSequences?: boolean; joinWrappedLines?: boolean }) {
  return tmux.captureSessionContent ? tmux.captureSessionContent(session, lines, opts)
    : opts ? tmux.capturePaneContent(session, lines, opts) : tmux.capturePaneContent(session, lines);
}
export function captureNamedSessionScreen(tmux: Pick<TmuxAdapter, "capturePaneScreen"> & Partial<Pick<TmuxAdapter, "captureSessionScreen">>, session: string, opts?: { escapeSequences?: boolean }) {
  return tmux.captureSessionScreen ? tmux.captureSessionScreen(session, opts) : opts ? tmux.capturePaneScreen(session, opts) : tmux.capturePaneScreen(session);
}
