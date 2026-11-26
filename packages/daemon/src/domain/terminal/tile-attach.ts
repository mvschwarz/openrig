import { tileAttachArgv078, tileAttachArgv079, tileAttachArgv0710 } from "./earlier-tile-attach.js";
import { tileAttachArgv0711 } from "./earlier-tile-attach-0711.js";
import { pinnedTileAttachArgv0723 } from "./earlier-tile-attach-0723.js";
import { WINDOW_SIZE_PRIOR_OPTION } from "../../terminal/window-pin.js";

/** The window options recording a seat's standing size pin, as a writable tile sets it: the seat's width and height. */
export const SEAT_PIN_WIDTH_OPTION = "@openrig-pin-width";
export const SEAT_PIN_HEIGHT_OPTION = "@openrig-pin-height";
/** OpenRig's index in each of the seat session's hook arrays, so a person's own hooks on it are kept. */
export const SEAT_PIN_HOOK_INDEX = 93;

/** Writable tiles are native sizing clients: tmux's latest active client controls the PTY, including on resize.
 * Once attached, tmux handles keys/paste directly; no capture mirror, replay buffer or idle detacher.
 * A Herdr view's writable tiles pin their seat instead (`pinnedTileAttachArgv`).
 * Cross-rig read-only tiles retain their observer view and never type into or resize the source seat. */
export function tileAttachArgv(
  tmux: string, server: readonly string[], session: string, readOnly: boolean,
  retrySeconds = 30, idleSeconds = 30,
): string[] {
  return readOnly ? tileAttachArgv0711(tmux, server, session, true, retrySeconds, idleSeconds)
    : tileAttachArgv0710(tmux, server, session, false, retrySeconds);
}

/** Whether a kept tile is the one an earlier release generated for the same seat: exactly the command 0.7.23's pinned
 * writable tile, pre-reflow 0.7.11's, 0.7.10's, 0.7.9's, or 0.7.5-0.7.8's, script makes for the current tile's session,
 * tmux, server and read-only intent. An upgrade changes only OpenRig's own script; any other difference, an edited script
 * included, is a different attachment. */
export function earlierTileAttachment(kept: readonly string[], current: readonly string[], readOnly: boolean): boolean {
  if (current.length < 6) return false;
  const [session, tmux, ...server] = current.slice(4) as [string, string, ...string[]];
  const pinned0723 = (t: string, s: readonly string[], n: string, ro: boolean) => ro ? [] : pinnedTileAttachArgv0723(t, s, n);
  return [pinned0723, tileAttachArgv0711, tileAttachArgv0710, tileAttachArgv079, tileAttachArgv078].some((make) => {
    const earlier = make(tmux, server, session, readOnly);
    return earlier.length === kept.length && earlier.every((word, i) => word === kept[i]);
  });
}

/** A Herdr view's writable tile: 0.7.10's attach and follow, with the seat pinned before each attach (`pin`).
 * A writable tile is a tmux client of its seat, and tmux sizes a window from its latest client (`window-size latest`), so a
 * Herdr tile used to resize the agent to the tile, where it stayed after the tile closed; `attach -f ignore-size` doesn't
 * help, since tmux sizes a window from ignore-size clients when no other client does. So before each attach (the first one,
 * and every re-attach to a replacement session or after a Herdr restart), the tile:
 * - pins a window that isn't `manual` at its size then: `window-size manual`, the size in @openrig-pin-width/-height. A `manual`
 *   window without that record is someone else's fixed size and is left alone, hooks included;
 * - sets the seat session's hooks at index 93: `client-focus-in` fits the window to the focused client, `client-focus-out`
 *   and `client-detached` give the recorded size back. The focused client is the hook's own (`#{hook_client}`, tmux 3.3 and
 *   later), whose size the hook reads back: a client format there can name another client, such as another seat's tile.
 *   Without it (an older tmux, or a read that fails) the fit uses that format, as before. Each acts only while the window is still `manual` with the record,
 *   so unsetting `window-size` is a whole unpin until the next tile attach, and not while a temporary window pin (a web
 *   terminal's or a readable capture's, `window-pin.ts`) holds the window after an unpin. The resize runs in run-shell, since a hook's
 *   own arguments aren't format-expanded; the hooks use formats only, never a shell variable.
 * Focus reaches tmux only with its focus-events option on; without it the seat simply keeps its size. No client is fitted
 * on attach: tmux counts a new client as focused before any focus event, which would resize the seat on every attach.
 * A tile that can't read or set the pin attaches anyway, as before. */
