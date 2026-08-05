// TUI scroll-focus fix (class-(b) focus-model defect, diagnosis 360e37d3).
//
// Founder defect: on a spec detail page, reflexive Down keys produce ZERO
// visible change — arrows drive the (hidden) explorer tree; body scroll lived
// only on undiscoverable PageUp/Down + content-focus, the scroll hint was gated
// behind the very state it teaches (catch-22), and the visible "content ↑/↓"
// indicator named mouse zones at keyboard users.
//
// Fix shape (honest minimal, focus-model-preserving): on a SCROLLABLE spec
// detail the reflexive ↑↓ scroll the body regardless of which pane holds focus;
// the scroll affordance surfaces whenever the body is actually scrollable (not
// gated behind already-being-focused); the overflow indicator names a scroll
// control, not the wrong keys. Routing + hint stay in lockstep via one helper.

import { describe, it, expect } from "vitest";
import { createViewState, emptySnapshot, computeExplorerRows } from "../src/state.js";
import { renderScreen } from "../src/render.js";
import { decodeInput, resolveKeyAction } from "../src/input.js";
import { demoSnapshot } from "../src/demo-data.js";
import type { FleetSnapshot, ViewStateStore, Screen } from "../src/types.js";

function syncLayout(s: ViewStateStore, snap: FleetSnapshot, cols: number, rows: number): Screen {
  const screen = renderScreen(s.get(), snap, { cols, rows });
  s.dispatch({ type: "layout", contentMaxOffset: screen.contentMaxOffset, contentTargetCount: screen.contentTargets.length });
  return renderScreen(s.get(), snap, { cols, rows });
}

function pressKey(s: ViewStateStore, snap: FleetSnapshot, bytes: string, screen: Screen): void {
  const ev = decodeInput(bytes)[0];
  if (!ev || ev.type !== "key") throw new Error("expected a key event");
  const action = resolveKeyAction(ev, s.get(), screen, computeExplorerRows(s.get(), snap).length);
  if (action) s.dispatch(action);
}

const DOWN = "\x1b[B";

function scrollableSpecSnapshot(): FleetSnapshot {
  const longDescription = Array.from({ length: 40 }, (_, i) =>
    `paragraph ${i}: this agent guidance body is deliberately long so the detail overflows a small viewport`,
  ).join(" ");
  return {
    ...emptySnapshot(),
    specs: [{
      name: "driver-agent",
      kind: "agent",
      description: longDescription,
      runtime: "claude-code",
      skills: ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"],
    }],
  };
}

describe("TUI scroll-focus fix — founder scenario + affordances", () => {
  it("FOUNDER PIN: Down on a scrollable spec detail scrolls the body, leaving the explorer put", () => {
    const snap = scrollableSpecSnapshot();
    const s = createViewState({ instanceId: "t", getSnapshot: () => snap });
    s.dispatch({ type: "drill", resource: "spec", name: "driver-agent" });
    const screen = syncLayout(s, snap, 100, 12);

    // precondition: we are on a scrollable spec detail
    expect(s.get().section).toBe("specs");
    expect(s.get().drill.length).toBeGreaterThan(0);
    expect(s.get().contentMaxOffset).toBeGreaterThan(0);

    const selectionBefore = s.get().selection;
    expect(s.get().contentOffset).toBe(0);

    pressKey(s, snap, DOWN, screen);

    // the body scrolled (visible change) and the explorer cursor did NOT move
    expect(s.get().contentOffset).toBeGreaterThan(0);
    expect(s.get().selection).toBe(selectionBefore);
  });

  it("CATCH-22 PIN: a scrollable body surfaces a scroll hint even when explorer-focused and not on the yaml tab", () => {
    const snap = demoSnapshot();
    const s = createViewState({ instanceId: "t", getSnapshot: () => snap });
    const screen = syncLayout(s, snap, 100, 8);

    // precondition: scrollable, but explorer-focused and NOT the yaml tab
    // (exactly the state the old hint gate suppressed the affordance in)
    expect(s.get().contentMaxOffset).toBeGreaterThan(0);
    expect(s.get().focusedPane).toBe("explorer");
    expect(s.get().viewTab).not.toBe("yaml");

    const hint = screen.lines.find((l) => l.includes("q quit"));
    expect(hint).toBeDefined();
    expect(hint).toContain("⇞⇟ scroll");
  });

  it("INDICATOR PIN: the overflow indicator names a scroll control, not the keys that used to not scroll", () => {
    const snap = scrollableSpecSnapshot();
    const s = createViewState({ instanceId: "t", getSnapshot: () => snap });
    s.dispatch({ type: "drill", resource: "spec", name: "driver-agent" });
    const screen = syncLayout(s, snap, 100, 12);

    const indicator = screen.lines.find((l) => /\d+-\d+ of \d+/.test(l));
    expect(indicator).toBeDefined();
    expect(indicator).not.toContain("content ↑/↓");
    expect(indicator).toMatch(/scroll/);
  });

  it("REGRESSION GUARD: Down still moves the explorer tree on the topology root (not a spec detail)", () => {
    const snap = demoSnapshot();
    const s = createViewState({ instanceId: "t", getSnapshot: () => snap });
    const screen = syncLayout(s, snap, 120, 32);
    const selectionBefore = s.get().selection;
    const offsetBefore = s.get().contentOffset;

    pressKey(s, snap, DOWN, screen);

    // topology root: arrows navigate the explorer, body does not scroll
    expect(s.get().selection).not.toBe(selectionBefore);
    expect(s.get().contentOffset).toBe(offsetBefore);
  });
});
