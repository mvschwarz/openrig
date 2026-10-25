// A tile owns its attach process; no daemon watcher or steady-state polling.
// Session names survive fresh launch, handover and restart. The node identity
// must survive too: never follow a same-name session belonging to another seat.
export function tileAttachArgv(
  tmux: string, server: readonly string[], session: string, readOnly: boolean,
  retrySeconds = 30,
): string[] {
  const ro = readOnly ? "-r " : "";
  // No apostrophes or control characters in the script: Herdr also stores this
  // argv as its restart command. All external values stay positional arguments.
  const script = [
    'target=$1; shift;',
    `snapshot=$("$@" display-message -p -t "=$target:" "#{pid} #{session_id}" 2>/dev/null) || exec "$@" attach ${ro}-t "=$target";`,
    'node=$("$@" show-environment -t "${snapshot#* }" OPENRIG_NODE_ID 2>/dev/null) || node=;',
    'if [ -z "${node#*=}" ]; then',
    'printf "%s\\n" "No managed identity for $target; reopen this view after replacement.";',
    `exec "$@" attach ${ro}-t "\${snapshot#* }"; fi;`,
    'while :; do',
    `"$@" attach ${ro}-t "\${snapshot#* }";`,
    `left=${retrySeconds}; same=0;`,
    'while [ "$left" -gt 0 ]; do',
    'next=$("$@" display-message -p -t "=$target:" "#{pid} #{session_id}" 2>/dev/null) || next=;',
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
    '/bin/sleep 1; left=$((left - 1));',
    'done;',
    'if [ "$left" -eq 0 ]; then printf "%s\\n" "No replacement for $target; reopen the view with rig terminal open."; exit 0; fi;',
    'done',
  ].join(" ");
  return ["/bin/sh", "-c", script, "openrig-tile", session, tmux, ...server];
}
