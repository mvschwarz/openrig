// Keyboard + mouse byte decoding. Mouse uses xterm SGR (1006) reporting:
// ESC [ < b ; x ; y M/m — the standard tmux/iTerm/Terminal.app mouse encoding.
// Mouse events are resolved against the renderer's hit-map by the caller and
// then dispatched through the SAME dispatch as commands and keys (PIN 1).
import type { Action, InputEvent, Screen, ViewState } from "./types.js";
import { specDetailArrowsScroll } from "./state.js";
import { StringDecoder } from "node:string_decoder";

function parseText(text: string, final: boolean, skipLF = false): { events: InputEvent[]; remainder: string; skipLF: boolean } {
  const events: InputEvent[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i] ?? "";
    if (skipLF) {
      skipLF = false;
      if (ch === "\n") { i += 1; continue; }
    }
    if (ch === "\x1b") {
      const tail = text.slice(i);
      if (!final && "\x1b[200~".startsWith(tail)) break;
      if (tail.startsWith("\x1b[200~")) {
        const end = text.indexOf("\x1b[201~", i + 6);
        if (end < 0 && !final) break;
        events.push({ type: "paste", text: text.slice(i + 6, end < 0 ? text.length : end).replace(/[\x00-\x1f\x7f]/g, " ") });
        i = end < 0 ? text.length : end + 6;
        continue;
      }
      if (i + 1 >= text.length && !final) break;
      if (text[i + 1] === "[") {
        if (i + 2 >= text.length && !final) break;
        const code = text[i + 2];
        if (code === "<") {
          const tail = text.slice(i);
          const match = tail.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
          if (match) {
            const button = Number(match[1]);
            if (match[4] === "M" && (button & 3) !== 3 && button < 32)
              events.push({ type: "mouse", button: button & 3, x: Number(match[2]), y: Number(match[3]) });
            // Preserve wheel coordinates. The renderer owns the actual pane boundary,
            // so routing before this point would make pointer-local scrolling impossible.
            else if (match[4] === "M" && (button & 64) !== 0) {
              events.push({ type: "mouse", button, x: Number(match[2]), y: Number(match[3]) });
            }
            i += match[0].length;
            continue;
          }
          if (!final && /^\x1b\[<[0-9;]*$/.test(tail)) break;
        }
        if ((code === "5" || code === "6") && i + 3 >= text.length && !final) break;
        if ((code === "5" || code === "6") && text[i + 3] === "~") {
          const down = code === "6";
          events.push({
            type: "key",
            key: down ? "pagedown" : "pageup",
            action: { type: "content-scroll", delta: down ? 10 : -10 },
          });
          i += 4;
          continue;
        }
        const key = code === "A" ? "up" : code === "B" ? "down" : code === "C" ? "right" : code === "D" ? "left" : null;
        if (key) {
          events.push({
            type: "key",
            key,
            action: { type: "select", delta: key === "down" ? 1 : key === "up" ? -1 : 0 },
          });
          i += 3;
          continue;
        }
        // A complete unsupported terminal key (Home/End/Delete, modifiers, etc.)
        // is one event, never a bare Escape followed by command text.
        const sequence = tail.match(/^\x1b\[[0-?]*[ -/]*[@-~]/);
        if (sequence) { i += sequence[0].length; continue; }
        if (!final && /^\x1b\[[0-?]*[ -/]*$/.test(tail)) break;
      }
      if (!final && tail === "\x1bO") break;
      if (/^\x1bO[@-~]/.test(tail)) {
        // Application-cursor mode sends SS3 arrows instead of CSI arrows.
        const code = text[i + 2];
        const key = code === "A" ? "up" : code === "B" ? "down" : code === "C" ? "right" : code === "D" ? "left" : null;
        if (key) events.push({ type: "key", key, action: { type: "select", delta: key === "down" ? 1 : key === "up" ? -1 : 0 } });
        i += 3;
        continue;
      }
      events.push({ type: "key", key: "escape" });
      i += 1;
      continue;
    }
    if (ch === "\t") { events.push({ type: "key", key: "tab" }); i += 1; continue; }
    if (ch === "\r" || ch === "\n") {
      skipLF = ch === "\r";
      events.push({ type: "key", key: "enter", action: { type: "activate" } });
      i += 1;
      continue;
    }
    if (ch === "\x7f" || ch === "\b") {
      events.push({ type: "key", key: "backspace" });
      i += 1;
      continue;
    }
    const char = String.fromCodePoint(text.codePointAt(i)!);
    if (char >= " ") events.push({ type: "char", ch: char });
    i += char.length;
  }
  return { events, remainder: text.slice(i), skipLF };
}

export interface InputDecoder {
  write(bytes: string | Buffer): InputEvent[];
  flush(): InputEvent[];
  /** true while a split escape sequence (or a lone Esc) is being held for more bytes —
   * the caller flushes after a short quiet gap so a bare Esc keypress is delivered. */
  hasPending(): boolean;
}

/** Stateful terminal-stream decoder: retains split escape sequences and uses
 * Node's StringDecoder so UTF-8 code points survive arbitrary Buffer chunks. */
export function createInputDecoder(): InputDecoder {
  const utf8 = new StringDecoder("utf8");
  let pending = "";
  let skipLF = false;
  return {
    write(bytes) {
      pending += typeof bytes === "string" ? bytes : utf8.write(bytes);
      const parsed = parseText(pending, false, skipLF);
      pending = parsed.remainder;
      skipLF = parsed.skipLF;
      return parsed.events;
    },
    flush() {
      const parsed = parseText(pending, true, skipLF);
      pending = parsed.remainder;
      skipLF = parsed.skipLF;
      return parsed.events;
    },
    hasPending() {
      // Bracketed paste may pause across chunks; only an escape prefix needs the short key timer.
      return pending.length > 0 && !pending.startsWith("\x1b[200~");
    },
  };
}

/** Whole-buffer convenience used by tests and synthetic adapters. */
export function decodeInput(bytes: string | Buffer): InputEvent[] {
  const decoder = createInputDecoder();
  return [...decoder.write(bytes), ...decoder.flush()];
}

/** Test/automation helper: the SGR bytes a terminal emits for a left click at (x, y). */
export function sgrClick(x: number, y: number): string {
  return `\x1b[<0;${x};${y}M\x1b[<0;${x};${y}m`;
}

/** Resolve the back control advertised by SCOPES detail pages. */
export function resolveEscapeAction(
  event: Extract<InputEvent, { type: "key" }>,
  state: ViewState,
  commandEditing = false,
): Action | null {
  if (event.key !== "escape" || commandEditing) return null;
  if ((state.file || state.externalUrl || (state.section === "specs" && state.drill.length > 0)) && state.history?.length) return { type: "back" };
  if (state.healthOpen) return { type: "health-close" };
  if (state.filter) return { type: "filter", text: "" };
  if (state.history?.length) return { type: "back" };
  if (state.section !== "scopes") return null;
  if (state.executionOpen) return { type: "execution-close" };
  return state.scopesSelected
    ? { type: "scopes-mission-open", mission: state.scopesSelected.mission }
    : null;
}

/** Resolve directional/Enter keys against the currently rendered pane. */
export function resolveKeyAction(
  event: Extract<InputEvent, { type: "key" }>,
  state: ViewState,
  screen: Screen,
  explorerCount: number,
): Action | null {
  // PULSE (founder Option-B) is a content-pane view inside the normal chrome, so
  // it uses the SAME input as every other view: ←→ switch panes (the sidebar is
  // the founder's action path), ↑↓ move the focused pane, Enter drills. No pulse
  // special-case — the lane cells are the content pane's selection targets.
  if (event.key === "left") return screen.explorerWidth === 0 ? { type: "back" } : { type: "focus", pane: "explorer" };
  if (event.key === "right") return screen.contentTargets.length > 0 ? { type: "focus", pane: "content" } : null;
  if (event.key === "up" || event.key === "down") {
    const delta = event.key === "down" ? 1 : -1;
    // Founder fix: on a scrollable spec detail the body is the meaningful
    // surface — reflexive ↑↓ scroll it while explorer-focused. Right explicitly
    // enters its links. Non-scrolling spec details and every other view fall through
    // to the unchanged explorer-move / content-select behavior.
    if (specDetailArrowsScroll(state)) return { type: "content-scroll", delta };
    if (state.focusedPane === "content" || screen.explorerWidth === 0) {
      // k9s selection-driven auto-scroll: at the viewport EDGE with more content beyond, the arrow
      // SCROLLS the viewport (reveal) instead of clamping — so ↑↓ reach every row without PgUp/PgDn
      // (most keyboards lack them — the founder fix). Away from the edge it moves the selection.
      const atBottom = state.contentSelection >= screen.contentTargets.length - 1;
      const atTop = state.contentSelection <= 0;
      if (delta === 1 && atBottom && state.contentOffset < state.contentMaxOffset) return { type: "content-scroll", delta: 1 };
      if (delta === -1 && atTop && state.contentOffset > 0) return { type: "content-scroll", delta: -1 };
      return { type: "content-select", delta };
    }
    return { type: "select", delta, rowCount: explorerCount };
  }
  if (event.key === "enter") {
    return state.focusedPane === "content" || screen.explorerWidth === 0
      ? (screen.contentTargets[state.contentSelection]?.action ?? { type: "error", message: "nothing selected in content" })
      : { type: "activate" };
  }
  return "action" in event ? event.action : null;
}

/** Route a wheel notch using the pane actually under the pointer. Clicks keep
 * using the renderer hit-map in the caller; this function only owns wheels. */
export function resolveMouseAction(
  event: Extract<InputEvent, { type: "mouse" }>,
  state: ViewState,
  screen: Screen,
  explorerCount: number,
): Action | null {
  void state;
  if ((event.button & 64) === 0) return null;
  const delta = (event.button & 1) !== 0 ? 3 : -3;
  return event.x <= screen.explorerWidth
    ? { type: "select", delta, rowCount: explorerCount }
    : { type: "content-scroll", delta };
}

export const PASTE_ENABLE = "\x1b[?2004h";
export const PASTE_DISABLE = "\x1b[?2004l";
export const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1006h";
export const MOUSE_DISABLE = "\x1b[?1006l\x1b[?1000l";
export const ALT_SCREEN_ON = "\x1b[?1049h\x1b[?25l";
export const ALT_SCREEN_OFF = "\x1b[?25h\x1b[?1049l";
