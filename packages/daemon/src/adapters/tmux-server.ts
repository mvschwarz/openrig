// Which tmux server the daemon's sessions live on, as the flags a person's attach command needs.
//
// Startup selects either the inherited server or this OpenRig home's dedicated socket.
// Inherited commands keep tmux's normal environment-based selection; attachment metadata
// names that server for a new terminal. Isolation fixes both paths to the recorded socket.

import fs from "node:fs";
import path from "node:path";
import type { TmuxServerSelection } from "../domain/tmux-server-selection.js";

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
  const socket = env["TMUX"]?.replace(/,\d+,\d+$/, "");
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
let daemonServerSelection: TmuxServerSelection | undefined;

/** Recorded once at daemon startup, before reconciliation or launch. */
export function setDaemonTmuxServer(args: readonly string[], selection?: TmuxServerSelection): void {
  daemonServerArgs = [...args];
  daemonServerSelection = selection;
}

/** Effective startup choice, including a deferred change while old seats survive. */
export function daemonTmuxServerInfo(): TmuxServerSelection | undefined {
  return daemonServerSelection;
}

/** The daemon's effective server flags; empty for legacy/injected compositions. */
export function daemonTmuxServerArgs(): readonly string[] {
  return daemonServerArgs;
}

function shellWord(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

/** `tmux attach -t <session>`, with the daemon's effective server flags. */
export function tmuxAttachCommand(session: string): string {
  const server = daemonServerArgs.map((arg, i) => (i % 2 === 0 ? arg : shellWord(arg))).join(" ");
  return `tmux${server ? ` ${server}` : ""} attach -t ${session}`;
}
