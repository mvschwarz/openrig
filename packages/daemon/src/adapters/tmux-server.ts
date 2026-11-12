// Which tmux server the daemon's sessions live on, as the flags a person's attach command needs.
//
// Startup selects either the inherited server or this OpenRig home's dedicated socket.
// Inherited commands keep tmux's normal environment-based selection; attachment metadata
// names that server for a new terminal. Isolation fixes both paths to the recorded socket.

import fs from "node:fs";
import path from "node:path";
import type { TmuxServerSelection } from "../domain/tmux-server-selection.js";
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

function shellWord(value: string, force = false): string {
  return !force && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

/** `tmux`, with the daemon's server flags when it isn't on the default server. */
export function tmuxOnDaemonServer(): string {
  const server = daemonServerArgs.map((arg, i) => (i % 2 === 0 ? arg : shellWord(arg))).join(" ");
  return `tmux${server ? ` ${server}` : ""}`;
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

/** `tmux attach -t <session>`, with the daemon's server flags when it isn't on the default server.
 *
 *  The session is encoded for tmux first and then quoted like any other shell word: callers type
 *  this line into a fresh terminal (the CMUX panes) or hand it to a person to run, and a session
 *  name is not guaranteed to be shell-safe — an adopted session's name comes from outside
 *  OpenRig. `shellWord` leaves the ordinary `name@rig` form byte-identical. `=` is the one
 *  character it cannot leave bare: zsh expands a word beginning with `=` to the path of that
 *  command, and with MAGIC_EQUAL_SUBST it can expand one inside a `name=value` word, so any
 *  session word carrying `=` is forced into quotes. A shell passes those quotes through. */
export function tmuxAttachCommand(session: string): string {
  const word = tmuxSessionWord(session);
  return `${tmuxOnDaemonServer()} attach -t ${shellWord(word, word.includes("="))}`;
}
