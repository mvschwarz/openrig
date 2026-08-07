import { describe, it, expect } from "vitest";
import { resolveWakeTarget, type WakeSessionRow } from "../src/domain/wake-resolver.js";

// rows are newest-first (id DESC), as the sessions query returns them.
function rows(...rs: Partial<WakeSessionRow>[]): WakeSessionRow[] {
  return rs.map((r, i) => ({
    id: r.id ?? 100 - i,
    sessionName: r.sessionName ?? "dev-planner@my-rig",
    // respect an explicitly-provided null (do not coalesce it to a default token)
    resumeToken: "resumeToken" in r ? (r.resumeToken ?? null) : `tok-${100 - i}`,
    runtime: r.runtime ?? "claude",
    createdAt: r.createdAt ?? `2026-08-0${i + 1}T00:00:00Z`,
  }));
}

describe("resolveWakeTarget — L3b seat[@gen] -> token (ruling A: resolve on existing stores)", () => {
  it("resolves the newest tenure by default (generation omitted)", () => {
    const res = resolveWakeTarget(rows({ resumeToken: "newest" }, { resumeToken: "older" }), { seat: "dev-planner@my-rig" });
    expect(res.resolved).toBe(true);
    if (res.resolved) {
      expect(res.token).toBe("newest");
      expect(res.runtime).toBe("claude");
    }
  });

  it("resolves an explicit generation (1 = newest, 2 = next-older)", () => {
    const res = resolveWakeTarget(rows({ resumeToken: "gen1" }, { resumeToken: "gen2" }), { seat: "dev-planner@my-rig", generation: 2 });
    expect(res.resolved).toBe(true);
    if (res.resolved) expect(res.token).toBe("gen2");
  });

  it("REFUSES an unknown seat (no rows) and lists nothing — never a guessed wake", () => {
    const res = resolveWakeTarget([], { seat: "ghost@my-rig" });
    expect(res.resolved).toBe(false);
    if (!res.resolved) {
      expect(res.reason).toMatch(/no.*session|unknown|not found/i);
      expect(res.known).toHaveLength(0);
    }
  });

  it("REFUSES an out-of-range generation and TEACHES which tenures exist", () => {
    const res = resolveWakeTarget(rows({ resumeToken: "g1" }, { resumeToken: "g2" }), { seat: "dev-planner@my-rig", generation: 5 });
    expect(res.resolved).toBe(false);
    if (!res.resolved) {
      expect(res.reason).toMatch(/generation|only.*2|tenure/i);
      expect(res.known).toHaveLength(2);
      expect(res.known[0]!.generation).toBe(1);
      expect(res.known[1]!.generation).toBe(2);
    }
  });

  it("REFUSES when the resolved tenure has no captured resume token (lists it as token-absent)", () => {
    const res = resolveWakeTarget(rows({ resumeToken: null }), { seat: "dev-planner@my-rig" });
    expect(res.resolved).toBe(false);
    if (!res.resolved) {
      expect(res.reason).toMatch(/no.*token|not captured/i);
      expect(res.known[0]!.tokenPresent).toBe(false);
    }
  });
});
