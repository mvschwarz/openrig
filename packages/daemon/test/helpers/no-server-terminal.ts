import { vi } from "vitest";
import { TmuxAdapter } from "../../src/adapters/tmux.js";

/** Real probe/startServer classification over modeled tmux command results; no native server. */
export function noServerTerminal(cause = "no server running on /tmp/tmux-1000/default") {
  let server = false;
  const commands: string[] = [];
  const adapter = new TmuxAdapter(async command => {
    commands.push(command);
    if (command.startsWith("tmux -D")) { server = true; return ""; }
    if (command.startsWith("tmux has-session")) throw new Error(server ? "can't find session" : cause);
    throw new Error(`Unexpected terminal command: ${command}`);
  });
  return {
    probeSession: vi.fn((name: string) => adapter.probeSession(name)),
    startServer: vi.fn(() => adapter.startServer()),
    commands, serverRunning: () => server,
  };
}
