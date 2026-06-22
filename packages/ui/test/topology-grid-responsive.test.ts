// OPR.0.4.0.39 FR-2/3/4 - source guards for the topology terminal grid:
// responsive 1/2/3-col, the legibility-floored CSS scale-down, and tightened
// padding. Source-guards (the exact visual result is QA-screenshot-validated).
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const SRC = fs.readFileSync(
  path.resolve(import.meta.dirname, "../src/components/topology/TopologyTerminalView.tsx"),
  "utf-8",
);

describe("TopologyTerminalView grid (OPR.0.4.0.39 FR-2/3/4)", () => {
  it("FR-2: responsive 1/2/3-col, with 3-col at the wider xl breakpoint (less cramping)", () => {
    expect(SRC).toContain("grid-cols-1");
    expect(SRC).toContain("md:grid-cols-2");
    expect(SRC).toContain("xl:grid-cols-3");
    // 3-col moved off the narrower lg so scaled statics fit 3-across cleanly.
    expect(SRC).not.toContain("lg:grid-cols-3");
  });

  it("FR-3: the static thumbnail scales down (legibility-floored) from a fixed top-left origin", () => {
    expect(SRC).toContain("origin-top-left");
    expect(SRC).toContain("xl:scale-90"); // starting value; QA measures the floor
  });

  it("FR-4: tightened card padding + gaps (no wasted edge space)", () => {
    expect(SRC).toContain("p-1.5");
    expect(SRC).toContain("gap-1.5");
    // the looser p-2 card padding + gap-3 grid gap are gone.
    expect(SRC).not.toMatch(/bg-white\/40 p-2 /);
    expect(SRC).not.toContain("gap-3");
  });
});
