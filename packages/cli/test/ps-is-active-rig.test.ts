// LEG-7 LOW 1 — isActiveRig extraction (fold-wave qitem 79159e6f). The bare-default table projection
// (ps.ts ~L942) and the rigsOnHost scope count (~L1081) both applied the same `.status !== "stopped"`
// active-rig predicate inline. This pins the ONE extracted `isActiveRig` predicate they now share, so
// the "1 of N" scope label and the shown rows can never diverge (the derived-label-must-carry-liveness
// class the LEG-2 QA flagged). RED-first: the import does not resolve until the helper is exported.
import { describe, expect, it } from "vitest";
import { isActiveRig } from "../src/commands/ps.js";

describe("isActiveRig — the one shared active-rig predicate (LEG-7 extraction)", () => {
  it("a rig is ACTIVE unless its status is exactly 'stopped'", () => {
    expect(isActiveRig({ status: "running" })).toBe(true);
    expect(isActiveRig({ status: "recoverable" })).toBe(true);
    expect(isActiveRig({ status: "degraded" })).toBe(true);
    expect(isActiveRig({ status: "stopped" })).toBe(false);
  });

  it("an absent/undefined status is ACTIVE (not stopped) — matches the pre-extraction inline behavior", () => {
    expect(isActiveRig({})).toBe(true);
    expect(isActiveRig({ status: undefined })).toBe(true);
  });
});
