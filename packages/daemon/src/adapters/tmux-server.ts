// Which tmux server the daemon's sessions live on, as the flags a person's attach command needs.
//
// The daemon runs every tmux command without -L or -S, so tmux uses the server named by the
// daemon's inherited $TMUX when it was started from inside tmux, and otherwise the default
// server. A person attaching from a new terminal reaches the default server, so an attach
// command printed for a daemon on another server must name that server.

import fs from "node:fs";
import path from "node:path";

function realpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/**
 * The tmux server flags for an environment: none for the default server (or no $TMUX),
 * `-L <name>` for another socket in tmux's own socket directory, `-S <path>` for one elsewhere.
 * tmux's socket directory is `${TMUX_TMPDIR:-/tmp}/tmux-<uid>`.
 */
export function tmuxServerArgs(env: NodeJS.ProcessEnv, uid: number | undefined = process.getuid?.()): string[] {
  const socket = env["TMUX"]?.split(",")[0]?.trim();
  if (!socket) return [];
  const base = env["TMUX_TMPDIR"]?.trim() || "/tmp";
  const socketDirs = new Set([path.dirname(socket), realpath(path.dirname(socket))]);
  const ownDirs = uid === undefined ? [] : [path.join(base, `tmux-${uid}`), path.join(realpath(base), `tmux-${uid}`)];
  if (ownDirs.some((dir) => socketDirs.has(dir))) {
    const name = path.basename(socket);
    return name === "default" ? [] : ["-L", name];
  }
  return ["-S", socket];
}

let daemonServerArgs: string[] = [];

/** Recorded once at daemon startup, from the daemon's own environment. */
export function setDaemonTmuxServer(args: readonly string[]): void {
  daemonServerArgs = [...args];
}

/** The daemon's tmux server flags; empty for the default server. */
export function daemonTmuxServerArgs(): readonly string[] {
  return daemonServerArgs;
}

function shellWord(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

/** `tmux attach -t <session>`, with the daemon's server flags when it isn't on the default server. */
export function tmuxAttachCommand(session: string): string {
  const server = daemonServerArgs.map((arg, i) => (i % 2 === 0 ? arg : shellWord(arg))).join(" ");
  return `tmux${server ? ` ${server}` : ""} attach -t ${session}`;
}
