import { describe, expect, it } from "vitest";
import { nextNativeRuntimeExchangeStep, type NativeExchangeSlot } from "../src/domain/native-runtime-switch-exchange.js";

const identity = { canonical: "seat@rig", staging: "openrig-switch-owned", parking: "openrig-parking-owned", predecessorGeneration: "generation-old", successorGeneration: "generation-new" };
const slot = (role: string): NativeExchangeSlot => role === "-" ? { state: "absent" } : role === "?" ? { state: "unknown" }
  : { state: "present", generation: role === "p" ? identity.predecessorGeneration : role === "s" ? identity.successorGeneration : "foreign" };
const observe = (roles: string) => ({ canonical: slot(roles[0]!), staging: slot(roles[1]!), parking: slot(roles[2]!) });

describe("native runtime exchange recovery planning", () => {
  it.each([
    ["ps-", "canonical", "parking"], ["-sp", "staging", "canonical"], ["s-p", "parking", "staging"],
  ] as const)("advances from observed %s without assuming the previous command result", (roles, from, to) => {
    expect(nextNativeRuntimeExchangeStep(identity, observe(roles), "forward")).toEqual({state:"rename",from:identity[from],to:identity[to]});
  });
  it.each([
    ["sp-", "staging", "parking"], ["s-p", "canonical", "staging"], ["-sp", "parking", "canonical"],
  ] as const)("rolls back observed %s while retaining both generations", (roles, from, to) => {
    expect(nextNativeRuntimeExchangeStep(identity, observe(roles), "rollback")).toEqual({state:"rename",from:identity[from],to:identity[to]});
  });
  it("recognizes the two completed directions",()=>{
    expect(nextNativeRuntimeExchangeStep(identity,observe("sp-"),"forward")).toEqual({state:"complete"});
    expect(nextNativeRuntimeExchangeStep(identity,observe("ps-"),"rollback")).toEqual({state:"complete"});
  });
  it.each(["?s-","ps?","psx","pp-","ss-","---","-s-","p--","spx"])("refuses unknown, foreign, duplicate or lost occupant observations %s",roles=>{
    for(const direction of ["forward","rollback"] as const)expect(nextNativeRuntimeExchangeStep(identity,observe(roles),direction).state).toBe("blocked");
  });
  it("refuses overlapping names and indistinguishable generations",()=>{
    expect(nextNativeRuntimeExchangeStep({...identity,parking:identity.canonical},observe("ps-"),"forward").state).toBe("blocked");
    expect(nextNativeRuntimeExchangeStep({...identity,successorGeneration:identity.predecessorGeneration},observe("ps-"),"forward").state).toBe("blocked");
  });
});
