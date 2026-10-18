import { describe, it, expect } from "vitest";
import { SeatKindRegistry, type SeatKind } from "../src/domain/seat-kinds.js";

function fakeKind(kind: string): SeatKind {
  const refuse = async () => { throw new Error("not called"); };
  return {
    kind,
    host: { create: refuse, launch: refuse, checkReady: refuse, probe: refuse, stop: refuse },
    inbound: { deliver: refuse, capture: refuse },
    activity: { probe: refuse },
  };
}

describe("SeatKindRegistry", () => {
  it("has no custom kind by default, so tmux and external_cli take the built-in paths", () => {
    const registry = new SeatKindRegistry();
    expect(registry.hasCustom()).toBe(false);
    expect(registry.custom("tmux")).toBeNull();
    expect(registry.custom("external_cli")).toBeNull();
    expect(registry.custom(null)).toBeNull();
  });

  it("returns a registered kind by its attachment type", () => {
    const acp = fakeKind("acp");
    const registry = new SeatKindRegistry([acp]);
    expect(registry.hasCustom()).toBe(true);
    expect(registry.custom("acp")).toBe(acp);
    expect(registry.custom("other")).toBeNull();
  });

  it("refuses to replace a built-in kind or register one twice", () => {
    expect(() => new SeatKindRegistry([fakeKind("tmux")])).toThrow(/built in/);
    expect(() => new SeatKindRegistry([fakeKind("external_cli")])).toThrow(/built in/);
    expect(() => new SeatKindRegistry([fakeKind("acp"), fakeKind("acp")])).toThrow(/already registered/);
  });

  it("reads a node's binding only when a custom kind is registered", () => {
    let reads = 0;
    const sessions = { getBindingForNode: () => { reads++; return { attachmentType: "acp", externalSessionName: "s1" } as never; } };
    expect(new SeatKindRegistry().forNode(sessions, "n1", "s1")).toBeNull();
    expect(reads).toBe(0);
    const found = new SeatKindRegistry([fakeKind("acp")]).forNode(sessions, "n1", "s1", "claude-code");
    expect(reads).toBe(1);
    expect(found?.ref).toEqual({ nodeId: "n1", sessionName: "s1", runtime: "claude-code", kind: "acp", pane: null, occupant: null });
    expect(new SeatKindRegistry([fakeKind("acp")]).forNode(sessions, "n1", "an-older-session")).toBeNull();
  });
});
