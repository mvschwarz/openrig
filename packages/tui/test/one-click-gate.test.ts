import { describe, it, expect } from "vitest";
import { evaluateOneClickGate } from "../src/crash-cart/one-click-gate.js";

// Crash-cart C3 — the one-click rule (founder, binding on ⏎): ⏎ is ONE keystroke IFF the plan is
// ZERO GENERATION (every seat resume-original). Pre-daemon PROXY over the C2 read: a rig is fully
// recoverable when resumableCount == seatCount. If ANY rig has non-resumable seats, ⏎ must lead to a
// confirm screen naming those deltas — never a silent resume→fresh downgrade.

const rig = (rigName: string, seatCount: number, resumableCount: number) => ({ rigName, seatCount, resumableCount });

describe("evaluateOneClickGate — zero-generation proxy over C2 discovery", () => {
  it("zero-generation TRUE (⏎ one keystroke) when every rig is fully resumable", () => {
    const g = evaluateOneClickGate({ foundOnHost: [rig("alpha", 3, 3), rig("kernel", 4, 4)] });
    expect(g.zeroGeneration).toBe(true);
    expect(g.deltas).toEqual([]);
  });

  it("FALSE with a delta naming the rig + its non-resumable seat count when any seat is not resumable", () => {
    const g = evaluateOneClickGate({ foundOnHost: [rig("alpha", 3, 3), rig("beta", 5, 2)] });
    expect(g.zeroGeneration).toBe(false);
    expect(g.deltas).toEqual([{ rigName: "beta", seatCount: 5, resumableCount: 2, nonResumable: 3 }]);
  });

  it("lists every rig that has non-resumable seats", () => {
    const g = evaluateOneClickGate({ foundOnHost: [rig("a", 2, 0), rig("b", 2, 2), rig("c", 3, 1)] });
    expect(g.deltas.map((d) => d.rigName)).toEqual(["a", "c"]);
    expect(g.zeroGeneration).toBe(false);
  });

  it("empty host (no rigs) is vacuously zero-generation (the no-rigs/onboarding path is handled upstream)", () => {
    const g = evaluateOneClickGate({ foundOnHost: [] });
    expect(g.zeroGeneration).toBe(true);
    expect(g.deltas).toEqual([]);
  });
});
