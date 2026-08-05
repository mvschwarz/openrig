// Keyboard + mouse byte decoding. Mouse uses xterm SGR (1006) reporting:
// ESC [ < b ; x ; y M/m — the standard tmux/iTerm/Terminal.app mouse encoding.
// Mouse events are resolved against the renderer's hit-map by the caller and
// then dispatched through the SAME dispatch as commands and keys (PIN 1).
import type { Action, InputEvent, Screen, ViewState } from "./types.js";
import { specDetailArrowsScroll } from "./state.js";
import { StringDecoder } from "node:string_decoder";

function parseText(text: string, final: boolean): { events: InputEvent[]; remainder: string } {
  const events: InputEvent[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i] ?? "";
    if (ch === "\x1b") {
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
      }
      events.push({ type: "key", key: "escape" });
      i += 1;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      events.push({ type: "key", key: "enter", action: { type: "activate" } });
      i += 1;
      continue;
    }
    if (ch === "\x7f" || ch === "\b") {
      events.push({ type: "key", key: "backspace" });
      i += 1;
      continue;
    }
    if (ch >= " ") events.push({ type: "char", ch });
    i += 1;
  }
  return { events, remainder: text.slice(i) };
}

export interface InputDecoder {
  write(bytes: string | Buffer): InputEvent[];
  flush(): InputEvent[];
}

/** Stateful terminal-stream decoder: retains split escape sequences and uses
 * Node's StringDecoder so UTF-8 code points survive arbitrary Buffer chunks. */
export function createInputDecoder(): InputDecoder {
  const utf8 = new StringDecoder("utf8");
  let pending = "";
  return {
    write(bytes) {
      pending += typeof bytes === "string" ? bytes : utf8.write(bytes);
      const parsed = parseText(pending, false);
      pending = parsed.remainder;
      return parsed.events;
    },
    flush() {
      const parsed = parseText(pending, true);
      pending = parsed.remainder;
      return parsed.events;
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

/** Resolve directional/Enter keys against the currently rendered pane. */
export function resolveKeyAction(
  event: Extract<InputEvent, { type: "key" }>,
  state: ViewState,
  screen: Screen,
  explorerCount: number,
): Action | null {
  if (event.key === "left") return { type: "focus", pane: "explorer" };
  if (event.key === "right") return screen.contentTargets.length > 0 ? { type: "focus", pane: "content" } : null;
  if (event.key === "up" || event.key === "down") {
    const delta = event.key === "down" ? 1 : -1;
    // Founder fix: on a scrollable spec detail the body is the meaningful
    // surface — reflexive ↑↓ scroll it (one line per press), whichever pane
    // holds focus. Non-scrolling spec details and every other view fall through
    // to the unchanged explorer-move / content-select behavior.
    if (specDetailArrowsScroll(state)) return { type: "content-scroll", delta };
    return state.focusedPane === "content"
      ? { type: "content-select", delta }
      : { type: "select", delta, rowCount: explorerCount };
  }
  if (event.key === "enter") {
    return state.focusedPane === "content"
      ? (screen.contentTargets[state.contentSelection]?.action ?? { type: "error", message: "nothing selected in content" })
      : { type: "activate" };
  }
  return "action" in event ? event.action : null;
}

export const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1006h";
export const MOUSE_DISABLE = "\x1b[?1006l\x1b[?1000l";
export const ALT_SCREEN_ON = "\x1b[?1049h\x1b[?25l";
export const ALT_SCREEN_OFF = "\x1b[?25h\x1b[?1049l";
