import { TmuxAdapter } from "./adapters/tmux.js";
import { execArgvCommand, execCommand } from "./adapters/tmux-exec.js";

export async function createTerminalCommandSession(session: string, child: readonly string[], serverArgs: readonly string[], command: readonly string[]): Promise<string> {
  if (!command[0] || command.some(word => word.includes("\0"))) throw new Error("Invalid terminal executable argv");
  const argvExec = (argv: string[]) => execArgvCommand([...command, ...argv.slice(1)]);
  const adapter = new TmuxAdapter(execCommand, undefined, argvExec, serverArgs, process.platform === "win32" ? "psmux" : "tmux");
  return adapter.createDetachedCommandSession(session, child);
}

/** Offline cleanup uses the same exact targets, native bindings and guarded stop as the daemon. */
export async function stopTerminalSessionForCleanup(session: string, serverArgs: readonly string[] = []): Promise<"stopped" | "missing" | "unknown"> {
  const adapter = new TmuxAdapter(execCommand, undefined, execArgvCommand, serverArgs, process.platform === "win32" ? "psmux" : "tmux");
  try {
    const before = await adapter.probeSession(session);
    if (before.state === "absent") return "missing";
    if (before.state !== "present") return "unknown";
    const stopped = await adapter.killSession(session);
    if (!stopped.ok) return "unknown";
    return (await adapter.probeSession(session)).state === "absent" ? "stopped" : "unknown";
  } catch { return "unknown"; }
}