export function pinnedTileAttachArgv(
  tmux: string, server: readonly string[], session: string,
  retrySeconds = 30,
): string[] {
  const w = SEAT_PIN_WIDTH_OPTION;
  const h = SEAT_PIN_HEIGHT_OPTION;
  const hook = (name: string, x: string, y: string) =>
    String.raw`"$@" set-hook -t "$sid" "${name}[${SEAT_PIN_HOOK_INDEX}]" "run-shell -b $q$g$r -x \"${x}\" -y \"${y}\"$q" 2>/dev/null;`;
  const own = (format: string) => `#{${format}}`;
  // The hook's own client's value, read back for that client (l: leaves the format for display-message to expand; ##
  // would break the conditional's braces); where tmux sets no hook_client (before 3.3), the plain format as before. The
  // choice is tmux's own conditional, since an unknown client makes display-message print nothing rather than fail.
  const focused = (format: string) =>
    String.raw`#{?hook_client,\$(\"$1\" -S \"#{socket_path}\" display-message -c \"#{hook_client}\" -p \"#{l:#{${format}}}\" 2>/dev/null),#{${format}}}`;
  // No apostrophes or control characters in the script: Herdr also stores this
  // argv as its restart command. All external values stay positional arguments; the hooks' quote comes from printf.
  const script = [
    'target=$1; shift;',
    // pin <window target> <tmux and server args...>: read the seat's window, pin it if it isn't manual, set its hooks.
    String.raw`pin() { s=$1; shift; "$@" display-message -p -t "$s" "#{session_id} #{window_id} #{window_width} #{window_height} #{window-size} #{${w}}" 2>/dev/null | {`,
    'read -r sid wid ww wh ws pw || exit 0;',
    `case "$ws" in manual) [ -n "$pw" ] || exit 0;; *) "$@" set-option -w -t "$wid" ${w} "$ww" 2>/dev/null && "$@" set-option -w -t "$wid" ${h} "$wh" 2>/dev/null && "$@" set-option -w -t "$wid" window-size manual 2>/dev/null || exit 0;; esac;`,
    String.raw`q=$(printf "\047"); r="\"$1\" -S \"#{socket_path}\" resize-window -t \"#{window_id}\""; g="[ -n \"#{${w}}\" ] && [ \"#{window-size}\" = manual ] && [ -z \"#{${WINDOW_SIZE_PRIOR_OPTION}}\" ] && ";`,
    hook("client-focus-in", focused("client_width"), focused("client_height")),
    hook("client-focus-out", own(w), own(h)),
    hook("client-detached", own(w), own(h)),
    '}; };',
    `snapshot=$("$@" display-message -p -t "=$target:" "#{pid} #{session_id}:#{session_name}" 2>/dev/null) || { exec "$@" attach -t "=$target"; };`,
    // display-message may succeed with empty/fallback context for a missing target.
    `if [ "\${snapshot#*:}" != "$target" ]; then exec "$@" attach -t "=$target"; fi;`,
    'snapshot=${snapshot%%:*};',
    'node=$("$@" show-environment -t "${snapshot#* }" OPENRIG_NODE_ID 2>/dev/null) || node=;',
    'case "$node" in OPENRIG_NODE_ID=?*) ;; *) node=;; esac;',
    'if [ -z "$node" ]; then',
    'printf "%s\\n" "No managed identity for $target; reopen this view after replacement.";',
    `pin "\${snapshot#* }:" "$@"; exec "$@" attach -t "\${snapshot#* }"; fi;`,
    'while :; do',
    `pin "\${snapshot#* }:" "$@"; "$@" attach -t "\${snapshot#* }";`,
    `left=${retrySeconds}; same=0;`,
    'while [ "$left" -gt 0 ]; do',
    'next=$("$@" display-message -p -t "=$target:" "#{pid} #{session_id}:#{session_name}" 2>/dev/null) || next=;',
    'if [ "${next#*:}" = "$target" ]; then next=${next%%:*}; else next=; fi;',
    'if [ -n "$next" ]; then',
    'identity=$("$@" show-environment -t "${next#* }" OPENRIG_NODE_ID 2>/dev/null) || identity=;',
    // A session can disappear between the two metadata reads; unknown waits.
    'if [ -n "$identity" ]; then',
    'if [ "$identity" != "$node" ]; then printf "%s\\n" "Seat identity changed for $target; reopen its view."; exit 1; fi;',
    'if [ "$next" != "$snapshot" ]; then snapshot=$next; break; fi;',
    // The stop adapter detaches BEFORE killing. Give that kill a chance to
    // finish; an ordinary Ctrl-b d leaves the original alive and ends the tile.
    'same=$((same + 1)); if [ "$same" -ge 3 ]; then exit 0; fi;',
    'else same=0; fi; else same=0; fi;',
    'sleep 1; left=$((left - 1));',
    'done;',
    'if [ "$left" -eq 0 ]; then printf "%s\\n" "No replacement for $target; reopen the view with rig terminal open."; exit 0; fi;',
    'done',
  ].join(" ");
  return ["/bin/sh", "-c", script, "openrig-tile", session, tmux, ...server];
}
