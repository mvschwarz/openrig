import { describe, expect, it } from "vitest";
import { createViewState, computeExplorerRows, locationKey } from "../src/state.js";
import { parseCommand } from "../src/grammar.js";
import { demoSnapshot } from "../src/demo-data.js";
import type { FleetSnapshot } from "../src/types.js";

// Founder round-4 pins: explorer selection sync + cursor stability (item 2),
// default expansion for topology (item 4) and specs (item 3).

const snap = demoSnapshot();

function fresh() {
  return createViewState({ instanceId: "t", getSnapshot: () => snap });
}

describe("topology default expansion (item 4): rigs+pods visible, agents on demand", () => {
  it("hides agents until their pod is expanded", () => {
    const s = fresh();
    const labels = computeExplorerRows(s.get(), snap).map((r) => r.label);
    expect(labels.some((l) => l.includes("dev50 ("))).toBe(true);
    expect(labels.some((l) => l.includes("dev50.driver"))).toBe(false);
    expect(labels.find((l) => l.includes("dev50 ("))).toContain("▸");
  });

  it("drilling a pod expands it and the cursor lands ON the pod row", () => {
    const s = fresh();
    s.dispatch(parseCommand("pod dev50"));
    const rows = computeExplorerRows(s.get(), snap);
    expect(rows.map((r) => r.label).some((l) => l.includes("dev50.driver"))).toBe(true);
    expect(rows[s.get().selection]?.key).toBe("pod:vm-host/openrig-build/dev50");
  });
});

describe("selection sync + cursor stability (item 2)", () => {
  it("a content-pane drill highlights the agent in the explorer (auto-expanding its pod)", () => {
    const s = fresh();
    s.dispatch(parseCommand("rig openrig-build"));
    // simulate the table-row click action shape
    s.dispatch({ type: "drill", resource: "agent", name: "dev50.guard", target: { host: "vm-host", rig: "openrig-build", pod: "dev50" } });
    const rows = computeExplorerRows(s.get(), snap);
    expect(rows[s.get().selection]?.key).toBe("agent:vm-host/openrig-build/dev50/dev50.guard");
  });

  it("the cursor never resets to the top across a navigation chain", () => {
    const s = fresh();
    const positions: number[] = [];
    for (const cmd of ["rig openrig-build", "pod dev50", "agent dev50.qa", "spec-of dev50.qa"]) {
      s.dispatch(parseCommand(cmd));
      positions.push(s.get().selection);
    }
    // every nav step lands on a real row (not the top) and matches the location
    for (const pos of positions) expect(pos).toBeGreaterThan(0);
    expect(computeExplorerRows(s.get(), snap)[s.get().selection]?.key).toBe(locationKey(s.get()));
  });

  it("cross-nav spec-of lands the cursor on the spec row (folder auto-expanded)", () => {
    const s = fresh();
    s.dispatch(parseCommand("spec-of dev50.driver"));
    const rows = computeExplorerRows(s.get(), snap);
    expect(rows[s.get().selection]?.key).toBe("spec:driver-agent");
  });
});

describe("filters are view-scoped (founder direct-drive catch)", () => {
  it("a specs filter never leaks into the topology table across a cross-section drill", () => {
    const s = fresh();
    s.dispatch(parseCommand(":specs"));
    s.dispatch(parseCommand("/independent-reviewer"));
    s.dispatch(parseCommand("rig openrig-build"));
    expect(s.get().section).toBe("topology");
    expect(s.get().filter).toBe("");
  });

  it("a same-section drill keeps the filter (topology rig → pod)", () => {
    const s = fresh();
    s.dispatch(parseCommand("rig openrig-build"));
    s.dispatch(parseCommand("/dev50"));
    s.dispatch(parseCommand("pod dev50"));
    expect(s.get().filter).toBe("dev50");
  });

  it("cross-nav across sections clears the filter too (spec-of)", () => {
    const s = fresh();
    s.dispatch(parseCommand("rig openrig-build"));
    s.dispatch(parseCommand("/dev50"));
    s.dispatch(parseCommand("spec-of dev50.driver"));
    expect(s.get().section).toBe("specs");
    expect(s.get().filter).toBe("");
  });
});

describe("specs default expansion (item 3): rig specs full, agent folders collapsed", () => {
  const nsSnap: FleetSnapshot = {
    ...snap,
    specs: [
      { name: "rig-a", kind: "rig" },
      { name: "rig-b", kind: "rig" },
      { name: "rev-1", kind: "agent", namespace: "review" },
      { name: "rev-2", kind: "agent", namespace: "review" },
      { name: "orch-1", kind: "agent", namespace: "orchestration" },
    ],
  };

  it("lists every rig spec but collapses agent folders to the folder row", () => {
    const s = createViewState({ instanceId: "t", getSnapshot: () => nsSnap });
    s.dispatch(parseCommand(":specs"));
    const labels = computeExplorerRows(s.get(), nsSnap).map((r) => r.label);
    expect(labels.some((l) => l.includes("rig-a"))).toBe(true);
    expect(labels.some((l) => l.includes("rig-b"))).toBe(true);
    expect(labels.some((l) => l.includes("review/ (2)"))).toBe(true);
    expect(labels.some((l) => l.includes("rev-1"))).toBe(false);
  });

  it("toggling a folder shows its specs; toggling again collapses", () => {
    const s = createViewState({ instanceId: "t", getSnapshot: () => nsSnap });
    s.dispatch(parseCommand(":specs"));
    s.dispatch({ type: "toggle-expand", key: "folder:review" });
    let labels = computeExplorerRows(s.get(), nsSnap).map((r) => r.label);
    expect(labels.some((l) => l.includes("rev-1"))).toBe(true);
    s.dispatch({ type: "toggle-expand", key: "folder:review" });
    labels = computeExplorerRows(s.get(), nsSnap).map((r) => r.label);
    expect(labels.some((l) => l.includes("rev-1"))).toBe(false);
  });

  it("a live filter overrides collapse so matches are always visible", () => {
    const s = createViewState({ instanceId: "t", getSnapshot: () => nsSnap });
    s.dispatch(parseCommand(":specs"));
    s.dispatch(parseCommand("/rev"));
    const labels = computeExplorerRows(s.get(), nsSnap).map((r) => r.label);
    expect(labels.some((l) => l.includes("rev-1"))).toBe(true);
  });
});
