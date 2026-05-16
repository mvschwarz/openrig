// release-0.3.2 slice 12 — dot-ID grammar unit tests.
//
// Aligned with `openrig-work/conventions/scope-and-versioning/README.md` §1.

import { describe, expect, it } from "vitest";
import {
  formatDotId,
  inferMissionDotId,
  isConformantDotId,
  nextEscapeBandOrdinal,
  parseDotId,
  sliceIdFromMission,
} from "../src/lib/scope/dot-id.js";

describe("dot-ID — parse + format", () => {
  it("parses a slice ID like OPR.0.3.2.12", () => {
    const id = parseDotId("OPR.0.3.2.12");
    expect(id).not.toBeNull();
    expect(id!.project).toBe("OPR");
    expect(id!.version).toBe("0.3.2.12");
  });

  it("parses an escape-band ID like OPR.99.0.1", () => {
    const id = parseDotId("OPR.99.0.1");
    expect(id).not.toBeNull();
    expect(id!.project).toBe("OPR");
    expect(id!.version).toBe("99.0.1");
  });

  it("rejects alpha segments (§1 explicit: uniform-numeric escape band)", () => {
    expect(parseDotId("OPR.A.1")).toBeNull();
    expect(parseDotId("OPR.0.3.A")).toBeNull();
  });

  it("rejects malformed prefixes", () => {
    expect(parseDotId("opr.0.3.2")).toBeNull();
    expect(parseDotId("O.0.3.2")).toBeNull();
    expect(parseDotId("OPRX.0.3.2")).toBeNull();
  });

  it("formats a DotId back to canonical string", () => {
    expect(formatDotId({ project: "OPR", version: "0.3.2" })).toBe("OPR.0.3.2");
    expect(formatDotId({ project: "OPR", version: "0.3.2", n: 12 })).toBe("OPR.0.3.2.12");
  });
});

describe("inferMissionDotId — release pattern + escape band", () => {
  it("infers OPR.X.Y.Z from release-X.Y.Z folder names", () => {
    expect(inferMissionDotId("release-0.3.2", null)).toBe("OPR.0.3.2");
    expect(inferMissionDotId("release-0.4.0", null)).toBe("OPR.0.4.0");
    expect(inferMissionDotId("release-1.0", null)).toBe("OPR.1.0");
  });

  it("requires an escape-band ordinal for non-release names", () => {
    expect(() => inferMissionDotId("backlog", null)).toThrow();
    expect(inferMissionDotId("backlog", 5)).toBe("OPR.99.0.5");
    expect(inferMissionDotId("bug-fix", 3)).toBe("OPR.99.0.3");
  });
});

describe("nextEscapeBandOrdinal", () => {
  it("returns 1 when no peer IDs exist", () => {
    expect(nextEscapeBandOrdinal([])).toBe(1);
    expect(nextEscapeBandOrdinal([null, null])).toBe(1);
  });

  it("returns max+1 across existing escape-band peers", () => {
    expect(nextEscapeBandOrdinal(["OPR.99.0.1", "OPR.99.0.3", null])).toBe(4);
  });

  it("ignores non-matching IDs (releases) when picking ordinal", () => {
    expect(nextEscapeBandOrdinal(["OPR.0.3.2", "OPR.99.0.2"])).toBe(3);
  });
});

describe("sliceIdFromMission", () => {
  it("appends the slice ordinal to the mission ID", () => {
    expect(sliceIdFromMission("OPR.0.3.2", 12)).toBe("OPR.0.3.2.12");
    expect(sliceIdFromMission("OPR.99.0.1", 4)).toBe("OPR.99.0.1.4");
  });
});

describe("isConformantDotId", () => {
  it("accepts conformant IDs across all tiers", () => {
    expect(isConformantDotId("OPR.0.3.2")).toBe(true);
    expect(isConformantDotId("OPR.0.3.2.12")).toBe(true);
    expect(isConformantDotId("OPR.99.0.1")).toBe(true);
  });
  it("rejects non-conformant inputs", () => {
    expect(isConformantDotId("")).toBe(false);
    expect(isConformantDotId(42)).toBe(false);
    expect(isConformantDotId("opr.0.3.2")).toBe(false);
  });
});
