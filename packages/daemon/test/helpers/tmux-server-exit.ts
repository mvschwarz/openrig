import { execFile } from "node:child_process";
import { promisify } from "node:util";

const runFile = promisify(execFile);

/** The tmux server on `socket` and every process under it; empty when no server answers. */
export async function tmuxServerProcesses(socket: string, env: NodeJS.ProcessEnv): Promise<Set<number>> {
  let listed: string;
  try {
    listed = (await runFile("tmux", ["-S", socket, "list-panes", "-a", "-F", "#{pid} #{pane_pid}"], { env })).stdout;
  } catch {
    return new Set();
  }
  const owned = new Set(listed.split(/\s+/).filter(Boolean).map(Number));
  const { stdout } = await runFile("ps", ["-axo", "pid=,ppid="]);
  const tree = stdout.trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number));
  for (let added = true; added;) {
    added = false;
    for (const [pid, parent] of tree) {
      if (owned.has(parent!) && !owned.has(pid!)) { owned.add(pid!); added = true; }
    }
  }
  return owned;
}

/**
 * kill-server returns once the server is signalled, while its pane shells are still exiting and can
 * write into their HOME (zsh saves history on SIGHUP). Kill the server, then wait until it, every
 * process under it and any `known` process from earlier (such as a pane a test already killed) are gone.
 */
export async function killTmuxServerAndWait(socket: string, env: NodeJS.ProcessEnv,
  known: Iterable<number> = [], timeoutMs = 5000): Promise<void> {
  const owned = new Set([...known, ...await tmuxServerProcesses(socket, env)]);
  await runFile("tmux", ["-S", socket, "kill-server"], { env }).catch(() => {});
  const alive = (pid: number) => {
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  };
  const deadline = Date.now() + timeoutMs;
  while ([...owned].some(alive)) {
    if (Date.now() >= deadline) throw new Error(`tmux server ${socket} left processes running: ${[...owned].filter(alive).join(" ")}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
