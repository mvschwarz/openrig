// Which tmux server the daemon's sessions live on, as the flags a person's attach command needs.
//
// Startup selects either the inherited server or this OpenRig home's dedicated socket.
// Inherited commands keep tmux's normal environment-based selection; attachment metadata
// names that server for a new terminal. Isolation fixes both paths to the recorded socket.

import fs from "node:fs";
import path from "node:path";
import type { TmuxServerSelection } from "../domain/tmux-server-selection.js";
import { nativeViewerCommand } from "../domain/terminal/native-viewer-command.js";
import { readPlatformEnv } from "../domain/platform-env.js";
import { bindNativeSessionName } from "../domain/terminal/native-session-name.js";
import { windowsTileAttachArgv } from "../domain/terminal/windows-tile-attach.js";
import { powershellQuote } from "./windows-launch.js";
import type { TmuxControlStatus } from "./tmux-control.js";

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
  const socket = readPlatformEnv(env, "TMUX")?.replace(/,\d+,\d+$/, "");
  if (!socket?.trim()) return [];
  const socketPaths = socket.startsWith("/") ? path.posix : path;
  const tmpdir = readPlatformEnv(env, "TMUX_TMPDIR")?.trim() ?? "";
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
let daemonAttachCommand: readonly string[] = ["tmux"];

/** Recorded once at daemon startup, before reconciliation or launch. */
export function setDaemonTmuxServer(args: readonly string[], selection?: TmuxServerSelection): void {
  daemonServerArgs = [...args];
  daemonServerSelection = selection;
  daemonAttachCommand = ["tmux"];
}

/** Pin generated recovery guidance to the daemon's resolved executable. */
export function setDaemonTmuxAttachCommand(command: readonly string[]): void {
  if (!command[0] || command.some(word => word.includes("\0"))) throw new Error("Invalid attach command argv");
  daemonAttachCommand = [...command];
}

/** Effective startup choice, including a deferred change while old seats survive. */
export function daemonTmuxServerInfo(): TmuxServerSelection | undefined {
  return daemonServerSelection;
}

/** The daemon's effective server flags; empty for legacy/injected compositions. */
export function daemonTmuxServerArgs(): readonly string[] {
  return daemonServerArgs;
}

/** Whether OPENRIG_TMUX_CONTROL=1 asked for control mode, and the control client's own account of it: recorded once at
 *  startup. With no client (psmux, an injected exec) a request reads off. */
let daemonControl: { requested: boolean; status?: () => TmuxControlStatus } = { requested: false };

export function setDaemonTmuxControl(control: { requested: boolean; status?: () => TmuxControlStatus }): void {
  daemonControl = control;
}

/** What `GET /api/adapters/tmux/control` answers, and `rig doctor` reads. */
export function daemonTmuxControlStatus(): { requested: boolean } & TmuxControlStatus {
  if (!daemonControl.requested) return { requested: false, state: "off" };
  return { requested: true, ...(daemonControl.status?.() ?? { state: "off" }) };
}

/** Structured executable and prefix arguments; never a shell command. */
export function daemonTmuxAttachCommand(): string[] {
  return [...daemonAttachCommand];
}

function shellWord(value: string, force = false): string {
  if (!force && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  // Native recovery guidance is entered in PowerShell; its single-quote
  // escaping differs from POSIX shells even though ordinary quoted paths match.
  return "'" + value.replace(/'/g, process.platform === "win32" ? "''" : "'\"'\"'") + "'";
}

/** `tmux`, with the daemon's server flags when it isn't on the default server. */
export function tmuxOnDaemonServer(command: readonly string[] = daemonAttachCommand): string {
  const server = daemonServerArgs.map((arg, i) => (i % 2 === 0 ? arg : shellWord(arg))).join(" ");
  const executable = command.map(value => shellWord(value)).join(" ");
  return `${process.platform === "win32" && (command.length !== 1 || command[0] !== "tmux") ? "& " : ""}${executable}${server ? ` ${server}` : ""}`;
}

/** A session name as tmux must receive it.
 *
 *  Callers hand this a raw session name, not an argument tmux has already escaped, so the name is
 *  encoded exactly once here, for the tmux rules that apply at this layer.
 *
 *  `cmd_parse_from_arguments` drops a final `;` as a command separator and consumes a backslash
 *  sitting immediately in front of it. One more backslash goes before that separator, whether or
 *  not one is already there: a session named `report;` goes as `report\;` and one named `report\;`
 *  goes as `report\\;`, so the two stay different all the way to tmux.
 *
 *  `cmd_find_parse_target` reads several spellings as target markers rather than as part of a name:
 *  a leading `=` is the exact-match prefix, a leading `@` a window target, a leading `%` a pane
 *  target, and the words `~` and `{marked}` mean the marked target. One more `=` in front turns
 *  each of those back into a session name, because the marker is consumed and the rest is looked up
 *  as the name. A name starting with `$` is the one that cannot be rescued this way:
 *  `cmd_find_get_session` reads it as a session id before the exact-match flag is consulted. */
function tmuxSessionWord(session: string): string {
  const markedTarget = session === "~" || session === "{marked}";
  let word = /^[=@%]/.test(session) || markedTarget ? `=${session}` : session;
  if (word.endsWith(";")) word = `${word.slice(0, -1)}\\;`;
  return word;
}

/** `tmux attach -t <session>`, with the daemon's server flags when it isn't on the default server. */
export function tmuxAttachCommand(session: string, command: readonly string[] = daemonAttachCommand): string {
  if (!command[0] || [...command, ...daemonServerArgs, session].some(value => value.includes("\0"))) throw new Error("Invalid attach command argv");
  if (process.platform !== "win32") {
    const word = tmuxSessionWord(session);
    return `${tmuxOnDaemonServer(command)} attach -t ${shellWord(word, word.includes("="))}`;
  }
  if (process.platform === "win32" && bindNativeSessionName(session).marker) {
    const argv = windowsTileAttachArgv(command[0], [...command.slice(1), ...daemonServerArgs], session, false);
    return "& " + argv.map(powershellQuote).join(" ");
  }
  // This API receives a session name, not a tmux target expression. A stale
  // hint must not fall back to a surviving session with the same prefix.
  const target = "=" + session;
  const argv = [...command, ...daemonServerArgs, "attach", "-t", target];
  // PowerShell 5's native call operator alters embedded quotes and drops empty
  // words even after shell parsing preserved them. Use the established native
  // argv bridge for those values; ordinary recovery hints stay readable.
  if (process.platform === "win32" && argv.some(value => value === "" || value.includes('"'))) return nativeViewerCommand(argv, "powershell.exe");
  return `${tmuxOnDaemonServer(command)} attach -t ${shellWord(target)}`;
}
