import { describe, it, expect } from "vitest";
import { resolveKeyAction } from "../src/input.js";
import type { Screen, ViewState, InputEvent } from "../src/types.js";

// TUI scroll (ruling cfec754f Part 1) — selection-driven arrow auto-scroll (k9s). content-focused, the
// selection moves among visible targets; at the viewport EDGE with more content beyond, the arrow
// SCROLLS the viewport (reveal) instead of clamping — so ↑↓ reach all rows without PgUp/PgDn. Away from
// the edge it still moves the selection.

const keyDown: Extract<InputEvent, { type: "key" }> = { type: "key", key: "down", action: { type: "select", delta: 1 } };
const keyUp: Extract<InputEvent, { type: "key" }> = { type: "key", key: "up", action: { type: "select", delta: -1 } };

function screen(nTargets: number): Screen {
  const contentTargets = Array.from({ length: nTargets }, (_, i) => ({ y: i + 3, x1: 32, x2: 80, action: { type: "noop" as const } }));
  return { lines: [], hitMap: [], contentTargets, contentMaxOffset: 5, explorerRows: [] };
}
function state(over: Partial<ViewState>): ViewState {
  return {
    instanceId: "t", section: "topology", drill: [], selection: 0, filter: "", viewTab: "table",
    focusedPane: "content", contentOffset: 0, contentMaxOffset: 5, contentSelection: 0, contentTargetCount: 3,
    ...over,
  } as ViewState;
}

describe("resolveKeyAction — arrow auto-scroll at the content viewport edge (k9s)", () => {
  it("down at the LAST visible target with more content below → content-scroll (reveal), not clamp", () => {
    const a = resolveKeyAction(keyDown, state({ contentSelection: 2, contentOffset: 0, contentMaxOffset: 5 }), screen(3), 10);
    expect(a).toEqual({ type: "content-scroll", delta: 1 });
  });

  it("down NOT at the edge → content-select (move selection)", () => {
    const a = resolveKeyAction(keyDown, state({ contentSelection: 0, contentOffset: 0 }), screen(3), 10);
    expect(a).toEqual({ type: "content-select", delta: 1 });
  });

  it("down at the last target with NO more content below → content-select (clamp, no phantom scroll)", () => {
    const a = resolveKeyAction(keyDown, state({ contentSelection: 2, contentOffset: 5, contentMaxOffset: 5 }), screen(3), 10);
    expect(a).toEqual({ type: "content-select", delta: 1 });
  });

  it("up at the FIRST target with content scrolled above → content-scroll (reveal upward)", () => {
    const a = resolveKeyAction(keyUp, state({ contentSelection: 0, contentOffset: 3, contentMaxOffset: 5 }), screen(3), 10);
    expect(a).toEqual({ type: "content-scroll", delta: -1 });
  });

  it("up at the first target already at the top → content-select (clamp)", () => {
    const a = resolveKeyAction(keyUp, state({ contentSelection: 0, contentOffset: 0 }), screen(3), 10);
    expect(a).toEqual({ type: "content-select", delta: -1 });
  });
});
