// OPR.0.5.3.6 — the productized chain-file trace: three altitudes keyed off
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

  it("the instance altitude has NO legacy fallback (the legacy layout began at rigs/)", () => {
    const files = { [join(LEGACY, "..", "LEARNED.md")]: "should never be consulted" };
    const result = traceTopologyChain({
      topologyRoot: ROOT, name: "LEARNED.md", rig: "product-team",
      legacyRigsRoot: LEGACY, fs: fsOf(files),
    });
    expect(result.levels.find((l) => l.altitude === "instance")!.source).toBe("absent");
  });
});
