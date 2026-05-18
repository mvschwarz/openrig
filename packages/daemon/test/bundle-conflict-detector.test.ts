import { describe, it, expect } from "vitest";
import { detectBundleConflicts, type DetectConflictsInput } from "../src/domain/bundle-conflict-detector.js";

// Item 3 / slice-05 Checkpoint 4.1: bundle-conflict-detector pure-function tests.
// Discriminator pattern: any test that asserts a conflict was reported must
// fail if the corresponding detection branch is commented out in the module.

describe("bundle-conflict-detector — rig name collision", () => {
  // R1: empty running rigs → no conflicts
  it("empty runningRigs produces no conflicts", () => {
    const input: DetectConflictsInput = { bundleRigName: "alpha", runningRigs: [] };
    const report = detectBundleConflicts(input);
    expect(report.hasConflicts).toBe(false);
    expect(report.conflicts).toHaveLength(0);
  });

  // R2: running rigs with different names → no conflicts
  it("runningRigs with different names produces no conflicts", () => {
    const input: DetectConflictsInput = {
      bundleRigName: "alpha",
      runningRigs: [
        { rigId: "01H000000000000000000001", name: "beta" },
        { rigId: "01H000000000000000000002", name: "gamma" },
      ],
    };
    const report = detectBundleConflicts(input);
    expect(report.hasConflicts).toBe(false);
  });

  // R3: running rig with same name → conflict reported with correct shape
  it("running rig with same name produces a rig_name_collision conflict", () => {
    const input: DetectConflictsInput = {
      bundleRigName: "alpha",
      runningRigs: [
        { rigId: "01H000000000000000000003", name: "alpha" },
      ],
    };
    const report = detectBundleConflicts(input);
    expect(report.hasConflicts).toBe(true);
    expect(report.conflicts).toHaveLength(1);
    const c = report.conflicts[0]!;
    expect(c.kind).toBe("rig_name_collision");
    expect(c.bundleRigName).toBe("alpha");
    if (c.kind === "rig_name_collision") {
      expect(c.collisionWith.rigId).toBe("01H000000000000000000003");
      expect(c.collisionWith.rigName).toBe("alpha");
      expect(c.description).toContain("alpha");
      expect(c.description).toContain("01H000000000000000000003");
      expect(c.resolutions.length).toBeGreaterThanOrEqual(2);
      // Resolutions mention the --target and --force flags (Checkpoint 4.2 surfaces)
      expect(c.resolutions.some((r) => r.includes("--target"))).toBe(true);
      expect(c.resolutions.some((r) => r.includes("--force"))).toBe(true);
    }
  });

  // R4: collision detected even when other rigs precede the match
  it("collision found in a list with multiple rigs, only the matching one reported", () => {
    const input: DetectConflictsInput = {
      bundleRigName: "alpha",
      runningRigs: [
        { rigId: "01H000000000000000000004", name: "beta" },
        { rigId: "01H000000000000000000005", name: "gamma" },
        { rigId: "01H000000000000000000006", name: "alpha" },
        { rigId: "01H000000000000000000007", name: "delta" },
      ],
    };
    const report = detectBundleConflicts(input);
    expect(report.conflicts).toHaveLength(1);
    if (report.conflicts[0]!.kind === "rig_name_collision") {
      expect(report.conflicts[0]!.collisionWith.rigId).toBe("01H000000000000000000006");
    }
  });

  // R5: empty bundleRigName produces no conflict (fail-open on missing input)
  it("empty bundleRigName produces no conflict (no rig name = nothing to compare)", () => {
    const input: DetectConflictsInput = {
      bundleRigName: "",
      runningRigs: [{ rigId: "01H000000000000000000008", name: "alpha" }],
    };
    const report = detectBundleConflicts(input);
    expect(report.hasConflicts).toBe(false);
  });

  // R6: case sensitivity — collision is exact-name match only
  it("name match is case-sensitive (case mismatch = no collision)", () => {
    const input: DetectConflictsInput = {
      bundleRigName: "alpha",
      runningRigs: [{ rigId: "01H000000000000000000009", name: "Alpha" }],
    };
    const report = detectBundleConflicts(input);
    expect(report.hasConflicts).toBe(false);
  });
});
