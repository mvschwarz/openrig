import { tileAttachArgv078, tileAttachArgv079, tileAttachArgv0710 } from "./earlier-tile-attach.js";
import { tileAttachArgv0711 } from "./earlier-tile-attach-0711.js";

/** Writable tiles are native sizing clients: tmux's latest active client controls the PTY, including on resize.
 * Once attached, tmux handles keys/paste directly; no capture mirror, replay buffer or idle detacher.
 * Cross-rig read-only tiles retain their observer view and never type into or resize the source seat. */
export function tileAttachArgv(
  tmux: string, server: readonly string[], session: string, readOnly: boolean,
  retrySeconds = 30, idleSeconds = 30,
): string[] {
  return readOnly ? tileAttachArgv0711(tmux, server, session, true, retrySeconds, idleSeconds)
    : tileAttachArgv0710(tmux, server, session, false, retrySeconds);
}

/** Whether a kept tile is the one an earlier release generated for the same seat: exactly the command pre-reflow 0.7.11's, 0.7.10's, 0.7.9's,
 * or 0.7.5-0.7.8's, script makes for the current tile's session, tmux, server and read-only intent. An upgrade changes
 * only OpenRig's own script; any other difference, an edited script included, is a different attachment. */
export function earlierTileAttachment(kept: readonly string[], current: readonly string[], readOnly: boolean): boolean {
  if (current.length < 6) return false;
  const [session, tmux, ...server] = current.slice(4) as [string, string, ...string[]];
  return [tileAttachArgv0711, tileAttachArgv0710, tileAttachArgv079, tileAttachArgv078].some((make) => {
    const earlier = make(tmux, server, session, readOnly);
    return earlier.length === kept.length && earlier.every((word, i) => word === kept[i]);
  });
}
