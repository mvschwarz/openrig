import { describe, it, expect } from "vitest";
import {
  CLOSURE_REASONS,
  computeClosureRequiredAt,
  isClosureReason,
  validateClosure,
} from "../src/domain/hot-potato-enforcer.js";

describe("hot-potato-enforcer / validateClosure", () => {
  it("non-done state passes through without closure reason", () => {
    const r = validateClosure({ state: "in-progress" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.closureReason).toBeNull();
      expect(r.closureTarget).toBeNull();
    }
  });

  it("rejects state=done without closure_reason", () => {
    const r = validateClosure({ state: "done" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe("missing_closure_reason");
      expect(r.validReasons).toEqual(CLOSURE_REASONS);
    }
  });

  it("rejects state=done with bogus closure_reason", () => {
    const r = validateClosure({ state: "done", closureReason: "made-up-reason" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_closure_reason");
  });

  it.each(CLOSURE_REASONS)("accepts state=done with valid closure_reason=%s", (reason) => {
    const target = (reason === "handed_off_to" || reason === "blocked_on" || reason === "escalation")
      ? "downstream-target"
      : null;
    const r = validateClosure({ state: "done", closureReason: reason, closureTarget: target });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.closureReason).toBe(reason);
  });

  it("rejects handed_off_to without closure_target", () => {
    const r = validateClosure({ state: "done", closureReason: "handed_off_to" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("missing_closure_target");
  });

  it("rejects blocked_on without closure_target", () => {
    const r = validateClosure({ state: "done", closureReason: "blocked_on" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("missing_closure_target");
  });

  it("rejects escalation without closure_target", () => {
    const r = validateClosure({ state: "done", closureReason: "escalation" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("missing_closure_target");
  });

  it("no-follow-on / canceled / denied accepted without target", () => {
    for (const reason of ["no-follow-on", "canceled", "denied"] as const) {
      const r = validateClosure({ state: "done", closureReason: reason });
      expect(r.ok).toBe(true);
    }
  });
});

describe("hot-potato-enforcer / isClosureReason", () => {
  it("recognizes all 6 enum values", () => {
    for (const r of CLOSURE_REASONS) expect(isClosureReason(r)).toBe(true);
  });
  it("rejects unknown values", () => {
    expect(isClosureReason("nope")).toBe(false);
    expect(isClosureReason(null)).toBe(false);
    expect(isClosureReason(42)).toBe(false);
  });
});

describe("hot-potato-enforcer / computeClosureRequiredAt", () => {
  it("returns null for null tier", () => {
    expect(computeClosureRequiredAt(new Date().toISOString(), null)).toBeNull();
  });
  it("returns null for unknown tier", () => {
    expect(computeClosureRequiredAt(new Date().toISOString(), "made-up-tier")).toBeNull();
  });
  it("computes fast tier as claimed + 30min", () => {
    const claimed = "2026-04-28T00:00:00.000Z";
    const required = computeClosureRequiredAt(claimed, "fast");
    expect(required).toBe("2026-04-28T00:30:00.000Z");
  });
  it("computes routine tier as claimed + 4h", () => {
    const claimed = "2026-04-28T00:00:00.000Z";
    const required = computeClosureRequiredAt(claimed, "routine");
    expect(required).toBe("2026-04-28T04:00:00.000Z");
  });
});
