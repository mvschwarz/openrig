import { describe, expect, it } from "vitest";
import { agentsRunningSpec, createViewState, defaultSections } from "../src/state.js";
import { parseCommand } from "../src/grammar.js";
import { demoSnapshot } from "../src/demo-data.js";
import type { NeedsItem, SectionDef } from "../src/types.js";

const snap = demoSnapshot();
const withSnap = { getSnapshot: () => snap };

describe("one instance-scoped view-state (PIN 1, FR-12/13)", () => {
  it("is instance-scoped: two instances never share state (FR-13 negative AC)", () => {
    const a = createViewState({ instanceId: "tui-a", ...withSnap });
    const b = createViewState({ instanceId: "tui-b", ...withSnap });
    a.dispatch({ type: "jump", section: "specs" });
    expect(a.get().section).toBe("specs");
    expect(b.get().section).toBe("topology");
    expect(a.get().instanceId).toBe("tui-a");
    expect(b.get().instanceId).toBe("tui-b");
  });

  it("keeps the section set as ONE in-code registry: adding a section is a localized edit (FR-12 negative AC)", () => {
    const extra: SectionDef = { name: "extra", sourceRead: "GET /api/ps (existing read)", drillShape: "flat" };
    const s = createViewState({ instanceId: "t", sections: [...defaultSections(), extra], ...withSnap });
    expect(s.dispatch({ type: "jump", section: "extra" }).section).toBe("extra");
  });

  it("reaches every registered view by a command (R1.2 drivability by construction)", () => {
    const s = createViewState({ instanceId: "t", ...withSnap });
    for (const sec of s.get().sections) {
      s.dispatch({ type: "jump", section: sec.name });
      expect(s.get().section).toBe(sec.name);
    }
  });

  it("drills to a known agent; an unknown target is a NAMED error in state", () => {
    const s = createViewState({ instanceId: "t", ...withSnap });
    s.dispatch({ type: "drill", resource: "agent", name: "dev50.driver" });
    expect(s.get().section).toBe("topology");
    expect(s.get().drill.at(-1)).toEqual({ kind: "agent", name: "dev50.driver" });
    expect(s.get().lastError).toBeNull();

    s.dispatch({ type: "drill", resource: "agent", name: "nobody.here" });
    expect(s.get().lastError).toMatch(/no such agent "nobody\.here"/);
  });

  it("rejects ambiguous fleet shorthand and accepts an exact scoped agent target", () => {
    const duplicate = demoSnapshot();
    duplicate.hosts[0]!.rigs.push({
      name: "other-rig",
      pods: [{ name: "dev50", agents: [{ name: "dev50.qa", runtime: "codex", spec: "qa-agent", context: null, tokens: null, status: "idle", live: true }] }],
    });
    const s = createViewState({ instanceId: "t", getSnapshot: () => duplicate });
    expect(s.dispatch({ type: "drill", resource: "agent", name: "dev50.qa" }).lastError).toMatch(/ambiguous agent/);
    expect(s.dispatch({
      type: "drill",
      resource: "agent",
      name: "dev50.qa",
      target: { host: "vm-host", rig: "other-rig", pod: "dev50" },
    }).drill.map((part) => part.name)).toEqual(["vm-host", "other-rig", "dev50", "dev50.qa"]);
    expect(s.dispatch(parseCommand("agent vm-host/openrig-build/dev50/dev50.qa")).drill.map((part) => part.name))
      .toEqual(["vm-host", "openrig-build", "dev50", "dev50.qa"]);
  });

  it("cross-navs spec-of: running agent → its agent spec", () => {
    const s = createViewState({ instanceId: "t", ...withSnap });
    s.dispatch({ type: "cross", kind: "spec-of", name: "dev50.driver" });
    expect(s.get().section).toBe("specs");
    expect(s.get().drill.at(-1)).toEqual({ kind: "spec", name: "driver-agent" });
  });

  it("cross-navs running: spec → topology scoped to its seats", () => {
    const s = createViewState({ instanceId: "t", ...withSnap });
    s.dispatch({ type: "cross", kind: "running", name: "driver-agent" });
    expect(s.get().section).toBe("topology");
    expect(s.get().runningOf).toBe("driver-agent");
  });

  it("filters spec reverse navigation to genuinely live seats", () => {
    const copy = demoSnapshot();
    copy.hosts[0]!.rigs[0]!.pods[0]!.agents[0]!.live = false;
    expect(agentsRunningSpec(copy, "driver-agent")).toEqual([]);
  });

  it("keeps a missing spec-of target in place with a named error", () => {
    const copy = demoSnapshot();
    copy.hosts[0]!.rigs[0]!.pods[0]!.agents[0]!.spec = "materialized-only";
    const s = createViewState({ instanceId: "t", getSnapshot: () => copy });
    const before = s.get().section;
    const next = s.dispatch({ type: "cross", kind: "spec-of", name: "dev50.driver" });
    expect(next.section).toBe(before);
    expect(next.lastError).toMatch(/spec .*not in the library/);
  });

  it("rejects tabs that do not exist in the current content context", () => {
    const s = createViewState({ instanceId: "t", ...withSnap });
    expect(s.dispatch({ type: "tab", tab: "yaml" }).lastError).toMatch(/not available/);
    s.dispatch({ type: "drill", resource: "spec", name: "openrig-build-rig" });
    expect(s.dispatch({ type: "tab", tab: "yaml" }).lastError).toBeNull();
  });

  it("filters the current view and clears with empty text", () => {
    const s = createViewState({ instanceId: "t", ...withSnap });
    s.dispatch({ type: "filter", text: "dev50" });
    expect(s.get().filter).toBe("dev50");
    s.dispatch({ type: "filter", text: "" });
    expect(s.get().filter).toBe("");
  });

  it("bounds content scrolling in state so PageUp moves immediately from the bottom", () => {
    const s = createViewState({ instanceId: "t", ...withSnap });
    s.dispatch({ type: "layout", contentMaxOffset: 15, contentTargetCount: 0 });
    for (let i = 0; i < 20; i++) s.dispatch({ type: "content-scroll", delta: 10 });
    expect(s.get().contentOffset).toBe(15);
    s.dispatch({ type: "content-scroll", delta: -10 });
    expect(s.get().contentOffset).toBe(5);
  });

  it("renders honest-empty against an empty snapshot: errors name the miss, nothing is fabricated", () => {
    const s = createViewState({ instanceId: "t" }); // default emptySnapshot
    s.dispatch({ type: "drill", resource: "agent", name: "dev50.driver" });
    expect(s.get().lastError).toMatch(/no such agent/);
    expect(s.get().drill).toEqual([]);
  });

  it("mutates needs snapshots only through the registry data (no hidden globals)", () => {
    const localNeeds: NeedsItem[] = [{ kind: "idle-with-work", target: "x", detail: "d" }];
    const s = createViewState({
      instanceId: "t",
      getSnapshot: () => ({ ...demoSnapshot(), needs: localNeeds }),
    });
    s.dispatch({ type: "jump", section: "needs" });
    expect(s.get().section).toBe("needs");
  });
});
