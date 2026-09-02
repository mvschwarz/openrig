// OPR.0.5.3.6 + OPR.0.5.8.7 — the productized chain-file trace keyed off
// topology.root (instance at the TOP, D2), per-level legacy fallback that
// NAMES its advisory (proof-contract item 2: legacy fallback honesty).
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { traceTopologyChain, type TraceFs } from "../src/lib/topology-trace.js";

const ROOT = "/inst/topology";
const LEGACY = "/inst/shared-docs/rigs";

function fsOf(files: Record<string, string>): TraceFs {
  return {
    exists: (p) => p in files,
    read: (p) => {
      const v = files[p];
      if (v === undefined) throw new Error(`unexpected read: ${p}`);
      return v;
    },
  };
}

describe("traceTopologyChain", () => {
  it("walks instance -> rig -> seat under topology.root, instance file at the TOP of the root", () => {
    const files = {
      [join(ROOT, "LEARNED.md")]: "instance-level",
      [join(ROOT, "rigs", "product-team", "LEARNED.md")]: "rig-level",
      [join(ROOT, "rigs", "product-team", "seats", "orch1-lead", "LEARNED.md")]: "seat-level",
    };
    const result = traceTopologyChain({
      topologyRoot: ROOT, name: "LEARNED.md", rig: "product-team", seat: "orch1-lead",
      legacyRigsRoot: LEGACY, fs: fsOf(files),
    });
    expect(result.levels.map((l) => [l.altitude, l.source, l.content])).toEqual([
      ["instance", "topology.root", "instance-level"],
      ["rig", "topology.root", "rig-level"],
      ["seat", "topology.root", "seat-level"],
    ]);
    expect(result.levels.every((l) => l.advisory === undefined)).toBe(true);
  });

  it("adds the canonical pod altitude between rig and seat when --pod is selected", () => {
    const files = {
      [join(ROOT, "LEARNED.md")]: "instance-level",
      [join(ROOT, "rigs", "product-team", "LEARNED.md")]: "rig-level",
      [join(ROOT, "rigs", "product-team", "pods", "delivery", "LEARNED.md")]: "pod-level",
      [join(ROOT, "rigs", "product-team", "seats", "impl", "LEARNED.md")]: "seat-level",
    };
    const result = traceTopologyChain({
      topologyRoot: ROOT, name: "LEARNED.md", rig: "product-team", pod: "delivery", seat: "impl",
      legacyRigsRoot: LEGACY, fs: fsOf(files),
    });
    expect(result.levels.map((l) => [l.altitude, l.source, l.content])).toEqual([
      ["instance", "topology.root", "instance-level"],
      ["rig", "topology.root", "rig-level"],
      ["pod", "topology.root", "pod-level"],
      ["seat", "topology.root", "seat-level"],
    ]);
  });

  it("legacy fallback honesty: a pre-convention file is READ and the advisory NAMES both locations", () => {
    const files = {
      [join(LEGACY, "product-team", "seats", "orch1-lead", "LEARNED.md")]: "legacy seat content",
    };
    const result = traceTopologyChain({
      topologyRoot: ROOT, name: "LEARNED.md", rig: "product-team", seat: "orch1-lead",
      legacyRigsRoot: LEGACY, fs: fsOf(files),
    });
    const seat = result.levels.find((l) => l.altitude === "seat")!;
    expect(seat.source).toBe("legacy");
    expect(seat.content).toBe("legacy seat content");
    expect(seat.resolvedPath).toBe(join(LEGACY, "product-team", "seats", "orch1-lead", "LEARNED.md"));
    // The advisory names the legacy source, the canonical destination, and the config key.
    expect(seat.advisory).toContain("legacy-topology-read");
    expect(seat.advisory).toContain(join(LEGACY, "product-team", "seats", "orch1-lead", "LEARNED.md"));
    expect(seat.advisory).toContain(join(ROOT, "rigs", "product-team", "seats", "orch1-lead", "LEARNED.md"));
    expect(seat.advisory).toContain("topology.root");
  });

  it("topology.root wins over legacy when both exist (canonical is never shadowed)", () => {
    const canonical = join(ROOT, "rigs", "product-team", "LEARNED.md");
    const files = {
      [canonical]: "canonical",
      [join(LEGACY, "product-team", "LEARNED.md")]: "stale legacy",
    };
    const result = traceTopologyChain({
      topologyRoot: ROOT, name: "LEARNED.md", rig: "product-team",
      legacyRigsRoot: LEGACY, fs: fsOf(files),
    });
    const rig = result.levels.find((l) => l.altitude === "rig")!;
    expect(rig).toMatchObject({ source: "topology.root", content: "canonical", resolvedPath: canonical });
  });

  it("absent everywhere is reported as absent — never an error, never a silent skip", () => {
    const result = traceTopologyChain({
      topologyRoot: ROOT, name: "CULTURE.md", rig: "ghost-rig", seat: "s1",
      legacyRigsRoot: LEGACY, fs: fsOf({}),
    });
    expect(result.levels.map((l) => [l.altitude, l.source])).toEqual([
      ["instance", "absent"], ["rig", "absent"], ["seat", "absent"],
    ]);
  });

  it("omitting the seat yields a rig-level trace (instance + rig only)", () => {
    const result = traceTopologyChain({
      topologyRoot: ROOT, name: "CULTURE.md", rig: "product-team",
      legacyRigsRoot: LEGACY, fs: fsOf({}),
    });
    expect(result.levels.map((l) => l.altitude)).toEqual(["instance", "rig"]);
  });

  it("r2-B3: traversal in rig/seat/name is REJECTED before any filesystem read", () => {
    // r2's discriminator: rig=../../outside, seat=../../../outside-seat,
    // name=../../secret resolved every level OUTSIDE topology.root. Each of
    // the three values must be a single safe path segment — no separators,
    // no dot-segments, non-empty — validated before any read.
    const reads: string[] = [];
    const spyFs: TraceFs = { exists: (p) => { reads.push(p); return false; }, read: () => { throw new Error("no"); } };
    const bad = [
      { rig: "../../outside", seat: "s", name: "LEARNED.md" },
      { rig: "r", seat: "../../../outside-seat", name: "LEARNED.md" },
      { rig: "r", seat: "s", name: "../../secret" },
      { rig: "r/nested", seat: "s", name: "LEARNED.md" },
      { rig: "r", seat: "s\\evil", name: "LEARNED.md" },
      { rig: "r", pod: "../outside-pod", seat: "s", name: "LEARNED.md" },
      { rig: ".", seat: "s", name: "LEARNED.md" },
      { rig: "", seat: "s", name: "LEARNED.md" },
    ];
    for (const args of bad) {
      expect(() => traceTopologyChain({ topologyRoot: ROOT, legacyRigsRoot: LEGACY, fs: spyFs, ...args }),
        JSON.stringify(args)).toThrow(/invalid|segment/i);
    }
    expect(reads).toEqual([]); // rejection happens BEFORE any filesystem contact
  });

  it("r2 residual: an EXPLICITLY EMPTY seat is rejected, not silently treated as omitted", () => {
    // `--seat ""` is user error, not a rig-level trace request. Omission
    // (undefined/null) stays the sanctioned rig-level form.
    expect(() => traceTopologyChain({
      topologyRoot: ROOT, name: "LEARNED.md", rig: "r", seat: "",
      legacyRigsRoot: LEGACY, fs: fsOf({}),
    })).toThrow(/invalid seat/i);
    const omitted = traceTopologyChain({
      topologyRoot: ROOT, name: "LEARNED.md", rig: "r", seat: null,
      legacyRigsRoot: LEGACY, fs: fsOf({}),
    });
    expect(omitted.levels.map((l) => l.altitude)).toEqual(["instance", "rig"]);
  });

  it("r2-B3: ordinary dotted names stay valid (LEARNED.md, a.b.c.md, seat ids with dashes/underscores)", () => {
    const result = traceTopologyChain({
      topologyRoot: ROOT, name: "a.b.c.md", rig: "product-team", seat: "orch1_lead-2",
      legacyRigsRoot: LEGACY, fs: fsOf({}),
    });
    expect(result.levels).toHaveLength(3);
  });

  it("the instance altitude has NO legacy fallback (the legacy layout began at rigs/)", () => {
    const files = { [join(LEGACY, "..", "LEARNED.md")]: "should never be consulted" };
    const result = traceTopologyChain({
      topologyRoot: ROOT, name: "LEARNED.md", rig: "product-team",
      legacyRigsRoot: LEGACY, fs: fsOf(files),
    });
    expect(result.levels.find((l) => l.altitude === "instance")!.source).toBe("absent");
  });
});
