// Frozen pinned-tile generator for exact upgrade recognition: a Herdr view's writable tile as 0.7.23 generated it
// (tile-attach.ts at v0.7.23, #3801), so a view kept across an upgrade is recognised only by a command OpenRig made.
// Values are literal here, so a later change to the live constants can't change what this recognises.
export function pinnedTileAttachArgv0723(
  tmux: string, server: readonly string[], session: string,
  retrySeconds = 30,
): string[] {
  const w = "@openrig-pin-width";
  const h = "@openrig-pin-height";
  const index = 93;
  const prior = "@openrig-window-size-prior";
  const hook = (name: string, x: string, y: string) =>
    String.raw`"$@" set-hook -t "$sid" "${name}[${index}]" "run-shell -b $q$g$r -x \"#{${x}}\" -y \"#{${y}}\"$q" 2>/dev/null;`;
  const script = [
    'target=$1; shift;',
    String.raw`pin() { s=$1; shift; "$@" display-message -p -t "$s" "#{session_id} #{window_id} #{window_width} #{window_height} #{window-size} #{${w}}" 2>/dev/null | {`,
    'read -r sid wid ww wh ws pw || exit 0;',
    `case "$ws" in manual) [ -n "$pw" ] || exit 0;; *) "$@" set-option -w -t "$wid" ${w} "$ww" 2>/dev/null && "$@" set-option -w -t "$wid" ${h} "$wh" 2>/dev/null && "$@" set-option -w -t "$wid" window-size manual 2>/dev/null || exit 0;; esac;`,
    String.raw`q=$(printf "\047"); r="\"$1\" -S \"#{socket_path}\" resize-window -t \"#{window_id}\""; g="[ -n \"#{${w}}\" ] && [ \"#{window-size}\" = manual ] && [ -z \"#{${prior}}\" ] && ";`,
    hook("client-focus-in", "client_width", "client_height"),
    hook("client-focus-out", w, h),
    hook("client-detached", w, h),
    '}; };',
    `snapshot=$("$@" display-message -p -t "=$target:" "#{pid} #{session_id}:#{session_name}" 2>/dev/null) || { exec "$@" attach -t "=$target"; };`,
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
    'if [ -n "$identity" ]; then',
    'if [ "$identity" != "$node" ]; then printf "%s\\n" "Seat identity changed for $target; reopen its view."; exit 1; fi;',
    'if [ "$next" != "$snapshot" ]; then snapshot=$next; break; fi;',
    'same=$((same + 1)); if [ "$same" -ge 3 ]; then exit 0; fi;',
    'else same=0; fi; else same=0; fi;',
    'sleep 1; left=$((left - 1));',
    'done;',
    'if [ "$left" -eq 0 ]; then printf "%s\\n" "No replacement for $target; reopen the view with rig terminal open."; exit 0; fi;',
    'done',
  ].join(" ");
  return ["/bin/sh", "-c", script, "openrig-tile", session, tmux, ...server];
}
