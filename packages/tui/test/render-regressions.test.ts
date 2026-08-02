import { describe, expect, it } from "vitest";
import { demoSnapshot } from "../src/demo-data.js";
import { renderScreen } from "../src/render.js";
import { createViewState } from "../src/state.js";
import type { FleetSnapshot } from "../src/types.js";

describe("live visual regressions", () => {
  it("renders the locked RIG column and value in the agents table", () => {
    const snap = demoSnapshot();
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch({ type: "drill", resource: "rig", name: "openrig-build" });

    const screen = renderScreen(view.get(), snap, { cols: 140, rows: 34 });
    const header = screen.lines.find((line) => line.includes("AGENT") && line.includes("STATUS"));
    const row = screen.lines.find((line) => line.includes("dev50.driver"));

    expect(header).toMatch(/RIG\s+POD\s+AGENT/);
    expect(row).toContain("openrig-build");
  });

  it("never emits a composed row wider than the terminal", () => {
    const snap = demoSnapshot();
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch({ type: "jump", section: "needs" });

    const screen = renderScreen(view.get(), snap, { cols: 80, rows: 20 });
    expect(screen.lines.every((line) => line.length <= 80)).toBe(true);
  });

  it("scrolls the Explorer viewport to keep the keyboard selection visible", () => {
    const base = demoSnapshot();
    const snap: FleetSnapshot = {
      ...base,
      specs: Array.from({ length: 20 }, (_, i) => ({ name: `spec-${i}`, kind: "agent" as const })),
    };
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch({ type: "jump", section: "specs" });
    view.dispatch({ type: "select", index: 18, rowCount: 23 });

    const screen = renderScreen(view.get(), snap, { cols: 100, rows: 12 });
    expect(screen.lines.some((line) => line.includes("›") && line.includes("spec-15"))).toBe(true);
  });

  it("does not advertise open on a Needs-You target that cannot navigate", () => {
    const base = demoSnapshot();
    const snap: FleetSnapshot = {
      ...base,
      needs: [{ kind: "overdue", target: "qitem-123", detail: "past closure_required_at" }],
    };
    const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
    view.dispatch({ type: "jump", section: "needs" });

    const screen = renderScreen(view.get(), snap, { cols: 140, rows: 20 });
    const lineIndex = screen.lines.findIndex((line) => line.includes("qitem-123"));
    expect(lineIndex).toBeGreaterThanOrEqual(0);
    expect(screen.lines[lineIndex]).not.toContain("open ▸");
    expect(screen.hitMap.some((hit) => hit.y === lineIndex + 1 && hit.x1 > 30)).toBe(false);
  });
});
