// Text that came from somewhere else — a daemon answer, a socket path, a host's display name — must
// reach the operator's terminal as text, never as terminal control. An OSC sequence in a copied line
// can rewrite the window title or push a string into the clipboard; a CSI sequence can move the
// cursor and overwrite what the operator is reading.
//
// This is the one helper for that job. The sites that only need one field cleaned call it with
// `trim`; a caller that wants bidi marks removed asks for it, because they are kept by default: a
// right-to-left path or message is text the operator meant to have, and this helper removes terminal
// control rather than rewriting what they were reading. Both live here so the rules cannot drift
// apart between call sites.

import { stripVTControlCharacters } from "node:util";

export interface TerminalSafeOptions {
  /** Remove leading and trailing whitespace after cleaning. Default false. */
  trim?: boolean;
  /**
   * Keep bidi control characters. Default true: a legitimate right-to-left path or message carries
   * them, and this helper is here to remove terminal control, not to change text the operator meant
   * to have. A caller that wants them gone asks with `keepBidi: false`.
   */
  keepBidi?: boolean;
  /**
   * What a control byte becomes. `"space"` (the default) keeps two fields that a control byte
   * separated from running together, which is what a copied value needs. `"remove"` glues them, which
   * is what a display label needs: a host name that was never meant to contain a control byte should
   * read as the name it was, not as the name with gaps in it.
   */
  control?: "space" | "remove";
}

/**
 * `value` with terminal escape sequences taken out, and control characters left alone.
 *
 * Split from `replaceControlCharacters` so a caller that also redacts credentials can do it in the
 * right place: an escape sequence can interrupt a URL, and a control byte inside it becomes a space,
 * so redacting between these two stages is the only point where the credential is both intact and free
 * of the escapes that hid it.
 */
export function stripTerminalEscapes(value: string): string {
  const withoutOsc = value.replace(/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g, "");
  return stripVTControlCharacters(withoutOsc)
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .replace(/\x1b[@-_]/g, "");
}

/** `value` with its control characters replaced (or removed) and, on request, trimmed. */
export function replaceControlCharacters(value: string, options: TerminalSafeOptions = {}): string {
  const controls = options.keepBidi === false ? /[\x00-\x1f\x7f-\x9f\p{Bidi_Control}]/gu : /[\x00-\x1f\x7f-\x9f]/g;
  const withoutControls = value.replace(controls, options.control === "remove" ? "" : " ");
  return options.trim ? withoutControls.trim() : withoutControls;
}

/**
 * `value` with terminal control removed and anything unsafe replaced by a space.
 *
 * Order matters. An OSC sequence is consumed whole first, because Node's VT stripper does not handle
 * every payload (a window title with spaces, for example) and would otherwise leave its tail behind
 * as literal text. Then CSI and the remaining escape sequences, then the control ranges themselves.
 * C0/C1 and DEL become spaces rather than disappearing, so two fields that were separated by a
 * control byte do not run together.
 */
export function terminalSafeText(value: string, options: TerminalSafeOptions = {}): string {
  return replaceControlCharacters(stripTerminalEscapes(value), options);
}
