import { NO_SESSION_BUS } from "./domain/seat-runtime-dir.js";

/** tmux 3.3a–3.6 inherits its creating client's limits. This runs in that child only:
 * never lower an already higher soft limit, change the hard limit, or restart a server. */
export const TMUX_SERVER_LIMIT_WARNING = "[tmux] Could not raise the open-file limit for a new terminal server; continuing with the inherited limit.";
export const TMUX_SERVER_LIMIT_PREFIX = `
openrig_tmux_nofile() {
  openrig_tmux_soft=$(ulimit -S -n) || return 1
  case "$openrig_tmux_soft" in unlimited) return 0;; ''|*[!0-9]*) return 1;; esac
  openrig_tmux_hard=$(ulimit -H -n) || return 1
  openrig_tmux_target=8192
  case "$openrig_tmux_hard" in
    unlimited) ;;
    ''|*[!0-9]*) return 1;;
    *) if [ "$openrig_tmux_hard" -lt "$openrig_tmux_target" ]; then openrig_tmux_target=$openrig_tmux_hard; fi;;
  esac
  [ "$openrig_tmux_soft" -ge "$openrig_tmux_target" ] || ulimit -S -n "$openrig_tmux_target"
}
openrig_tmux_nofile 2>/dev/null || printf '%s\\n' '${TMUX_SERVER_LIMIT_WARNING}' >&2
`;

/** #3253: the session bus address a terminal server OpenRig starts gets in its own process: one that can't connect (the
 *  unknown `disabled:` transport, as NO_SESSION_BUS), marked as OpenRig's own. tmux copies it into the new server's
 *  global environment, and a start gives the panes the real value back there only while that environment still holds
 *  exactly this address, which only OpenRig's own starts set: a server another program started, or whose global
 *  environment a person's tmux configuration set (NO_SESSION_BUS included), is left as it is. A fixed value, not one made per daemon process: the server outlives
 *  the daemon (`tmux -D`, the user scope), and a daemon that starts again on the same server finds it and gives the bus
 *  back. Only OpenRig's own starts put it on that server, so "only our own value" holds across a restart. */
export const TMUX_SERVER_SESSION_BUS = `${NO_SESSION_BUS}openrig=tmux-server`;

/** #3253: the line that gives only OpenRig's own terminal-server process a session bus it can't reach. A systemd-enabled
 *  tmux moves every new pane into a tmux-spawn-*.scope through that bus (3.4: the server, right after the fork; 3.6: the
 *  child, before exec), which races the seat's own `systemd-run --scope` and takes an unlimited pane out of the server's
 *  cgroup. Without a bus the move is skipped; the requested seat limits still apply. tmux copies the starting process's
 *  environment into its global environment too, so the server start gives the panes the real value back there
 *  (TmuxAdapter.startServer). `export`: a bare assignment before `exec` isn't sure to reach a backgrounded command. */
export const TMUX_SERVER_NO_SESSION_BUS = `export DBUS_SESSION_BUS_ADDRESS=${TMUX_SERVER_SESSION_BUS}\n`;

/** Whether a shell command is a bare server start, `tmux [global flags] -D …` with no tmux command (the -D of
 *  `select-pane -D` or `attach-session -D` is not one). Only such a start gets TMUX_SERVER_NO_SESSION_BUS. */
export function startsServerOnly(cmd: string): boolean {
  // A word may join quoted and bare parts, as posixJoinArgv writes a path with an apostrophe: 'it'"'"'s'.
  const words = cmd.match(/(?:'[^']*'|"(?:[^"\\]|\\.)*"|\\.|[^\s'"\\])+/g) ?? [];
  if (words[0] !== "tmux") return false;
  for (let i = 1; words[i]?.startsWith("-"); i += ["-L", "-S", "-f", "-c", "-T"].includes(words[i]!) ? 2 : 1) {
    if (words[i] === "-D") return true;
  }
  return false;
}

/** Production callers use full command names. A matching data argument merely gets the same harmless child limit. */
export function mayStartTmuxServer(args: readonly string[]): boolean {
  return args.some(arg => ["new-session", "start-server", "attach-session", "-D"].includes(arg));
}

export function tmuxServerStartCommand(file: string, args: string[]): { file: string; args: string[] } {
  if (process.platform === "win32" || !mayStartTmuxServer(args)) return { file, args };
  return { file: "/bin/sh", args: ["-c", TMUX_SERVER_LIMIT_PREFIX + 'exec "$0" "$@"', file, ...args] };
}

let warned = false;
/** execFile captures stderr even on success; surface this advisory once per process. */
export function reportTmuxServerLimit(stderr: unknown): void {
  if (!warned && String(stderr ?? "").includes(TMUX_SERVER_LIMIT_WARNING)) {
    warned = true;
    console.warn(TMUX_SERVER_LIMIT_WARNING);
  }
}
