import { describe, expect, it } from "vitest";
import { createViewState, defaultSections } from "../src/state.js";
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

  it("filters the current view and clears with empty text", () => {
    const s = createViewState({ instanceId: "t", ...withSnap });
    s.dispatch({ type: "filter", text: "dev50" });
    expect(s.get().filter).toBe("dev50");
    s.dispatch({ type: "filter", text: "" });
    expect(s.get().filter).toBe("");
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
