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

function shellWord(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : "'" + value.replace(/'/g, "'\"'\"'") + "'";
}

/** `tmux`, with the daemon's server flags when it isn't on the default server. */
function tmuxOnDaemonServer(): string {
  const server = daemonServerArgs.map((arg, i) => (i % 2 === 0 ? arg : shellWord(arg))).join(" ");
  return `tmux${server ? ` ${server}` : ""}`;
}

/** The daemon's lookup of a seat's terminal substrate, recorded once at startup (absent: every seat is tmux). */
let daemonSubstrateOf: ((session: string) => string) | null = null;

export function setDaemonSubstrateLookup(lookup: ((session: string) => string) | null): void {
  daemonSubstrateOf = lookup;
}

/** The recorded lookup's answer; "tmux" when none is recorded or it can't answer (e.g. its daemon's DB is closed). */
function substrateOf(session: string): string {
  try { return daemonSubstrateOf?.(session) ?? "tmux"; } catch { return "tmux"; }
}

/** The attach COMMAND for a caller that runs or types it (cmux surfaces, layouts): null for a seat that isn't on tmux,
 *  so no prose hint ever reaches a shell (S3). Display callers use tmuxAttachCommand. */
export function tmuxAttachExecCommand(session: string): string | null {
  const bare = session.replace(/^'(.*)'$/, "$1");
  if (substrateOf(bare) !== "tmux") return null;
  return `${tmuxOnDaemonServer()} attach -t ${session}`;
}

/** `tmux attach -t <session>`, with the daemon's server flags when it isn't on the default server. A seat on another
 *  terminal substrate gets where to find it instead: a tmux attach by its name could reach an unrelated session. */
export function tmuxAttachCommand(session: string): string {
  const bare = session.replace(/^'(.*)'$/, "$1");
  const substrate = substrateOf(bare);
  if (substrate === "herdr") return `(Herdr seat: open Herdr and select the workspace "${bare}")`;
  if (substrate !== "tmux") return `(seat on terminal substrate "${substrate}": not attachable with tmux)`;
  return `${tmuxOnDaemonServer()} attach -t ${session}`;
}
