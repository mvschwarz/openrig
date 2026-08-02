// Keyboard + mouse byte decoding. Mouse uses xterm SGR (1006) reporting:
// ESC [ < b ; x ; y M/m — the standard tmux/iTerm/Terminal.app mouse encoding.
// Mouse events are resolved against the renderer's hit-map by the caller and
// then dispatched through the SAME dispatch as commands and keys (PIN 1).
import type { InputEvent } from "./types.js";

const SGR_MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

export function decodeInput(bytes: string | Buffer): InputEvent[] {
  const text = typeof bytes === "string" ? bytes : bytes.toString("utf8");
  const events: InputEvent[] = [];

  const rest = text.replace(SGR_MOUSE, (_, b: string, x: string, y: string, kind: string) => {
    const button = Number(b);
    if (kind === "M" && (button & 3) !== 3 && button < 32) {
      // press of button 0/1/2 (32+ are motion/wheel — out of the safe core)
      events.push({ type: "mouse", button: button & 3, x: Number(x), y: Number(y) });
    }
    return "";
  });

  let i = 0;
  while (i < rest.length) {
    const ch = rest[i] ?? "";
    if (ch === "\x1b" && rest[i + 1] === "[") {
      const code = rest[i + 2];
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
    if (ch === "\x1b") {
      events.push({ type: "key", key: "escape" });
      i += 1;
      continue;
    }
    if (ch >= " ") events.push({ type: "char", ch });
    i += 1;
  }
  return events;
}

/** Test/automation helper: the SGR bytes a terminal emits for a left click at (x, y). */
export function sgrClick(x: number, y: number): string {
  return `\x1b[<0;${x};${y}M\x1b[<0;${x};${y}m`;
}

export const MOUSE_ENABLE = "\x1b[?1000h\x1b[?1006h";
export const MOUSE_DISABLE = "\x1b[?1006l\x1b[?1000l";
export const ALT_SCREEN_ON = "\x1b[?1049h\x1b[?25l";
export const ALT_SCREEN_OFF = "\x1b[?25h\x1b[?1049l";
