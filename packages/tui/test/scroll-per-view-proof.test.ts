import { describe, it, expect } from "vitest";
import { createViewState, emptySnapshot } from "../src/state.js";
import { parseCommand } from "../src/grammar.js";

// TUI scroll (ruling cfec754f Part 1) — the scroll CONTRACT proof through the real store. The scroll
// path is view-agnostic by construction (the content-scroll reducer touches only contentOffset/
// contentMaxOffset, never branches on viewTab), so this proves the contract once end-to-end: the
// top/bottom commands reach the true extremes, and intermediate rows are reachable ONE LINE at a time
// (line-scroll, never a page skip → every row is grep-able at some offset; the no-pagination guarantee).
// Per-view wiring (each scrollable view populating contentMaxOffset) is covered by the render suites;
// the enumeration (table/overview/graph/topology/yaml/pulse) is documented in the handoff.

function store(contentMaxOffset: number) {
  const snap = emptySnapshot();
  const s = createViewState({ instanceId: "t", getSnapshot: () => snap });
  s.dispatch({ type: "layout", contentMaxOffset, contentTargetCount: 0 });
  return s;
}

describe("scroll contract — top/bottom reach the extremes; intermediate rows reachable line-by-line", () => {
  it("`bottom` clamps to contentMaxOffset (the true bottom, not a page)", () => {
    const s = store(5);
    s.dispatch(parseCommand("bottom"));
    expect(s.get().contentOffset).toBe(5);
  });

  it("`top` clamps to 0 (the true top)", () => {
    const s = store(5);
    s.dispatch(parseCommand("bottom"));
    s.dispatch(parseCommand("top"));
    expect(s.get().contentOffset).toBe(0);
  });

  it("wheel/arrow one-line deltas step every row (no page skip → grep-able at each offset)", () => {
    const s = store(3);
    const seen: number[] = [];
    for (let i = 0; i < 3; i++) {
      s.dispatch({ type: "content-scroll", delta: 1 });
      seen.push(s.get().contentOffset);
    }
    expect(seen).toEqual([1, 2, 3]); // 0→1→2→3, every intermediate offset visited (no pagination jumps)
  });
});
