import { describe, it, expect } from "vitest";
import {
  effectiveGateRoles,
  gateRolesOf,
  isGateTag,
  qitemIsGated,
} from "../src/domain/gate-predicate.js";

describe("gate-predicate (OPR.0.4.3.16 — centralized queue gate predicate)", () => {
  it("isGateTag recognizes well-formed gate:<role> tags only", () => {
    expect(isGateTag("gate:guard")).toBe(true);
    expect(isGateTag("gate:spec-review")).toBe(true);
    expect(isGateTag("gate:")).toBe(false); // empty role
    expect(isGateTag("mission:x")).toBe(false);
    expect(isGateTag("slice:16")).toBe(false);
    expect(isGateTag("notagate")).toBe(false);
  });

  it("gateRolesOf extracts + de-duplicates roles, order-preserving", () => {
    expect(gateRolesOf(["mission:x", "gate:guard", "gate:qa", "gate:guard"])).toEqual([
      "guard",
      "qa",
    ]);
    expect(gateRolesOf(null)).toEqual([]);
    expect(gateRolesOf([])).toEqual([]);
    expect(gateRolesOf(["slice:16"])).toEqual([]);
  });

  it("qitemIsGated is true for ANY gate:* tag (primary predicate)", () => {
    expect(qitemIsGated({ tags: ["gate:guard"] })).toBe(true);
    expect(qitemIsGated({ tags: ["mission:x", "gate:spec-review"] })).toBe(true);
    expect(qitemIsGated({ tags: ["mission:x"], tier: "routine" })).toBe(false);
    expect(qitemIsGated({ tags: null })).toBe(false);
  });

  it("qitemIsGated falls back to tier === human-gate (secondary predicate)", () => {
    expect(qitemIsGated({ tags: null, tier: "human-gate" })).toBe(true);
    expect(qitemIsGated({ tags: ["mission:x"], tier: "human-gate" })).toBe(true);
    expect(qitemIsGated({ tags: null, tier: "deep" })).toBe(false);
  });

  it("effectiveGateRoles surfaces human-gate tier as the human role (deduped)", () => {
    expect(effectiveGateRoles({ tags: ["gate:guard"], tier: "human-gate" })).toEqual([
      "guard",
      "human",
    ]);
    expect(effectiveGateRoles({ tags: ["gate:human"], tier: "human-gate" })).toEqual(["human"]);
    expect(effectiveGateRoles({ tags: null, tier: "human-gate" })).toEqual(["human"]);
    expect(effectiveGateRoles({ tags: null, tier: "routine" })).toEqual([]);
  });
});
