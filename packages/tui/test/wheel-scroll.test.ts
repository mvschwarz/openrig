import { describe, it, expect } from "vitest";
import { createInputDecoder, sgrClick } from "../src/input.js";

// TUI scroll (ruling cfec754f Part 1) — the founder bug: clicking works, WHEEL does not. The SGR mouse
// decode only emitted events for button < 32 (clicks); wheel notches (button & 64 → codes 64/65) were
// decoded then DROPPED. This pins wheel → a content-scroll action (via the pageup/pagedown pass-through
// path), and guards that plain clicks still decode (regression).

// SGR wheel: ESC [ < <button> ; x ; y M — 64 = wheel up, 65 = wheel down.
const wheel = (button: number, x = 10, y = 5) => `\x1b[<${button};${x};${y}M`;

function events(seq: string) {
  return createInputDecoder().write(seq);
}

describe("wheel scroll — SGR wheel notches drive content-scroll", () => {
  it("wheel DOWN (button 65) → a content-scroll with positive delta", () => {
    const evs = events(wheel(65));
    const scroll = evs.find((e) => e.type === "key" && "action" in e && e.action?.type === "content-scroll");
    expect(scroll).toBeDefined();
    expect((scroll as { action: { type: "content-scroll"; delta: number } }).action.delta).toBeGreaterThan(0);
  });

  it("wheel UP (button 64) → a content-scroll with negative delta", () => {
    const evs = events(wheel(64));
    const scroll = evs.find((e) => e.type === "key" && "action" in e && e.action?.type === "content-scroll");
    expect(scroll).toBeDefined();
    expect((scroll as { action: { type: "content-scroll"; delta: number } }).action.delta).toBeLessThan(0);
  });

  it("a plain left click still decodes as a mouse event (regression guard)", () => {
    const evs = events(sgrClick(10, 5));
    expect(evs.some((e) => e.type === "mouse")).toBe(true);
    expect(evs.some((e) => e.type === "key" && "action" in e && e.action?.type === "content-scroll")).toBe(false);
  });
});
