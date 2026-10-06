import { expect, it } from "vitest";
import { createViewState, computeExplorerRows } from "../src/state.js";
import { demoSnapshot } from "../src/demo-data.js";
import { attentionLines } from "../src/attention/attention-model.js";
import { terminalLines } from "../src/terminals/terminal-model.js";
import { renderScreen } from "../src/render.js";

it.each([[140, 42], [80, 24]])("Feed keeps categories in Explorer and items in content, with category Back at %ix%i", (cols, rows) => {
  const snap = demoSnapshot();
  snap.attentionRead = { scope: "instance", readAt: "2026-09-11T18:00:00Z", sources: [], detail: null, detailError: null,
    items: ["action", "update"].map(kind => ({ id: kind, kind: kind as "action" | "update", summary: `${kind} content only`, scope: "instance", project: null, source: "/api/queue/x", urgency: "update", at: null, unblocks: null })) };
  const view = createViewState({ instanceId: "organizer", getSnapshot: () => snap });
  view.dispatch({ type: "jump", section: "needs" });
  const navigator = computeExplorerRows(view.get(), snap);
  expect(navigator.map(row => row.key)).toContain("attention-category:action");
  expect(navigator.map(row => row.key)).toContain("attention-category:update");
  expect(navigator.some(row => row.label.includes("content only"))).toBe(false);
  view.dispatch({ type: "attention-category", category: "update" });
  const text = attentionLines(view.get(), snap, cols).map(line => line.text).join("\n");
  expect(text).toContain("update content only"); expect(text).not.toContain("action content only");
  view.dispatch({ type: "attention-open", id: "update" }); view.dispatch({ type: "back" });
  expect(view.get().attentionCategory).toBe("update");
  expect(renderScreen(view.get(), snap, { cols, rows }).explorerRows.filter(row => row.key?.startsWith("attention-category"))).toHaveLength(2);
});

it("Specs kinds and Derived views start collapsed, expand deliberately, and retain Saved views", () => {
  const snap = demoSnapshot();
  snap.terminals = { catalogLoaded: true, preview: null, catalog: [
    { view: "saved:watch", name: "Build watch", kind: "saved", members: ["owner@build"], ready: 0, absent: 0, degraded: 0, pages: 0, readinessUnverified: true },
    ...Array.from({ length: 24 }, (_, n) => ({ view: `rig:r${n}`, name: `rig-${n}`, kind: "derived" as const, members: [], ready: 0, absent: 0, degraded: 0, pages: 0, readinessUnverified: true })),
  ] };
  const view = createViewState({ instanceId: "groups", getSnapshot: () => snap });
  view.dispatch({ type: "jump", section: "specs" });
  expect(computeExplorerRows(view.get(), snap).some(row => row.key?.startsWith("spec:"))).toBe(false);
  view.dispatch({ type: "toggle-expand", key: "specs-kind:rig" });
  expect(computeExplorerRows(view.get(), snap).some(row => row.key === `spec:rig:${snap.specs.find(s => s.kind === "rig")!.name}`)).toBe(true);
  view.dispatch({ type: "jump", section: "terminals" });
  expect(computeExplorerRows(view.get(), snap).some(row => row.key === "terminal:saved:watch")).toBe(true);
  expect(computeExplorerRows(view.get(), snap).some(row => row.key?.startsWith("terminal:rig:"))).toBe(false);
  expect(terminalLines(view.get(), snap, 60).some(line => line.text.includes("rig-23"))).toBe(false);
  view.dispatch({ type: "toggle-expand", key: "terminals:derived" });
  expect(computeExplorerRows(view.get(), snap).filter(row => row.key?.startsWith("terminal:rig:"))).toHaveLength(24);
});
