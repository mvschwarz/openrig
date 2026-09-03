import { describe, it, expect } from "vitest";
import { createInputDecoder, resolveMouseAction, sgrClick } from "../src/input.js";
import { createViewState } from "../src/state.js";
import { renderScreen } from "../src/render.js";
import { demoSnapshot } from "../src/demo-data.js";

// TUI scroll (ruling cfec754f Part 1) — the founder bug: clicking works, WHEEL does not. The SGR mouse
// decode only emitted events for button < 32 (clicks); wheel notches (button & 64 → codes 64/65) were
// decoded then DROPPED. This pins wheel → a content-scroll action (via the pageup/pagedown pass-through
// path), and guards that plain clicks still decode (regression).

// SGR wheel: ESC [ < <button> ; x ; y M — 64 = wheel up, 65 = wheel down.
const wheel = (button: number, x = 10, y = 5) => `\x1b[<${button};${x};${y}M`;

function events(seq: string) {
  return createInputDecoder().write(seq);
}

describe("wheel scroll — the pointer decides which pane moves", () => {
  it("preserves wheel coordinates as a mouse event", () => {
    const evs = events(wheel(65));
    expect(evs).toEqual([{ type: "mouse", button: 65, x: 10, y: 5 }]);
  });

  it("scrolls Explorer under the pointer and content under the pointer", () => {
    const snap = demoSnapshot();
    const view = createViewState({ instanceId: "wheel", getSnapshot: () => snap });
    const screen = renderScreen(view.get(), snap, { cols: 120, rows: 34 });
    expect(resolveMouseAction({ type: "mouse", button: 65, x: 5, y: 8 }, view.get(), screen, 20)).toEqual({
      type: "select", delta: 3, rowCount: 20,
    });
    expect(resolveMouseAction({ type: "mouse", button: 64, x: 90, y: 8 }, view.get(), screen, 20)).toEqual({
      type: "content-scroll", delta: -3,
    });
  });

  it("a plain left click still decodes as a mouse event (regression guard)", () => {
    const evs = events(sgrClick(10, 5));
    expect(evs.some((e) => e.type === "mouse")).toBe(true);
    expect(evs).toEqual([
      { type: "mouse", button: 0, x: 10, y: 5 },
    ]);
  });
});
