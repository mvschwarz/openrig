import type { TmuxAdapter } from "./tmux.js";

export function switchClientToNamedSession(
  tmux: Pick<TmuxAdapter, "switchClient"> & Partial<Pick<TmuxAdapter, "switchClientToSession">>,
  client: string, session: string, window: number,
) {
  return tmux.switchClientToSession ? tmux.switchClientToSession(client, session, window)
    : tmux.switchClient(client, `=${session}:${window}`);
}
