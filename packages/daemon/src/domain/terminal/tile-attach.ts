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
    ? 'open() { t=$1; shift; stty -echo -isig 2>/dev/null; view "$t" "" "$@"; };'
    : 'open() { t=$1; shift; while use "$t" "$@"; do :; done; };';
  // No apostrophes or control characters in the script: Herdr also stores this
  // argv as its restart command. All external values stay positional arguments.
  const script = [
    // A box-drawing rule (Claude Code draws them as wide as its window) is cut to the tile's width, so a narrow tile
    // doesn't spend most of its rows on one wrapped rule. The cut works on bytes, so no character can blank the view.
    // One tmux call a second reads the activity time and the screen together; the screen is drawn only after new
    // activity, and once more after it, since tmux records activity in whole seconds. The tile's width is read again
    // only after it's resized.
    // A session id is unique only within one tmux server, and a restarted server numbers its sessions from $0 again.
    // So each read also checks the server, and for a managed seat its identity, and anything else ends the view.
    'view() { t=$1; keys=$2; shift 2; last=; again=; d=$(printf "\\342\\224\\200"); nl=$(printf "\\nx"); nl=${nl%x};',
    'case "$t" in =*) p=;; *) p=${snapshot%% *};; esac; n=$node; cols=; rw=; rule=; trap "cols=" WINCH;',
    'while :; do',
    'if [ -n "$n" ]; then r=$("$@" display-message -p -t "$t" "#{pid} #{window_activity}" \\; show-environment -t "$t" OPENRIG_NODE_ID \\; capture-pane -p -e -t "$t" 2>/dev/null) || break;',
    'else r=$("$@" display-message -p -t "$t" "#{pid} #{window_activity}" \\; capture-pane -p -e -t "$t" 2>/dev/null) || break; fi;',
    'l=${r%%"$nl"*}; case "$r" in *"$nl"*) s=${r#*"$nl"};; *) s=;; esac; a=${l#* };',
    '[ -n "$a" ] && { [ -z "$p" ] || [ "${l%% *}" = "$p" ]; } || break;',
    'if [ -n "$n" ]; then [ "${s%%"$nl"*}" = "$n" ] || break; case "$s" in *"$nl"*) s=${s#*"$nl"};; *) s=;; esac; fi;',
    'if [ "$a" != "$last" ] || [ -n "$again" ]; then',
    'if [ "$a" != "$last" ]; then again=1; else again=; fi;',
    'case "$s" in *"$d$d$d$d"*) if [ -z "$cols" ]; then cols=$(stty size 2>/dev/null) || cols=; cols=${cols#* }; fi;',
    'case "$cols" in ""|*[!0-9]*) ;; *) if [ "$cols" -gt 0 ] && [ "$cols" -le 255 ]; then',
    'if [ "$cols" != "$rw" ]; then rule=$(printf "%${cols}s" "" | LC_ALL=C sed "s/ /$d/g"); rw=$cols; fi;',
    's=$(printf "%s\\n" "$s" | LC_ALL=C sed "s/\\($d\\)\\{$cols,\\}/$rule/g"); fi;; esac;; esac;',
    'printf "\\033[H\\033[2J%s\\n" "$s"; last=$a; fi;',
    // A writable tile waits for its next read on its own input, so the first key ends the wait at once. The input
    // goes to a file, which keeps every byte. A wait that can't run ends the view rather than reading without pause.
    'if [ -n "$keys" ]; then dd bs=4096 count=1 of="$f" 2>/dev/null || return 1; if [ -s "$f" ]; then return 0; fi;',
    'else sleep 1 || return 1; fi;',
    'done; return 1; };',
    // The first input goes through tmux as an attached client's does, and only while it's still the same seat. While a
    // writable tile shows, the tile's terminal frames pastes, so the whole first burst (a paste, or keys) is read into a
    // file, with a UTF-8 character it ends inside completed; nothing passes through a shell variable, so every byte is
    // kept, NUL included. A paste goes in as one (paste-buffer frames it if the agent asked for that). Then the tile
    // attaches and the keys go in through its client (send-keys -K), so tmux's own key table applies, the prefix
    // included: control bytes by name, the rest as text. tmux reads anything typed after that itself.
    // Without a terminal to read keys from, or a file to keep them in, a writable tile only views.
    'use() { t=$1; shift; f=$(mktemp 2>/dev/null) || f=;',
    'if [ -n "$f" ] && stty -icanon -echo -isig -icrnl min 0 time 10 2>/dev/null; then',
    'printf "\\033[?2004h"; view "$t" 1 "$@"; seen=$?; printf "\\033[?2004l"; [ "$seen" -ne 0 ] || take;',
    'else view "$t" "" "$@"; seen=$?; fi; stty sane 2>/dev/null;',
    'if [ "$seen" -ne 0 ] || ! here "$@"; then [ -z "$f" ] || rm -f "$f" "$f.p"; return 1; fi;',
    'if [ -s "$f.p" ]; then "$@" load-buffer -b "openrig-tile-$$" "$f.p" \\; paste-buffer -p -d -b "openrig-tile-$$" -t "$t" 2>/dev/null; fi; rm -f "$f.p";',
    'me=$(tty 2>/dev/null) || me=; w=;',
    'if [ -n "$me" ]; then idle "$me" "$@" & w=$!; fi;',
    'if [ -s "$f" ]; then go "$@"; else "$@" attach -t "$t"; fi;',
    'if [ -n "$w" ]; then kill "$w" 2>/dev/null; wait "$w" 2>/dev/null; fi; rm -f "$f"; return 0; };',
    'take() { stty min 0 time 1 2>/dev/null; b0=$(printf "\\033[200~"); b1=$(printf "\\033[201~"); i=0; pp=;',
    'case "$(dd if="$f" bs=6 count=1 2>/dev/null)" in "$b0") pp=1; stty min 0 time 10 2>/dev/null;; esac;',
    'while [ "$i" -lt 256 ]; do if [ -n "$pp" ] && LC_ALL=C grep -aqF -- "$b1" "$f"; then break; fi;',
    'dd bs=4096 count=1 of="$f.n" 2>/dev/null && [ -s "$f.n" ] || break; cat "$f.n" >> "$f"; i=$((i + 1)); done; rm -f "$f.n";',
    'if [ -n "$pp" ] && o=$(LC_ALL=C grep -abo -F -- "$b1" "$f" 2>/dev/null); then o=${o%%:*};',
    'dd if="$f" of="$f.p" bs=1 skip=6 count=$((o - 6)) 2>/dev/null; dd if="$f" of="$f.n" bs=1 skip=$((o + 6)) 2>/dev/null; mv "$f.n" "$f"; fi;',
    'm=0; for c in $(tail -c 4 "$f" | od -An -tu1 -v); do',
    'if [ "$c" -lt 128 ]; then m=0; elif [ "$c" -lt 192 ]; then [ "$m" -eq 0 ] || m=$((m - 1)); elif [ "$c" -lt 224 ]; then m=1;',
    'elif [ "$c" -lt 240 ]; then m=2; elif [ "$c" -lt 248 ]; then m=3; else m=0; fi; done;',
    'if [ "$m" -gt 0 ]; then stty min 0 time 10 2>/dev/null; dd bs=1 count="$m" 2>/dev/null >> "$f"; fi; };',
    'here() { v=$("$@" display-message -p -t "$t" "#{pid} #{session_id}" 2>/dev/null) || return 1; [ -n "${v#* }" ] || return 1;',
    '[ -z "$p" ] || [ "${v%% *}" = "$p" ] || return 1;',
    '[ -z "$n" ] || [ "$("$@" show-environment -t "$t" OPENRIG_NODE_ID 2>/dev/null)" = "$n" ]; };',
    // The keys go in the attach command itself, after attach-session: tmux runs them for the new client before it
    // reads anything typed since, so they keep their order.
    'go() { set -- "$@" attach -t "$t"; x=0; r0=0; for c in $(od -An -tu1 -v "$f"); do if [ "$c" -lt 32 ] || [ "$c" -eq 127 ]; then',
    'if [ "$x" -gt "$r0" ]; then set -- "$@" \\; send-keys -K -l -- "$(dd if="$f" bs=1 skip="$r0" count=$((x - r0)) 2>/dev/null)"; fi;',
    'case "$c" in 0) k=C-Space;; 9) k=Tab;; 13) k=Enter;; 27) k=Escape;; 28) k=C-\\\\;; 29) k=C-];; 30) k=C-^;; 31) k=C-_;; 127) k=BSpace;;',
    '*) k=C-$(printf "\\\\$(printf %o $((c + 96)))");; esac;',
    'set -- "$@" \\; send-keys -K "$k"; r0=$((x + 1)); fi; x=$((x + 1)); done;',
    'if [ "$x" -gt "$r0" ]; then set -- "$@" \\; send-keys -K -l -- "$(dd if="$f" bs=1 skip="$r0" count=$((x - r0)) 2>/dev/null)"; fi; "$@"; };',
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
    'if [ "$next" = "$snapshot" ]; then sleep 1 || exit 1; fi; snapshot=$next; break;',
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
