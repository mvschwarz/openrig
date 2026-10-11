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
 * The tmux server flags for an environment. `-L <name>` and the bare form resolve under the attaching
 * terminal's own TMUX_TMPDIR, so they're used only for tmux's standard directory (`/tmp/tmux-<uid>`)
 * with no custom TMUX_TMPDIR in play: nothing for its `default` socket, `-L <name>` for another.
 * Every other socket is named by its path, `-S <path>`. Outside tmux (no $TMUX), nothing: the daemon
 * shares the TMUX_TMPDIR of the shell that started it, so the default form stays as it was.
 */
export function tmuxServerArgs(env: NodeJS.ProcessEnv, uid: number | undefined = process.getuid?.()): string[] {
  // tmux puts the socket path first, as is: keep any whitespace in it.
  const socket = env["TMUX"]?.split(",")[0];
  if (!socket?.trim()) return [];
  const tmpdir = env["TMUX_TMPDIR"]?.trim() ?? "";
  const customTmpdir = tmpdir !== "" && realpath(tmpdir) !== realpath("/tmp");
  if (!customTmpdir && uid !== undefined) {
    const standardDirs = [path.join("/tmp", `tmux-${uid}`), path.join(realpath("/tmp"), `tmux-${uid}`)];
    const socketDirs = [path.dirname(socket), realpath(path.dirname(socket))];
    if (socketDirs.some((dir) => standardDirs.includes(dir))) {
      const name = path.basename(socket);
      return name === "default" ? [] : ["-L", name];
    }
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
