// release-0.3.2 slice 12 — dot-ID grammar unit tests.
//
// Aligned with `openrig-work/conventions/scope-and-versioning/README.md` §1.

import { describe, expect, it } from "vitest";
import {
  formatDotId,
  inferMissionDotId,
  isConformantDotId,
  isMissionDotId,
  isSliceDotId,
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

describe("BLOCK 1 — tier-aware validation (isMissionDotId / isSliceDotId)", () => {
  it("isMissionDotId accepts release-shaped IDs (2-3 numeric segments)", () => {
    expect(isMissionDotId("OPR.0.3.2")).toBe(true);
    expect(isMissionDotId("OPR.1.0")).toBe(true);
  });

  it("isMissionDotId accepts the escape-band shape (99.x.y, exactly 3 segments)", () => {
    expect(isMissionDotId("OPR.99.0.1")).toBe(true);
    expect(isMissionDotId("OPR.99.0.42")).toBe(true);
  });

  it("isMissionDotId REJECTS slice-shaped IDs (4+ numeric segments) — guard BC discriminator", () => {
    // The crux of BLOCK 1: a slice-depth ID like OPR.0.3.2.12 must
    // not pass mission validation, even though it parses as a valid
    // dot-ID at SOME tier.
    expect(isMissionDotId("OPR.0.3.2.12")).toBe(false);
    expect(isMissionDotId("OPR.99.0.1.5")).toBe(false);
  });

  it("isMissionDotId rejects malformed inputs (alpha / wrong prefix shape)", () => {
    expect(isMissionDotId("OPR.A.1")).toBe(false);
    expect(isMissionDotId("opr.0.3.2")).toBe(false);
    expect(isMissionDotId(42 as unknown)).toBe(false);
    expect(isMissionDotId("OPR.99.0")).toBe(false); // escape band must be exactly 3
  });

  it("isSliceDotId accepts slice-shaped IDs (3-4 numeric segments)", () => {
    expect(isSliceDotId("OPR.0.3.2.12")).toBe(true); // release-X.Y.Z slice
    expect(isSliceDotId("OPR.1.0.5")).toBe(true);    // release-X.Y slice
    expect(isSliceDotId("OPR.99.0.1.7")).toBe(true); // escape-band slice
  });

  it("isSliceDotId admits the inherent depth-3 overlap (release X.Y.Z mission shape = slice for an X.Y parent)", () => {
    // The convention's positional grammar can't distinguish a
    // release-X.Y.Z mission from a slice of a release-X.Y mission
    // by depth alone. Both shapes are accepted by isSliceDotId; the
    // CLI disambiguates by tier at use sites (mission create uses
    // isMissionDotId; slice IDs are minted from a parent + ordinal,
    // never user-typed).
    expect(isSliceDotId("OPR.0.3.2")).toBe(true);   // release X.Y.Z OR slice of X.Y
    // Escape-band IDs are UNAMBIGUOUS by depth: an escape-band mission
    // is depth-3 (OPR.99.0.1); an escape-band slice is depth-4
    // (OPR.99.0.1.5). Depth-3 with leading 99 is mission-only.
    expect(isSliceDotId("OPR.99.0.1")).toBe(false);
    // The strictly-impossible-slice case is depth 2 (X.Y only) — no
    // parent can have a sub-NN-segment of "Y".
    expect(isSliceDotId("OPR.1.0")).toBe(false);
  });

  it("parseDotId(s, 'slice') peels the last segment off as `n`", () => {
    // Per guard discriminator: parsing OPR.0.3.2.12 as a slice must
    // yield version=0.3.2 and n=12, not version=0.3.2.12.
    const id = parseDotId("OPR.0.3.2.12", "slice");
    expect(id).not.toBeNull();
    expect(id!.version).toBe("0.3.2");
    expect(id!.n).toBe(12);
  });

  it("parseDotId(s, 'mission') keeps all numeric segments as version", () => {
    const id = parseDotId("OPR.0.3.2", "mission");
    expect(id).not.toBeNull();
    expect(id!.version).toBe("0.3.2");
    expect(id!.n).toBeUndefined();
  });

  it("BC-2 BLOCK 1: escape band rejects [99, !0, n] mission ver (only [99, 0, n] is valid)", () => {
    // §1 fixes the escape band as <PFX>.99.0.<n> — the `0` is FIXED.
    // Previously the depth-3 check accepted OPR.99.7.8 as a mission;
    // now require the middle 0.
    expect(isMissionDotId("OPR.99.7.8")).toBe(false);
    expect(isMissionDotId("OPR.99.1.0")).toBe(false);
    expect(isMissionDotId("OPR.99.0.42")).toBe(true);    // still valid
    expect(isMissionDotId("OPR.99.0.1")).toBe(true);     // still valid
  });

  it("BC-2 BLOCK 1: escape-band slice parent must also satisfy the [99,0,n] rule", () => {
    expect(isSliceDotId("OPR.99.7.8.1")).toBe(false);    // parent=99.7.8 invalid
    expect(isSliceDotId("OPR.99.0.42.7")).toBe(true);    // parent=99.0.42 valid
  });
});
