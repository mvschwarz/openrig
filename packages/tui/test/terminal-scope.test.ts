// The terminal button opens the scope being viewed: an agent's page opens that one agent, a pod's page the pod,
// and the rig's page the rig. Each page offers only its own scope's button.
import { describe, expect, it } from "vitest";
import { createViewState } from "../src/state.js";
import { parseCommand } from "../src/grammar.js";
import { renderScreen } from "../src/render.js";
import { demoSnapshot } from "../src/demo-data.js";
import type { Action } from "../src/types.js";

const snap = demoSnapshot();

function page(open: (dispatch: (action: Action) => void) => void) {
  const view = createViewState({ instanceId: "t", getSnapshot: () => snap });
  open((action) => view.dispatch(action));
  const screen = renderScreen(view.get(), snap, { cols: 140, rows: 40 });
  const button = (label: string) => {
    const y = screen.lines.findIndex((line) => line.includes(label)) + 1;
    return y > 0 ? screen.hitMap.find((hit) => hit.y === y && hit.action?.type === "act")?.action : undefined;
  };
  const buttonViews = screen.lines.flatMap((line, i) => line.includes("Open terminal")
    ? screen.hitMap.filter((hit) => hit.y === i + 1 && hit.action?.type === "act").map((hit) => (hit.action as { view: string }).view)
    : []);
  return { button, buttonViews };
}

describe("the terminal button opens the scope being viewed", () => {
  it("an agent's page opens just that agent", () => {
    const { button, buttonViews } = page((dispatch) => dispatch(parseCommand("agent dev50.driver")));
    expect(button("Open terminal ▸ dev50.driver")).toEqual({ type: "act", act: "open-terminal", view: "seat:openrig-build/dev50.driver" });
    expect(buttonViews).toEqual(["seat:openrig-build/dev50.driver"]);
  });

  it("a pod's page opens the pod", () => {
    const { button, buttonViews } = page((dispatch) =>
      dispatch({ type: "drill", resource: "pod", name: "dev50", target: { host: "vm-host", rig: "openrig-build" } }));
    expect(button("Open terminals ▸ pod dev50")).toEqual({ type: "act", act: "open-terminal", view: "pod:openrig-build/dev50" });
    expect(buttonViews).toEqual(["pod:openrig-build/dev50"]);
  });

  it("the rig's page opens the rig", () => {
    const { button, buttonViews } = page((dispatch) => dispatch(parseCommand("rig openrig-build")));
    expect(button("Open terminals ▸ rig openrig-build")).toEqual({ type: "act", act: "open-terminal", view: "rig:openrig-build" });
    expect(buttonViews).toEqual(["rig:openrig-build"]);
  });
});
