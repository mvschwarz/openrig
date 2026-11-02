// Which tmux server the daemon's sessions live on, as the flags a person's attach command needs.
//
// Startup selects either the inherited server or this OpenRig home's dedicated socket.
// Inherited commands keep tmux's normal environment-based selection; attachment metadata
// names that server for a new terminal. Isolation fixes both paths to the recorded socket.

import fs from "node:fs";
import path from "node:path";
import type { TmuxServerSelection } from "../domain/tmux-server-selection.js";
import { nativeViewerCommand } from "../domain/terminal/native-viewer-command.js";

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
  const socketPaths = socket.startsWith("/") ? path.posix : path;
  const tmpdir = env["TMUX_TMPDIR"]?.trim() ?? "";
  const customTmpdir = tmpdir !== "" && realpath(tmpdir) !== realpath("/tmp");
  if (!customTmpdir && uid !== undefined) {
    const standardDirs = [socketPaths.join("/tmp", `tmux-${uid}`), socketPaths.join(realpath("/tmp"), `tmux-${uid}`)];
    const socketDirs = [socketPaths.dirname(socket), realpath(socketPaths.dirname(socket))];
    if (socketDirs.some((dir) => standardDirs.includes(dir))) {
      const name = socketPaths.basename(socket);
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
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  // Native recovery guidance is entered in PowerShell; its single-quote
  // escaping differs from POSIX shells even though ordinary quoted paths match.
  return "'" + value.replace(/'/g, process.platform === "win32" ? "''" : "'\"'\"'") + "'";
}

/** `tmux`, with the daemon's server flags when it isn't on the default server. */
function tmuxOnDaemonServer(command: readonly string[]): string {
  const server = daemonServerArgs.map((arg, i) => (i % 2 === 0 ? arg : shellWord(arg))).join(" ");
  const executable = command.map(shellWord).join(" ");
  return `${process.platform === "win32" && (command.length !== 1 || command[0] !== "tmux") ? "& " : ""}${executable}${server ? ` ${server}` : ""}`;
}

/** `tmux attach -t <session>`, with the daemon's server flags when it isn't on the default server. */
export function tmuxAttachCommand(session: string, command: readonly string[] = ["tmux"]): string {
  if (!command[0] || [...command, ...daemonServerArgs, session].some(value => value.includes("\0"))) throw new Error("Invalid attach command argv");
  const argv = [...command, ...daemonServerArgs, "attach", "-t", session];
  // PowerShell 5's native call operator alters embedded quotes and drops empty
  // words even after shell parsing preserved them. Use the established native
  // argv bridge for those values; ordinary recovery hints stay readable.
  if (process.platform === "win32" && argv.some(value => value === "" || value.includes('"'))) return nativeViewerCommand(argv, "powershell.exe");
  return `${tmuxOnDaemonServer(command)} attach -t ${shellWord(session)}`;
}
