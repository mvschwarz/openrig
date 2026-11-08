import { tileAttachArgv078, tileAttachArgv079, tileAttachArgv0710 } from "./earlier-tile-attach.js";

// A tile owns its view and attach processes; no daemon watcher. Its view reads the seat only after new activity.
// Session names survive fresh launch, handover and restart. The node identity
// must survive too: never follow a same-name session belonging to another seat.
export function tileAttachArgv(
  tmux: string, server: readonly string[], session: string, readOnly: boolean,
  retrySeconds = 30, idleSeconds = 30,
): string[] {
  // A tmux window has one size, and a client narrower than it sees only the left part of each line. So a tile shows the
  // seat by mirroring it rather than attaching, and attaches only while the person types in it.
  // - view: the seat's own screen, printed into the tile, whose terminal wraps each line at the tile's width. The tile is
  //   then no tmux client of the seat, so it never sizes, reflows or types into it. The screen is read again only when
  //   tmux records new activity in the window (read each second), and the view ends when the session goes, or, for a
  //   writable tile, when the person presses a key.
  // - use (writable tiles): that first key goes to the seat and the tile attaches, sizing the seat while it's used, as
  //   any client the person types in does. Once the tile has had no key for idleSeconds it detaches back to the view,
  //   as any other detach of it does.
  // - A read-only tile only views.
  const open = readOnly
    ? 'open() { t=$1; shift; view "$t" "" "$@"; };'
    : 'open() { t=$1; shift; while use "$t" "$@"; do :; done; };';
  // No apostrophes or control characters in the script: Herdr also stores this
  // argv as its restart command. All external values stay positional arguments.
  const script = [
    // A box-drawing rule (Claude Code draws them as wide as its window) is cut to the tile's width, so a narrow tile
    // doesn't spend most of its rows on one wrapped rule. The cut works on bytes, so no character can blank the view.
    // One tmux call a second reads the activity time and the screen together; the screen is drawn only after new
    // activity, and once more after it, since tmux records activity in whole seconds. The tile's width is read again
    // only after it's resized.
    'view() { t=$1; keys=$2; shift 2; last=; again=; k=; d=$(printf "\\342\\224\\200"); nl=$(printf "\\nx"); nl=${nl%x};',
    'cols=; rw=; rule=; trap "cols=" WINCH;',
    'while r=$("$@" display-message -p -t "$t" "#{window_activity}" \\; capture-pane -p -e -t "$t" 2>/dev/null)',
    '&& a=${r%%"$nl"*} && [ -n "$a" ]; do',
    'if [ "$a" != "$last" ] || [ -n "$again" ]; then',
    'if [ "$a" != "$last" ]; then again=1; else again=; fi;',
    'case "$r" in *"$nl"*) s=${r#*"$nl"};; *) s=;; esac;',
    'case "$s" in *"$d$d$d$d"*) if [ -z "$cols" ]; then cols=$(stty size 2>/dev/null) || cols=; cols=${cols#* }; fi;',
    'case "$cols" in ""|*[!0-9]*) ;; *) if [ "$cols" -gt 0 ] && [ "$cols" -le 255 ]; then',
    'if [ "$cols" != "$rw" ]; then rule=$(printf "%${cols}s" "" | LC_ALL=C sed "s/ /$d/g"); rw=$cols; fi;',
    's=$(printf "%s\\n" "$s" | LC_ALL=C sed "s/\\($d\\)\\{$cols,\\}/$rule/g"); fi;; esac;; esac;',
    'printf "\\033[H\\033[2J%s\\n" "$s"; last=$a; fi;',
    // A writable tile waits for its next read on its own input, so the first key ends the wait at once. A wait that
    // can't run ends the view rather than reading the seat without pause.
    'if [ -n "$keys" ]; then k=$(dd bs=64 count=1 2>/dev/null && printf x) || k=; [ -n "$k" ] || return 1;',
    'k=${k%x}; if [ -n "$k" ]; then return 0; fi;',
    'else sleep 1 || return 1; fi;',
    'done; return 1; };',
    // Without a terminal to read keys from, a writable tile only views.
    'use() { t=$1; shift;',
    'if stty -icanon -echo -isig -icrnl min 0 time 10 2>/dev/null; then view "$t" 1 "$@"; else view "$t" "" "$@"; fi;',
    'seen=$?; stty sane 2>/dev/null;',
    'if [ "$seen" -ne 0 ] || [ -z "$k" ]; then return 1; fi;',
    '"$@" send-keys -t "$t" -l -- "$k" 2>/dev/null;',
    'me=$(tty 2>/dev/null) || me=;',
    'if [ -n "$me" ]; then idle "$me" "$@" & w=$!; else w=; fi;',
    '"$@" attach -t "$t";',
    'if [ -n "$w" ]; then kill "$w" 2>/dev/null; wait "$w" 2>/dev/null; fi; return 0; };',
    'idle() { me=$1; shift; while sleep 1; do',
    'a=$("$@" display-message -p -c "$me" "#{client_activity}" 2>/dev/null) || return 0;',
    `if [ $(($(date +%s) - a)) -ge ${idleSeconds} ]; then "$@" detach-client -t "$me" 2>/dev/null; return 0; fi;`,
    'done; };',
    open,
    'target=$1; shift;',
    // When the seat can't be read, any view ends as soon as it starts, and tmux's own error (or the shell's, when
    // tmux isn't found) says why.
    `snapshot=$("$@" display-message -p -t "=$target:" "#{pid} #{session_id}:#{session_name}" 2>/dev/null) || { open "=$target" "$@"; exec "$@" has-session -t "=$target"; };`,
    // display-message may succeed with empty/fallback context for a missing target.
    `if [ "\${snapshot#*:}" != "$target" ]; then open "=$target" "$@"; exec "$@" has-session -t "=$target"; fi;`,
    'snapshot=${snapshot%%:*};',
    'node=$("$@" show-environment -t "${snapshot#* }" OPENRIG_NODE_ID 2>/dev/null) || node=;',
    'case "$node" in OPENRIG_NODE_ID=?*) ;; *) node=;; esac;',
    'if [ -z "$node" ]; then',
    'printf "%s\\n" "No managed identity for $target; reopen this view after replacement.";',
    `open "\${snapshot#* }" "$@"; exit 0; fi;`,
    'while :; do',
    `open "\${snapshot#* }" "$@";`,
    `left=${retrySeconds};`,
    'while [ "$left" -gt 0 ]; do',
    'next=$("$@" display-message -p -t "=$target:" "#{pid} #{session_id}:#{session_name}" 2>/dev/null) || next=;',
    'if [ "${next#*:}" = "$target" ]; then next=${next%%:*}; else next=; fi;',
    'if [ -n "$next" ]; then',
    'identity=$("$@" show-environment -t "${next#* }" OPENRIG_NODE_ID 2>/dev/null) || identity=;',
    // A session can disappear between the two metadata reads; unknown waits.
    'if [ -n "$identity" ]; then',
    'if [ "$identity" != "$node" ]; then printf "%s\\n" "Seat identity changed for $target; reopen its view."; exit 1; fi;',
    // A view that ended while its session is still there (a failed read) views it again.
    'if [ "$next" = "$snapshot" ]; then sleep 1; fi; snapshot=$next; break;',
    'fi; fi;',
    'sleep 1; left=$((left - 1));',
    'done;',
    'if [ "$left" -eq 0 ]; then printf "%s\\n" "No replacement for $target; reopen the view with rig terminal open."; exit 0; fi;',
    'done',
  ].join(" ");
  return ["/bin/sh", "-c", script, "openrig-tile", session, tmux, ...server];
}

/** Whether a kept tile is the one an earlier release generated for the same seat: exactly the command 0.7.10's, 0.7.9's,
 * or 0.7.5-0.7.8's, script makes for the current tile's session, tmux, server and read-only intent. An upgrade changes
 * only OpenRig's own script; any other difference, an edited script included, is a different attachment. */
export function earlierTileAttachment(kept: readonly string[], current: readonly string[], readOnly: boolean): boolean {
  if (current.length < 6) return false;
  const [session, tmux, ...server] = current.slice(4) as [string, string, ...string[]];
  return [tileAttachArgv0710, tileAttachArgv079, tileAttachArgv078].some((make) => {
    const earlier = make(tmux, server, session, readOnly);
    return earlier.length === kept.length && earlier.every((word, i) => word === kept[i]);
  });
}
