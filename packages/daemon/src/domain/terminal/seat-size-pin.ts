// A writable Herdr tile is a tmux client of its seat, and tmux sizes a window from its latest client (`window-size
// latest`). So watching a seat in Herdr resized the agent's real pane to the tile, and it stayed that size after the tile
// closed; `attach -f ignore-size` doesn't help, since tmux sizes a window from ignore-size clients when no other client
// does. Opening a Herdr view therefore pins each local seat it attaches to at the seat's own size (`window-size manual`,
// with the size recorded in @openrig_pin), and hooks on the seat's session fit the window to a client only while that
// client has keyboard focus (Herdr forwards focus in and out to its panes, and a tmux client asks for it when the server
// option focus-events is on), giving the pinned size back on focus-out and detach. Without focus events the seat simply
// keeps its size; OpenRig doesn't turn focus-events on, a server-wide choice.
// - No client is fitted on attach: tmux counts a new client as focused before any focus event arrives, so fitting there
//   would resize the seat on every open.
// - A window someone else made manual (no @openrig_pin) is theirs and is left alone.
// - The pin stays after the view closes: a Herdr restart or a tile's own reattach brings tiles back without an open, and
//   a pinned window at the seat's own size changes nothing for anyone.

/** The window option recording OpenRig's pin: the seat's own size, `<width>x<height>`. */
export const SEAT_PIN_OPTION = "@openrig_pin";
/** OpenRig's index in each hook array, so a person's own hooks on the session are kept. */
const HOOK_INDEX = 93;

/** Runs one tmux command (argv after the binary and server flags) on the seats' tmux server. */
export type TmuxRunner = (args: string[]) => Promise<string>;

/** The hook commands for a seat session. `tmux` is the binary the daemon resolved; `#{socket_path}` keeps the same server.
 *  run-shell expands the formats when the hook fires (a hook's own arguments aren't expanded). No single quotes inside. */
export function seatPinHooks(tmux: string): Array<[hook: string, command: string]> {
  const bin = `"${tmux}" -S "#{socket_path}"`;
  const fit = `[ -n "#{${SEAT_PIN_OPTION}}" ] && ${bin} resize-window -t "#{window_id}" -x "#{client_width}" -y "#{client_height}"`;
  const back = `p="#{${SEAT_PIN_OPTION}}"; [ -n "$p" ] && ${bin} resize-window -t "#{window_id}" -x "\${p%x*}" -y "\${p#*x}"`;
  return [
    ["client-focus-in", `run-shell -b '${fit}'`],
    ["client-focus-out", `run-shell -b '${back}'`],
    ["client-detached", `run-shell -b '${back}'`],
  ];
}

/** Pin each seat session's window at its own size and set its focus hooks, before Herdr attaches to it. Best effort: an
 *  open never fails on this, and each seat that couldn't be pinned is named in the returned notes. */
export async function pinSeatsForHerdr(run: TmuxRunner, tmux: string, sessions: readonly string[]): Promise<string[]> {
  const notes: string[] = [];
  const hooks = seatPinHooks(tmux);
  for (const session of new Set(sessions)) {
    try {
      // By id from here on: a seat name holds `@`, which tmux's session targets don't take exactly.
      const [sessionId, windowId, size, windowSize, pin] = (await run(["display-message", "-p", "-t", `=${session}:`,
        `#{session_id} #{window_id} #{window_width}x#{window_height} #{window-size} #{${SEAT_PIN_OPTION}}`])).trim().split(" ");
      if (!sessionId?.startsWith("$") || !windowId?.startsWith("@") || !size || !windowSize) throw new Error("its window couldn't be read");
      if (windowSize === "manual") {
        // A manual window without OpenRig's pin is someone else's fixed size (a person's, or a web terminal's or
        // readable capture's while it holds one): theirs to keep.
        if (!pin) { notes.push(`${session} has a fixed window size set by someone else; Herdr views leave it as it is.`); continue; }
      } else {
        // Not pinned now, including a pin whose window-size was dropped since (as a readable capture's note says how
        // to): pin at the size the seat has as this view opens.
        await run(["set-option", "-w", "-t", windowId, SEAT_PIN_OPTION, size]);
        await run(["set-option", "-w", "-t", windowId, "window-size", "manual"]);
      }
      for (const [hook, command] of hooks) await run(["set-hook", "-t", sessionId, `${hook}[${HOOK_INDEX}]`, command]);
    } catch (err) {
      notes.push(`${session} keeps tmux's usual sizing: its size couldn't be pinned (${err instanceof Error ? err.message : String(err)}), so a Herdr tile may resize it.`);
    }
  }
  return notes;
}
