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

  // MALFORMED RAIL STATUS REGRESSIONS (guard BLOCKING)
  it("parse error + PROGRESS.md => railStatus malformed (not present)", () => {
    const result = classifyScopeItem(makeInput({
      readmeFrontmatterRaw: "id: OPR.broken\nbad: {{yaml",
      progressFileExists: true,
    }));
    expect(result.railStatus).toBe("malformed");
    expect(result.frontmatterError).not.toBeNull();
  });

  it("parse error + id line => registration_ghost + malformed", () => {
    const result = classifyScopeItem(makeInput({
      readmeFrontmatterRaw: "id: OPR.test\nbroken: {{yaml",
      isActiveRelease: true,
    }));
    expect(result.railStatus).toBe("malformed");
    expect(result.findings.some((f) => f.kind === "registration_ghost" && f.severity === "high")).toBe(true);
  });

  it("parse error WITHOUT id line => finding + frontmatterError for UI severity", () => {
    const result = classifyScopeItem(makeInput({
      readmeFrontmatterRaw: "broken: {{yaml",
      isActiveRelease: true,
    }));
    expect(result.railStatus).toBe("malformed");
    expect(result.frontmatterError).not.toBeNull();
    expect(result.findings.some((f) => f.kind === "registration_ghost")).toBe(true);
  });

  // GUARD BLOCKING: no-leading-frontmatter README must emit finding
  it("README with no frontmatter (readmeFrontmatterRaw null) + PROGRESS.md => missing_id finding", () => {
    const result = classifyScopeItem(makeInput({
      readmeFrontmatterRaw: null,
      progressFileExists: true,
      isActiveRelease: true,
    }));
    expect(result.findings.some((f) => f.kind === "missing_id")).toBe(true);
    expect(result.railStatus).toBe("present");
  });

  it("README with no frontmatter + no PROGRESS.md => missing_id + missing_progress", () => {
    const result = classifyScopeItem(makeInput({
      readmeFrontmatterRaw: null,
      progressFileExists: false,
      isActiveRelease: true,
    }));
    expect(result.findings.some((f) => f.kind === "missing_id")).toBe(true);
    expect(result.findings.some((f) => f.kind === "missing_progress")).toBe(true);
  });

  it("mission without MISSION_BRIEF.md emits medium missing_mission_brief at the artifact path", () => {
    const result = classifyScopeItem(makeInput({
      level: "mission",
      readmeFrontmatterRaw: "id: OPR.0.4.1",
      progressFileExists: true,
      missionBriefExists: false,
      missionBriefPath: "/workspace/missions/release-0.4.1/MISSION_BRIEF.md",
    }));
    const finding = result.findings.find((f) => f.kind === "missing_mission_brief");
    expect(finding).toMatchObject({
      severity: "medium",
      path: "/workspace/missions/release-0.4.1/MISSION_BRIEF.md",
    });
    expect(finding?.message).toMatch(/MISSION_BRIEF\.md/);
    expect(finding?.remediation).toMatch(/# <Mission name> — Brief/);
  });

  it("mission with malformed MISSION_BRIEF.md emits medium malformed_mission_brief", () => {
    const result = classifyScopeItem(makeInput({
      level: "mission",
      readmeFrontmatterRaw: "id: OPR.0.4.1",
      progressFileExists: true,
      missionBriefExists: true,
      missionBriefPath: "/workspace/missions/release-0.4.1/MISSION_BRIEF.md",
      missionBriefContent: "# release — Brief\n\n## Progress\n## What & why\n",
    }));
    const finding = result.findings.find((f) => f.kind === "malformed_mission_brief");
    expect(finding?.severity).toBe("medium");
    expect(finding?.path).toBe("/workspace/missions/release-0.4.1/MISSION_BRIEF.md");
    expect(finding?.message).toMatch(/canonical MISSION_BRIEF\.md section order/);
  });

  it("mission with locked slice-16 MISSION_BRIEF.md schema does not emit brief findings", () => {
    const content = [
      "# release-0.4.1 — Brief",
      "",
      "## What & why",
      "## Building",
      "## Progress",
      "## Proven",
      "## Needs you",
      "## Pointers",
    ].join("\n");
    const result = classifyScopeItem(makeInput({
      level: "mission",
      readmeFrontmatterRaw: "id: OPR.0.4.1",
      progressFileExists: true,
      missionBriefExists: true,
      missionBriefPath: "/workspace/missions/release-0.4.1/MISSION_BRIEF.md",
      missionBriefContent: content,
    }));
    expect(result.findings.filter((f) =>
      f.kind === "missing_mission_brief" || f.kind === "malformed_mission_brief"
    )).toHaveLength(0);
  });

  it("mission without MISSION_NOTES.md emits low missing_mission_notes", () => {
    const result = classifyScopeItem(makeInput({
      level: "mission",
      readmeFrontmatterRaw: "id: OPR.0.4.1",
      progressFileExists: true,
      missionNotesExists: false,
      missionNotesPath: "/workspace/missions/release-0.4.1/MISSION_NOTES.md",
    }));
    const finding = result.findings.find((f) => f.kind === "missing_mission_notes");
    expect(finding).toMatchObject({
      severity: "low",
      path: "/workspace/missions/release-0.4.1/MISSION_NOTES.md",
    });
    expect(finding?.remediation).toMatch(/MISSION_NOTES\.md/);
  });

  it("done slice with no PROOF.md and no proof packet emits medium missing_proof", () => {
    const result = classifyScopeItem(makeInput({
      level: "slice",
      readmeFrontmatterRaw: "id: OPR.0.4.1.28\nstatus: done",
      progressFileExists: true,
      proofFileExists: false,
      proofFilePath: "/workspace/missions/release-0.4.1/slices/28-slice/PROOF.md",
      proofDirExists: true,
      proofDirHasEntries: false,
      proofDirPath: "/workspace/missions/release-0.4.1/slices/28-slice/proof",
      hasProofPacket: false,
    }));
    const finding = result.findings.find((f) => f.kind === "missing_proof");
    expect(finding).toMatchObject({
      severity: "medium",
      path: "/workspace/missions/release-0.4.1/slices/28-slice/PROOF.md",
    });
    expect(finding?.message).toMatch(/done\/proven/);
    expect(finding?.remediation).toMatch(/proof\//);
  });

  it("wip slice with no proof does not emit missing_proof", () => {
    const result = classifyScopeItem(makeInput({
      level: "slice",
      readmeFrontmatterRaw: "id: OPR.0.4.1.28\nstatus: wip",
      progressFileExists: true,
      proofFileExists: false,
      proofDirExists: false,
      hasProofPacket: false,
    }));
    expect(result.findings.some((f) => f.kind === "missing_proof")).toBe(false);
  });

  it("proof packet marks a slice proven and still emits missing_proof when root proof is absent", () => {
    const result = classifyScopeItem(makeInput({
      level: "slice",
      readmeFrontmatterRaw: "id: OPR.0.4.1.28\nstatus: active",
      progressFileExists: true,
      proofFileExists: false,
      proofFilePath: "/workspace/missions/release-0.4.1/slices/28-slice/PROOF.md",
      proofDirExists: false,
      hasProofPacket: true,
    }));
    const finding = result.findings.find((f) => f.kind === "missing_proof");
    expect(finding).toMatchObject({
      severity: "medium",
      path: "/workspace/missions/release-0.4.1/slices/28-slice/PROOF.md",
    });
    expect(finding?.message).not.toMatch(/no proof packet/);
  });

  it("root PROOF.md plus populated proof directory suppresses missing_proof", () => {
    const result = classifyScopeItem(makeInput({
      level: "slice",
      readmeFrontmatterRaw: "id: OPR.0.4.1.28\nstatus: shipped",
      progressFileExists: true,
      proofFileExists: true,
      proofDirExists: true,
      proofDirHasEntries: true,
      hasProofPacket: false,
    }));
    expect(result.findings.some((f) => f.kind === "missing_proof")).toBe(false);
  });

  // TIGHTENED: missing_mission_notes gates on ACTIVE mission status
  it("active mission (no status) without MISSION_NOTES emits missing_mission_notes", () => {
    const result = classifyScopeItem(makeInput({
      level: "mission",
      readmeFrontmatterRaw: "id: OPR.0.4.1",
      progressFileExists: true,
      missionNotesExists: false,
    }));
    expect(result.findings.some((f) => f.kind === "missing_mission_notes")).toBe(true);
  });

  it("active mission (explicit active status) without MISSION_NOTES emits missing_mission_notes", () => {
    const result = classifyScopeItem(makeInput({
      level: "mission",
      readmeFrontmatterRaw: "id: OPR.0.4.1\nstatus: active",
      progressFileExists: true,
      missionNotesExists: false,
    }));
    expect(result.findings.some((f) => f.kind === "missing_mission_notes")).toBe(true);
  });

  it("terminal mission (shipped/archived/complete) without MISSION_NOTES does NOT emit missing_mission_notes", () => {
    for (const status of ["shipped", "archived", "complete", "closed", "historical", "superseded"]) {
      const result = classifyScopeItem(makeInput({
        level: "mission",
        readmeFrontmatterRaw: `id: OPR.0.4.1\nstatus: ${status}`,
        progressFileExists: true,
        missionNotesExists: false,
      }));
      expect(
        result.findings.some((f) => f.kind === "missing_mission_notes"),
        `status "${status}" should not flag missing notes`,
      ).toBe(false);
    }
  });

  // NEW: committed-without-PROGRESS (git-derived, CLI-only input)
  it("slice touched by HEAD without a PROGRESS.md change emits progress_not_updated_on_commit", () => {
    const result = classifyScopeItem(makeInput({
      level: "slice",
      path: "/workspace/missions/release-0.4.1/slices/32-x",
      readmeFrontmatterRaw: "id: OPR.0.4.1.32\nstatus: wip",
      progressFileExists: true,
      sliceTouchedByRecentCommit: true,
      progressTouchedByRecentCommit: false,
    }));
    const finding = result.findings.find((f) => f.kind === "progress_not_updated_on_commit");
    expect(finding).toMatchObject({
      severity: "medium",
      path: "/workspace/missions/release-0.4.1/slices/32-x/PROGRESS.md",
    });
    expect(finding?.remediation).toMatch(/PROGRESS\.md/);
  });

  it("slice touched by HEAD WITH a PROGRESS.md change does not emit progress_not_updated_on_commit", () => {
    const result = classifyScopeItem(makeInput({
      level: "slice",
      readmeFrontmatterRaw: "id: OPR.0.4.1.32\nstatus: wip",
      progressFileExists: true,
      sliceTouchedByRecentCommit: true,
      progressTouchedByRecentCommit: true,
    }));
    expect(result.findings.some((f) => f.kind === "progress_not_updated_on_commit")).toBe(false);
  });

  it("committed-without-PROGRESS is inert when git context is unavailable (both inputs undefined)", () => {
    const result = classifyScopeItem(makeInput({
      level: "slice",
      readmeFrontmatterRaw: "id: OPR.0.4.1.32\nstatus: wip",
      progressFileExists: true,
      // sliceTouchedByRecentCommit / progressTouchedByRecentCommit left undefined
    }));
    expect(result.findings.some((f) => f.kind === "progress_not_updated_on_commit")).toBe(false);
  });

  it("committed-without-PROGRESS does not fire when HEAD did not touch the slice", () => {
    const result = classifyScopeItem(makeInput({
      level: "slice",
      readmeFrontmatterRaw: "id: OPR.0.4.1.32\nstatus: wip",
      progressFileExists: true,
      sliceTouchedByRecentCommit: false,
      progressTouchedByRecentCommit: false,
    }));
    expect(result.findings.some((f) => f.kind === "progress_not_updated_on_commit")).toBe(false);
  });
});
