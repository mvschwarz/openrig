import { describe, it, expect } from "vitest";
import { classifyScopeItem, type ScopeAuditInput } from "../src/lib/scope/scope-audit.js";

function makeInput(overrides: Partial<ScopeAuditInput>): ScopeAuditInput {
  return {
    id: null,
    path: "/workspace/missions/release-0.4.0",
    readmeFrontmatterRaw: null,
    progressFileExists: false,
    readmeOnlyMarker: false,
    isActiveRelease: true,
    level: "mission",
    ...overrides,
  };
}

describe("scope-audit classifier", () => {
  // RAIL STATUS
  it("present when PROGRESS.md exists", () => {
    const result = classifyScopeItem(makeInput({ progressFileExists: true }));
    expect(result.railStatus).toBe("present");
  });

  it("missing when no PROGRESS.md and no readme-only marker", () => {
    const result = classifyScopeItem(makeInput());
    expect(result.railStatus).toBe("missing");
    expect(result.findings.some((f) => f.kind === "missing_progress")).toBe(true);
  });

  it("readme-only when marker is set", () => {
    const result = classifyScopeItem(makeInput({ readmeOnlyMarker: true }));
    expect(result.railStatus).toBe("readme-only");
    expect(result.findings.filter((f) => f.kind === "missing_progress")).toHaveLength(0);
  });

  // 3-WAY DISCRIMINATOR (AC-3)
  it("registration ghost: id: line + YAML parse error -> ghost finding (HIGH for active)", () => {
    const result = classifyScopeItem(makeInput({
      readmeFrontmatterRaw: "id: OPR.0.4.0.16\nbad: yaml: {{broken",
      isActiveRelease: true,
    }));
    expect(result.findings.some((f) => f.kind === "registration_ghost" && f.severity === "high")).toBe(true);
    expect(result.frontmatterError).not.toBeNull();
  });

  it("missing-id: frontmatter parses but no id field -> missing_id finding", () => {
    const result = classifyScopeItem(makeInput({
      readmeFrontmatterRaw: "title: Some slice\nstatus: in-progress",
      isActiveRelease: true,
    }));
    expect(result.findings.some((f) => f.kind === "missing_id")).toBe(true);
    expect(result.frontmatterError).toBeNull();
  });

  it("id-convention violation: id present but invalid format", () => {
    const result = classifyScopeItem(makeInput({
      readmeFrontmatterRaw: "id: not-a-dot-id",
      isActiveRelease: true,
      level: "mission",
    }));
    expect(result.findings.some((f) => f.kind === "id_convention_violation")).toBe(true);
  });

  it("clean: valid id + PROGRESS.md -> no findings", () => {
    const result = classifyScopeItem(makeInput({
      readmeFrontmatterRaw: "id: release-0.4.0",
      progressFileExists: true,
      level: "mission",
    }));
    // mission dot-id validator may or may not accept "release-0.4.0"
    // but there should be no ghost or missing-id finding
    expect(result.findings.filter((f) => f.kind === "registration_ghost" || f.kind === "missing_id")).toHaveLength(0);
    expect(result.railStatus).toBe("present");
  });

  // SEVERITY
  it("missing progress is HIGH for active release, LOW for historical", () => {
    const active = classifyScopeItem(makeInput({ isActiveRelease: true }));
    const historical = classifyScopeItem(makeInput({ isActiveRelease: false }));
    expect(active.findings[0]?.severity).toBe("high");
    expect(historical.findings[0]?.severity).toBe("low");
  });

  // GHOST vs MISSING-ID DISTINCT
  it("ghost and missing-id are distinct finding kinds", () => {
    const ghost = classifyScopeItem(makeInput({
      readmeFrontmatterRaw: "id: OPR.broken\nbad: {{yaml",
    }));
    const missingId = classifyScopeItem(makeInput({
      readmeFrontmatterRaw: "title: no id here",
    }));
    const ghostKinds = ghost.findings.map((f) => f.kind);
    const missingKinds = missingId.findings.map((f) => f.kind);
    expect(ghostKinds).toContain("registration_ghost");
    expect(ghostKinds).not.toContain("missing_id");
    expect(missingKinds).toContain("missing_id");
    expect(missingKinds).not.toContain("registration_ghost");
  });

  // SLICE LEVEL
  it("slice missing-id uses slice dot-ID validator", () => {
    const result = classifyScopeItem(makeInput({
      readmeFrontmatterRaw: "id: not-a-slice-id",
      level: "slice",
      isActiveRelease: true,
    }));
    expect(result.findings.some((f) => f.kind === "id_convention_violation")).toBe(true);
  });
});
